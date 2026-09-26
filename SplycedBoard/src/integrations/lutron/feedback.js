/**
 * Feedback for Savant: the Lutron levels and keypad LEDs that changed, and the keypad buttons
 * pressed, for the LEAP Bridge profile to show and trigger on.
 *
 * The profile talks to SplycedBoard over HTTP, which can't push. So it asks twice a second
 * (its PollFeedback action) and gets back what changed since it last asked. First come button
 * events, up to BUTTON_SLOTS, keyed "<device>_<button>" (Address1 and Address2 of a Keypad
 * Button row):
 *
 *     {"b0":"501_6","e0":"Release", … "b7":"501_6","e7":"Release"}
 *
 * which ButtonFeedback writes into ButtonEvent_<device>_<button>, for Savant triggers. The
 * answer after sets it back to "None", so the same event twice is two changes in Savant; one
 * event per button per answer. Then an answer is zone levels, up to SLOTS of them:
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
const BUTTON_IDLE = 'None'; // what ButtonEvent_* goes back to after an event
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
    //             events: [{ key, event }], resetNext: Set<key>, askedAt, syncedAt }
    this.hosts = new Map();
  }

  /**
   * A keypad button was pressed, released, held… (the processor's EventType). Queued for the
   * hosts asking now: a host that isn't wouldn't want presses from before it started.
   */
  buttonEvent(deviceId, buttonNumber, event) {
    if (deviceId == null || buttonNumber == null || !event) return;
    const now = this.now();
    for (const host of this.hosts.values()) {
      if (now - host.askedAt > IDLE_MS) continue;
      host.events.push({ key: `${deviceId}_${buttonNumber}`, event: String(event) });
      if (host.events.length > MAX_QUEUED_EVENTS) host.events.shift();
    }
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
        events: [], resetNext: new Set(), askedAt: now, syncedAt: -Infinity,
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
   * Button events first, then the resets to None the last answer's events are owed; null when
   * there's neither. A button's next event waits for its reset, so the same event twice is two
   * changes; and one event per button per answer, since Savant keeps a slot's last value only.
   */
  _buttonAnswer(host) {
    const items = [];
    const inThisAnswer = new Set();
    const later = [];
    const sent = [];
    for (const e of host.events) {
      if (items.length < BUTTON_SLOTS && !inThisAnswer.has(e.key) && !host.resetNext.has(e.key)) {
        items.push([e.key, e.event]);
        inThisAnswer.add(e.key);
        sent.push(e.key);
      } else {
        later.push(e);
      }
    }
    host.events = later;
    for (const key of host.resetNext) {
      if (items.length === BUTTON_SLOTS) break;
      items.push([key, BUTTON_IDLE]);
      host.resetNext.delete(key);
    }
    for (const key of sent) host.resetNext.add(key);
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

module.exports = { ZoneFeedback, SLOTS, LED_SLOTS, BUTTON_SLOTS, BUTTON_IDLE, IDLE_MS, RESYNC_MS };
