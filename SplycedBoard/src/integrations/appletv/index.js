/**
 * Apple TV integration — IP control of any number of Apple TVs over Apple's Companion
 * protocol (what the iPhone Remote uses; paired with a PIN shown on the TV, no HomeKit).
 *
 * Savant addresses each Apple TV by its IP address: every Apple TV is its own component
 * in Blueprint, pointed at SplycedBoard (127.0.0.1:47200), with the Apple TV's IP in the
 * component's AppleTVAddress state variable.
 *
 * Settings (data/appletv/settings.json):
 *   identity  { name, model, rpId, deviceId } — how SplycedBoard introduces itself (made once)
 *   devices   [{ id, name, address, port, model, pairedAt, credentials }]
 */
const crypto = require('crypto');

const { AppleTvDevice } = require('./device');
const { CompanionClient } = require('./companion/client');
const { pairSetupStart, pairSetupFinish } = require('./companion/pairing');
const { probe, DEFAULT_PORT } = require('./discovery');
const { createRoutes } = require('./routes');

const PAIRING_TIMEOUT_MS = 2 * 60 * 1000;
const DISPLAY_NAME = 'SplycedBoard';

const httpError = (status, message) => Object.assign(new Error(message), { status });

class AppleTvIntegration {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log;
    this.settings = ctx.settings;
    this.devices = new Map(); // id → AppleTvDevice
    this.pairings = new Map(); // address → { busy, client, m2, host, port, name, model, timer }
    this.identity = null;
    this.stopped = true;
    this.router = createRoutes(this);
    this._changeTimer = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start() {
    this.stopped = false;
    this.identity = this._identity();
    const records = this.settings.load().devices || [];
    for (const record of records) this._attach(record).start();
    this.log.info(records.length ? `Controlling ${records.length} Apple TV${records.length === 1 ? '' : 's'}` : 'No Apple TVs paired yet');
  }

  async stop() {
    // First, so nothing that finishes while we wind down can save or start devices.
    this.stopped = true;
    for (const address of [...this.pairings.keys()]) this.cancelPairing(address);
    await Promise.all([...this.devices.values()].map((d) => d.stop()));
    this.devices.clear();
    clearTimeout(this._changeTimer);
    this._changeTimer = null;
  }

  _assertRunning() {
    if (this.stopped) throw httpError(503, 'Apple TV control is switched off');
  }

