/**
 * Dashboard + API server — port 47200
 *
 *   /                  dashboard (public/)
 *   /ui/<id>/...       an integration's dashboard panel (src/integrations/<id>/ui/)
 *   /api/hub/...       hub management: integrations on/off, profiles, logs, settings, restart
 *   /api/<id>/...      each integration's own API — answers 503 while the integration is off
 *   /api/...           legacy paths for integrations with "legacyApiRoot" (Lutron profile ≤ v1.11)
 *   /ws                WebSocket: { source: 'hub' | <id>, type, ... }
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

const WEB_PORT = Number(process.env.SPLYCEDBOARD_WEB_PORT) || 47200;

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
 * @param hub   core/hub Hub, already load()ed
 * @param app   { name, version, runtime, managed, startedAt, restart() }
 */
async function createWebServer({ hub, port = WEB_PORT, app: appInfo }) {
  const log = logger.createLogger('web');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(express.static(paths.PUBLIC_DIR));

  // ── Integration dashboard panels ───────────────────────────────────────────
  for (const { id } of hub.list()) {
    app.use(`/ui/${id}`, express.static(path.join(paths.INTEGRATIONS_DIR, id, 'ui')));
  }

  // ── Hub API ────────────────────────────────────────────────────────────────
  const api = express.Router();

  const snapshot = () => ({
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
  });

  api.get('/', (req, res) => res.json(snapshot()));

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

  api.get('/integrations/:id/profile', (req, res, next) => {
    try {
      const { profile } = hub.describe(req.params.id);
      const file = profile && path.join(paths.PROFILES_DIR, profile);
      if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'This integration has no Savant profile' });
      res.download(file, profile);
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
  // mount only ever sees paths nobody else owns — e.g. /api/zone/level from
  // Lutron profiles ≤ v1.11.
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
  const wss = new WebSocket.Server({ server, path: '/ws' });

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
  hub.on('change', onChange);
  hub.on('message', onMessage);
  const stopLogFeed = logger.onEntry((entry) => broadcast({ source: 'hub', type: 'log', entry }));

  await listen(server, port);
  log.info(`Dashboard at http://localhost:${port}`);

  return {
    server,
    async close() {
      hub.off('change', onChange);
      hub.off('message', onMessage);
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
