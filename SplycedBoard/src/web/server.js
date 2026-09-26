/**
 * Dashboard + API server — port 47200
 *
 *   /                  dashboard (public/)
 *   /ui/<id>/...       an integration's dashboard panel (src/integrations/<id>/ui/)
 *   /api/hub/...       hub management: integrations on/off, profiles, logs, settings, restart,
 *                      updates, and profile-report (called by the Savant profiles themselves)
 *   /api/<id>/...      each integration's own API — answers 503 while the integration is off
 *   /api/...           root paths for integrations with "legacyApiRoot" (the Lutron profile's)
 *   /ws                WebSocket: { source: 'hub' | <id>, type, ... }
 *   /login, /api/auth  the dashboard password (web/access.js): with one set, requests from other
 *                      devices need a login; requests from this Mac itself (Savant) never do
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const logger = require('../core/log');
const paths = require('../core/paths');
const { listen, close } = require('../core/net');
const { zip } = require('../core/zip');
const { readProfile } = require('../core/profiles');
const { AuthStore } = require('../core/auth');
const { createAccess } = require('./access');

const WEB_PORT = Number(process.env.SPLYCEDBOARD_WEB_PORT) || 47200;

const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

// The dashboard marks its requests; browsers also add Origin/Referer, and Sec-Fetch-Mode where
// the page is on https or localhost. Savant's HTTP client sends none of these.
const fromDashboard = (req) => Boolean(req.headers['x-splycedboard-dashboard'] || req.headers['sec-fetch-mode']
  || req.headers.origin || req.headers.referer);

function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/**
 * @param hub       core/hub Hub, already load()ed
 * @param app       { name, version, runtime, managed, startedAt, restart() }
 * @param updates   core/updates Updater (optional: no update API without it)
 * @param auth      core/auth AuthStore (default: data/auth.json)
 * @param trustLocal  requests from this Mac need no password (tests turn it off)
 */
