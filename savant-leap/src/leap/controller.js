/**
 * High-level Lutron LEAP controller.
 *
 * Wraps LeapClient to provide:
 *  - Zone/device/area/button group inventory with full name resolution
 *  - Real-time zone level updates via events
 *  - Zone control (setLevel, raise, lower, stop)
 *  - Virtual button (scene) recall
 *  - Keypad button press/release
 *  - LED status tracking
 *
 * Events emitted:
 *  'zoneUpdate'    { zone }      — zone level changed
 *  'buttonEvent'   { device, button, event }
 *  'ledUpdate'     { device, button, state }
 *  'ready'         inventory loaded
 *  'connect'       LEAP connected
 *  'disconnect'    LEAP disconnected
 */
const { EventEmitter } = require('events');
const { LeapClient } = require('./client');

// Maps LEAP ControlType to our simplified type
const CONTROL_TYPE_MAP = {
  Dimmed: 'dimmer',
  Switched: 'switch',
  Shade: 'shade',
  ShadeWithTilt: 'shade',
  CCO: 'switch',
  FanSpeed: 'fan',
  ShadeWithTiltWhenClosed: 'shade',
  // Ketra (full spectrum RGB + tunable white)
  SpectrumTune: 'ketra',
  SpectrumTuning: 'ketra',
  Ketra: 'ketra',
  ColorTuning: 'ketra',
  // Rania / tunable white
  WhiteTune: 'rania',
  CCT: 'rania',
  TunableWhite: 'rania',
  WhiteAmbience: 'rania',
  Unknown: 'switch',
};

class LeapController extends EventEmitter {
  constructor(host, certOptions) {
    super();
    this.client = new LeapClient(host, certOptions);
    this.zones = new Map();        // zoneId (int) -> zone object
    this.devices = new Map();      // deviceId -> device object
    this.areas = new Map();        // areaId -> area object
    this.buttonGroups = new Map(); // bgId -> button group object
    this.virtualButtons = new Map(); // vbId -> virtual button object
    this.thermostats = new Map();  // hvacId (int) -> thermostat object
    this.ready = false;

    this.client.on('connect', () => this._onConnect());
    this.client.on('disconnect', () => {
      this.ready = false;
      this.emit('disconnect');
    });
    this.client.on('message', (msg) => this._onMessage(msg));
  }

  connect() {
    this.client.connect();
  }

  async _onConnect() {
    this.emit('connect');
    try {
      await this._loadInventory();
      await this._subscribeAll();
      this.ready = true;
      this.emit('ready');
    } catch (err) {
      console.error('[controller] Failed to load inventory:', err.message);
    }
  }

