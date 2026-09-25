/**
 * Lutron HTTP API — mounted at /api/lutron (and at /api for profiles ≤ v1.11).
 *
 * Savant profile endpoints (GET + query string, called by the Lutron LEAP Bridge profile):
 *   feedback[?start=1]                → the levels and LEDs that changed (feedback.js), polled twice a second
 *   zone/query?id                     → { zone, level }   (QueryDimmerLevel, when Savant starts)
 *   zone/level?id&level[&fade]         zone/raise|lower|stop?id
 *   area/level?id&level[&fade]
 *   shade/level?id&level[&delay]       shade/raise|lower|stop?id
 *   scene/recall?id
 *   button?device&num&action=press|release|hold|pressrelease
 *   color?id&level&r&g&b&w[&fade]      cct?id&level[&fade]
 *   hvac/status?id                     hvac/heat|cool?id&setpoint    hvac/mode|fan?id&mode
 *
 * Dashboard endpoints:
 *   GET  status | inventory | discover | config | export/lighting[?keypads=1] | debug/leap
 *   POST pair | connect | config | debug/leap
 *   POST zone/:id/level|raise|lower|stop|spectrum   area/:id/level   scene/:id/recall
 *   POST button/press|release  { href }
 *
 * Note: fade/delay are accepted for compatibility but not yet sent to the processor.
 */
const express = require('express');

const { discoverProcessors } = require('./discovery');
const { buildLightingPlist, isLighting } = require('./blueprint-export');
const { buildRooms, overrideFor, normalize } = require('./rooms');
const { savantZones, runningConfig } = require('../../core/savant');
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

const clientAddress = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

/**
 * Keypad buttons for the lighting export, by area, keypad and position. Each goes in the
 * Savant zones its Lutron area's lights went in (Rooms tab), or else under the area's name.
 */
