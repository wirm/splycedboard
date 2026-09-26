/**
 * Feedback for Savant: the Lutron levels and keypad LEDs that changed, and the keypad buttons
 * pressed, for the LEAP Bridge profile to show and trigger on.
 *
 * The profile talks to SplycedBoard over HTTP, which can't push. So it asks twice a second
 * (its PollFeedback action) and gets back what changed since it last asked. First come button
 * events, up to BUTTON_SLOTS, keyed "<device>_<button>" (Address1 and Address2 of a Keypad
 * Button row):
 *
 *     {"b0":"501_6","e0":"Press", … "b7":"501_6","e7":"Press"}
 *
 * which ButtonFeedback writes into ButtonEvent_<device>_<button>, for Savant triggers. It stays
 * on what the button did last, like CurrentButtonStatus in Savant's own Lutron profiles: Press,
 * Hold while held, Release, MultiTap. A trigger fires on a change, so a value never follows
 * itself: a tap is Press, then Release PRESS_MS later at the least, even where the processor
 * reports only the Release. One event per button per answer, so Savant sees each. Only buttons
 * used are sent, only when used. Then an answer is zone levels, up to SLOTS of them:
 *
 *     {"z0":"486","l0":55,"z1":"606","l1":0, … "z31":"486","l31":55}
 *
 * which the ZoneFeedback status message writes into DimmerLevel_<zone> and ColorLevel_<zone>,
 * or, once no level is waiting, keypad LEDs, up to LED_SLOTS, keyed "<device>_<LED>":
 *
 *     {"k0":"501_801","o0":1, … "k15":"501_801","o15":1}
 *
 * which LEDFeedback writes into IsCurrentLEDOn_<device>_<LED>, the state a Keypad Button row
 * lights from (Address1 = device, Address3 = LED). Never both at once: a status message is
 * sure to apply only when it's the one that matches.
 *
 * Every slot is always filled, spares repeating the first: Savant keeps each slot's last
 * values, so a slot left out would write an old one again. Nothing new: {}.
 *
 * Savant hosts are told apart by address. One that's new, that says it just started
 * (?start=1, its FeedbackStart action), or that stopped asking for a while, is sent
 * everything, behind whatever just changed. So is every host every RESYNC_MS, in case an
 * answer went missing.
 */
const SLOTS = 32; // the profile's ZoneFeedback reads exactly this many
const LED_SLOTS = 16; // and LEDFeedback this many
const BUTTON_SLOTS = 8; // and ButtonFeedback this many
// A tap's Press shows at least this long before its Release: the gap Savant's own Lutron
// profiles leave between the two in ButtonPressAndRelease. In practice one poll, half a second.
const PRESS_MS = 200;
const MAX_QUEUED_EVENTS = 64; // per host: presses aren't worth delivering minutes late
const IDLE_MS = 15 * 1000;
const RESYNC_MS = 10 * 60 * 1000;
const FORGET_MS = 60 * 60 * 1000;

class ZoneFeedback {
  /** @param getController  () => LeapController | null — the controller is replaced on re-pair */
  constructor({ getController, now = Date.now }) {
    this.getController = getController;
    this.now = now;
    // address → { changed, sync: Set<zoneId>, changedLeds, syncLeds: Set<ledHref>,
    //             events: [{ key, event, afterMs }], sentAt: Map<key, ms>, askedAt, syncedAt }
    this.hosts = new Map();
    // "<device>_<button>" → { down, last }: whether the processor has it pressed, and the value
    // it was last given for Savant
    this.buttons = new Map();
  }

  /**
   * A keypad button was pressed, released, held… (the processor's EventType), as the values
   * ButtonEvent_<device>_<button> goes through. Queued for the hosts asking now: a host that
   * isn't wouldn't want presses from before it started.
   */
  buttonEvent(deviceId, buttonNumber, event) {
    if (deviceId == null || buttonNumber == null || !event) return;
    const key = `${deviceId}_${buttonNumber}`;
    const steps = this._buttonSteps(key, String(event));
    const now = this.now();
    for (const host of this.hosts.values()) {
      if (now - host.askedAt > IDLE_MS) continue;
      for (const [value, afterMs] of steps) host.events.push({ key, event: value, afterMs });
      if (host.events.length > MAX_QUEUED_EVENTS) host.events.splice(0, host.events.length - MAX_QUEUED_EVENTS);
    }
  }

  /**
   * [value, ms after the button's one before] for one event. A trigger fires on a change, so a
   * value never follows itself: a tap the processor reports only once it's over (a Release,
   * with no Press before it) is Press then Release, and a second MultiTap has a Press between.
   * A hold is Hold until the Release, however long (LongHold too).
   */
  _buttonSteps(key, event) {
    const button = this.buttons.get(key) || { down: false, last: null };
    this.buttons.set(key, button);
    let steps;
    if (event === 'Press') steps = button.last === 'Press' ? [['Release', 0], ['Press', PRESS_MS]] : [['Press', 0]];
    else if (event === 'Hold' || event === 'LongHold') steps = button.last === 'Hold' ? [] : [['Hold', 0]];
    else if (event === 'Release') steps = button.down ? [['Release', 0]] : [['Press', 0], ['Release', PRESS_MS]];
    else steps = button.last === event ? [['Press', 0], [event, PRESS_MS]] : [[event, 0]];
    button.down = event === 'Press' || event === 'Hold' || event === 'LongHold';
    if (steps.length) button.last = steps[steps.length - 1][0];
    return steps;
  }

