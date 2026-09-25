/**
 * Lutron HTTP API — mounted at /api/lutron (and at /api for profiles ≤ v1.11).
 *
 * Savant profile endpoints (GET + query string, called by lutron_leap_bridge.xml):
 *   zone/query?id                     → { level }   (QueryDimmerLevel polling)
 *   zone/level?id&level[&fade]         zone/raise|lower|stop?id
 *   area/level?id&level[&fade]
 *   shade/level?id&level[&delay]       shade/raise|lower|stop?id
 *   scene/recall?id
 *   button?device&num&action=press|release|hold|pressrelease
 *   color?id&level&r&g&b&w[&fade]      cct?id&level[&fade]
 *   hvac/status?id                     hvac/heat|cool?id&setpoint    hvac/mode|fan?id&mode
 *
 * Dashboard endpoints:
 *   GET  status | inventory | discover | config | export/lighting | debug/leap
 *   POST pair | connect | config | debug/leap
 *   POST zone/:id/level|raise|lower|stop|spectrum   area/:id/level   scene/:id/recall
 *   POST button/press|release  { href }
 *
 * Note: fade/delay are accepted for compatibility but not yet sent to the processor.
 */
const express = require('express');

const { discoverProcessors } = require('./discovery');
const { buildLightingPlist } = require('./blueprint-export');
const { rgbToHsv, cctLevelToKelvin } = require('./color');

const DEFAULT_COMPONENT_NAME = 'LutronLeapBridge';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function int(value, name) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) throw httpError(400, `${name} required`);
  return n;
}

function num(value, name) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) throw httpError(400, `${name} required`);
  return n;
}

