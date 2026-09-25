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
 *  'zoneUpdate'        { zone }                 — zone level changed
 *  'thermostatUpdate'  { thermostat }           — HVAC state changed
 *  'buttonEvent'       { buttonHref, event }
 *  'ledUpdate'         { ledHref, state }
 *  'ready'             inventory loaded
 *  'connect'           LEAP connected
 *  'disconnect'        LEAP disconnected
 */
const { EventEmitter } = require('events');
const { keypadLayout, buttonRole } = require('./keypads');
const { LeapClient } = require('./leap-client');

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
  // Palladiom thermostats — handled on the Thermostats tab, not as loads
  DualSetPointHVAC: 'hvac',
  SingleSetPointHVAC: 'hvac',
  Unknown: 'switch',
};

class LeapController extends EventEmitter {
  /**
   * @param host         processor IP / hostname
   * @param certOptions  { ca, cert, key } from pairing
   * @param opts         { port, log }
   */
  constructor(host, certOptions, { port, log } = {}) {
    super();
    this.log = log;
    this.client = new LeapClient(host, certOptions, { port, log: log.child('leap') });
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
      this.log.error('Failed to load inventory:', err.message);
    }
  }

  async _loadInventory() {
    this.log.info('Loading inventory...');

    // Load areas first (required for QSX per-area fallbacks)
    const rawAreas = [];
    try {
      const areaResp = await this.client.request('ReadRequest', '/area');
      const areas = areaResp.Body?.AreaList || areaResp.Body?.Areas || [];
      this.areas.clear();
      for (const area of areas) {
        const id = this._hrefId(area.href);
        // parentId: areas nest (Main Floor › Primary Suite › Bath); room mapping needs the path.
        const areaObj = {
          id,
          name: area.Name || `Area ${id}`,
          href: area.href,
          parentId: this._hrefId(area.Parent?.href) ?? null,
          isLeaf: area.IsLeaf ?? null,
        };
        this.areas.set(id, areaObj);
        rawAreas.push(areaObj);
      }
      this.log.info(`Loaded ${this.areas.size} areas`);
    } catch (err) {
      this.log.warn('Could not load areas:', err.message);
    }

    // Load zones — try flat list first (Caseta/RA2), fall back to per-area (QSX/RA3)
    this.zones.clear();
    let zonesLoaded = false;
    try {
      const zoneResp = await this.client.request('ReadRequest', '/zone');
      this.log.debug('/zone response keys:', Object.keys(zoneResp.Body || {}));
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
        this.log.warn('Zone/status discovery failed:', err.message);
      }
    }
    this.log.info(`Loaded ${this.zones.size} zones`);

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
      this.log.info('Falling back to per-area device discovery (QSX)...');
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
                if (d?.href) this._addDevice(d, area, station);
              }
            } else if (ganged?.href) {
              this._addDevice(ganged, area, station);
            }
            if (station.Device) this._addDevice(station.Device, area, station);
          }
        } catch (err) {
          this.log.info(`${area.name}: control station failed — ${err.message}`);
        }
      }
    }
    this.log.info(`Loaded ${this.devices.size} devices, ${rawStations.length} control stations`);

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
              bg._deviceId = this._hrefId(deviceHref);
              bg._areaName = area.name;
              bg._stationName = station.Name || station.href;
              this._addButtonGroup(bg);
            }
          } catch { /* device has no button groups */ }
        }
      }
    }

    this.log.info(`Loaded ${this.buttonGroups.size} button groups`);

    // Button detail: on QSX a button group lists only hrefs. Each /button/:id has the number
    // (its position on the faceplate), engraving, LED and programming model.
    {
      const buttons = [...this.buttonGroups.values()].flatMap((bg) => bg.buttons)
        .filter((btn) => btn.href && (btn.number == null || !btn.name || /^Button \d+$/.test(btn.name)));
      let enriched = 0;
      await eachLimited(buttons, 8, async (btn) => {
        try {
          const resp = await this.client.request('ReadRequest', btn.href);
          const b = resp.Body?.Button || resp.Body?.Buttons?.[0];
          if (!b) return;
          Object.assign(btn, buttonDetail(b, btn));
          enriched++;
        } catch { /* keep what the group said */ }
      });
      if (enriched) this.log.info(`Read ${enriched} keypad buttons`);
    }

    // Keypad models: what a control station lists doesn't carry ModelNumber
    await eachLimited([...this.buttonGroups.values()], 8, async (bg) => {
      const device = this.devices.get(bg.deviceId);
      if (!device || device.modelNumber) return;
      try {
        const d = (await this.client.request('ReadRequest', device.href)).Body?.Device;
        if (d) {
          device.modelNumber = d.ModelNumber || null;
          device.type = d.DeviceType || device.type;
          device.model = d.ModelNumber || device.model;
        }
      } catch { /* the device type still tells the family */ }
    });

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
    if (this.virtualButtons.size > 0) this.log.info(`Loaded ${this.virtualButtons.size} virtual buttons`);

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
    if (this.thermostats.size > 0) this.log.info(`Loaded ${this.thermostats.size} thermostats`);
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

  _addDevice(d, fallbackArea = null, station = null) {
    const id = this._hrefId(d.href);
    if (!id) return;
    const areaId = this._hrefId(d.AssociatedArea?.href) ?? fallbackArea?.id;
    const area = this.areas.get(areaId) ?? fallbackArea;
    // A device in a control station is "Device 1", "Device 2" by gang position: the station
    // has the name people know it by ("Entry", or Designer's "Control Station 001").
    const ownName = d.Name || d.FullyQualifiedName;
    const name = station?.Name && (!ownName || /^Device \d+$/.test(ownName)) ? station.Name : ownName || `Device ${id}`;
    this.devices.set(id, {
      id,
      href: d.href,
      name,
      model: d.ModelNumber || d.DeviceType,
      modelNumber: d.ModelNumber || null,
      type: d.DeviceType,
      areaId,
      areaName: area?.name || 'Unknown Area',
      buttonGroups: d.ButtonGroups || [],
    });
  }

  _addButtonGroup(bg) {
    const id = this._hrefId(bg.href);
    if (!id) return;
    // QSX names the keypad as the group's Parent; others as AssociatedDevice
    const parent = /^\/device\//.test(bg.Parent?.href || '') ? bg.Parent.href : null;
    const deviceId = this._hrefId(parent || bg.AssociatedDevice?.href) ?? bg._deviceId ?? null;
    const device = this.devices.get(deviceId);
    const buttons = (bg.Buttons || []).map((btn) => ({
      id: this._hrefId(btn.href),
      href: btn.href,
      ...buttonDetail(btn, { name: `Button ${btn.ButtonNumber ?? this._hrefId(btn.href)}` }),
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
      this.log.info('Subscribed to zone status');
    } catch (err) {
      this.log.warn('Zone status subscription failed:', err.message);
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
      this.log.warn('Could not query zone levels:', err.message);
    }

    // Query initial thermostat state — zone/status subscription already covers updates
    if (this.thermostats.size > 0) {
      for (const t of this.thermostats.values()) {
        try {
          const resp = await this.client.request('ReadRequest', `${t.href}/status`);
          const s = resp.Body?.ZoneStatus;
          if (s) this._applyHvacStatus(s);
        } catch (err) {
          this.log.warn(`Could not query thermostat ${t.id} status:`, err.message);
        }
      }
      this.log.info(`Queried initial state for ${this.thermostats.size} thermostat(s)`);
    }

    // Button presses: all at once where the processor allows it; a QSX supports neither of
    // these, only one subscription per button (/button/:id/status/event).
    let allButtons = false;
    for (const url of ['/button/status', '/button/status/event']) {
      try {
        await this.client.subscribe(url);
        this.log.info(`Subscribed to ${url}`);
        allButtons = true;
        break;
      } catch { /* try the next */ }
    }
    if (!allButtons) {
      const buttons = [...this.buttonGroups.values()].flatMap((bg) => bg.buttons).filter((b) => b.href);
      let subscribed = 0;
      await eachLimited(buttons, 8, async (btn) => {
        try {
          await this.client.subscribe(`${btn.href}/status/event`);
          subscribed++;
        } catch { /* this processor doesn't report presses */ }
      });
      if (buttons.length) this.log.info(`Subscribed to presses of ${subscribed} of ${buttons.length} keypad buttons`);
    }

    // Keypad LEDs, one by one: QSX has no subscription for all of them (/led/status is "not
    // supported"). Each answer carries the LED's state now; later changes arrive as LEDStatus.
    const leds = [...this.buttonGroups.values()].flatMap((bg) => bg.buttons).filter((b) => b.ledHref);
    let subscribed = 0;
    await eachLimited(leds, 8, async (btn) => {
      try {
        const resp = await this.client.subscribe(`${btn.ledHref}/status`);
        const state = resp.Body?.LEDStatus?.State;
        if (state) btn.ledState = state;
        subscribed++;
      } catch { /* this processor doesn't report LEDs */ }
    });
    if (leds.length) this.log.info(`Subscribed to ${subscribed} of ${leds.length} keypad LEDs`);
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
          this.log.debug(`← zone ${id} (${zone.name}) ${prev ?? '?'} → ${zone.level}%`);
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
      const ledHref = ls.LED?.href;
      const state = ls.State ?? ls.LEDStatus; // LEAP sends State; LEDStatus kept for older payloads
      for (const bg of this.buttonGroups.values()) {
        for (const btn of bg.buttons) if (btn.ledHref === ledHref) btn.ledState = state;
      }
      this.emit('ledUpdate', { ledHref, state });
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

    this.log.debug(`→ setLevel zone ${zoneId} (${zone.name}) → ${Math.round(level)}%`);
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

    this.log.debug(`→ spectrum zone ${zoneId} (${zone.name})`, tuningParams);

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
    this.log.debug(`→ raise zone ${zoneId} (${zone.name}) → ${newLevel}%`);
    return this.setZoneLevel(zoneId, newLevel);
  }

  async lowerZone(zoneId, step = 5) {
    const zone = this.zones.get(zoneId);
    if (!zone) throw new Error(`Zone ${zoneId} not found`);
    const newLevel = Math.max(0, Math.round(zone.level ?? 0) - step);
    this.log.debug(`→ lower zone ${zoneId} (${zone.name}) → ${newLevel}%`);
    return this.setZoneLevel(zoneId, newLevel);
  }

  async stopZone(zoneId) {
    const zone = this.zones.get(zoneId);
    if (!zone) throw new Error(`Zone ${zoneId} not found`);
    if (this._isColorZone(zone)) {
      return this.setZoneSpectrum(zoneId, {});
    }
    this.log.debug(`→ stop zone ${zoneId} (${zone.name}) → hold at ${zone.level ?? 0}%`);
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
    this.log.debug(`→ scene recall ${vbId} (${vb.name})`);
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
    this.log.debug(`← hvac ${id} (${t.name}) temp=${t.temperature}°F heat=${t.heatSetpoint} cool=${t.coolSetpoint} mode=${t.mode} fan=${t.fanMode}`);
    this.emit('thermostatUpdate', { thermostat: { ...t } });
  }

  async setHeatSetpoint(hvacId, setpoint) {
    const t = this.thermostats.get(hvacId);
    if (!t) throw new Error(`Thermostat ${hvacId} not found`);
    this.log.debug(`→ hvac setHeatSetpoint ${hvacId} (${t.name}) → ${setpoint}°F`);
    return this.client.request('CreateRequest', `${t.href}/commandprocessor`, {
      Command: { CommandType: 'GoToDualSetPointParameters', DualSetPointParameters: { HeatingSetPoint: { F: setpoint } } },
    });
  }

  async setCoolSetpoint(hvacId, setpoint) {
    const t = this.thermostats.get(hvacId);
    if (!t) throw new Error(`Thermostat ${hvacId} not found`);
    this.log.debug(`→ hvac setCoolSetpoint ${hvacId} (${t.name}) → ${setpoint}°F`);
    return this.client.request('CreateRequest', `${t.href}/commandprocessor`, {
      Command: { CommandType: 'GoToDualSetPointParameters', DualSetPointParameters: { CoolingSetPoint: { F: setpoint } } },
    });
  }

  async setHvacMode(hvacId, mode) {
    const t = this.thermostats.get(hvacId);
    if (!t) throw new Error(`Thermostat ${hvacId} not found`);
    this.log.debug(`→ hvac setHvacMode ${hvacId} (${t.name}) → ${mode}`);
    return this.client.request('CreateRequest', `${t.href}/commandprocessor`, {
      Command: { CommandType: 'GoToDualSetPointParameters', DualSetPointParameters: { OperatingMode: mode } },
    });
  }

  async setFanMode(hvacId, mode) {
    const t = this.thermostats.get(hvacId);
    if (!t) throw new Error(`Thermostat ${hvacId} not found`);
    this.log.debug(`→ hvac setFanMode ${hvacId} (${t.name}) → ${mode}`);
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

  /** Keypad button href for a device ID + button number (the Savant addressing scheme). */
  findButtonHref(deviceId, buttonNumber) {
    for (const bg of this.buttonGroups.values()) {
      if (bg.deviceId !== deviceId) continue;
      const btn = bg.buttons.find((b) => b.number === buttonNumber);
      if (btn) return btn.href;
    }
    return null;
  }

  /** A button group as the dashboard draws it: its keypad's family, model and faceplate. */
  _keypad(bg) {
    const device = this.devices.get(bg.deviceId);
    const deviceType = device?.type || null;
    const model = device?.modelNumber || null;
    const { family, rows } = keypadLayout({ deviceType, model, buttons: bg.buttons });
    return {
      ...bg,
      deviceType,
      model,
      family,
      rows,
      buttons: bg.buttons.map((b) => ({ ...b, role: buttonRole(b, family.id), ledId: this._hrefId(b.ledHref) ?? null })),
    };
  }

  /** Every keypad LED: which keypad it's on, and whether it's lit ('On' | 'Off' | null). */
  keypadLeds() {
    const leds = [];
    for (const bg of this.buttonGroups.values()) {
      for (const b of bg.buttons) {
        if (b.ledHref) leds.push({ ledHref: b.ledHref, ledId: this._hrefId(b.ledHref), deviceId: bg.deviceId, state: b.ledState });
      }
    }
    return leds;
  }

  /** Reverse lookup: which device/button an LED href belongs to. */
  findLedButton(ledHref) {
    if (!ledHref) return null;
    for (const bg of this.buttonGroups.values()) {
      for (const btn of bg.buttons) {
        if (btn.ledHref === ledHref) return { deviceId: bg.deviceId, buttonNumber: btn.number };
      }
    }
    return null;
  }

  getInventory() {
    return {
      zones: Array.from(this.zones.values()),
      areas: Array.from(this.areas.values()),
      devices: Array.from(this.devices.values()),
      buttonGroups: Array.from(this.buttonGroups.values(), (bg) => this._keypad(bg)),
      virtualButtons: Array.from(this.virtualButtons.values()),
      thermostats: Array.from(this.thermostats.values()),
    };
  }

  destroy() {
    this.client.destroy();
    this.removeAllListeners();
  }
}

/** What a LEAP Button says of itself, over what's known already. */
function buttonDetail(b, known = {}) {
  const engraving = b.Engraving?.Text ?? known.engraving ?? null;
  return {
    number: b.ButtonNumber ?? known.number ?? null,
    engraving,
    name: engraving || b.Name || b.FullyQualifiedName || known.name,
    ledHref: b.AssociatedLED?.href ?? known.ledHref ?? null,
    programmingModel: b.ProgrammingModel?.ProgrammingModelType ?? known.programmingModel ?? null,
  };
}

/** Run fn over items, at most `limit` at a time. */
async function eachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

module.exports = { LeapController };