  async _loadInventory() {
    console.log('[controller] Loading inventory...');

    // Load areas first (required for QSX per-area fallbacks)
    const rawAreas = [];
    try {
      const areaResp = await this.client.request('ReadRequest', '/area');
      const areas = areaResp.Body?.AreaList || areaResp.Body?.Areas || [];
      this.areas.clear();
      for (const area of areas) {
        const id = this._hrefId(area.href);
        const areaObj = { id, name: area.Name || `Area ${id}`, href: area.href };
        this.areas.set(id, areaObj);
        rawAreas.push(areaObj);
      }
      console.log(`[controller] Loaded ${this.areas.size} areas`);
    } catch (err) {
      console.warn('[controller] Could not load areas:', err.message);
    }

    // Load zones — try flat list first (Caseta/RA2), fall back to per-area (QSX/RA3)
    this.zones.clear();
    let zonesLoaded = false;
    try {
      const zoneResp = await this.client.request('ReadRequest', '/zone');
      console.log('[controller] /zone response keys:', Object.keys(zoneResp.Body || {}));
      const zones = zoneResp.Body?.ZoneList || zoneResp.Body?.Zones || [];
      for (const z of zones) {
        this._addZone(z);
      }
      zonesLoaded = zones.length > 0;
    } catch { /* QSX returns 405 — fall through to zone/status discovery */ }

    if (!zonesLoaded) {
      try {
        const statusResp = await this.client.request('ReadRequest', '/zone/status');
        const statuses = statusResp.Body?.ZoneStatusList || statusResp.Body?.ZoneStatuses || [];

        // Build level map first so we can apply levels after zone detail fetch
        const levelMap = new Map();
        for (const s of statuses) {
          if (s.Zone?.href) levelMap.set(s.Zone.href, s.Level ?? null);
        }

        for (const s of statuses) {
          const href = s.Zone?.href;
          if (!href) continue;
          try {
            const zResp = await this.client.request('ReadRequest', href);
            const z = zResp.Body?.Zone || zResp.Body?.ZoneList?.[0] || zResp.Body?.Zones?.[0];
            if (z) {
              this._addZone(z);
            } else {
              const id = this._hrefId(href);
              this.zones.set(id, {
                id, href, name: `Zone ${id}`, areaId: null, areaName: 'Unknown Area',
                controlType: 'Unknown', type: 'switch', level: null,
              });
            }
          } catch {
            const id = this._hrefId(href);
            this.zones.set(id, {
              id, href, name: `Zone ${id}`, areaId: null, areaName: 'Unknown Area',
              controlType: 'Unknown', type: 'switch', level: null,
            });
          }
          // Apply level from status (overrides null set by _addZone)
          const id = this._hrefId(href);
          const zone = this.zones.get(id);
          if (zone) zone.level = levelMap.get(href) ?? null;
        }
      } catch (err) {
        console.warn('[controller] Zone/status discovery failed:', err.message);
      }
    }
    console.log(`[controller] Loaded ${this.zones.size} zones`);

    // Load devices — try flat list first, fall back to per-area control stations (QSX)
    this.devices.clear();
    try {
      const deviceResp = await this.client.request('ReadRequest', '/device');
      const devices = deviceResp.Body?.DeviceList || deviceResp.Body?.Devices || [];
      for (const d of devices) {
        this._addDevice(d);
      }
    } catch { /* ignore */ }

    const rawStations = []; // collect for button group discovery
    if (this.devices.size === 0 && rawAreas.length > 0) {
      console.log('[controller] Falling back to per-area device discovery (QSX)...');
      for (const area of rawAreas) {
        try {
          const resp = await this.client.request('ReadRequest', `${area.href}/associatedcontrolstation`);
          const stations = resp.Body?.ControlStationList || resp.Body?.AssociatedControlStationList || resp.Body?.ControlStations || [];
          for (const station of stations) {
            if (station.href) rawStations.push({ station, area });
            // AssociatedGangedDevices is an array of { Device: {...} } objects
            const ganged = station.AssociatedGangedDevices;
            if (Array.isArray(ganged)) {
              for (const gang of ganged) {
                const d = gang.Device || gang;
                if (d?.href) this._addDevice(d, area);
              }
            } else if (ganged?.href) {
              this._addDevice(ganged, area);
            }
            if (station.Device) this._addDevice(station.Device, area);
          }
        } catch (err) {
          console.log(`[controller]   ${area.name}: control station failed — ${err.message}`);
        }
      }
    }
    console.log(`[controller] Loaded ${this.devices.size} devices, ${rawStations.length} control stations`);

    // Load button groups
    this.buttonGroups.clear();

    // Try flat list first (Caseta/RA2), fall back to per-ganged-device sub-resource (QSX)
    try {
      const bgResp = await this.client.request('ReadRequest', '/buttongroup/expanded');
      const list = bgResp.Body?.ButtonGroupExpandedList || bgResp.Body?.ButtonGroups || [];
      for (const bg of list) this._addButtonGroup(bg);
    } catch { /* not supported on QSX */ }

    if (this.buttonGroups.size === 0) {
      try {
        const bgResp = await this.client.request('ReadRequest', '/buttongroup');
        const list = bgResp.Body?.ButtonGroupList || bgResp.Body?.ButtonGroups || [];
        for (const bg of list) this._addButtonGroup(bg);
      } catch { /* not supported on QSX */ }
    }

    // QSX: button groups are sub-resources of each ganged device (/device/:id/buttongroup)
    if (this.buttonGroups.size === 0 && rawStations.length > 0) {
      for (const { station, area } of rawStations) {
        const ganged = station.AssociatedGangedDevices || [];
        for (const gang of (Array.isArray(ganged) ? ganged : [ganged])) {
          const deviceHref = (gang.Device || gang)?.href;
          if (!deviceHref) continue;
          try {
            const resp = await this.client.request('ReadRequest', `${deviceHref}/buttongroup`);
            const list = resp.Body?.ButtonGroupList || resp.Body?.ButtonGroups || resp.Body?.ButtonGroupExpandedList || [];
            for (const bg of list) {
              bg._areaName = area.name;
              bg._stationName = station.Name || station.href;
              this._addButtonGroup(bg);
            }
          } catch { /* device has no button groups */ }
        }
      }
    }

    console.log(`[controller] Loaded ${this.buttonGroups.size} button groups`);

    // Enrich button names — button group responses only carry hrefs, not full button detail.
    // Fetch each /button/:id individually to get Engraving.Text (the designer label).
    {
      const missingName = (btn) => !btn.name || btn.name.startsWith('Button ');
      let enriched = 0;
      for (const bg of this.buttonGroups.values()) {
        for (const btn of bg.buttons) {
          if (!btn.href || !missingName(btn)) continue;
          try {
            const resp = await this.client.request('ReadRequest', btn.href);
            const b = resp.Body?.Button || resp.Body?.Buttons?.[0];
            if (b) {
              const name = b.Engraving?.Text || b.Name || b.FullyQualifiedName;
              if (name) { btn.name = name; enriched++; }
            }
          } catch { /* ignore */ }
        }
      }
      if (enriched) console.log(`[controller] Enriched ${enriched} button names`);
    }

    // Load virtual buttons (scenes)
    this.virtualButtons.clear();
    try {
      const vbResp = await this.client.request('ReadRequest', '/virtualbutton');
      for (const vb of (vbResp.Body?.VirtualButtonList || vbResp.Body?.VirtualButtons || [])) {
        const id = this._hrefId(vb.href);
        this.virtualButtons.set(id, {
          id,
          href: vb.href,
          name: vb.Name || `Scene ${id}`,
          isProgrammed: vb.IsProgrammed !== false,
        });
      }
    } catch { /* virtual buttons not available on this processor */ }
    if (this.virtualButtons.size > 0) console.log(`[controller] Loaded ${this.virtualButtons.size} virtual buttons`);

    // Thermostats appear as zones with DualSetPointHVAC or SingleSetPointHVAC controlType
    this.thermostats.clear();
    for (const zone of this.zones.values()) {
      if (zone.controlType === 'DualSetPointHVAC' || zone.controlType === 'SingleSetPointHVAC') {
        const props = zone.hvacProperties;
        this.thermostats.set(zone.id, {
          id: zone.id, href: zone.href,
          name: zone.name, areaId: zone.areaId, areaName: zone.areaName,
          temperature: null, heatSetpoint: null, coolSetpoint: null,
          mode: null, fanMode: null, operatingState: null,
          supportedModes: props?.OperatingModes || null,
          supportedFanModes: props?.FanModes || null,
          heatRange: props?.HeatingSetPointRange?.F || null,
          coolRange: props?.CoolingSetPointRange?.F || null,
        });
      }
    }
    if (this.thermostats.size > 0) console.log(`[controller] Loaded ${this.thermostats.size} thermostats`);
  }