function createRoutes(lutron) {
  const router = express.Router();
  const log = lutron.log;

  /** Run `fn(controller, req, res)`; its return value (or { ok: true }) becomes the JSON body. */
  const withController = (fn) => async (req, res) => {
    const controller = lutron.controller;
    if (!controller) return res.status(503).json({ error: 'Lutron processor not connected' });
    try {
      const result = await fn(controller, req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error(`${req.method} ${req.originalUrl}: ${err.message}`);
      if (!res.headersSent) res.status(status).json({ error: err.message });
    }
  };

  /** Same, for handlers that don't need the processor. */
  const handle = (fn) => async (req, res) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error(`${req.method} ${req.originalUrl}: ${err.message}`);
      if (!res.headersSent) res.status(status).json({ error: err.message });
    }
  };

  // ── Setup: status, discovery, pairing ──────────────────────────────────────

  router.get('/status', (req, res) => res.json(lutron.connectionDetails()));

  router.get('/discover', handle(async (req) => {
    const timeout = parseInt(req.query.timeout, 10) || 8000;
    log.info(`Scanning for processors (${timeout}ms)...`);
    return { processors: await discoverProcessors(timeout, { log: log.child('discovery') }) };
  }));

  router.post('/pair', handle(async (req) => {
    const { host, name } = req.body || {};
    if (!host) throw httpError(400, 'host required');
    const { processorId } = await lutron.pair(host, name);
    return { success: true, processorId, message: 'Paired successfully' };
  }));

  router.post('/connect', handle(async () => {
    lutron.connect();
    return { success: true };
  }));

  router.get('/inventory', (req, res) => {
    const c = lutron.controller;
    if (!c?.ready) return res.status(503).json({ error: 'Not connected' });
    res.json(c.getInventory());
  });

  router.get('/config', (req, res) => {
    res.json({ componentName: lutron.settings.load().componentName || '' });
  });

  router.post('/config', handle(async (req) => {
    const { componentName } = req.body || {};
    if (componentName !== undefined) lutron.settings.update((s) => { s.componentName = String(componentName); });
    return { ok: true };
  }));

  router.get('/export/lighting', withController((c, req, res) => {
    if (!c.ready) throw httpError(503, 'Not connected');
    const component = lutron.settings.load().componentName || DEFAULT_COMPONENT_NAME;
    res.setHeader('Content-Type', 'application/x-plist');
    res.setHeader('Content-Disposition', 'attachment; filename="lighting_export.plist"');
    res.send(buildLightingPlist(c.zones.values(), component));
  }));

  // ── Savant profile: zones, areas, shades ───────────────────────────────────

  // Polled by Savant every few seconds per load — keep it cheap and quiet.
  router.get('/zone/query', withController((c, req) => {
    const id = int(req.query.id, 'id');
    const zone = c.zones.get(id);
    if (!zone) throw httpError(404, `Zone ${id} not found`);
    return { level: Math.round(zone.level ?? 0) };
  }));

  router.get('/zone/level', withController((c, req) => (
    c.setZoneLevel(int(req.query.id, 'id'), num(req.query.level, 'level')).then(() => null)
  )));
  router.get('/zone/raise', withController((c, req) => c.raiseZone(int(req.query.id, 'id')).then(() => null)));
  router.get('/zone/lower', withController((c, req) => c.lowerZone(int(req.query.id, 'id')).then(() => null)));
  router.get('/zone/stop', withController((c, req) => c.stopZone(int(req.query.id, 'id')).then(() => null)));

  router.get('/area/level', withController((c, req) => (
    c.setAreaLevel(int(req.query.id, 'id'), num(req.query.level, 'level')).then(() => null)
  )));

  router.get('/shade/level', withController((c, req) => (
    c.setZoneLevel(int(req.query.id, 'id'), num(req.query.level, 'level')).then(() => null)
  )));
  router.get('/shade/raise', withController((c, req) => c.raiseZone(int(req.query.id, 'id')).then(() => null)));
  router.get('/shade/lower', withController((c, req) => c.lowerZone(int(req.query.id, 'id')).then(() => null)));
  router.get('/shade/stop', withController((c, req) => c.stopZone(int(req.query.id, 'id')).then(() => null)));

  router.get('/scene/recall', withController((c, req) => c.pressVirtualButton(int(req.query.id, 'id')).then(() => null)));

  // ── Savant profile: keypad buttons ─────────────────────────────────────────

  router.get('/button', withController(async (c, req) => {
    const { device, num: buttonNum, action = 'press' } = req.query;
    const href = c.findButtonHref(int(device, 'device'), int(buttonNum, 'num'));
    if (!href) throw httpError(404, 'Button not found');

    if (action === 'press' || action === 'hold') await c.pressButton(href);
    else if (action === 'release') await c.releaseButton(href);
    else {
      await c.pressButton(href); // pressrelease
      await new Promise((r) => setTimeout(r, 100));
      await c.releaseButton(href);
    }
  }));

  // ── Savant profile: color (HTTP carries the bleColor args that TCP can't) ──

  // GET color?id=12640&level=93&r=0&g=75&b=238&w=0&fade=0.5
  router.get('/color', withController(async (c, req) => {
    const id = int(req.query.id, 'id');
    const level = parseFloat(req.query.level) || 0;
    const [r, g, b, w] = ['r', 'g', 'b', 'w'].map((k) => parseInt(req.query[k], 10) || 0);
    log.debug(`← color id=${id} level=${level} r=${r} g=${g} b=${b} w=${w}`);

    if (r || g || b || w) {
      // Color wheel: level 0 is Savant's "keep the current brightness" sentinel.
      const zone = c.zones.get(id);
      const effectiveLevel = level > 0 ? level : Math.round(zone?.level ?? 100);
      const { hue, saturation } = rgbToHsv(r, g, b);
      await c.setZoneSpectrum(id, { level: effectiveLevel, hue, saturation });
      return { ok: true, id, level: effectiveLevel };
    }

    // No color values: a plain dimmer command, where 0 means off.
    await c.setZoneLevel(id, level);
    return { ok: true, id, level };
  }));

  // GET cct?id=12640&level=50   (0 = warmest 1400 K, 100 = coolest 10000 K)
  router.get('/cct', withController(async (c, req) => {
    const id = int(req.query.id, 'id');
    const kelvin = cctLevelToKelvin(num(req.query.level, 'level'));
    await c.setZoneSpectrum(id, { colorTemp: kelvin, warmDim: true });
    return { ok: true, id, kelvin };
  }));

  // ── Savant profile: thermostats ────────────────────────────────────────────

  router.get('/hvac/status', withController((c, req) => {
    const id = int(req.query.id, 'id');
    const t = c.thermostats.get(id);
    if (!t) throw httpError(404, `Thermostat ${id} not found`);
    const whole = (v) => (v != null ? String(Math.round(v)) : '--');
    return {
      id: t.id,
      name: t.name,
      areaName: t.areaName,
      temperature: whole(t.temperature),
      heatSetpoint: whole(t.heatSetpoint),
      coolSetpoint: whole(t.coolSetpoint),
      mode: t.mode || 'Off',
      fanMode: t.fanMode || 'Auto',
      operatingState: t.operatingState || 'Idle',
    };
  }));

  router.get('/hvac/heat', withController((c, req) => (
    c.setHeatSetpoint(int(req.query.id, 'id'), num(req.query.setpoint, 'setpoint')).then(() => null)
  )));
  router.get('/hvac/cool', withController((c, req) => (
    c.setCoolSetpoint(int(req.query.id, 'id'), num(req.query.setpoint, 'setpoint')).then(() => null)
  )));
  router.get('/hvac/mode', withController((c, req) => {
    if (!req.query.mode) throw httpError(400, 'mode required');
    return c.setHvacMode(int(req.query.id, 'id'), req.query.mode).then(() => null);
  }));
  router.get('/hvac/fan', withController((c, req) => {
    if (!req.query.mode) throw httpError(400, 'mode required');
    return c.setFanMode(int(req.query.id, 'id'), req.query.mode).then(() => null);
  }));

  // ── Dashboard controls ─────────────────────────────────────────────────────

  router.post('/zone/:id/level', withController((c, req) => (
    c.setZoneLevel(int(req.params.id, 'id'), req.body?.level ?? 0).then(() => ({ success: true }))
  )));
  router.post('/zone/:id/raise', withController((c, req) => c.raiseZone(int(req.params.id, 'id')).then(() => ({ success: true }))));
  router.post('/zone/:id/lower', withController((c, req) => c.lowerZone(int(req.params.id, 'id')).then(() => ({ success: true }))));
  router.post('/zone/:id/stop', withController((c, req) => c.stopZone(int(req.params.id, 'id')).then(() => ({ success: true }))));
  router.post('/zone/:id/spectrum', withController((c, req) => (
    c.setZoneSpectrum(int(req.params.id, 'id'), req.body || {}).then(() => ({ success: true }))
  )));

  router.post('/area/:id/level', withController((c, req) => (
    c.setAreaLevel(int(req.params.id, 'id'), req.body?.level ?? 0).then(() => ({ success: true }))
  )));

  router.post('/scene/:id/recall', withController((c, req) => (
    c.pressVirtualButton(int(req.params.id, 'id')).then(() => ({ success: true }))
  )));

  router.post('/button/press', withController((c, req) => c.pressButton(req.body?.href).then(() => ({ success: true }))));
  router.post('/button/release', withController((c, req) => c.releaseButton(req.body?.href).then(() => ({ success: true }))));

  // ── Debug: raw LEAP requests ───────────────────────────────────────────────

  router.get('/debug/leap', withController((c, req) => {
    if (!req.query.url) throw httpError(400, 'url query param required');
    return c.client.request('ReadRequest', req.query.url);
  }));

  // body: { url, body, method? }
  router.post('/debug/leap', withController((c, req) => {
    const { url, body, method = 'CreateRequest' } = req.body || {};
    if (!url) throw httpError(400, 'url required');
    return c.client.request(method, url, body);
  }));

  return router;
}

module.exports = { createRoutes };
