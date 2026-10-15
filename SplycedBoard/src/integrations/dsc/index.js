/**
 * DSC PowerSeries Pro (and Neo) over ITv2, DSC's third-party integration protocol, through the
 * panel's IP communicator. A proof of concept: the dashboard arms, disarms and shows zones;
 * there's no Savant profile yet.
 *
 * Everything lives in this folder (itv2/ is the protocol, panel.js what's known about the
 * panel, ui/ the dashboard page). To remove the integration: delete this folder, its line in
 * src/integrations/index.js, docs/dsc.md, and test/dsc*.test.js with test/support/mock-dsc.js;
 * on a host, data/dsc/ holds its settings.
 *
 * The panel's communicator dials SplycedBoard: it's programmed with this host's IP and port as
 * its integration server. Settings (data/dsc/settings.json):
 *   port            where SplycedBoard listens for it (default 3072, the communicator's default)
 *   integrationId   the communicator's integration identification number, section [422]
 *   accessCode      the integration access code: 8 hex digits (type 1) or 32 (type 2); never
 *                   sent back to the dashboard
 */
const express = require('express');

const { PanelState } = require('./panel');
const { Itv2Session, DEFAULT_PORT, validateCredentials } = require('./itv2/session');

const MAX_MESSAGES = 1000;

class DscIntegration {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log;
    this.panel = new PanelState();
    this.session = null;
    this.messages = [];
    this.panelTimer = null;
    this.panel.on('change', () => this._panelChanged());
    this.router = this._routes();
  }

  async start() {
    await this._startSession();
  }

  async stop() {
    clearTimeout(this.panelTimer);
    this.panelTimer = null;
    if (this.session) await this.session.stop();
    this.session = null;
  }

  status() {
    if (!this.session) return { level: 'idle', text: 'Not set up' };
    const s = this.session.status();
    return { level: s.level, text: s.text };
  }

  hello() {
    return [
      { type: 'status', status: this._status() },
      { type: 'panel', panel: this.panel.snapshot() },
    ];
  }

  // ── Session ──────────────────────────────────────────────────────────────

  async _startSession() {
    const settings = this.ctx.settings.load();
    this.session = new Itv2Session({
      log: this.log,
      panel: this.panel,
      port: settings.port || DEFAULT_PORT,
      integrationId: settings.integrationId || '',
      accessCode: settings.accessCode || '',
      onStatus: () => {
        this.ctx.broadcast('status', { status: this._status() });
        this.ctx.statusChanged();
      },
      onMessage: (m) => this._message(m),
    });
    await this.session.start();
  }

  _status() {
    return this.session ? this.session.status() : { level: 'idle', text: 'Not set up', connected: false };
  }

  _message(m) {
    const entry = { t: Date.now(), ...m };
    this.messages.push(entry);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.ctx.broadcast('message', { message: entry });
  }

  /** Coalesces a burst of updates (a status answer touches every zone) into one broadcast. */
  _panelChanged() {
    if (this.panelTimer) return;
    this.panelTimer = setTimeout(() => {
      this.panelTimer = null;
      this.ctx.broadcast('panel', { panel: this.panel.snapshot() });
    }, 150);
  }

  _publicSettings() {
    const s = this.ctx.settings.load();
    return {
      port: s.port || null,
      defaultPort: DEFAULT_PORT,
      integrationId: s.integrationId || '',
      accessCodeSet: Boolean(s.accessCode),
      accessCodeHint: s.accessCode ? `Saved: ${s.accessCode.length} hex digits (type ${s.accessCode.length === 32 ? 2 : 1})` : 'Not set',
    };
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  _routes() {
    const router = express.Router();
    const handle = (fn) => async (req, res) => {
      try {
        res.json(await fn(req));
      } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
      }
    };
    const bad = (message) => Object.assign(new Error(message), { status: 400 });
    const partitionOf = (body) => {
      const n = Number(body?.partition);
      if (!Number.isInteger(n) || n < 1 || n > 32) throw bad('partition must be 1–32');
      return n;
    };
    const codeOf = (body) => {
      const code = String(body?.code || '');
      if (!/^(\d{4}|\d{6}|\d{8})$/.test(code)) throw bad('Enter the 4-, 6- or 8-digit user code');
      return code;
    };
    const connected = () => {
      if (!this.session?.status().connected) throw Object.assign(new Error('The panel is not connected'), { status: 409 });
      return this.session;
    };

    router.get('/state', handle(() => ({
      status: this._status(),
      settings: this._publicSettings(),
      panel: this.panel.snapshot(),
    })));

    router.put('/settings', handle(async (req) => {
      const b = req.body || {};
      const current = this.ctx.settings.load();
      const next = {
        port: b.port == null || b.port === '' ? null : Number(b.port),
        integrationId: String(b.integrationId ?? current.integrationId ?? '').trim().toUpperCase(),
        accessCode: b.accessCode != null && b.accessCode !== '' ? String(b.accessCode).replace(/\s+/g, '').toUpperCase() : current.accessCode || '',
      };
      if (next.port != null && !(Number.isInteger(next.port) && next.port > 0 && next.port < 65536)) throw bad('Port must be 1–65535');
      const problem = validateCredentials(next.integrationId, next.accessCode);
      if (problem) throw bad(problem);
      this.ctx.settings.save(next);
      this.log.info(`Settings saved (port ${next.port || DEFAULT_PORT}); restarting the session`);
      await this.stop();
      await this._startSession();
      this.ctx.statusChanged();
      return { settings: this._publicSettings() };
    }));

    router.post('/arm', handle(async (req) => {
      const mode = String(req.body?.mode || '');
      if (!['away', 'stay', 'night'].includes(mode)) throw bad('mode must be away, stay or night');
      return { result: await connected().arm(partitionOf(req.body), mode, codeOf(req.body)) };
    }));

    router.post('/disarm', handle(async (req) => ({
      result: await connected().disarm(partitionOf(req.body), codeOf(req.body)),
    })));

    router.post('/refresh', handle(async () => {
      await connected().refresh();
      return { ok: true };
    }));

    router.get('/messages', handle(() => ({ messages: this.messages })));
    router.delete('/messages', handle(() => {
      this.messages = [];
      return { ok: true };
    }));

    return router;
  }
}

module.exports = { create: (ctx) => new DscIntegration(ctx) };