  /** A zone's level changed: every host gets it on its next poll, ahead of any resync. */
  zoneChanged(zoneId) {
    for (const host of this.hosts.values()) {
      host.sync.delete(zoneId);
      host.changed.add(zoneId);
    }
  }

  /** A keypad LED went on or off. */
  ledChanged(ledHref) {
    for (const host of this.hosts.values()) {
      host.syncLeds.delete(ledHref);
      host.changedLeds.add(ledHref);
    }
  }

  /** The controller (re)loaded its inventory: everything again, for every host. */
  resyncAll() {
    for (const host of this.hosts.values()) this._resync(host, this.now());
  }

  /** The answer to one poll from `address`; `start`: Savant says it just started. */
  poll(address, { start = false } = {}) {
    const now = this.now();
    for (const [key, host] of this.hosts) {
      if (now - host.askedAt > FORGET_MS) this.hosts.delete(key);
    }
    let host = this.hosts.get(address);
    if (!host) {
      host = {
        changed: new Set(), sync: new Set(), changedLeds: new Set(), syncLeds: new Set(),
        events: [], sentAt: new Map(), askedAt: now, syncedAt: -Infinity,
      };
      this.hosts.set(address, host);
    }
    if (start || now - host.askedAt > IDLE_MS || now - host.syncedAt > RESYNC_MS) this._resync(host, now);
    host.askedAt = now;
    return this._buttonAnswer(host) || this._zoneAnswer(host) || this._ledAnswer(host) || {};
  }

  /** The Savant hosts asking right now, for the dashboard. */
  activeHosts() {
    const now = this.now();
    return [...this.hosts].filter(([, host]) => now - host.askedAt <= IDLE_MS).map(([address]) => address);
  }

  _resync(host, now) {
    const controller = this.getController();
    if (!controller?.ready) return; // nothing to send yet: resyncAll() runs once it's ready
    for (const id of controller.zones.keys()) {
      if (!host.changed.has(id)) host.sync.add(id);
    }
    for (const { ledHref } of controller.keypadLeds()) {
      if (!host.changedLeds.has(ledHref)) host.syncLeds.add(ledHref);
    }
    host.syncedAt = now;
  }

  /** Up to `slots` items from what just changed, then from a resync; null when there are none. */
  _take(queues, slots, item) {
    const items = [];
    for (const queue of queues) {
      for (const key of queue) {
        if (items.length === slots) break;
        queue.delete(key);
        const it = item(key);
        if (it) items.push(it);
      }
    }
    return items.length ? items : null;
  }

  _fill(items, slots, keyName, valueName) {
    const answer = {};
    for (let i = 0; i < slots; i++) {
      const [key, value] = items[i] || items[0];
      answer[`${keyName}${i}`] = key;
      answer[`${valueName}${i}`] = value;
    }
    return answer;
  }

  /**
   * The button events due, in order; null when none is. One per button per answer, since
   * Savant keeps a slot's last value only, and each waits its afterMs from the button's last.
   */
  _buttonAnswer(host) {
    const now = this.now();
    const items = [];
    const waiting = new Set(); // buttons with an event in this answer, or one not due yet
    const later = [];
    for (const e of host.events) {
      const due = !e.afterMs || now - (host.sentAt.get(e.key) ?? -Infinity) >= e.afterMs;
      if (items.length < BUTTON_SLOTS && due && !waiting.has(e.key)) {
        items.push([e.key, e.event]);
        host.sentAt.set(e.key, now);
      } else {
        later.push(e);
      }
      waiting.add(e.key);
    }
    host.events = later;
    return items.length ? this._fill(items, BUTTON_SLOTS, 'b', 'e') : null;
  }

  _zoneAnswer(host) {
    const controller = this.getController();
    if (!controller?.ready) return null;
    const items = this._take([host.changed, host.sync], SLOTS, (id) => {
      const zone = controller.zones.get(id);
      return zone && zone.type !== 'hvac' && zone.level != null ? [String(id), Math.round(zone.level)] : null;
    });
    return items && this._fill(items, SLOTS, 'z', 'l');
  }

  _ledAnswer(host) {
    const controller = this.getController();
    if (!controller?.ready) return null;
    const leds = new Map(controller.keypadLeds().map((led) => [led.ledHref, led]));
    const items = this._take([host.changedLeds, host.syncLeds], LED_SLOTS, (href) => {
      const led = leds.get(href);
      return led && led.deviceId != null && led.state ? [`${led.deviceId}_${led.ledId}`, led.state === 'On' ? 1 : 0] : null;
    });
    return items && this._fill(items, LED_SLOTS, 'k', 'o');
  }
}

module.exports = { ZoneFeedback, SLOTS, LED_SLOTS, BUTTON_SLOTS, PRESS_MS, IDLE_MS, RESYNC_MS };
