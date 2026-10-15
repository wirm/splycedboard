/**
 * The hub: loads every integration in the registry, starts the enabled ones, and
 * lets them be switched on and off at runtime without restarting the process.
 *
 * Integration contract (see docs/ADDING-AN-INTEGRATION.md):
 *
 *   create(ctx) → {
 *     router,            express.Router mounted at /api/<id> (optional)
 *     async start(),     open sockets/servers — throw to report a failure
 *     async stop(),      release everything start() opened
 *     status(),          → { level: 'ok'|'warn'|'error'|'idle', text }
 *     hello(),           → WebSocket messages to send a newly connected dashboard (optional)
 *   }
 *
 *   ctx = { id, manifest, dataDir, log, settings, broadcast(type, payload), statusChanged() }
 *
 * Events:
 *   'change'   the integration list/status changed
 *   'message'  { source, type, ... } to forward to dashboards over WebSocket
 */
const { EventEmitter } = require('events');
const path = require('path');

const logger = require('./log');
const { JsonStore } = require('./store');
const { DATA_DIR, PROFILES_DIR } = require('./paths');
const { ProfileTracker, readProfile } = require('./profiles');
const registry = require('../integrations');

const STOP_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class Hub extends EventEmitter {
  constructor({ dataDir = DATA_DIR } = {}) {
    super();
    this.dataDir = dataDir;
    this.settings = new JsonStore(path.join(dataDir, 'hub.json'), { integrations: {}, verbose: true, beta: false });
    this.log = logger.createLogger('hub');
    this.entries = new Map(); // id → { manifest, instance, running, error, queue }
    // Which version of each Savant profile Savant runs (see core/profiles.js).
    this.profiles = new ProfileTracker({ log: this.log.child('profiles') });
    this.profiles.on('change', () => this.emit('change'));
  }

  /** Create every integration instance. Nothing is started yet. */
  load() {
    logger.setVerbose(this.settings.load().verbose !== false);

    for (const manifest of registry.manifests()) {
      const entry = { manifest, instance: null, running: false, error: null, queue: Promise.resolve() };
      this.entries.set(manifest.id, entry);
      if (manifest.profile) {
        const shipped = readProfile(path.join(PROFILES_DIR, manifest.profile));
        this.profiles.register(manifest.id, { name: manifest.name, file: manifest.profile, ...shipped });
      }
      try {
        entry.instance = registry.load(manifest.id).create(this._context(manifest));
      } catch (err) {
        entry.error = `Failed to load: ${err.message}`;
        this.log.error(`Could not load integration "${manifest.id}":`, err);
      }
    }
    this.profiles.start();
  }

  /** Start every integration that is switched on. */
  async startEnabled() {
    for (const entry of this.entries.values()) {
      if (!this.isAvailable(entry.manifest.id)) this.log.info(`${entry.manifest.name} is a beta feature, and Beta is off`);
      else if (this.isEnabled(entry.manifest.id)) await this._enqueue(entry, () => this._start(entry));
      else this.log.info(`${entry.manifest.name} is disabled`);
    }
  }

  _context(manifest) {
    const dataDir = path.join(this.dataDir, manifest.id);
    return {
      id: manifest.id,
      manifest,
      dataDir,
      log: logger.createLogger(manifest.id),
      settings: new JsonStore(path.join(dataDir, 'settings.json')),
      broadcast: (type, payload = {}) => this.emit('message', { ...payload, source: manifest.id, type }),
      statusChanged: () => this.emit('change'),
    };
  }

  // ── Enable / disable ─────────────────────────────────────────────────────

  /**
   * Whether an integration exists as far as the dashboard is concerned. One marked
   * "beta": true in its manifest only does with Beta switched on in Settings: otherwise it's
   * left out of the list and doesn't run, whatever its own switch says.
   */
  isAvailable(id) {
    return !this.entries.get(id)?.manifest.beta || this.getSettings().beta;
  }

  isEnabled(id) {
    const saved = this.settings.load().integrations?.[id]?.enabled;
    if (typeof saved === 'boolean') return saved;
    return this.entries.get(id)?.manifest.defaultEnabled !== false;
  }

  async setEnabled(id, enabled) {
    const entry = this._entry(id);
    if (enabled && !this.isAvailable(id)) {
      throw Object.assign(new Error(`${entry.manifest.name} is a beta feature: switch Beta on in Settings first`), { status: 409 });
    }
    this.settings.update((s) => {
      s.integrations = { ...s.integrations, [id]: { ...s.integrations?.[id], enabled } };
    });
    this.log.info(`${enabled ? 'Enabling' : 'Disabling'} ${entry.manifest.name}`);
    await this._enqueue(entry, () => (enabled ? this._start(entry) : this._stop(entry)));
    return this.describe(id);
  }

  /** Stop then start again — used after settings that need a fresh start. */
  async restart(id) {
    const entry = this._entry(id);
    await this._enqueue(entry, async () => {
      await this._stop(entry);
      if (this.isEnabled(id) && this.isAvailable(id)) await this._start(entry);
    });
    return this.describe(id);
  }

  // Start/stop for one integration run strictly one at a time, so a quick
  // enable→disable from the dashboard can't interleave with a slow start().
  _enqueue(entry, op) {
    entry.queue = entry.queue.then(op, op);
    return entry.queue;
  }

  async _start(entry) {
    if (entry.running || !entry.instance) return;
    entry.error = null;
    try {
      await entry.instance.start();
      entry.running = true;
      this.log.info(`${entry.manifest.name} started`);
    } catch (err) {
      entry.error = err.message;
      this.log.error(`${entry.manifest.name} failed to start: ${err.message}`);
      // Release anything start() opened before it failed.
      try { await entry.instance.stop(); } catch { /* already reported */ }
    }
    this.emit('change');
  }

  async _stop(entry) {
    if (!entry.instance) return;
    const wasRunning = entry.running;
    entry.running = false;
    entry.error = null;
    try {
      // A stop() that never settles would wedge this integration's queue for good.
      await withTimeout(entry.instance.stop(), STOP_TIMEOUT_MS, 'stop() timed out');
      if (wasRunning) this.log.info(`${entry.manifest.name} stopped`);
    } catch (err) {
      this.log.error(`${entry.manifest.name} did not stop cleanly: ${err.message}`);
    }
    this.emit('change');
  }

  async stopAll() {
    this.profiles.stop();
    for (const entry of this.entries.values()) {
      await this._enqueue(entry, () => this._stop(entry));
    }
  }

  // ── Introspection ────────────────────────────────────────────────────────

  _entry(id) {
    const entry = this.entries.get(id);
    if (!entry) throw Object.assign(new Error(`Unknown integration "${id}"`), { status: 404 });
    return entry;
  }

  /** The running instance, or null when the integration is disabled or failed. */
  instance(id) {
    const entry = this.entries.get(id);
    return entry?.running ? entry.instance : null;
  }

  describe(id) {
    const entry = this._entry(id);
    const enabled = this.isEnabled(id);
    let status;
    if (entry.error) status = { level: 'error', text: entry.error };
    else if (!enabled) status = { level: 'off', text: 'Disabled' };
    else if (!entry.running) status = { level: 'warn', text: 'Starting…' };
    else {
      try { status = entry.instance.status(); } catch (err) { status = { level: 'error', text: err.message }; }
    }
    const { id: _id, ...manifest } = entry.manifest;
    return { id, ...manifest, enabled, running: entry.running, status, profileStatus: this.profiles.summary(id) };
  }

  /** What the dashboard shows; `all` adds beta integrations hidden while Beta is off. */
  list({ all = false } = {}) {
    return Array.from(this.entries.keys()).filter((id) => all || this.isAvailable(id)).map((id) => this.describe(id));
  }

  /** Messages a newly connected dashboard needs to render current state. */
  hello() {
    const messages = [];
    for (const [id, entry] of this.entries) {
      if (!entry.running || typeof entry.instance.hello !== 'function') continue;
      for (const msg of entry.instance.hello()) messages.push({ ...msg, source: id });
    }
    return messages;
  }

  // ── Hub settings ─────────────────────────────────────────────────────────

  getSettings() {
    const { verbose, beta } = this.settings.load();
    return { verbose: verbose !== false, beta: beta === true };
  }

  async updateSettings({ verbose, beta }) {
    if (typeof verbose === 'boolean') {
      this.settings.update((s) => { s.verbose = verbose; });
      logger.setVerbose(verbose);
      this.log.info(`Verbose logging ${verbose ? 'on' : 'off'}`);
    }
    if (typeof beta === 'boolean' && beta !== this.getSettings().beta) {
      this.settings.update((s) => { s.beta = beta; });
      this.log.info(`Beta features ${beta ? 'on' : 'off'}`);
      // Beta integrations appear (and those switched on start), or stop and disappear.
      for (const entry of this.entries.values()) {
        if (!entry.manifest.beta) continue;
        if (!beta) await this._enqueue(entry, () => this._stop(entry));
        else if (this.isEnabled(entry.manifest.id)) await this._enqueue(entry, () => this._start(entry));
      }
      this.emit('change');
    }
    return this.getSettings();
  }
}

module.exports = { Hub };
