/**
 * Apple TV HTTP API — mounted at /api/appletv.
 *
 * Savant profile endpoints (GET; `ip` = the Apple TV's IP, from the component's
 * AppleTVAddress state variable):
 *   cmd?ip&cmd[&action=press|hold|double][&seconds]   remote buttons, transport, power
 *   status?ip        → { power: ON|OFF|UNKNOWN, playing, connected, name } (strings, for Savant)
 *   app?ip&id        launch an app by bundle id (com.netflix.Netflix) or URL
 *   apps?ip          → [{ bundleId, name }]
 *   pair/start?ip    · pair/finish?ip&pin               pairing without the dashboard
 *
 * Dashboard endpoints:
 *   GET devices · GET discover · GET probe?ip
 *   POST pair/start { ip, port?, name? } · POST pair/finish { ip, pin } · POST pair/cancel { ip }
 *   PATCH devices/:id { name?, address? } · DELETE devices/:id
 *   POST devices/:id/cmd { cmd, action? } · POST devices/:id/app { id } · GET devices/:id/apps
 */
const express = require('express');

const { COMMANDS } = require('./device');
const { scan, probe } = require('./discovery');

// Savant action names and other spellings → our command names
const ALIASES = {
  osdcursorup: 'up',
  osdcursordown: 'down',
  osdcursorleft: 'left',
  osdcursorright: 'right',
  ok: 'select',
  enter: 'select',
  exit: 'menu',
  commandplay: 'play',
  commandpause: 'pause',
  commandstop: 'stop',
  commandskipup: 'next',
  commandskipdown: 'previous',
  commandscanup: 'skipforward',
  commandscandown: 'skipbackward',
  on: 'poweron',
  wake: 'poweron',
  off: 'poweroff',
  sleep: 'poweroff',
  repeatstop: 'release',
};

function commandName(raw) {
  const key = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  const cmd = ALIASES[key] || key;
  if (!COMMANDS.includes(cmd)) {
    throw Object.assign(new Error(`Unknown command "${raw}". Known: ${COMMANDS.join(', ')}`), { status: 400 });
  }
  return cmd;
}

const ACTIONS = new Set(['press', 'hold', 'double']);

function createRoutes(atv) {
  const router = express.Router();
  const log = atv.log;

  const handle = (fn) => async (req, res) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (err) {
      const status = err.status || 502;
      if (status >= 500) log.warn(`${req.method} ${req.originalUrl}: ${err.message}`);
      if (!res.headersSent) res.status(status).json({ error: err.message });
    }
  };

  const options = (src) => {
    const action = String(src.action || 'press').toLowerCase();
    if (!ACTIONS.has(action)) throw Object.assign(new Error('action must be press, hold or double'), { status: 400 });
    return { action, seconds: src.seconds };
  };

  // ── Savant profile ─────────────────────────────────────────────────────────

  router.get('/cmd', handle(async (req) => {
    const device = atv.find(req.query.ip);
    await device.run(commandName(req.query.cmd), options(req.query));
  }));

  // Polled by the profile: keep it instant — never wait on the Apple TV here.
  router.get('/status', handle(async (req) => {
    const d = atv.find(req.query.ip).snapshot();
    return {
      name: d.name,
      power: d.power === 'unknown' ? 'UNKNOWN' : d.power.toUpperCase(),
      playing: String(d.playing === true),
      connected: String(d.connection === 'connected'),
      state: d.attention,
    };
  }));

  router.get('/app', handle(async (req) => {
    if (!req.query.id) throw Object.assign(new Error('id required (e.g. com.netflix.Netflix)'), { status: 400 });
    await atv.find(req.query.ip).launch(String(req.query.id));
  }));

  router.get('/apps', handle(async (req) => atv.find(req.query.ip).apps()));

  router.get('/pair/start', handle((req) => atv.startPairing({ address: req.query.ip, name: req.query.name })));
  router.get('/pair/finish', handle((req) => atv.finishPairing({ address: req.query.ip, pin: req.query.pin })));

  // ── Dashboard ──────────────────────────────────────────────────────────────

  router.get('/devices', handle(async () => ({ devices: atv.list(), commands: COMMANDS })));

  router.get('/discover', handle(async (req) => {
    const timeoutMs = Math.min(parseInt(req.query.timeout, 10) || 4000, 15000);
    const found = await scan({ timeoutMs });
    const paired = new Set(atv.list().map((d) => d.address));
    return { appleTvs: found.map((tv) => ({ ...tv, paired: paired.has(tv.address) })) };
  }));

  router.get('/probe', handle(async (req) => {
    const found = await probe(String(req.query.ip || ''));
    if (!found) throw Object.assign(new Error(`No Apple TV answered at ${req.query.ip}`), { status: 404 });
    return found;
  }));

  router.post('/pair/start', handle((req) => atv.startPairing({
    address: req.body?.ip, host: req.body?.host, port: req.body?.port, name: req.body?.name,
  })));
  router.post('/pair/finish', handle((req) => atv.finishPairing({ address: req.body?.ip, pin: req.body?.pin })));
  router.post('/pair/cancel', handle(async (req) => ({ cancelled: atv.cancelPairing(String(req.body?.ip || '')) })));

  router.patch('/devices/:id', handle((req) => atv.updateDevice(req.params.id, req.body || {})));
  router.delete('/devices/:id', handle(async (req) => {
    await atv.removeDevice(req.params.id);
  }));

  router.post('/devices/:id/cmd', handle(async (req) => {
    await atv.find(req.params.id).run(commandName(req.body?.cmd), options(req.body || {}));
  }));
  router.post('/devices/:id/app', handle(async (req) => {
    if (!req.body?.id) throw Object.assign(new Error('id required'), { status: 400 });
    await atv.find(req.params.id).launch(String(req.body.id));
  }));
  router.get('/devices/:id/apps', handle(async (req) => atv.find(req.params.id).apps()));

  return router;
}

module.exports = { createRoutes, commandName };