  _addZone(z, fallbackArea = null) {
    const id = this._hrefId(z.href);
    if (!id) return;
    const areaId = this._hrefId(z.AssociatedArea?.href) ?? fallbackArea?.id;
    const area = this.areas.get(areaId) ?? fallbackArea;
    const controlType = z.ControlType || 'Unknown';
    this.zones.set(id, {
      id,
      href: z.href,
      name: z.Name || `Zone ${id}`,
      areaId,
      areaName: area?.name || 'Unknown Area',
      controlType,
      type: CONTROL_TYPE_MAP[controlType] || 'switch',
      level: null,
      hvacProperties: z.DualSetPointHVACProperties || z.SingleSetPointHVACProperties || null,
    });
  }

  _addDevice(d, fallbackArea = null) {
    const id = this._hrefId(d.href);
    if (!id) return;
    const areaId = this._hrefId(d.AssociatedArea?.href) ?? fallbackArea?.id;
    const area = this.areas.get(areaId) ?? fallbackArea;
    this.devices.set(id, {
      id,
      href: d.href,
      name: d.Name || d.FullyQualifiedName || `Device ${id}`,
      model: d.ModelNumber || d.DeviceType,
      type: d.DeviceType,
      areaId,
      areaName: area?.name || 'Unknown Area',
      buttonGroups: d.ButtonGroups || [],
    });
  }

