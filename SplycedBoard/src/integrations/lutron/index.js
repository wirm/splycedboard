/**
 * Lutron LEAP integration.
 *
 * Owns the LEAP connection to one HomeWorks QSX / RadioRA 3 processor and exposes it
 * to Savant two ways: the HTTP endpoints in routes.js (used by the Savant profile, which
 * polls feedback.js for the levels that changed) and the HomeWorks QS–style telnet bridge
 * on port 8023.
 *
 * Settings (data/lutron/settings.json):
 *   processor      { id, host, name, pairedAt, port? }   written by pairing
 *   componentName  Blueprint component name, used by the lighting export
 *   telnetPort     override for the telnet bridge port (default 8023)
 */
const path = require('path');

const { LeapController } = require('./controller');
const { TelnetBridge, TELNET_PORT } = require('./telnet-bridge');
const { ZoneFeedback } = require('./feedback');
const { CertStore } = require('./certs');
const { pairWithProcessor } = require('./pairing');
const { migrateLegacyConfig } = require('./legacy-config');
const { createRoutes } = require('./routes');

class LutronIntegration {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log;
    this.settings = ctx.settings;
    this.certs = new CertStore(path.join(ctx.dataDir, 'certs'));
    this.controller = null;
    this.telnet = new TelnetBridge({
      log: ctx.log.child('telnet'),
      getController: () => this.controller,
    });
    this.feedback = new ZoneFeedback({ getController: () => this.controller });
    this.router = createRoutes(this);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start() {
    migrateLegacyConfig({ settings: this.settings, certDir: this.certs.dir, log: this.log });

    this.telnet.port = this.settings.load().telnetPort || TELNET_PORT;
    await this.telnet.start();

    const processor = this.processor();
    if (!processor) {
      this.log.info('No processor paired yet — open the dashboard to pair one.');
    } else if (!this.certs.has(processor.id)) {
      this.log.warn(`Certificates for ${processor.host} are missing — pair again from the dashboard.`);
    } else {
      this.connect();
    }
  }

  async stop() {
    this.pairing?.abort();
    this._disconnect();
    await this.telnet.stop();
  }

  // ── Processor connection ───────────────────────────────────────────────────

  processor() {
    return this.settings.load().processor || null;
  }

  /** (Re)connect to the paired processor, replacing any existing controller. */
  connect() {
    const processor = this.processor();
    if (!processor) throw Object.assign(new Error('Not paired'), { status: 400 });
    const certs = this.certs.load(processor.id);
    if (!certs) throw Object.assign(new Error('No certificates found. Please pair first.'), { status: 400 });

    this._disconnect();
    const controller = new LeapController(processor.host, certs, { port: processor.port, log: this.log });
    this.controller = controller;
    this._wire(controller);
    controller.connect();
    this.ctx.statusChanged();
    return controller;
  }

  _wire(controller) {
    const { broadcast, statusChanged } = this.ctx;
    const connectionChanged = () => {
      broadcast('status', this.connectionState());
      statusChanged();
    };

    controller.on('connect', connectionChanged);
    controller.on('disconnect', connectionChanged);
    controller.on('ready', () => {
      this.log.info(`Ready — ${controller.zones.size} zones, ${controller.buttonGroups.size} keypads, `
        + `${controller.virtualButtons.size} scenes, ${controller.thermostats.size} thermostats`);
      this.telnet.sendInitialState();
      this.feedback.resyncAll();
      connectionChanged();
    });

    controller.on('zoneUpdate', ({ zone }) => {
      this.telnet.zoneChanged(zone);
      this.feedback.zoneChanged(zone.id);
      broadcast('zoneUpdate', { zone });
    });
    controller.on('ledUpdate', (e) => {
      this.telnet.ledChanged(e.ledHref, e.state);
      broadcast('ledUpdate', e);
    });
    controller.on('thermostatUpdate', ({ thermostat }) => broadcast('thermostatUpdate', { thermostat }));
    controller.on('buttonEvent', (e) => broadcast('buttonEvent', e));
  }

  _disconnect() {
    if (!this.controller) return;
    this.controller.destroy();
    this.controller = null;
    this.ctx.broadcast('status', this.connectionState());
  }

  async pair(host, name) {
    // Clicking Pair again replaces an attempt still waiting for pairing mode.
    this.pairing?.abort();
    const pairing = new AbortController();
    this.pairing = pairing;
    this.log.info(`Pairing with ${host}...`);
    let result;
    try {
      result = await pairWithProcessor(host, name || 'Savant Bridge', { log: this.log.child('pairing'), signal: pairing.signal });
    } finally {
      if (this.pairing === pairing) this.pairing = null;
    }

    const processorId = host.replace(/[^a-zA-Z0-9]/g, '-');
    this.certs.save(processorId, result);
    this.settings.update((s) => {
      s.processor = { id: processorId, host, name: name || host, pairedAt: new Date().toISOString() };
    });

    this.log.info(`Paired with ${host}`);
    this.ctx.statusChanged();
    return { processorId };
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  connectionState() {
    const c = this.controller;
    return { connected: !!c?.client.connected, ready: !!c?.ready };
  }

  /** Shape of GET /api/lutron/status (unchanged from the standalone bridge). */
  connectionDetails() {
    const processor = this.processor();
    return {
      paired: !!processor,
      processor,
      ...this.connectionState(),
      bridgePort: this.telnet.port,
      webPort: Number(process.env.SPLYCEDBOARD_WEB_PORT) || 47200,
      feedbackFrom: this.feedback.activeHosts(),
    };
  }

  status() {
    const p = this.processor();
    if (!p) return { level: 'idle', text: 'Not paired — open Lutron LEAP to pair a processor' };
    const c = this.controller;
    const label = p.name && p.name !== p.host ? `${p.name} (${p.host})` : p.host;
    if (!c && !this.certs.has(p.id)) return { level: 'error', text: `Certificates for ${label} are missing — pair again` };
    if (c?.ready) return { level: 'ok', text: `Connected to ${label} · ${c.zones.size} zones` };
    if (c?.client.connected) return { level: 'warn', text: `Loading inventory from ${label}…` };
    return { level: 'warn', text: `Connecting to ${label}…` };
  }

  hello() {
    return [{ type: 'status', ...this.connectionState() }];
  }
}

module.exports = {
  create: (ctx) => new LutronIntegration(ctx),
};
