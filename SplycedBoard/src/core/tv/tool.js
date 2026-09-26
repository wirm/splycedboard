/**
 * A TV tool: finds one brand's TVs on the network, gets or keeps the key each one needs, lists
 * the ones in the Blueprint configuration Savant runs on this host, and works them like a
 * remote. The Samsung, LG and Sony tools are this, each with its own driver
 * (src/integrations/<brand>tv/driver.js).
 *
 * Settings (data/<id>/settings.json):
 *   tvs  [{ id, name, address, mac, model, year, info, key, keyCheck, extra, blueprint, addedAt, seenAt }]
 *        blueprint: the component it is in Blueprint's configuration, or null
 *
 * A driver has:
 *   brand                    'Samsung'
 *   keyLabel                 what the TV's key is called: 'AccessToken', 'Keycode', 'Pre-Shared Key'
 *   defaultKey               the key a new TV starts with (Sony: Savant's '1234'), or null
 *   scanPorts, ssdpTargets   what marks a device on the network as a candidate
 *   isBlueprintTv(component) whether a component in Blueprint's configuration is one of its TVs
 *   blueprintKey(profileXml) → { variable, fixed }: where that TV's profile keeps the key: in a
 *                            state variable ('AccessToken') or written into the profile ('1234')
 *   probe(address, hint)     → null (not one of its TVs) | { name, model, year, mac, power, info }
 *   pair(tv, { progress })   (optional) has the TV make a key → { key?, extra?, message }
 *   checkKey(tv)             → { ok, message, mac? }
 *   commands(tv)             → the remote's commands this TV takes
 *   command(tv, id, value)   sends one
 *   state(tv)                → { power, volume, mute, source }
 *   warnings(tv)             (optional) → [text]
 *   close(tv), closeAll()    (optional) drop open connections
 */
const crypto = require('crypto');
const express = require('express');

const lan = require('../lan');
const savant = require('../savant');
const { adviceForEmptyScan } = require('../local-network');

const BLUEPRINT_CHECK_MS = 30 * 1000; // how often to look for a newly uploaded configuration
const JOB_KEEP_MS = 10 * 60 * 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const newId = () => crypto.randomBytes(5).toString('hex');
const clientAddress = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

class TvTool {
  constructor(ctx, driver) {
    this.ctx = ctx;
    this.log = ctx.log;
    this.driver = driver;
    this.tvs = new Map(); // id → record
    this.jobs = new Map(); // id → job
    this.blueprint = { found: false, stamp: null, components: [], withoutAddress: [] };
    this.stopped = true;
    this.timer = null;
    this._changeTimer = null;
    this.router = this._routes();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start() {
    this.stopped = false;
    this.tvs = new Map((this.ctx.settings.load().tvs || []).map((r) => [r.id, r]));
    this._importBlueprint();
    this.timer = setInterval(() => this._importBlueprint(), BLUEPRINT_CHECK_MS);
    this.timer.unref?.();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this._changeTimer);
    this._changeTimer = null;
    for (const job of this.jobs.values()) {
      if (job.state === 'running') Object.assign(job, { state: 'failed', message: `${this.ctx.manifest.name} was switched off` });
    }
    try { await this.driver.closeAll?.(); } catch { /* nothing left to close */ }
  }

  status() {
    const tvs = this.list();
    if (!tvs.length) return { level: 'idle', text: 'No TVs yet' };
    const attention = tvs.filter((t) => t.warnings.length).length;
    const count = `${tvs.length} TV${tvs.length === 1 ? '' : 's'}`;
    return attention
      ? { level: 'warn', text: `${count} · ${attention} need${attention === 1 ? 's' : ''} attention` }
      : { level: 'ok', text: count };
  }

  hello() {
    return [{ type: 'tvs', ...this.snapshot() }];
  }

  _assertRunning() {
    if (this.stopped) throw httpError(503, `${this.ctx.manifest.name} is switched off`);
  }

  _save() {
    if (this.stopped) return;
    this.ctx.settings.update((s) => { s.tvs = [...this.tvs.values()]; });
  }