  _addButtonGroup(bg) {
    const id = this._hrefId(bg.href);
    if (!id) return;
    const deviceId = this._hrefId(bg.AssociatedDevice?.href) ?? bg._deviceId ?? null;
    const device = this.devices.get(deviceId);
    const buttons = (bg.Buttons || []).map((btn) => ({
      id: this._hrefId(btn.href),
      href: btn.href,
      name: btn.Engraving?.Text || btn.Name || `Button ${this._hrefId(btn.href)}`,
      number: btn.ButtonNumber,
      ledHref: btn.AssociatedLED?.href,
      ledState: null,
    }));
    this.buttonGroups.set(id, {
      id,
      href: bg.href,
      deviceId,
      deviceName: device?.name || bg._deviceName || bg._stationName || `Device ${deviceId}`,
      areaName: device?.areaName || bg._areaName || 'Unknown Area',
      buttons,
    });
  }

  async _subscribeAll() {
    // Subscribe to zone level updates
    try {
      await this.client.subscribe('/zone/status');
      console.log('[controller] Subscribed to zone status');
    } catch (err) {
      console.warn('[controller] Zone status subscription failed:', err.message);
    }

    // Query current zone levels
    try {
      const resp = await this.client.request('ReadRequest', '/zone/status');
      const statuses = resp.Body?.ZoneStatusList || resp.Body?.ZoneStatuses || [];
      for (const s of statuses) {
        const id = this._hrefId(s.Zone?.href);
        const zone = this.zones.get(id);
        if (zone) zone.level = s.Level ?? null;
      }
    } catch (err) {
      console.warn('[controller] Could not query zone levels:', err.message);
    }

    // Query initial thermostat state — zone/status subscription already covers updates
    if (this.thermostats.size > 0) {
      for (const t of this.thermostats.values()) {
        try {
          const resp = await this.client.request('ReadRequest', `${t.href}/status`);
          const s = resp.Body?.ZoneStatus;
          if (s) this._applyHvacStatus(s);
        } catch (err) {
          console.warn(`[controller] Could not query thermostat ${t.id} status:`, err.message);
        }
      }
      console.log(`[controller] Queried initial state for ${this.thermostats.size} thermostat(s)`);
    }

    // Subscribe to button/LED updates (QSX uses /button/status/event, not /button/status)
    try {
      await this.client.subscribe('/button/status');
      console.log('[controller] Subscribed to button status');
    } catch {
      try {
        await this.client.subscribe('/button/status/event');
        console.log('[controller] Subscribed to button status events');
      } catch { /* button subscriptions not available */ }
    }
  }

