/**
 * Feedback for Savant: the Lutron levels that changed, for the LEAP Bridge profile to show.
 *
 * The profile talks to SplycedBoard over HTTP, which can't push. So it asks twice a second
 * (its PollFeedback action) and gets back the zones whose level changed since it last asked,
 * up to SLOTS at a time:
 *
 *     {"z0":"486","l0":55,"z1":"606","l1":0, … "z31":"486","l31":55}
 *
 * Its ZoneFeedback status message writes each slot into DimmerLevel_<zone> and
 * ColorLevel_<zone>, the states Blueprint's lighting table rows show. Every slot is always
 * filled, spares repeating the first zone: Savant keeps each slot's last values, so a slot
 * left out would write an old level again. Nothing new: {}.
 *
 * Savant hosts are told apart by address. One that's new, or that stopped asking for a while
 * (restarted, or its configuration reloaded), is sent every level, behind whatever just
 * changed. So is every host every RESYNC_MS, in case an answer went missing.
 */
const SLOTS = 32; // the profile's ZoneFeedback reads exactly this many
const IDLE_MS = 15 * 1000;
const RESYNC_MS = 10 * 60 * 1000;
const FORGET_MS = 60 * 60 * 1000;

class ZoneFeedback {
  /** @param getController  () => LeapController | null — the controller is replaced on re-pair */
  constructor({ getController, now = Date.now }) {
    this.getController = getController;
    this.now = now;
    this.hosts = new Map(); // address → { changed: Set<zoneId>, sync: Set<zoneId>, askedAt, syncedAt }
  }

  /** A zone's level changed: every host gets it on its next poll, ahead of any resync. */
  zoneChanged(zoneId) {
    for (const host of this.hosts.values()) {
      host.sync.delete(zoneId);
      host.changed.add(zoneId);
    }
  }

  /** The controller (re)loaded its inventory: every level again, for every host. */
  resyncAll() {
    for (const host of this.hosts.values()) this._resync(host, this.now());
  }

  /** The answer to one poll from `address`: the next levels it should show. */
  poll(address) {
    const now = this.now();
    for (const [key, host] of this.hosts) {
      if (now - host.askedAt > FORGET_MS) this.hosts.delete(key);
    }
    let host = this.hosts.get(address);
    if (!host) {
      host = { changed: new Set(), sync: new Set(), askedAt: now, syncedAt: -Infinity };
      this.hosts.set(address, host);
    }
    if (now - host.askedAt > IDLE_MS || now - host.syncedAt > RESYNC_MS) this._resync(host, now);
    host.askedAt = now;
    return this._answer(host);
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
    host.syncedAt = now;
  }

  _answer(host) {
    const controller = this.getController();
    if (!controller?.ready) return {};
    const items = [];
    for (const queue of [host.changed, host.sync]) {
      for (const id of queue) {
        if (items.length === SLOTS) break;
        queue.delete(id);
        const zone = controller.zones.get(id);
        if (zone && zone.type !== 'hvac' && zone.level != null) items.push([String(id), Math.round(zone.level)]);
      }
    }
    if (!items.length) return {};
    const answer = {};
    for (let i = 0; i < SLOTS; i++) {
      const [zone, level] = items[i] || items[0];
      answer[`z${i}`] = zone;
      answer[`l${i}`] = level;
    }
    return answer;
  }
}

module.exports = { ZoneFeedback, SLOTS, IDLE_MS, RESYNC_MS };