  /** Coalesce bursts of changes into one dashboard update. */
  _changed() {
    if (this.stopped || this._changeTimer) return;
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null;
      this.ctx.broadcast('tvs', this.snapshot());
      this.ctx.statusChanged();
    }, 100);
  }

  // ── The list ───────────────────────────────────────────────────────────────

  _find(id) {
    const tv = this.tvs.get(String(id));
    if (!tv) throw httpError(404, `No ${this.driver.brand} TV "${id}" in the list`);
    return tv;
  }

  /** Is this the TV we already have? Same MAC, or else the same address. */
  _existing({ address, mac }) {
    const m = lan.normalizeMac(mac);
    for (const tv of this.tvs.values()) if (m && tv.mac === m) return tv;
    for (const tv of this.tvs.values()) if (address && tv.address === address) return tv;
    return null;
  }

  warnings(tv) {
    const w = [];
    const bp = tv.blueprint;
    const label = this.driver.keyLabel;
    if (bp?.keyVariable) {
      if (!bp.key) {
        w.push(`No ${label} is stored for "${bp.component}" in Blueprint, so Savant can't control this TV over IP. `
          + `In Blueprint, inspect the TV, show its State Variables and paste the ${label} into ${bp.keyVariable}.`);
      } else if (tv.key && tv.key !== bp.key) {
        w.push(`Blueprint has a different ${label} for "${bp.component}". Savant uses Blueprint's: paste this one into `
          + `${bp.keyVariable} if it's the one that works.`);
      }
    }
    if (tv.keyCheck?.ok === false) w.push(tv.keyCheck.message);
    try {
      w.push(...(this.driver.warnings?.(tv) || []));
    } catch { /* a driver's advice is optional */ }
    return w;
  }

  view(tv) {
    let commands = [];
    try { commands = this.driver.commands(tv); } catch { /* none */ }
    return {
      ...tv,
      warnings: this.warnings(tv),
      commands,
      pairing: [...this.jobs.values()].find((j) => j.kind === 'pair' && j.tvId === tv.id && j.state === 'running') || null,
    };
  }

  list() {
    return [...this.tvs.values()].map((tv) => this.view(tv))
      .sort((a, b) => (a.blueprint?.zone || '~').localeCompare(b.blueprint?.zone || '~') || a.name.localeCompare(b.name));
  }

  snapshot() {
    return {
      tvs: this.list(),
      blueprint: {
        found: this.blueprint.found,
        withoutAddress: this.blueprint.withoutAddress,
      },
    };
  }

  // ── Blueprint ──────────────────────────────────────────────────────────────

  /**
   * Adds the brand's TVs from the configuration Savant runs, with the key Blueprint has for
   * each, and links TVs already in the list to their component. Only re-reads the
   * configuration when it changed, unless `force`.
   */
  _importBlueprint({ force = false } = {}) {
    if (this.stopped) return;
    const stamp = savant.configStamp();
    if (!force && stamp === this.blueprint.stamp) return;

    const config = savant.configuredComponents();
    const components = (config?.components || []).filter((c) => this.driver.isBlueprintTv(c));
    const withAddress = components.filter((c) => lan.isIPv4(c.address) && !c.address.startsWith('127.'));
    this.blueprint = {
      found: Boolean(config),
      stamp,
      components: withAddress,
      withoutAddress: components.filter((c) => !withAddress.includes(c)).map((c) => ({ component: c.name, zone: c.zone, model: c.model })),
    };

    let changed = false;
    const linked = new Set();
    for (const c of withAddress) {
      const profile = savant.componentProfile({ dir: config.dir, manufacturer: c.manufacturer, model: c.model });
      const where = profile ? this.driver.blueprintKey(profile) : { variable: null, fixed: null };
      const key = where.variable ? String(c.variables[where.variable] ?? '').trim() || null : where.fixed;
      const link = {
        component: c.name,
        zone: c.zone,
        manufacturer: c.manufacturer,
        model: c.model,
        keyVariable: where.variable,
        key,
      };

      let tv = [...this.tvs.values()].find((t) => t.blueprint?.component === c.name)
        || this._existing({ address: c.address, mac: c.mac });
      if (!tv) {
        tv = {
          id: newId(),
          name: c.name,
          address: c.address,
          mac: lan.normalizeMac(c.mac),
          model: null,
          year: this.driver.yearFromModel?.(c.model) || null, // until the TV itself says
          info: {},
          key: key || this.driver.defaultKey || null,
          keyCheck: null,
          extra: {},
          blueprint: null,
          addedAt: new Date().toISOString(),
          seenAt: null,
        };
        this.tvs.set(tv.id, tv);
        this.log.info(`Added ${c.name} (${c.address}) from Blueprint's configuration${key ? '' : `, no ${this.driver.keyLabel} stored there`}`);
      }
      // Blueprint's address is the one Savant uses.
      if (tv.address !== c.address) tv.address = c.address;
      if (!tv.mac && c.mac) tv.mac = lan.normalizeMac(c.mac);
      if (!tv.key && key) tv.key = key;
      if (JSON.stringify(tv.blueprint) !== JSON.stringify(link)) {
        tv.blueprint = link;
        changed = true;
      }
      linked.add(tv.id);
    }
    for (const tv of this.tvs.values()) {
      if (tv.blueprint && !linked.has(tv.id)) {
        tv.blueprint = null;
        changed = true;
      }
    }
    if (changed || force) {
      this._save();
      this._changed();
    }
  }

  // ── Scanning ───────────────────────────────────────────────────────────────

  _job(kind, props = {}) {
    for (const [id, j] of this.jobs) {
      if (j.state !== 'running' && Date.now() - Date.parse(j.startedAt) > JOB_KEEP_MS) this.jobs.delete(id);
    }
    const job = { id: newId(), kind, state: 'running', message: '', startedAt: new Date().toISOString(), ...props };
    this.jobs.set(job.id, job);
    return job;
  }

  _update(job, patch) {
    Object.assign(job, patch);
    if (!this.stopped) this.ctx.broadcast('job', { job });
  }

  startScan({ client } = {}) {
    this._assertRunning();
    const running = [...this.jobs.values()].find((j) => j.kind === 'scan' && j.state === 'running');
    if (running) return running;
    const job = this._job('scan', { found: [], hint: null, problem: null, message: 'Looking around the network…' });
    this._scan(job, { client }).catch((err) => {
      this.log.error(`Scan failed: ${err.message}`);
      this._update(job, { state: 'failed', message: err.message });
    });
    return job;
  }

  async _scan(job, { client }) {
    const { driver } = this;
    const [open, answered] = await Promise.all([
      lan.sweep(driver.scanPorts),
      lan.ssdp(driver.ssdpTargets, { timeoutMs: 2500 }),
    ]);
    if (job.state !== 'running') return;
    const candidates = new Map();
    for (const [address, e] of open) candidates.set(address, { ports: e.ports, mac: e.mac });
    for (const [address, e] of answered) candidates.set(address, { ports: [], mac: null, ...candidates.get(address), ssdp: e });
    this._update(job, { message: `Checking ${candidates.size} device${candidates.size === 1 ? '' : 's'}…` });

    await lan.eachLimited([...candidates], 6, async ([address, hint]) => {
      let found = null;
      try {
        found = await driver.probe(address, hint);
      } catch (err) {
        this.log.debug(`${address}: ${err.message}`);
      }
      if (!found || job.state !== 'running') return;
      const mac = lan.normalizeMac(found.mac) || hint.mac || await lan.macAddress(address);
      const known = this._existing({ address, mac });
      job.found.push({ address, mac, ...found, known: known?.id || null });
      job.found.sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }));
      this._update(job, {});
    });
    if (job.state !== 'running') return;

    const n = job.found.length;
    const result = { state: 'done', message: n ? `Found ${n} ${driver.brand} TV${n === 1 ? '' : 's'}` : `No ${driver.brand} TVs found` };
    if (!n) {
      Object.assign(result, await adviceForEmptyScan({
        what: `${driver.brand} TVs`,
        fallback: 'Or add the TV by its IP address.',
        client,
      }));
    }
    this.log.info(`${result.message}${n ? `: ${job.found.map((f) => `${f.name || f.model} (${f.address})`).join(', ')}` : ''}`);
    this._update(job, result);
  }

  // ── Adding, changing, removing ─────────────────────────────────────────────

  async add({ address, name } = {}) {
    this._assertRunning();
    address = String(address || '').trim();
    if (!lan.isIPv4(address)) throw httpError(400, 'Enter the TV\'s IPv4 address, like 192.168.1.50');
    const existing = this._existing({ address });
    if (existing) throw httpError(409, `${existing.name} (${address}) is already in the list`);

    let found = null;
    try {
      found = await this.driver.probe(address, {});
    } catch (err) {
      this.log.debug(`${address}: ${err.message}`);
    }
    const mac = lan.normalizeMac(found?.mac) || await lan.macAddress(address);
    const byMac = mac && this._existing({ mac });
    if (byMac) throw httpError(409, `That's ${byMac.name}, already in the list at ${byMac.address}`);

    const tv = {
      id: newId(),
      name: String(name || '').trim() || found?.name || `${this.driver.brand} TV ${address}`,
      address,
      mac,
      model: found?.model || null,
      year: found?.year || null,
      info: found?.info || {},
      key: this.driver.defaultKey || null,
      keyCheck: null,
      extra: {},
      blueprint: null,
      power: found?.power || null,
      addedAt: new Date().toISOString(),
      seenAt: found ? new Date().toISOString() : null,
    };
    this.tvs.set(tv.id, tv);
    this._save();
    this.log.info(`Added ${tv.name} (${address})${found ? '' : ' — it didn\'t answer yet'}`);
    this._importBlueprint({ force: true }); // it may be one of Blueprint's
    if (tv.key) await this._checkKey(tv).catch(() => {});
    this._changed();
    return this.view(tv);
  }

  async update(id, { name, key, mac } = {}) {
    this._assertRunning();
    const tv = this._find(id);
    if (name !== undefined) {
      const n = String(name).trim();
      if (!n) throw httpError(400, 'Give the TV a name');
      tv.name = n;
    }
    if (mac !== undefined) {
      if (String(mac).trim() === '') tv.mac = null;
      else {
        const m = lan.normalizeMac(mac);
        if (!m) throw httpError(400, `"${mac}" isn't a MAC address`);
        tv.mac = m;
      }
    }
    let keyChanged = false;
    if (key !== undefined) {
      const k = String(key).trim();
      if (k && this.driver.validateKey) {
        const problem = this.driver.validateKey(k);
        if (problem) throw httpError(400, problem);
      }
      keyChanged = (k || null) !== tv.key;
      tv.key = k || null;
      if (keyChanged) {
        tv.keyCheck = null;
        this.driver.close?.(tv);
      }
    }
    this._save();
    if (keyChanged && tv.key) await this._checkKey(tv).catch(() => {});
    this._changed();
    return this.view(tv);
  }

  remove(id) {
    this._assertRunning();
    const tv = this._find(id);
    if (tv.blueprint) throw httpError(409, `${tv.name} is in Blueprint's configuration, so it stays in the list`);
    this.driver.close?.(tv);
    this.tvs.delete(tv.id);
    this._save();
    this._changed();
    this.log.info(`Removed ${tv.name} (${tv.address})`);
  }

  // ── Talking to a TV ────────────────────────────────────────────────────────

  /** Asks the TV again who it is, whether it's on, and whether its key works. */
  async refresh(id) {
    this._assertRunning();
    const tv = this._find(id);
    let found = null;
    try {
      found = await this.driver.probe(tv.address, {});
    } catch (err) {
      this.log.debug(`${tv.address}: ${err.message}`);
    }
    if (found) {
      tv.model = found.model || tv.model;
      tv.year = found.year || tv.year;
      tv.info = { ...tv.info, ...found.info };
      tv.power = found.power || 'on';
      tv.seenAt = new Date().toISOString();
      const mac = lan.normalizeMac(found.mac) || await lan.macAddress(tv.address);
      if (mac) tv.mac = mac;
    } else {
      tv.power = 'unreachable';
    }
    if (found && tv.key) await this._checkKey(tv).catch(() => {});
    this._save();
    this._changed();
    return this.view(tv);
  }

  async refreshAll() {
    await lan.eachLimited([...this.tvs.keys()], 4, (id) => this.refresh(id).catch(() => {}));
    return this.snapshot();
  }

  async _checkKey(tv) {
    const result = await this.driver.checkKey(tv);
    // ok: true / false, or null when the TV couldn't be asked (off, unreachable)
    tv.keyCheck = { ok: typeof result.ok === 'boolean' ? result.ok : null, message: result.message || '', at: new Date().toISOString() };
    const mac = lan.normalizeMac(result.mac);
    if (mac && !tv.mac) tv.mac = mac;
    this._save();
    return tv.keyCheck;
  }

  async checkKey(id) {
    this._assertRunning();
    const tv = this._find(id);
    if (!tv.key && !this.driver.keyOptional) throw httpError(400, `There's no ${this.driver.keyLabel} to test yet`);
    await this._checkKey(tv);
    this._changed();
    return this.view(tv);
  }

  /** Has the TV make a key (the viewer approves it on the TV). A job: it waits on a person. */
  startPairing(id) {
    this._assertRunning();
    if (!this.driver.pair) throw httpError(400, `${this.driver.brand} TVs don't hand out keys; enter it instead`);
    const tv = this._find(id);
    const running = [...this.jobs.values()].find((j) => j.kind === 'pair' && j.tvId === tv.id && j.state === 'running');
    if (running) return running;
    const job = this._job('pair', { tvId: tv.id, message: 'Asking the TV…' });
    this._changed();
    (async () => {
      try {
        const result = await this.driver.pair(tv, { progress: (message) => this._update(job, { message }) });
        if (job.state !== 'running') return;
        if (result.key) {
          tv.key = result.key;
          tv.keyCheck = { ok: true, message: '', at: new Date().toISOString() };
        }
        if (result.extra) tv.extra = { ...tv.extra, ...result.extra };
        this._save();
        this.log.info(`${tv.name}: ${result.message}`);
        this._update(job, { state: 'done', message: result.message, key: result.key || null });
      } catch (err) {
        this.log.warn(`${tv.name}: ${err.message}`);
        this._update(job, { state: 'failed', message: err.message });
      }
      this._changed();
    })();
    return job;
  }

  async command(id, command, value) {
    this._assertRunning();
    const tv = this._find(id);
    if (!this.driver.commands(tv).includes(command)) {
      throw httpError(400, `${tv.name} can't do "${command}" the way it's connected`);
    }
    this.log.debug(`${tv.name}: ${command}${value !== undefined ? ` ${value}` : ''}`);
    try {
      return (await this.driver.command(tv, command, value)) || {};
    } catch (err) {
      throw httpError(err.status || 502, err.message);
    }
  }

  async state(id) {
    this._assertRunning();
    const tv = this._find(id);
    try {
      return await this.driver.state(tv);
    } catch (err) {
      return { power: 'unreachable', error: err.message };
    }
  }

  async wake(id) {
    this._assertRunning();
    const tv = this._find(id);
    if (!tv.mac) throw httpError(400, `${tv.name} has no MAC address yet`);
    const sent = await lan.wake(tv.mac, { address: tv.address });
    this.log.info(`Wake-on-LAN for ${tv.name} (${tv.mac}): ${sent} packets`);
    return { sent };
  }

  // ── HTTP API (/api/<id>) ───────────────────────────────────────────────────

  _routes() {
    const router = express.Router();
    const handle = (fn) => async (req, res) => {
      try {
        res.json(await fn(req));
      } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
      }
    };

    router.get('/tvs', handle(async () => {
      this._assertRunning();
      this._importBlueprint();
      return this.snapshot();
    }));
    router.post('/tvs', handle((req) => this.add(req.body || {})));
    router.put('/tvs/:id', handle((req) => this.update(req.params.id, req.body || {})));
    router.delete('/tvs/:id', handle((req) => {
      this.remove(req.params.id);
      return { ok: true };
    }));
    router.post('/tvs/:id/refresh', handle((req) => this.refresh(req.params.id)));
    router.post('/tvs/:id/check', handle((req) => this.checkKey(req.params.id)));
    router.post('/tvs/:id/pair', handle((req) => this.startPairing(req.params.id)));
    router.post('/tvs/:id/wake', handle((req) => this.wake(req.params.id)));
    router.get('/tvs/:id/state', handle((req) => this.state(req.params.id)));
    router.post('/tvs/:id/command', handle((req) => this.command(req.params.id, String(req.body?.command || ''), req.body?.value)));
    router.post('/refresh', handle(() => {
      this._assertRunning();
      this._importBlueprint({ force: true });
      return this.refreshAll();
    }));
    router.post('/blueprint', handle(() => {
      this._assertRunning();
      this._importBlueprint({ force: true });
      return this.snapshot();
    }));
    router.post('/scan', handle((req) => this.startScan({ client: clientAddress(req) })));
    router.get('/jobs/:id', handle((req) => {
      const job = this.jobs.get(req.params.id);
      if (!job) throw httpError(404, 'That job is gone');
      return job;
    }));
    return router;
  }
}

module.exports = { TvTool };