  _onMessage(msg) {
    if (!msg.Body) return;

    // Zone level update (or thermostat update if it's an HVAC zone)
    if (msg.Body.ZoneStatus) {
      const s = msg.Body.ZoneStatus;
      const id = this._hrefId(s.Zone?.href);
      if (this.thermostats.has(id)) {
        this._applyHvacStatus(s);
        return;
      }
      const zone = this.zones.get(id);
      if (zone) {
        const prev = zone.level;
        zone.level = s.Level ?? zone.level;
        if (prev !== zone.level) {
          console.log(`\x1b[32m[leap ←]\x1b[0m zone ${id} (${zone.name}) ${prev ?? '?'} → ${zone.level}%`);
          this.emit('zoneUpdate', { zone: { ...zone } });
        }
      }
      return;
    }

    // Zone status list (bulk update)
    if (msg.Body.ZoneStatusList || msg.Body.ZoneStatuses) {
      for (const s of (msg.Body.ZoneStatusList || msg.Body.ZoneStatuses)) {
        const id = this._hrefId(s.Zone?.href);
        const zone = this.zones.get(id);
        if (zone) {
          const prev = zone.level;
          zone.level = s.Level ?? zone.level;
          if (prev !== zone.level) {
            this.emit('zoneUpdate', { zone: { ...zone } });
          }
        }
      }
      return;
    }

    // Button event
    if (msg.Body.ButtonStatus) {
      const bs = msg.Body.ButtonStatus;
      this.emit('buttonEvent', {
        buttonHref: bs.Button?.href,
        event: bs.ButtonEvent?.EventType,
      });
      return;
    }

    // LED status
    if (msg.Body.LEDStatus) {
      const ls = msg.Body.LEDStatus;
      this.emit('ledUpdate', {
        ledHref: ls.LED?.href,
        state: ls.LEDStatus,
      });
      return;
    }
  }

  // ─── Zone Control ──────────────────────────────────────────────────────────

  _isColorZone(zone) {
    return zone.type === 'ketra' || zone.type === 'rania';
  }

  async setZoneLevel(zoneId, level) {
    const zone = this.zones.get(zoneId);
    if (!zone) throw new Error(`Zone ${zoneId} not found`);

    if (this._isColorZone(zone)) {
      return this.setZoneSpectrum(zoneId, { level: Math.round(level) });
    }

    console.log(`\x1b[33m[leap →]\x1b[0m setLevel zone ${zoneId} (${zone.name}) → ${Math.round(level)}%`);
    return this.client.request('CreateRequest', `${zone.href}/commandprocessor`, {
      Command: {
        CommandType: 'GoToLevel',
        Parameter: [{ Type: 'Level', Value: Math.round(level) }],
      },
    });
  }

  /**
   * Set spectrum/color properties for a Ketra or Rania zone.
   * Only the keys you pass will be updated; the rest carry over from stored state.
   * Ketra (SpectrumTune): { level, colorTemp, hue, vibrancy }
   * Rania (WhiteTune):    { level, colorTemp }
   */
  async setZoneSpectrum(zoneId, params) {
    const zone = this.zones.get(zoneId);
    if (!zone) throw new Error(`Zone ${zoneId} not found`);

    // Merge into stored per-zone color state
    if (!zone.colorState) zone.colorState = {};
    if (params.level      !== undefined) zone.colorState.level      = Math.round(params.level);
    if (params.colorTemp  !== undefined) zone.colorState.colorTemp  = params.colorTemp;
    if (params.hue        !== undefined) zone.colorState.hue        = params.hue;
    if (params.saturation !== undefined) zone.colorState.saturation = params.saturation;
    if (params.vibrancy   !== undefined) zone.colorState.vibrancy   = params.vibrancy;
    if (params.warmDim    !== undefined) zone.colorState.warmDim    = params.warmDim;

    const cs = zone.colorState;
    const lvl = cs.level ?? Math.round(zone.level ?? 100);

    const tuningParams = { Level: lvl };

    if (cs.warmDim || zone.type === 'rania') {
      // White / warm-dim mode — ColorTuningStatus.WhiteTuningLevel.Kelvin
      if (cs.colorTemp !== undefined) {
        tuningParams.ColorTuningStatus = {
          WhiteTuningLevel: { Kelvin: cs.colorTemp },
        };
      }
    } else {
      // Full color mode (Ketra):
      //   Vibrancy = top-level (0 = white, 100 = full color)
      //   ColorTuningStatus.HSVTuningLevel = hue + saturation
      if (cs.vibrancy !== undefined) tuningParams.Vibrancy = cs.vibrancy;
      if (cs.hue !== undefined || cs.saturation !== undefined) {
        tuningParams.ColorTuningStatus = {
          HSVTuningLevel: {
            Hue:        cs.hue        ?? 0,
            Saturation: cs.saturation ?? 100,
          },
        };
      }
    }

    console.log(`\x1b[33m[leap →]\x1b[0m spectrum zone ${zoneId} (${zone.name})`, tuningParams);

    return this.client.request('CreateRequest', `${zone.href}/commandprocessor`, {
      Command: {
        CommandType: 'GoToSpectrumTuningLevel',
        SpectrumTuningLevelParameters: tuningParams,
      },
    });
  }