  /** Generated once and kept, so the Apple TVs always see the same controller. */
  _identity() {
    const saved = this.settings.load().identity;
    if (saved) return saved;
    const mac = crypto.randomBytes(6);
    mac[0] = (mac[0] | 0x02) & 0xfe; // locally administered, unicast
    const identity = {
      name: DISPLAY_NAME,
      model: 'iPhone10,6',
      rpId: crypto.randomBytes(6).toString('hex'),
      deviceId: [...mac].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':'),
    };
    this.settings.update((s) => { s.identity = identity; });
    return identity;
  }

  _attach(record) {
    const device = new AppleTvDevice(record, { identity: this.identity, log: this.log });
    device.on('change', ({ recordChanged } = {}) => {
      if (recordChanged) this._saveDevices();
      this._changed();
    });
    this.devices.set(record.id, device);
    return device;
  }

  _saveDevices() {
    // this.devices is emptied while stopping — never write that out as "no Apple TVs".
    if (this.stopped) return;
    this.settings.update((s) => { s.devices = [...this.devices.values()].map((d) => d.record); });
  }

  /** Coalesce bursts of state changes into one dashboard/hub update. */
  _changed() {
    if (this.stopped || this._changeTimer) return;
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null;
      this.ctx.broadcast('devices', { devices: this.list() });
      this.ctx.statusChanged();
    }, 100);
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  list() {
    return [...this.devices.values()].map((d) => d.snapshot()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** By IP address (what Savant sends), id, or name. */
  find(key) {
    if (!key) throw httpError(400, 'ip required');
    const k = String(key).trim().toLowerCase();
    for (const d of this.devices.values()) {
      const r = d.record;
      if (r.address === k || r.id === k || r.name.toLowerCase() === k) return d;
    }
    throw httpError(404, `No paired Apple TV at ${key}`);
  }

  // ── Pairing ────────────────────────────────────────────────────────────────

  /**
   * Connects and asks the Apple TV to show a PIN.
   * @param host  optional: connect here instead of `address` (address stays the Savant key)
   */
  async startPairing({ address, host, port, name }) {
    this._assertRunning();
    address = String(address || '').trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) throw httpError(400, 'Enter the Apple TV\'s IPv4 address');
    if (port !== undefined && port !== null && port !== '') {
      port = Number(port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'Invalid port');
    } else {
      port = null;
    }
    if (this.pairings.get(address)?.busy) throw httpError(409, `Already pairing with ${address} — finish or cancel that first`);
    this.cancelPairing(address);

    // Registered before anything is awaited, so a second request can see it.
    const session = { busy: true, client: null, m2: null, host: host && host !== address ? host : null, timer: null };
    this.pairings.set(address, session);
    const current = () => this.pairings.get(address) === session;

    try {
      const target = host || address;
      const found = port ? null : await probe(target);
      if (!current()) throw httpError(409, 'Pairing was cancelled');
      session.client = new CompanionClient({ host: target, port: port || found?.port || DEFAULT_PORT, log: this.log });
      try {
        await session.client.open({ timeoutMs: 5000 });
      } catch (err) {
        throw httpError(502, `Couldn't reach an Apple TV at ${address}: ${err.message}`);
      }
      try {
        session.m2 = await pairSetupStart(session.client);
      } catch (err) {
        throw httpError(502, err.message);
      }
      if (!current()) throw httpError(409, 'Pairing was cancelled');
      session.port = session.client.port;
      session.name = String(name || '').trim() || found?.name || `Apple TV ${address}`;
      session.model = found?.model || null;
    } catch (err) {
      if (current()) this.pairings.delete(address);
      session.client?.close();
      throw err;
    }

    session.busy = false;
    session.timer = setTimeout(() => this.cancelPairing(address), PAIRING_TIMEOUT_MS);
    session.client.on('close', () => {
      if (current() && !session.busy) this.cancelPairing(address);
    });
    this.log.info(`Pairing with ${session.name} (${address}) — waiting for the PIN shown on the TV`);
    return { address, name: session.name, port: session.port, model: session.model };
  }

  /** Completes pairing with the PIN the user read off the TV. */
  async finishPairing({ address, pin }) {
    this._assertRunning();
    address = String(address || '').trim();
    const session = this.pairings.get(address);
    if (!session) throw httpError(409, `No pairing in progress for ${address} — start again`);
    if (session.busy) throw httpError(409, `Pairing with ${address} is already in progress`);
    if (!/^\d{4}$/.test(String(pin || '').trim())) throw httpError(400, 'Enter the 4-digit PIN shown on the TV');

    session.busy = true;
    let credentials;
    try {
      credentials = await pairSetupFinish(session.client, session.m2, pin, DISPLAY_NAME, this.log);
    } catch (err) {
      // A wrong PIN is the user's to fix; anything else is the network or the Apple TV.
      throw httpError(err.tlvError ? 400 : 502, `${err.message} — start pairing again`);
    } finally {
      if (this.pairings.get(address) === session) this.cancelPairing(address);
      else session.client.close();
    }
    this._assertRunning();

    // Re-pairing an address replaces the old pairing but keeps its id and name.
    let existing = null;
    try { existing = this.find(address); } catch { /* new Apple TV */ }
    const record = {
      id: existing?.id || crypto.randomBytes(4).toString('hex'),
      name: existing?.record.name || session.name,
      address,
      ...(session.host ? { host: session.host } : {}),
      port: session.port,
      model: session.model || existing?.record.model || null,
      pairedAt: new Date().toISOString(),
      credentials,
    };
    // Swap in the new device and save before awaiting anything.
    if (existing) this.devices.delete(existing.id);
    const device = this._attach(record);
    this._saveDevices();
    if (existing) await existing.stop();
    if (!this.stopped) device.start();
    this._changed();
    this.log.info(`Paired with ${record.name} (${address})`);
    return device.snapshot();
  }

  cancelPairing(address) {
    const session = this.pairings.get(address);
    if (!session) return false;
    this.pairings.delete(address);
    clearTimeout(session.timer);
    session.client?.close();
    return true;
  }

  // ── Editing ────────────────────────────────────────────────────────────────

  async updateDevice(id, { name, address }) {
    this._assertRunning();
    const device = this.find(id);
    if (name !== undefined) {
      if (!String(name).trim()) throw httpError(400, 'Name can\'t be empty');
      device.record.name = String(name).trim();
    }
    if (address !== undefined && address !== device.record.address) {
      address = String(address).trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) throw httpError(400, 'Enter an IPv4 address');
      for (const d of this.devices.values()) {
        if (d !== device && d.record.address === address) throw httpError(409, `${d.record.name} already uses ${address}`);
      }
      device.record.address = address;
      delete device.record.host; // "the Apple TV is now at this IP"
      this._saveDevices();
      await device.stop();
      if (!this.stopped && this.devices.get(device.id) === device) device.start();
    } else {
      this._saveDevices();
    }
    this._changed();
    return device.snapshot();
  }

  async removeDevice(id) {
    this._assertRunning();
    const device = this.find(id);
    this.devices.delete(device.id);
    this._saveDevices();
    await device.stop();
    this._changed();
    this.log.info(`Removed ${device.label}`);
  }

  // ── Hub contract ───────────────────────────────────────────────────────────

  status() {
    const devices = this.list();
    if (!devices.length) return { level: 'idle', text: 'No Apple TVs paired — open Apple TV to add one' };
    const connected = devices.filter((d) => d.connection === 'connected').length;
    const noun = devices.length === 1 ? 'Apple TV' : 'Apple TVs';
    if (connected === devices.length) return { level: 'ok', text: `${connected} ${noun} connected` };
    return { level: 'warn', text: `${connected} of ${devices.length} ${noun} connected` };
  }

  hello() {
    return [{ type: 'devices', devices: this.list() }];
  }
}

module.exports = {
  create: (ctx) => new AppleTvIntegration(ctx),
};
