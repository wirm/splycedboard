/**
 * Web UI + REST API + WebSocket server — port 47200
 *
 * Endpoints:
 *  GET  /api/status              → connection status, config summary
 *  GET  /api/discover            → trigger mDNS scan, return found processors
 *  POST /api/pair                → initiate cert pairing with a processor
 *  POST /api/connect             → connect to paired processor
 *  GET  /api/inventory           → zones, areas, devices, button groups, scenes
 *  POST /api/zone/:id/level      → { level, fade, delay }
 *  POST /api/zone/:id/raise
 *  POST /api/zone/:id/lower
 *  POST /api/zone/:id/stop
 *  POST /api/area/:id/level      → { level, fade, delay }
 *  POST /api/scene/:id/recall
 *  POST /api/button/:href/press  → href is base64-encoded LEAP href
 *  POST /api/button/:href/release
 *
 * WebSocket (ws://host:47200/ws):
 *  Server → Client:
 *    { type: 'zoneUpdate', zone }
 *    { type: 'buttonEvent', buttonHref, event }
 *    { type: 'ledUpdate', ledHref, state }
 *    { type: 'status', connected, ready }
 */
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const { discoverProcessors } = require('../discovery');
const { pairWithProcessor } = require('../pairing');
const config = require('../config');
const scli = require('../scli/bridge');

function rgbToHsvWeb(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
  }
  return { hue: h, saturation: max ? Math.round((d / max) * 100) : 0 };
}

const WEB_PORT = 47200;