  async raiseZone(zoneId, step = 5) {
    const zone = this.zones.get(zoneId);
    if (!zone) throw new Error(`Zone ${zoneId} not found`);
    const newLevel = Math.min(100, Math.round(zone.level ?? 0) + step);
    console.log(`\x1b[33m[leap →]\x1b[0m raise zone ${zoneId} (${zone.name}) → ${newLevel}%`);
    return this.setZoneLevel(zoneId, newLevel);
  }

  async lowerZone(zoneId, step = 5) {
    const zone = this.zones.get(zoneId);
    if (!zone) throw new Error(`Zone ${zoneId} not found`);
    const newLevel = Math.max(0, Math.round(zone.level ?? 0) - step);
    console.log(`\x1b[33m[leap →]\x1b[0m lower zone ${zoneId} (${zone.name}) → ${newLevel}%`);
    return this.setZoneLevel(zoneId, newLevel);
  }

  async stopZone(zoneId) {
    const zone = this.zones.get(zoneId);
    if (!zone) throw new Error(`Zone ${zoneId} not found`);
    if (this._isColorZone(zone)) {
      return this.setZoneSpectrum(zoneId, {});
    }
    console.log(`\x1b[33m[leap →]\x1b[0m stop zone ${zoneId} (${zone.name}) → hold at ${zone.level ?? 0}%`);
    return this.client.request('CreateRequest', `${zone.href}/commandprocessor`, {
      Command: {
        CommandType: 'GoToLevel',
        Parameter: [{ Type: 'Level', Value: Math.round(zone.level ?? 0) }],
      },
    });
  }

  // ─── Area Control ──────────────────────────────────────────────────────────

  async setAreaLevel(areaId, level) {
    const area = this.areas.get(areaId);
    if (!area) throw new Error(`Area ${areaId} not found`);
    return this.client.request('CreateRequest', `${area.href}/commandprocessor`, {
      Command: {
        CommandType: 'GoToLevel',
        Parameter: [{ Type: 'Level', Value: Math.round(level) }],
      },
    });
  }

  // ─── Scene / Virtual Button ────────────────────────────────────────────────

  async pressVirtualButton(vbId) {
    const vb = this.virtualButtons.get(vbId);
    if (!vb) throw new Error(`Virtual button ${vbId} not found`);
    console.log(`\x1b[33m[leap →]\x1b[0m scene recall ${vbId} (${vb.name})`);
    return this.client.request('CreateRequest', `${vb.href}/commandprocessor`, {
      Command: { CommandType: 'PressAndRelease' },
    });
  }

  // ─── Physical Button ───────────────────────────────────────────────────────

  async pressButton(buttonHref) {
    return this.client.request('CreateRequest', `${buttonHref}/commandprocessor`, {
      Command: { CommandType: 'PressAndHold' },
    });
  }

  async releaseButton(buttonHref) {
    return this.client.request('CreateRequest', `${buttonHref}/commandprocessor`, {
      Command: { CommandType: 'Release' },
    });
  }

  // ─── Thermostat Control ────────────────────────────────────────────────────

