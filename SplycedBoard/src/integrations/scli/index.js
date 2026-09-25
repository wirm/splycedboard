/**
 * SCLI Bridge integration — see sclibridge.js for the wire protocol.
 *
 * Settings (data/scli/settings.json, all optional):
 *   sclibridgePath   explicit path to the sclibridge binary
 *   clientPort       default 12000
 *   savantPort       default 12001
 */
const express = require('express');

const { ScliBridge, CLIENT_PORT, SAVANT_PORT } = require('./sclibridge');

class ScliIntegration {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log;
    this.bridge = null;
    this.router = this._routes();
  }

  async start() {
    const s = this.ctx.settings.load();
    this.bridge = new ScliBridge({
      log: this.log,
      clientPort: s.clientPort || CLIENT_PORT,
      savantPort: s.savantPort || SAVANT_PORT,
      scliPath: s.sclibridgePath || null,
    });
    this.bridge.onChange = () => {
      this.ctx.broadcast('status', this.bridge.status());
      this.ctx.statusChanged();
    };
    await this.bridge.start();
  }

  async stop() {
    if (!this.bridge) return;
    await this.bridge.stop();
    this.bridge = null;
  }

  status() {
    const s = this.bridge.status();
    if (!s.scliFound) return { level: 'error', text: 'sclibridge not found — is this the Savant Pro Host?' };
    if (s.savantConnected) return { level: 'ok', text: `Savant connected (${s.savantAddr})` };
    return { level: 'warn', text: `Listening on ${s.clientPort} — waiting for Savant on ${s.savantPort}` };
  }

  hello() {
    return [{ type: 'status', ...this.bridge.status() }];
  }

  _routes() {
    const router = express.Router();

    router.get('/status', (req, res) => res.json(this.bridge.status()));

    router.post('/exec', async (req, res) => {
      const { command } = req.body || {};
      if (!command) return res.status(400).json({ error: 'command required' });
      const output = await this.bridge.run(command);
      if (output === null) return res.status(400).json({ error: 'unrecognised command' });
      res.json({ output });
    });

    return router;
  }
}

module.exports = {
  create: (ctx) => new ScliIntegration(ctx),
};
