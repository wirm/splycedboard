/**
 * Feedback for Savant: the Lutron levels and keypad LEDs that changed, for the LEAP Bridge
 * profile to show.
 *
 * The profile talks to SplycedBoard over HTTP, which can't push. So it asks twice a second
 * (its PollFeedback action) and gets back what changed since it last asked. An answer is
 * either zone levels, up to SLOTS of them:
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
const IDLE_MS = 15 * 1000;
const RESYNC_MS = 10 * 60 * 1000;
const FORGET_MS = 60 * 60 * 1000;

class ZoneFeedback {
  /** @param getController  () => LeapController | null — the controller is replaced on re-pair */
  constructor({ getController, now = Date.now }) {
    this.getController = getController;
    this.now = now;
    // address → { changed, sync: Set<zoneId>, changedLeds, syncLeds: Set<ledHref>, askedAt, syncedAt }
    this.hosts = new Map();
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
      host = { changed: new Set(), sync: new Set(), changedLeds: new Set(), syncLeds: new Set(), askedAt: now, syncedAt: -Infinity };
      this.hosts.set(address, host);
    }
    if (start || now - host.askedAt > IDLE_MS || now - host.syncedAt > RESYNC_MS) this._resync(host, now);
    host.askedAt = now;
    return this._zoneAnswer(host) || this._ledAnswer(host) || {};
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

module.exports = { ZoneFeedback, SLOTS, LED_SLOTS, IDLE_MS, RESYNC_MS };