function exportedKeypadButtons(controller, rooms) {
  const zonesOfArea = new Map(rooms.areas.map((a) => [a.areaId, Object.keys(a.zones || {})]));
  const out = [];
  for (const bg of controller.getInventory().buttonGroups) {
    if (bg.deviceId == null) continue;
    const areaId = controller.devices.get(bg.deviceId)?.areaId;
    for (const b of bg.buttons) {
      if (b.number == null) continue;
      out.push({
        keypad: bg.deviceName,
        // The button's own name, as engraved: "All Lights", "Raise"
        label: b.role === 'raise' ? 'Raise' : b.role === 'lower' ? 'Lower' : (b.engraving || b.name),
        deviceId: bg.deviceId,
        number: b.number,
        ledId: b.ledId,
        areaName: bg.areaName,
        savantZones: zonesOfArea.get(areaId) || [],
      });
    }
  }
  return out.sort((a, b) => a.areaName.localeCompare(b.areaName) || a.keypad.localeCompare(b.keypad) || a.number - b.number);
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
    // The dashboard's own address is a host certainly on the network: it helps tell "found
    // nothing" apart from "not allowed onto the network".
    return discoverProcessors(timeout, { log: log.child('discovery'), client: clientAddress(req) });
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

  /**
   * The Lutron component's name in Blueprint, which the lighting export's rows point at:
   * typed on the Setup tab, else read from the configuration Savant is running (the component
   * using the LEAP Bridge profile), else the default.
   */
  function controllerName() {
    const typed = lutron.settings.load().componentName;
    if (typed) return { name: typed, source: 'typed', found: foundController() };
    const found = foundController();
    return found ? { name: found, source: 'blueprint', found } : { name: DEFAULT_COMPONENT_NAME, source: 'default', found: null };
  }

  // The Lutron LEAP Bridge component in the configuration Savant runs: by manufacturer and model
  // where zoneConfig.xml can be read; else (SavantOS 11 keeps it to Savant) as the component
  // with this profile's own state variables, SystemType and FadeTime.
  function foundController() {
    const config = runningConfig();
    const byModel = (config?.components || []).find((c) => /lutron/i.test(c.manufacturer) && normalize(c.model) === 'leap bridge' && c.name);
    if (byModel) return byModel.name;
    const byVariables = Object.entries(config?.variables || {}).find(([, v]) => 'SystemType' in v && 'FadeTime' in v);
    return byVariables?.[0] || null;
  }

  router.get('/config', (req, res) => {
    res.json({ componentName: lutron.settings.load().componentName || '', controller: controllerName() });
  });

  router.post('/config', handle(async (req) => {
    const { componentName } = req.body || {};
    if (componentName !== undefined) lutron.settings.update((s) => { s.componentName = String(componentName); });
    return { ok: true };
  }));

  // ── Rooms: which Savant Blueprint zones each Lutron area's lights go in (rooms.js) ──
  // settings.rooms = {
  //   savant: [zone names], savantSource: 'blueprint' | 'savant' | 'typed', savantAt,
  //   overrides: { [zone]: { addAreas, removeAreas, addLights } },   on top of the automatic matches
  //   kept: [areaId],                                                 left out on purpose
  // }

  const roomSettings = () => lutron.settings.load().rooms || {};
  const saveRooms = (change) => lutron.settings.update((s) => {
    s.rooms = s.rooms || {};
    change(s.rooms);
  });
  const ready = (c) => {
    if (!c.ready) throw httpError(503, 'Not connected to the processor');
  };

  const computeRooms = (c) => {
    const r = roomSettings();
    return buildRooms({
      areas: [...c.areas.values()],
      lights: [...c.zones.values()].filter(isLighting),
      savantZones: r.savant || [],
      overrides: r.overrides || {},
      kept: r.kept || [],
    });
  };

  // 2.2.0 kept one Savant room per area (rooms.decisions): fold those into the per-zone model.
  function migrateDecisions(c) {
    const { decisions } = roomSettings();
    if (!decisions) return;
    const before = computeRooms(c);
    saveRooms((r) => {
      r.overrides = r.overrides || {};
      const kept = new Set(r.kept || []);
      const edit = (zone) => (r.overrides[zone] = r.overrides[zone] || { addAreas: [], removeAreas: [], addLights: [] });
      for (const [id, { zone }] of Object.entries(decisions)) {
        const areaId = Number(id);
        const area = before.areas.find((a) => a.areaId === areaId);
        const auto = area?.status === 'auto' ? area.suggestion.zone : null;
        if (zone && zone !== auto) edit(zone).addAreas.push(areaId);
        if (auto && zone !== auto) edit(auto).removeAreas.push(areaId);
        if (zone === null) kept.add(areaId);
      }
      r.kept = [...kept];
      delete r.decisions;
    });
  }

  function currentRooms(c) {
    migrateDecisions(c);
    return computeRooms(c);
  }

  function roomView(c) {
    const r = roomSettings();
    const { zones, areas, counts } = currentRooms(c);
    return {
      savant: { zones: r.savant || [], source: r.savantSource || null, at: r.savantAt || null },
      controller: controllerName(),
      zones,
      areas,
      counts,
    };
  }

  router.get('/rooms', withController((c) => {
    ready(c);
    return roomView(c);
  }));

  // Savant's zones, from the configuration it's running (or sclibridge)
  router.post('/rooms/savant/read', withController(async (c) => {
    ready(c);
    const { zones, source } = await savantZones();
    saveRooms((r) => Object.assign(r, { savant: zones, savantSource: source, savantAt: new Date().toISOString() }));
    log.info(`Read ${zones.length} Savant zones from ${source === 'blueprint' ? 'the configuration Savant is running' : 'sclibridge'}`);
    return roomView(c);
  }));

  // ...or typed in, e.g. before the configuration is on the host
  router.put('/rooms/savant', withController((c, req) => {
    ready(c);
    const list = req.body?.zones;
    if (!Array.isArray(list)) throw httpError(400, 'zones (a list of names) required');
    const zones = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
    saveRooms((r) => Object.assign(r, { savant: zones, savantSource: 'typed', savantAt: new Date().toISOString() }));
    return roomView(c);
  }));

  // What's in one Savant zone: { zone, areas: [whole Lutron areas], lights: [single lights] },
  // or { zone, automatic: true } to go back to the automatic matches. A light can be in
  // several zones: choosing it here doesn't take it out of the others.
  router.put('/rooms/zone', withController((c, req) => {
    ready(c);
    const { zone, areas, lights, automatic } = req.body || {};
    if (!(roomSettings().savant || []).includes(zone)) throw httpError(404, `No Savant zone "${zone}"`);
    if (!automatic && !(Array.isArray(areas) && Array.isArray(lights))) {
      throw httpError(400, 'areas and lights (lists of ids), or automatic: true, required');
    }
    const now = currentRooms(c);
    saveRooms((r) => {
      r.overrides = r.overrides || {};
      if (automatic) {
        delete r.overrides[zone];
        return;
      }
      const chosen = { areas: areas.map(Number), lights: lights.map(Number) };
      const o = overrideFor(zone, chosen, now);
      if (o.addAreas.length || o.removeAreas.length || o.addLights.length) r.overrides[zone] = o;
      else delete r.overrides[zone];
      // Whatever is in a zone now isn't "left out" any more.
      const placed = new Set([...chosen.areas, ...now.areas.filter((a) => a.lights.some((l) => chosen.lights.includes(l.id))).map((a) => a.areaId)]);
      r.kept = (r.kept || []).filter((id) => !placed.has(id));
    });
    return roomView(c);
  }));

  // Leave an area out on purpose (exported under its Lutron name), or stop leaving it out
  router.put('/rooms/area/:areaId', withController((c, req) => {
    ready(c);
    const areaId = int(req.params.areaId, 'areaId');
    if (!c.areas.has(areaId)) throw httpError(404, `No Lutron area ${areaId}`);
    const { kept } = req.body || {};
    if (typeof kept !== 'boolean') throw httpError(400, 'kept (true or false) required');
    saveRooms((r) => {
      const set = new Set(r.kept || []);
      if (kept) set.add(areaId);
      else set.delete(areaId);
      r.kept = [...set];
    });
    return roomView(c);
  }));

  // ?keypads=1: every keypad button too, as Keypad Button rows
  router.get('/export/lighting', withController((c, req, res) => {
    if (!c.ready) throw httpError(503, 'Not connected');
    const rooms = currentRooms(c);
    const keypadButtons = req.query.keypads === '1' ? exportedKeypadButtons(c, rooms) : [];
    res.setHeader('Content-Type', 'application/x-plist');
    res.setHeader('Content-Disposition', 'attachment; filename="lighting_export.plist"');
    res.send(buildLightingPlist(c.zones.values(), controllerName().name, {
      zonesFor: (light) => rooms.zonesOf(light.id),
      keypadButtons,
    }));
  }));

  // ── Savant profile: zones, areas, shades ───────────────────────────────────

  // Polled by the profile twice a second, per Savant host: keep it cheap and quiet. Without a
  // processor there's simply nothing new ({}), rather than an error every half second.
  // ?start=1: Savant just started (FeedbackStart), send everything again.
  router.get('/feedback', (req, res) => res.json(lutron.feedback.poll(clientAddress(req), { start: req.query.start === '1' })));

  // Asked once per load when Savant starts. The zone comes back too, so the profile knows
  // whose level it is (DimmerLevel_<zone>).
  router.get('/zone/query', withController((c, req) => {
    const id = int(req.query.id, 'id');
    const zone = c.zones.get(id);
    if (!zone) throw httpError(404, `Zone ${id} not found`);
    return { zone: String(id), level: Math.round(zone.level ?? 0) };
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

    // press: a scene button is tapped, raise/lower starts ramping; release: raise/lower stops
    if (action === 'press' || action === 'hold') await c.pressButton(href);
    else if (action === 'release') await c.releaseButton(href);
    else await c.tapButton(href); // pressrelease
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