function createWebServer(controllerHolder) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  // ── Helpers ────────────────────────────────────────────────────────────────

  function ctrl() {
    return controllerHolder.controller;
  }

  function wsClients() {
    return controllerHolder.wsClients || new Set();
  }

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of wsClients()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  // Wire controller events → WebSocket broadcasts
  controllerHolder.onControllerChange = (controller) => {
    controller.on('zoneUpdate', ({ zone }) => broadcast({ type: 'zoneUpdate', zone }));
    controller.on('thermostatUpdate', ({ thermostat }) => broadcast({ type: 'thermostatUpdate', thermostat }));
    controller.on('buttonEvent', (e) => broadcast({ type: 'buttonEvent', ...e }));
    controller.on('ledUpdate', (e) => broadcast({ type: 'ledUpdate', ...e }));
    controller.on('connect', () => broadcast({ type: 'status', connected: true, ready: false }));
    controller.on('disconnect', () => broadcast({ type: 'status', connected: false, ready: false }));
    controller.on('ready', () => broadcast({ type: 'status', connected: true, ready: true }));
  };

  // ── Status ─────────────────────────────────────────────────────────────────

  app.get('/api/status', (req, res) => {
    const cfg = config.load();
    const c = ctrl();
    res.json({
      paired: !!cfg.processor,
      processor: cfg.processor || null,
      connected: c?.client?.connected || false,
      ready: c?.ready || false,
      bridgePort: 8023,
      webPort: WEB_PORT,
    });
  });

  // ── Discovery ──────────────────────────────────────────────────────────────

  app.get('/api/discover', async (req, res) => {
    try {
      const timeout = parseInt(req.query.timeout) || 8000;
      console.log(`[web] Starting discovery (${timeout}ms)...`);
      const processors = await discoverProcessors(timeout);
      res.json({ processors });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Pairing ────────────────────────────────────────────────────────────────

  app.post('/api/pair', async (req, res) => {
    const { host, name } = req.body;
    if (!host) return res.status(400).json({ error: 'host required' });

    try {
      console.log(`[web] Pairing with ${host}...`);
      const result = await pairWithProcessor(host, name || 'Savant Bridge');

      // Generate a stable ID for this processor
      const processorId = host.replace(/[^a-zA-Z0-9]/g, '-');
      config.saveCerts(processorId, result);

      const cfg = config.load();
      cfg.processor = { id: processorId, host, name: name || host, pairedAt: new Date().toISOString() };
      config.save(cfg);

      console.log(`[web] Paired successfully with ${host}`);
      res.json({ success: true, processorId, message: 'Paired successfully' });
    } catch (err) {
      console.error('[web] Pairing failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Connect ────────────────────────────────────────────────────────────────

  app.post('/api/connect', async (req, res) => {
    const cfg = config.load();
    if (!cfg.processor) return res.status(400).json({ error: 'Not paired' });

    try {
      await controllerHolder.reconnect();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Inventory ──────────────────────────────────────────────────────────────

  app.get('/api/inventory', (req, res) => {
    const c = ctrl();
    if (!c || !c.ready) return res.status(503).json({ error: 'Not connected' });
    res.json(c.getInventory());
  });

  // ── Profile GET endpoints (used by HTTP Savant profile on port 47200) ────────
  // These mirror the POST endpoints below but accept query-string params so
  // Savant's http_request_type="GET" profile actions can call them.

  // Read-only zone status for Savant QueryDimmerLevel polling
  app.get('/api/zone/query', (req, res) => {
    const c = ctrl(); if (!c) return res.sendStatus(503);
    const id = parseInt(req.query.id);
    const zone = c.zones?.get(id);
    if (!zone) return res.status(404).json({ error: `Zone ${id} not found` });
    res.json({ level: Math.round(zone.level ?? 0) });
  });

  app.get('/api/zone/level', async (req, res) => {
    const c = ctrl(); if (!c) return res.sendStatus(503);
    const id = parseInt(req.query.id), level = parseFloat(req.query.level) ?? 0;
    const fade = req.query.fade !== undefined ? parseFloat(req.query.fade) : undefined;
    try { await c.setZoneLevel(id, level, fade); res.send('OK'); }
    catch (e) { res.status(500).send(e.message); }
  });

  app.get('/api/zone/raise',  async (req, res) => { const c = ctrl(); if (!c) return res.sendStatus(503); try { await c.raiseZone(parseInt(req.query.id));  res.send('OK'); } catch (e) { res.status(500).send(e.message); } });
  app.get('/api/zone/lower',  async (req, res) => { const c = ctrl(); if (!c) return res.sendStatus(503); try { await c.lowerZone(parseInt(req.query.id));  res.send('OK'); } catch (e) { res.status(500).send(e.message); } });
  app.get('/api/zone/stop',   async (req, res) => { const c = ctrl(); if (!c) return res.sendStatus(503); try { await c.stopZone(parseInt(req.query.id));   res.send('OK'); } catch (e) { res.status(500).send(e.message); } });

  app.get('/api/area/level', async (req, res) => {
    const c = ctrl(); if (!c) return res.sendStatus(503);
    const id = parseInt(req.query.id), level = parseFloat(req.query.level) ?? 0;
    const fade = req.query.fade !== undefined ? parseFloat(req.query.fade) : undefined;
    try { await c.setAreaLevel(id, level, fade); res.send('OK'); }
    catch (e) { res.status(500).send(e.message); }
  });

  app.get('/api/shade/level', async (req, res) => {
    const c = ctrl(); if (!c) return res.sendStatus(503);
    const id = parseInt(req.query.id), level = parseFloat(req.query.level) ?? 0;
    const delay = req.query.delay !== undefined ? parseFloat(req.query.delay) : undefined;
    try { await c.setZoneLevel(id, level, undefined, delay); res.send('OK'); }
    catch (e) { res.status(500).send(e.message); }
  });

  app.get('/api/shade/raise', async (req, res) => { const c = ctrl(); if (!c) return res.sendStatus(503); try { await c.raiseZone(parseInt(req.query.id));  res.send('OK'); } catch (e) { res.status(500).send(e.message); } });
  app.get('/api/shade/lower', async (req, res) => { const c = ctrl(); if (!c) return res.sendStatus(503); try { await c.lowerZone(parseInt(req.query.id));  res.send('OK'); } catch (e) { res.status(500).send(e.message); } });
  app.get('/api/shade/stop',  async (req, res) => { const c = ctrl(); if (!c) return res.sendStatus(503); try { await c.stopZone(parseInt(req.query.id));   res.send('OK'); } catch (e) { res.status(500).send(e.message); } });

  app.get('/api/scene/recall', async (req, res) => {
    const c = ctrl(); if (!c) return res.sendStatus(503);
    try { await c.pressVirtualButton(parseInt(req.query.id)); res.send('OK'); }
    catch (e) { res.status(500).send(e.message); }
  });

  // action = press | release | pressrelease | hold
  app.get('/api/button', async (req, res) => {
    const c = ctrl(); if (!c) return res.sendStatus(503);
    const { device, num, action = 'press' } = req.query;
    const deviceId = parseInt(device), btnNum = parseInt(num);
    const href = c.buttonGroups && (() => {
      for (const bg of c.buttonGroups.values()) {
        if (bg.deviceId === deviceId) {
          const b = bg.buttons.find(b => b.number === btnNum);
          if (b) return b.href;
        }
      }
    })();
    if (!href) return res.status(404).send('Button not found');
    try {
      if (action === 'press')        { await c.pressButton(href); }
      else if (action === 'release') { await c.releaseButton(href); }
      else if (action === 'hold')    { await c.pressButton(href); }
      else { // pressrelease
        await c.pressButton(href);
        await new Promise(r => setTimeout(r, 100));
        await c.releaseButton(href);
      }
      res.send('OK');
    } catch (e) { res.status(500).send(e.message); }
  });

  // ── Zone Control ───────────────────────────────────────────────────────────

  app.post('/api/zone/:id/level', async (req, res) => {
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    try {
      const { level, fade, delay } = req.body;
      await c.setZoneLevel(parseInt(req.params.id), level ?? 0, fade, delay);
      res.json({ success: true });
    } catch (err) {
      console.error(`[web] setLevel zone ${req.params.id} failed:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/zone/:id/raise', async (req, res) => {
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    try {
      await c.raiseZone(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/zone/:id/lower', async (req, res) => {
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    try {
      await c.lowerZone(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/zone/:id/stop', async (req, res) => {
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    try {
      await c.stopZone(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/zone/:id/spectrum', async (req, res) => {
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    try {
      await c.setZoneSpectrum(parseInt(req.params.id), req.body);
      res.json({ success: true });
    } catch (err) {
      console.error(`[web] spectrum zone ${req.params.id} failed:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Area Control ───────────────────────────────────────────────────────────

  app.post('/api/area/:id/level', async (req, res) => {
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    try {
      const { level, fade, delay } = req.body;
      await c.setAreaLevel(parseInt(req.params.id), level ?? 0, fade, delay);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Scene Recall ───────────────────────────────────────────────────────────

  app.post('/api/scene/:id/recall', async (req, res) => {
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    try {
      await c.pressVirtualButton(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Button Press ───────────────────────────────────────────────────────────

  app.post('/api/button/press', async (req, res) => {
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    try {
      const { href } = req.body;
      await c.pressButton(href);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/button/release', async (req, res) => {
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    try {
      const { href } = req.body;
      await c.releaseButton(href);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── HTTP Color Wheel (for HTTP profile — bleColor args that TCP can't carry) ─

  // GET /api/color?id=12640&level=93&r=0&g=75&b=238&w=0&fade=0.5
  app.get('/api/color', async (req, res) => {
    console.log(`\x1b[35m[http ←]\x1b[0m GET /api/color raw query: ${JSON.stringify(req.query)}`);
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    const id    = parseInt(req.query.id);
    const level = parseFloat(req.query.level) || 0;
    const r     = parseInt(req.query.r)  || 0;
    const g     = parseInt(req.query.g)  || 0;
    const b     = parseInt(req.query.b)  || 0;
    const w     = parseInt(req.query.w)  || 0;
    const fade  = req.query.fade !== undefined ? parseFloat(req.query.fade) : undefined;
    console.log(`\x1b[35m[http ←]\x1b[0m color id=${id} level=${level} r=${r} g=${g} b=${b} w=${w} fade=${fade}`);
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const zone = c.zones?.get(id);
      const effectiveLevel = level > 0 ? level : Math.round(zone?.level ?? 100);
      if (r || g || b || w) {
        const { hue, saturation } = rgbToHsvWeb(r, g, b);
        await c.setZoneSpectrum(id, { level: effectiveLevel, hue, saturation });
      } else {
        console.log(`\x1b[35m[http ←]\x1b[0m color r/g/b/w all zero — falling back to setZoneLevel`);
        await c.setZoneLevel(id, effectiveLevel, fade);
      }
      res.json({ ok: true, id, level: effectiveLevel });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/cct?id=12640&level=50&fade=0.5   (0=warmest ~1400K, 100=coolest ~10000K)
  app.get('/api/cct', async (req, res) => {
    console.log(`\x1b[35m[http ←]\x1b[0m GET /api/cct raw query: ${JSON.stringify(req.query)}`);
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    const id    = parseInt(req.query.id);
    const level = parseFloat(req.query.level) ?? 50;
    const fade  = req.query.fade !== undefined ? parseFloat(req.query.fade) : undefined;
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const kelvin = Math.round(1400 + (level / 100) * (10000 - 1400));
      await c.setZoneSpectrum(id, { colorTemp: kelvin, warmDim: true, fade });
      res.json({ ok: true, id, kelvin });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── HVAC / Thermostat ─────────────────────────────────────────────────────

  app.get('/api/hvac/status', (req, res) => {
    const c = ctrl(); if (!c) return res.sendStatus(503);
    const id = parseInt(req.query.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const t = c.thermostats?.get(id);
    if (!t) return res.status(404).json({ error: `Thermostat ${id} not found` });
    res.json({
      id: t.id, name: t.name, areaName: t.areaName,
      temperature:    t.temperature    != null ? String(Math.round(t.temperature))    : '--',
      heatSetpoint:   t.heatSetpoint   != null ? String(Math.round(t.heatSetpoint))   : '--',
      coolSetpoint:   t.coolSetpoint   != null ? String(Math.round(t.coolSetpoint))   : '--',
      mode:           t.mode           || 'Off',
      fanMode:        t.fanMode        || 'Auto',
      operatingState: t.operatingState || 'Idle',
    });
  });

  app.get('/api/hvac/heat', async (req, res) => {
    const c = ctrl(); if (!c) return res.sendStatus(503);
    const id = parseInt(req.query.id);
    const setpoint = parseFloat(req.query.setpoint);
    if (!id || isNaN(setpoint)) return res.status(400).json({ error: 'id and setpoint required' });
    try { await c.setHeatSetpoint(id, setpoint); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/hvac/cool', async (req, res) => {
    const c = ctrl(); if (!c) return res.sendStatus(503);
    const id = parseInt(req.query.id);
    const setpoint = parseFloat(req.query.setpoint);
    if (!id || isNaN(setpoint)) return res.status(400).json({ error: 'id and setpoint required' });
    try { await c.setCoolSetpoint(id, setpoint); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/hvac/mode', async (req, res) => {
    const c = ctrl(); if (!c) return res.sendStatus(503);
    const id = parseInt(req.query.id);
    const { mode } = req.query;
    if (!id || !mode) return res.status(400).json({ error: 'id and mode required' });
    try { await c.setHvacMode(id, mode); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/hvac/fan', async (req, res) => {
    const c = ctrl(); if (!c) return res.sendStatus(503);
    const id = parseInt(req.query.id);
    const { mode } = req.query;
    if (!id || !mode) return res.status(400).json({ error: 'id and mode required' });
    try { await c.setFanMode(id, mode); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── SCLI Bridge ───────────────────────────────────────────────────────────

  app.get('/api/scli/status', (req, res) => {
    res.json(scli.getStatus());
  });

  app.post('/api/scli/exec', async (req, res) => {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });
    const result = await scli.dispatch(command);
    if (result === null) return res.status(400).json({ error: 'unrecognised command' });
    res.json({ output: result });
  });

  // ── Config (UI-editable settings) ────────────────────────────────────────

  app.get('/api/config', (req, res) => {
    const cfg = config.load();
    res.json({ componentName: cfg.componentName || '' });
  });

  app.post('/api/config', (req, res) => {
    const cfg = config.load();
    if (req.body.componentName !== undefined) cfg.componentName = req.body.componentName;
    config.save(cfg);
    res.json({ ok: true });
  });

  // ── Lighting Export (Savant Blueprint lighting table plist) ───────────────

  app.get('/api/export/lighting', (req, res) => {
    const c = ctrl();
    if (!c || !c.ready) return res.status(503).json({ error: 'Not connected' });
    const cfg = config.load();
    const comp = cfg.componentName || 'LutronLeapBridge';

    const EXPORT_TYPES = new Set(['dimmer', 'switch', 'fan', 'ketra', 'rania']);
    const zones = Array.from(c.zones.values()).filter(z => EXPORT_TYPES.has(z.type));

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Derived from real export: ketra/rania use Entity "DMX" + stateName "CurrentColor"
    function meta(type) {
      if (type === 'ketra') return { entity: 'DMX',    stateName: 'CurrentColor', typeLabel: 'RGBW', cmd: 'DimmerSet', group: 'Dimmer' };
      if (type === 'rania') return { entity: 'DMX',    stateName: 'CurrentColor', typeLabel: 'CCT',  cmd: 'DimmerSet', group: 'Dimmer' };
      if (type === 'fan')   return { entity: 'Fan',    stateName: 'DimmerLevel',  typeLabel: 'Fan',  cmd: 'FanSet',    group: 'Fan'    };
      if (type === 'switch') return { entity: 'Switch', stateName: 'DimmerLevel',  typeLabel: 'W',    cmd: 'DimmerSet', group: 'Dimmer' };
      return                        { entity: 'Dimmer', stateName: 'DimmerLevel',  typeLabel: 'W',    cmd: 'DimmerSet', group: 'Dimmer' };
    }

    const UMF = `\t\t\t<dict>
\t\t\t\t<key>Address1</key>
\t\t\t\t<true/>
\t\t\t\t<key>Command</key>
\t\t\t\t<false/>
\t\t\t\t<key>Command Type</key>
\t\t\t\t<false/>
\t\t\t\t<key>Controller</key>
\t\t\t\t<true/>
\t\t\t\t<key>Controller Zone</key>
\t\t\t\t<true/>
\t\t\t\t<key>DelayTime</key>
\t\t\t\t<false/>
\t\t\t\t<key>DimmerLevel</key>
\t\t\t\t<false/>
\t\t\t\t<key>Entity</key>
\t\t\t\t<true/>
\t\t\t\t<key>FadeTime</key>
\t\t\t\t<false/>
\t\t\t\t<key>IsSceneable</key>
\t\t\t\t<false/>
\t\t\t\t<key>Label</key>
\t\t\t\t<true/>
\t\t\t\t<key>LightsAreOn</key>
\t\t\t\t<false/>
\t\t\t\t<key>RoomLightsControl</key>
\t\t\t\t<false/>
\t\t\t\t<key>SavantAppGrouping</key>
\t\t\t\t<false/>
\t\t\t\t<key>State1</key>
\t\t\t\t<false/>
\t\t\t\t<key>State2</key>
\t\t\t\t<false/>
\t\t\t\t<key>Type</key>
\t\t\t\t<true/>
\t\t\t\t<key>UI Type</key>
\t\t\t\t<false/>
\t\t\t\t<key>WholeHouseLightsControl</key>
\t\t\t\t<false/>
\t\t\t</dict>`;

    function stateDict(comp, zoneId, stateName) {
      const rpm = `${esc(comp)}.Lighting_controller.${stateName}_${zoneId}`;
      return `\t\t\t<dict>
\t\t\t\t<key>RPMStateName</key>
\t\t\t\t<string>${rpm}</string>
\t\t\t\t<key>RPMStateType</key>
\t\t\t\t<string>RPMComponentBasedStateName</string>
\t\t\t\t<key>component</key>
\t\t\t\t<string>${esc(comp)}</string>
\t\t\t\t<key>identifiers</key>
\t\t\t\t<array>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>description</key>
\t\t\t\t\t\t<string></string>
\t\t\t\t\t\t<key>name</key>
\t\t\t\t\t\t<string>DeviceID</string>
\t\t\t\t\t\t<key>value</key>
\t\t\t\t\t\t<string>${zoneId}</string>
\t\t\t\t\t</dict>
\t\t\t\t</array>
\t\t\t\t<key>logicalComponent</key>
\t\t\t\t<string>Lighting_controller</string>
\t\t\t\t<key>stateName</key>
\t\t\t\t<string>${stateName}</string>
\t\t\t</dict>`;
    }

    const entries = zones.map((zone, i) => {
      const { entity, stateName, typeLabel, cmd, group } = meta(zone.type);
      const sd = stateDict(comp, zone.id, stateName);
      return `\t\t<dict>
\t\t\t<key>Address1</key>
\t\t\t<string>${zone.id}</string>
\t\t\t<key>Address2</key>
\t\t\t<string></string>
\t\t\t<key>Address3</key>
\t\t\t<string></string>
\t\t\t<key>Address4</key>
\t\t\t<string></string>
\t\t\t<key>Address5</key>
\t\t\t<string></string>
\t\t\t<key>Address6</key>
\t\t\t<string></string>
\t\t\t<key>BLEGroupId</key>
\t\t\t<string></string>
\t\t\t<key>BLENetworkKey</key>
\t\t\t<string></string>
\t\t\t<key>BLENodeId</key>
\t\t\t<string></string>
\t\t\t<key>Button Label</key>
\t\t\t<string>${esc(zone.name)}</string>
\t\t\t<key>Command</key>
\t\t\t<string>${cmd}</string>
\t\t\t<key>Command Type</key>
\t\t\t<string>Push Command</string>
\t\t\t<key>Controller</key>
\t\t\t<string>${esc(comp)}</string>
\t\t\t<key>Controller Zone</key>
\t\t\t<string>${esc(zone.areaName)}</string>
\t\t\t<key>DelayTime</key>
\t\t\t<string>0</string>
\t\t\t<key>DimmerLevel</key>
\t\t\t<string></string>
\t\t\t<key>Enabled</key>
\t\t\t<string>YES</string>
\t\t\t<key>Entity</key>
\t\t\t<string>${entity}</string>
\t\t\t<key>FadeTime</key>
\t\t\t<string>2</string>
\t\t\t<key>Identifier</key>
\t\t\t<string>${i}</string>
\t\t\t<key>IsSceneable</key>
\t\t\t<true/>
\t\t\t<key>Label</key>
\t\t\t<string>${esc(zone.name)}</string>
\t\t\t<key>LightsAreOn</key>
\t\t\t<true/>
\t\t\t<key>Logical Component</key>
\t\t\t<string>Lighting_controller</string>
\t\t\t<key>RoomLightsControl</key>
\t\t\t<string>Active</string>
\t\t\t<key>Savant Keypad</key>
\t\t\t<string></string>
\t\t\t<key>Savant Zone</key>
\t\t\t<dict>
\t\t\t\t<key>${esc(zone.areaName)}</key>
\t\t\t\t<true/>
\t\t\t</dict>
\t\t\t<key>SavantAppGrouping</key>
\t\t\t<string>${group}</string>
\t\t\t<key>ServiceID</key>
\t\t\t<string>SVC_ENV_LIGHTING</string>
\t\t\t<key>State1</key>
${sd}
\t\t\t<key>State2</key>
${sd}
\t\t\t<key>Technology</key>
\t\t\t<string></string>
\t\t\t<key>Toggle Label</key>
\t\t\t<string></string>
\t\t\t<key>Type</key>
\t\t\t<string>${typeLabel}</string>
\t\t\t<key>UI Type</key>
\t\t\t<string>Slider</string>
\t\t\t<key>UMF</key>
${UMF}
\t\t\t<key>WholeHouseLightsControl</key>
\t\t\t<string>Active</string>
\t\t\t<key>hasCompiled</key>
\t\t\t<true/>
\t\t\t<key>maxKelvinTemp</key>
\t\t\t<string></string>
\t\t\t<key>minKelvinTemp</key>
\t\t\t<string></string>
\t\t\t<key>sendReleaseAfterHold</key>
\t\t\t<true/>
\t\t\t<key>shouldDefaultRow</key>
\t\t\t<true/>
\t\t</dict>`;
    });

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Lighting</key>
\t<array>
${entries.join('\n')}
\t</array>
</dict>
</plist>`;

    res.setHeader('Content-Type', 'application/x-plist');
    res.setHeader('Content-Disposition', 'attachment; filename="lighting_export.plist"');
    res.send(plist);
  });

  // ── Debug ─────────────────────────────────────────────────────────────────
  app.get('/api/debug/leap', async (req, res) => {
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url query param required' });
    try {
      const resp = await c.client.request('ReadRequest', url);
      res.json(resp);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST body: { url, body, method? } — sends a LEAP request and returns raw response
  app.post('/api/debug/leap', async (req, res) => {
    const c = ctrl();
    if (!c) return res.status(503).json({ error: 'Not connected' });
    const { url, body, method = 'CreateRequest' } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    try {
      const resp = await c.client.request(method, url, body);
      res.json(resp);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── HTTP + WebSocket Server ────────────────────────────────────────────────

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, path: '/ws' });

  controllerHolder.wsClients = new Set();

  wss.on('connection', (ws) => {
    controllerHolder.wsClients.add(ws);

    // Send current status on connect
    const c = ctrl();
    ws.send(JSON.stringify({
      type: 'status',
      connected: c?.client?.connected || false,
      ready: c?.ready || false,
    }));

    ws.on('close', () => controllerHolder.wsClients.delete(ws));
    ws.on('error', () => controllerHolder.wsClients.delete(ws));
  });

  server.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`[web] UI available at http://localhost:${WEB_PORT}`);
  });

  return server;
}

module.exports = { createWebServer, WEB_PORT };
