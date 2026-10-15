/**
 * What SplycedBoard knows about the alarm panel: its partitions and zones, as the ITv2
 * notifications and status answers describe them. Knows nothing about the wire format.
 *
 * Emits 'change' ({ kind: 'partition' | 'zone' | 'panel', number? }) after every update.
 */
const { EventEmitter } = require('events');

const { ARMING, ARM_METHOD, READY, ENTRY_DELAY, ALARM_TYPE } = require('./itv2/codes');

class PanelState extends EventEmitter {
  constructor({ now = Date.now } = {}) {
    super();
    this.now = now;
    this.info = {}; // capabilities, software version, panel status
    this.partitions = new Map();
    this.zones = new Map();
  }

  partition(number) {
    if (!this.partitions.has(number)) {
      this.partitions.set(number, {
        number,
        label: null,
        arming: 'unknown', // disarmed | stay | away | night | armed | unknown
        armingText: 'Unknown',
        ready: null,
        readyText: 'Unknown',
        exitDelayUntil: null, // ms timestamp while an exit delay counts down
        entryDelay: null, // null, or ENTRY_DELAY text while running
        alarmMemory: null,
        trouble: null,
        bell: null,
        lastChange: null, // { by: 'access code', user: 3, at }
      });
    }
    return this.partitions.get(number);
  }

  zone(number) {
    if (!this.zones.has(number)) {
      this.zones.set(number, { number, label: null, open: null, alarm: null, alarmType: null, changedAt: null });
    }
    return this.zones.get(number);
  }

  // ── Updates ────────────────────────────────────────────────────────────────

  setZoneOpen(number, open) {
    const z = this.zone(number);
    if (z.open === open) return;
    z.open = open;
    z.changedAt = this.now();
    this._changed('zone', number);
  }

  setZoneAlarm(number, alarmTypeCode, active) {
    const z = this.zone(number);
    z.alarm = active;
    z.alarmType = active ? ALARM_TYPE[alarmTypeCode] || `Type ${alarmTypeCode}` : null;
    this._changed('zone', number);
  }

  setArming(number, code, methodCode, user) {
    const p = this.partition(number);
    const a = ARMING[code] || { mode: 'armed', text: `Arming state ${code}` };
    p.arming = a.mode;
    p.armingText = a.text;
    p.exitDelayUntil = null; // armed or disarmed: any countdown is over
    if (a.mode === 'disarmed') p.entryDelay = null;
    // Only an arming notification says who and how; a status answer just says what.
    if (methodCode != null) p.lastChange = { by: ARM_METHOD[methodCode] || 'unknown', user: user ?? null, at: this.now() };
    this._changed('partition', number);
  }

  setReady(number, code) {
    const p = this.partition(number);
    const r = READY[code] || READY[0];
    p.ready = r.ready;
    p.readyText = r.text;
    this._changed('partition', number);
  }

  setExitDelay(number, seconds) {
    const p = this.partition(number);
    p.exitDelayUntil = seconds > 0 ? this.now() + seconds * 1000 : null;
    this._changed('partition', number);
  }

  setEntryDelay(number, statusCode) {
    const p = this.partition(number);
    p.entryDelay = statusCode ? ENTRY_DELAY[statusCode] || 'running' : null;
    this._changed('partition', number);
  }

  setPartitionFlag(number, flag, on) {
    const p = this.partition(number);
    p[flag] = on;
    this._changed('partition', number);
  }

  setLabel(kind, number, label) {
    const item = kind === 'zone' ? this.zone(number) : this.partition(number);
    const clean = String(label || '').replace(/\0+$/, '').trim() || null;
    if (item.label === clean) return;
    item.label = clean;
    this._changed(kind, number);
  }

  setInfo(fields) {
    Object.assign(this.info, fields);
    this._changed('panel');
  }

  /** The session ended: what we knew may be stale, but keep it on screen, marked unknown. */
  clearLive() {
    for (const z of this.zones.values()) z.open = null;
    this._changed('panel');
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  snapshot() {
    const now = this.now();
    const byNumber = (a, b) => a.number - b.number;
    return {
      info: { ...this.info },
      partitions: [...this.partitions.values()].sort(byNumber).map((p) => ({
        ...p,
        exitDelaySeconds: p.exitDelayUntil ? Math.max(0, Math.round((p.exitDelayUntil - now) / 1000)) : null,
      })),
      zones: [...this.zones.values()].sort(byNumber).map((z) => ({ ...z })),
    };
  }

  _changed(kind, number) {
    this.emit('change', { kind, number });
  }
}

module.exports = { PanelState };