async function createWebServer({ hub, port = WEB_PORT, app: appInfo, updates = null, auth = null, trustLocal = true }) {
  const log = logger.createLogger('web');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // ── The password: before anything else is served ───────────────────────────
  const access = createAccess({
    store: auth || new AuthStore(path.join(paths.DATA_DIR, 'auth.json')),
    trustLocal,
    publicDir: paths.PUBLIC_DIR,
    log,
  });
  app.use(access.middleware);
  app.get('/login', access.loginPage);
  app.use('/api/auth', access.router);

  app.use(express.static(paths.PUBLIC_DIR));

  // ── Integration dashboard panels ───────────────────────────────────────────
  for (const { id } of hub.list()) {
    app.use(`/ui/${id}`, express.static(path.join(paths.INTEGRATIONS_DIR, id, 'ui')));
  }

  // ── Requests from Savant that fail ─────────────────────────────────────────
  // A profile calling a path that doesn't exist, or a report being refused, would otherwise
  // go unnoticed. Logged once per caller and path every 10 minutes.
  const rejectedLogged = new Map();
  app.use('/api', (req, res, next) => {
    if (!fromDashboard(req)) {
      res.on('finish', () => {
        if (res.statusCode < 400 || res.statusCode === 503) return; // 503: integration switched off, shown elsewhere
        const key = `${clientIp(req)} ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode}`;
        if (Date.now() - (rejectedLogged.get(key) || 0) < 10 * 60 * 1000) return;
        rejectedLogged.set(key, Date.now());
        log.warn(`${clientIp(req)} called ${req.method} ${req.originalUrl} and got HTTP ${res.statusCode}`);
      });
    }
    next();
  });

  // ── Hub API ────────────────────────────────────────────────────────────────
  const api = express.Router();

  const snapshot = (req) => ({
    auth: access.describe(req),
    app: {
      name: appInfo.name,
      version: appInfo.version,
      runtime: appInfo.runtime,
      managed: appInfo.managed,
      pid: process.pid,
      startedAt: appInfo.startedAt,
      hostname: os.hostname(),
      addresses: lanAddresses(),
      port,
      dirs: { app: paths.APP_DIR, home: paths.HOME_DIR, data: paths.DATA_DIR, logs: paths.LOG_DIR },
    },
    settings: hub.getSettings(),
    integrations: hub.list(),
    update: updates ? updates.status() : null,
  });

  api.get('/', (req, res) => res.json(snapshot(req)));

  // Called by the Savant profiles' ReportProfileVersion action (see core/profiles.js).
  api.get('/profile-report', (req, res) => {
    const integration = String(req.query.integration || '');
    const version = String(req.query.version || '');
    if (!hub.profiles.has(integration)) {
      return res.status(404).json({ error: `No integration "${integration}" with a Savant profile` });
    }
    if (!/^\d+(\.\d+)*$/.test(version)) return res.status(400).json({ error: 'version (like 1.12) required' });
    const device = String(req.query.device || '') || clientIp(req);
    const state = hub.profiles.report(integration, device, version);
    log.debug(`${device} reports ${integration} profile ${version} (${state})`);
    res.json({ ok: true, state, shipped: hub.profiles.summary(integration).version });
  });

  if (updates) {
    // Expected failures (offline, nothing newer, already updating) carry a status: answer
    // them with the updater's state rather than logging them as server errors.
    const updateAction = (fn) => async (req, res, next) => {
      try {
        res.json(await fn());
      } catch (err) {
        if (!err.status) return next(err);
        res.status(err.status).json({ error: err.message, update: updates.status() });
      }
    };
    api.get('/update', (req, res) => res.json(updates.status()));
    api.get('/update/log', (req, res) => res.type('text/plain').send(updates.logTail()));
    api.post('/update/check', updateAction(() => updates.check()));
    api.post('/update/install', updateAction(() => updates.install()));
  }

  api.put('/integrations/:id', async (req, res, next) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (true/false) required' });
    try {
      res.json(await hub.setEnabled(req.params.id, enabled));
    } catch (err) {
      next(err);
    }
  });

  api.post('/integrations/:id/restart', async (req, res, next) => {
    try {
      res.json(await hub.restart(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // A zip holding "<profile> <version>/<profile>.xml": a browser renames a second download to
  // "… (1)", and Blueprint only finds a profile under its exact file name. Unzipped, the file
  // inside keeps it. ?format=xml: the bare file.
  api.get('/integrations/:id/profile', (req, res, next) => {
    try {
      const { profile } = hub.describe(req.params.id);
      const file = profile && path.join(paths.PROFILES_DIR, profile);
      if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'This integration has no Savant profile' });
      if (req.query.format === 'xml') return res.download(file, profile);
      const { version } = readProfile(file);
      const folder = `${profile.replace(/\.xml$/, '')}${version ? ` ${version}` : ''}`;
      const archive = zip([
        { name: `${folder}/`, data: '' },
        { name: `${folder}/${profile}`, data: fs.readFileSync(file), date: fs.statSync(file).mtime },
      ]);
      res.attachment(`${folder}.zip`);
      res.type('application/zip').send(archive);
    } catch (err) {
      next(err);
    }
  });

  api.get('/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);
    res.json({ entries: logger.recent(limit) });
  });

  api.put('/settings', (req, res) => res.json(hub.updateSettings(req.body || {})));

  api.post('/restart', (req, res) => {
    if (!appInfo.managed) {
      return res.status(409).json({ error: 'Not running as a background service — restart it from the terminal.' });
    }
    res.json({ ok: true });
    setTimeout(() => appInfo.restart(), 300);
  });

  const notFound = (req, res) => res.status(404).json({ error: `No API at ${req.originalUrl}` });
  api.use(notFound);
  app.use('/api/hub', api);

  // ── Integration APIs ───────────────────────────────────────────────────────
  // Resolved per request so enabling/disabling takes effect immediately.
  // `fallthrough` is only used by the legacy root mount, where unmatched paths
  // must reach the final 404 rather than stop here.
  const integrationApi = (id, { fallthrough = false } = {}) => (req, res, next) => {
    // Savant calling the integration: lets the hub notice a profile too old to report its
    // version. Keyed like the profile's reports: by the Apple TV address in ?ip=, else by the
    // calling host.
    if (!fromDashboard(req)) {
      res.on('finish', () => {
        if (res.statusCode < 400) hub.profiles.traffic(id, String(req.query.ip || '') || clientIp(req));
      });
    }
    const instance = hub.instance(id);
    if (!instance) {
      const { name, enabled } = hub.describe(id);
      return res.status(503).json({ error: enabled ? `${name} is not running` : `${name} is disabled` });
    }
    const done = fallthrough ? next : () => notFound(req, res);
    if (!instance.router) return done();
    instance.router(req, res, done);
  };

  // /api/hub and every /api/<id> always answer (200/404/503), so the legacy root
  // mount only ever sees paths nobody else owns — e.g. /api/zone/level from the
  // Lutron profile.
  const integrations = hub.list();
  for (const { id } of integrations) app.use(`/api/${id}`, integrationApi(id));
  for (const { id, legacyApiRoot } of integrations) {
    if (legacyApiRoot) app.use('/api', integrationApi(id, { fallthrough: true }));
  }

  app.use('/api', notFound);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log.error(`${req.method} ${req.originalUrl}:`, err);
    res.status(status).json({ error: err.message });
  });

  // ── HTTP + WebSocket ───────────────────────────────────────────────────────
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, path: '/ws', verifyClient: ({ req }) => access.allowUpgrade(req) });

  const broadcast = (msg) => {
    if (!wss.clients.size) return;
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  };
  const integrationsMessage = () => ({ source: 'hub', type: 'integrations', integrations: hub.list() });

  wss.on('connection', (ws) => {
    ws.on('error', () => {});
    ws.send(JSON.stringify(integrationsMessage()));
    for (const msg of hub.hello()) ws.send(JSON.stringify(msg));
  });

  // Status changes tend to arrive in bursts (connect → ready); send one update per burst.
  let changeTimer = null;
  const onChange = () => {
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      broadcast(integrationsMessage());
    }, 50);
  };
  const onMessage = (msg) => broadcast(msg);
  const onUpdate = (update) => broadcast({ source: 'hub', type: 'update', update });
  hub.on('change', onChange);
  hub.on('message', onMessage);
  updates?.on('change', onUpdate);
  const stopLogFeed = logger.onEntry((entry) => broadcast({ source: 'hub', type: 'log', entry }));

  await listen(server, port);
  log.info(`Dashboard at http://localhost:${port}`);

  return {
    server,
    async close() {
      hub.off('change', onChange);
      hub.off('message', onMessage);
      updates?.off('change', onUpdate);
      stopLogFeed();
      clearTimeout(changeTimer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections?.(); // don't wait on idle keep-alive connections
      await close(server);
    },
  };
}

module.exports = { createWebServer, WEB_PORT };