  // s is a ZoneStatus object: { Zone: { href }, DualSetPointHVACStatus: { ... } }
  _applyHvacStatus(s) {
    const id = this._hrefId(s.Zone?.href);
    const t = this.thermostats.get(id);
    if (!t) return;
    const hvac = s.DualSetPointHVACStatus || s.SingleSetPointHVACStatus;
    if (!hvac) return;
    if (hvac.CurrentTemperature?.F !== undefined) t.temperature  = hvac.CurrentTemperature.F;
    if (hvac.HeatingSetPoint?.F    !== undefined) t.heatSetpoint = hvac.HeatingSetPoint.F;
    if (hvac.CoolingSetPoint?.F    !== undefined) t.coolSetpoint = hvac.CoolingSetPoint.F;
    if (hvac.OperatingMode         !== undefined) t.mode         = hvac.OperatingMode;
    if (hvac.FanMode               !== undefined) t.fanMode      = hvac.FanMode;
    if (hvac.OperatingStatuses?.length > 0)       t.operatingState = hvac.OperatingStatuses[0];
    console.log(`\x1b[36m[hvac ←]\x1b[0m ${id} (${t.name}) temp=${t.temperature}°F heat=${t.heatSetpoint} cool=${t.coolSetpoint} mode=${t.mode} fan=${t.fanMode}`);
    this.emit('thermostatUpdate', { thermostat: { ...t } });
  }

  async setHeatSetpoint(hvacId, setpoint) {
    const t = this.thermostats.get(hvacId);
    if (!t) throw new Error(`Thermostat ${hvacId} not found`);
    console.log(`\x1b[36m[hvac →]\x1b[0m setHeatSetpoint ${hvacId} (${t.name}) → ${setpoint}°F`);
    return this.client.request('CreateRequest', `${t.href}/commandprocessor`, {
      Command: { CommandType: 'GoToDualSetPointParameters', DualSetPointParameters: { HeatingSetPoint: { F: setpoint } } },
    });
  }

  async setCoolSetpoint(hvacId, setpoint) {
    const t = this.thermostats.get(hvacId);
    if (!t) throw new Error(`Thermostat ${hvacId} not found`);
    console.log(`\x1b[36m[hvac →]\x1b[0m setCoolSetpoint ${hvacId} (${t.name}) → ${setpoint}°F`);
    return this.client.request('CreateRequest', `${t.href}/commandprocessor`, {
      Command: { CommandType: 'GoToDualSetPointParameters', DualSetPointParameters: { CoolingSetPoint: { F: setpoint } } },
    });
  }

  async setHvacMode(hvacId, mode) {
    const t = this.thermostats.get(hvacId);
    if (!t) throw new Error(`Thermostat ${hvacId} not found`);
    console.log(`\x1b[36m[hvac →]\x1b[0m setHvacMode ${hvacId} (${t.name}) → ${mode}`);
    return this.client.request('CreateRequest', `${t.href}/commandprocessor`, {
      Command: { CommandType: 'GoToDualSetPointParameters', DualSetPointParameters: { OperatingMode: mode } },
    });
  }

  async setFanMode(hvacId, mode) {
    const t = this.thermostats.get(hvacId);
    if (!t) throw new Error(`Thermostat ${hvacId} not found`);
    console.log(`\x1b[36m[hvac →]\x1b[0m setFanMode ${hvacId} (${t.name}) → ${mode}`);
    return this.client.request('CreateRequest', `${t.href}/commandprocessor`, {
      Command: { CommandType: 'GoToDualSetPointParameters', DualSetPointParameters: { FanMode: mode } },
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _hrefId(href) {
    if (!href) return null;
    const parts = href.split('/');
    return parseInt(parts[parts.length - 1], 10);
  }

  /**
   * Convert Lutron telnet-style time (SS, SS.ss, MM:SS, HH:MM:SS) to
   * LEAP time format (HH:MM:SS).
   */
  _formatTime(t) {
    if (!t || t === '0' || t === '00') return '00:00:00';
    if (/^\d+:\d+:\d+$/.test(t)) return t;
    if (/^\d+:\d+$/.test(t)) return `00:${t}`;
    const secs = parseFloat(t) || 0;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  }

  getInventory() {
    return {
      zones: Array.from(this.zones.values()),
      areas: Array.from(this.areas.values()),
      devices: Array.from(this.devices.values()),
      buttonGroups: Array.from(this.buttonGroups.values()),
      virtualButtons: Array.from(this.virtualButtons.values()),
      thermostats: Array.from(this.thermostats.values()),
    };
  }

  destroy() {
    this.client.destroy();
  }
}

module.exports = { LeapController };
