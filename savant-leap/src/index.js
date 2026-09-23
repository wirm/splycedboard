/**
 * Savant-Lutron LEAP Bridge
 * Entry point — wires together LEAP controller, Savant TCP bridge, and web UI.
 */

// ── Verbose timestamped logging ───────────────────────────────────────────────
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origErr = console.error.bind(console);
function ts() { return new Date().toLocaleTimeString('en-US', { hour12: false }); }
console.log   = (...a) => _origLog( `\x1b[2m${ts()}\x1b[0m`, ...a);
console.warn  = (...a) => _origWarn(`\x1b[2m${ts()}\x1b[0m \x1b[33m⚠\x1b[0m`, ...a);
console.error = (...a) => _origErr( `\x1b[2m${ts()}\x1b[0m \x1b[31m✗\x1b[0m`, ...a);

const config = require('./config');
const { LeapController } = require('./leap/controller');
const { SavantTcpBridge } = require('./bridge/tcp-server');
const { createWebServer } = require('./web/server');
const { startScliBridge } = require('./scli/bridge');

// ── Controller holder ────────────────────────────────────────────────────────
// Allows the web server to reference a controller that may be replaced
// when pairing/reconnecting without restarting the whole process.

const controllerHolder = {
  controller: null,
  wsClients: null,
  onControllerChange: null,

  async reconnect() {
    const cfg = config.load();
    if (!cfg.processor) throw new Error('No processor paired');

    const { id, host } = cfg.processor;
    if (!config.hasCerts(id)) throw new Error('No certificates found. Please pair first.');

    const certs = config.loadCerts(id);

    // Tear down existing controller
    if (this.controller) {
      this.controller.destroy();
      this.controller = null;
    }

    const controller = new LeapController(host, certs);
    this.controller = controller;

    // Wire TCP bridge to new controller
    if (bridge) bridge.controller = controller;

    if (this.onControllerChange) this.onControllerChange(controller);

    controller.connect();
    return controller;
  },
};

// ── Start services ────────────────────────────────────────────────────────────

// Web UI + API (always starts regardless of pairing state)
createWebServer(controllerHolder);

// SCLI bridge (ports 12000 + 12001)
startScliBridge();

// Savant TCP bridge (needs a controller reference, but starts immediately)
// Uses a proxy so bridge keeps working when controller is replaced
const bridgeProxy = {
  get controller() {
    return controllerHolder.controller;
  },
};

// We create a minimal bridge shell that wraps the holder
const { SavantTcpBridge: BridgeClass } = require('./bridge/tcp-server');

// Create a real bridge with a placeholder that delegates to holder
class ProxyBridge {
  constructor(holder) {
    this.holder = holder;
    this.server = null;
    this.clients = new Set();

    // Re-wire events whenever the controller changes.
    // Chain onto any existing handler (e.g. web server's WebSocket wiring).
    const prevHandler = holder.onControllerChange;
    holder.onControllerChange = (controller) => {
      if (prevHandler) prevHandler(controller);
      this._wireController(controller);
    };
  }

  _wireController(controller) {
    controller.on('zoneUpdate', ({ zone }) => {
      const level = Math.round(zone.level ?? 0);
      if (zone.type === 'shade') {
        this._broadcast(`~SHADEGRP,${zone.id},1,${level}.`);
      } else {
        this._broadcast(`~OUTPUT,${zone.id},1,${level}.`);
      }
    });
    controller.on('ledUpdate', ({ ledHref, state }) => {
      const { deviceId, buttonNum } = this._resolveLedHref(ledHref, controller);
      if (deviceId !== null) {
        const stateCode = state === 'On' ? '01' : '00';
        this._broadcast(`~DEVICE,${deviceId},${buttonNum},09,${stateCode}`);
      }
    });
  }

  start() {
    const net = require('net');
    const { BRIDGE_PORT } = require('./bridge/tcp-server');

    this.server = net.createServer((socket) => this._onClient(socket));
    this.server.listen(BRIDGE_PORT, '0.0.0.0', () => {
      console.log(`[bridge] Savant TCP bridge listening on port ${BRIDGE_PORT}`);
    });
    this.server.on('error', (err) => console.error('[bridge] Server error:', err.message));
  }

  _onClient(socket) {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[bridge] Savant connected from ${addr}`);
    this.clients.add(socket);
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30000);

    const ctrl = () => this.holder.controller;

    if (ctrl()?.ready) this._sendInitialState(socket, ctrl());

    // Also send initial state when controller becomes ready
    const onReady = () => this._sendInitialState(socket, ctrl());
    ctrl()?.once('ready', onReady);

    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          console.log(`\x1b[36m[savant →]\x1b[0m ${trimmed}`);
          this._handleCommand(socket, trimmed, ctrl());
        }
      }
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      console.log(`[bridge] Savant disconnected from ${addr}`);
    });
    socket.on('error', () => this.clients.delete(socket));
  }

  _sendInitialState(socket, controller) {
    if (!controller) return;
    for (const zone of controller.zones.values()) {
      if (zone.level !== null) {
        const level = Math.round(zone.level);
        const msg = zone.type === 'shade'
          ? `~SHADEGRP,${zone.id},1,${level}.`
          : `~OUTPUT,${zone.id},1,${level}.`;
        this._send(socket, msg);
      }
    }
  }

  _handleCommand(socket, line, controller) {
    if (!controller) return;
    const cmd = line.replace(/^QNET>\s*/, '').trim().toUpperCase();

    const outputMatch = cmd.match(/^#OUTPUT,\s*(\d+),(\d+)(?:,(\S+))?(?:,(\S+))?(?:,(\S+))?/);
    if (outputMatch) {
      const [, id, action, lvl, fade, delay] = outputMatch;
      const zoneId = parseInt(id);
      switch (action) {
        case '1': controller.setZoneLevel(zoneId, parseFloat(lvl) || 0, fade, delay).catch(e => console.error('[bridge]', e.message)); break;
        case '2': controller.raiseZone(zoneId).catch(e => console.error('[bridge]', e.message)); break;
        case '3': controller.lowerZone(zoneId).catch(e => console.error('[bridge]', e.message)); break;
        case '4': controller.stopZone(zoneId).catch(e => console.error('[bridge]', e.message)); break;
      }
      return;
    }

    const areaMatch = cmd.match(/^#AREA,\s*(\d+),(\d+)(?:,(\S+))?(?:,(\S+))?(?:,(\S+))?/);
    if (areaMatch) {
      const [, id, action, lvl, fade, delay] = areaMatch;
      if (action === '1') {
        const zoneId = parseInt(id);
        if (controller.areas.has(zoneId)) {
          controller.setAreaLevel(zoneId, parseFloat(lvl) || 0, fade, delay)
            .catch(e => console.error('[bridge]', e.message));
        } else if (controller.zones.has(zoneId)) {
          // ID is a zone, not an area — fall back to zone control
          controller.setZoneLevel(zoneId, parseFloat(lvl) || 0, fade, delay)
            .catch(e => console.error('[bridge]', e.message));
        } else {
          console.warn(`[bridge] #AREA ${zoneId} not found as area or zone`);
        }
      }
      return;
    }

    const deviceMatch = cmd.match(/^#DEVICE,\s*(\d+),(\d+),(\d+)/);
    if (deviceMatch) {
      const [, deviceId, component, action] = deviceMatch;
      const href = this._resolveButtonHref(parseInt(deviceId), parseInt(component), controller);
      if (href) {
        if (action === '3') controller.pressButton(href).catch(console.error);
        else if (action === '4') controller.releaseButton(href).catch(console.error);
      }
      return;
    }

    const vbMatch = cmd.match(/^#VIRTUALBUTTON,\s*(\d+),3/);
    if (vbMatch) {
      controller.pressVirtualButton(parseInt(vbMatch[1])).catch(console.error);
      return;
    }

    const shadeMatch = cmd.match(/^#SHADEGRP,\s*(\d+),(\d+)(?:,(\S+))?(?:,(\S+))?/);
    if (shadeMatch) {
      const [, id, action, lvl, delay] = shadeMatch;
      const zoneId = parseInt(id);
      switch (action) {
        case '1': controller.setZoneLevel(zoneId, parseFloat(lvl) || 0, delay || '0').catch(e => console.error('[bridge]', e.message)); break;
        case '2': controller.raiseZone(zoneId).catch(e => console.error('[bridge]', e.message)); break;
        case '3': controller.lowerZone(zoneId).catch(e => console.error('[bridge]', e.message)); break;
        case '4': controller.stopZone(zoneId).catch(e => console.error('[bridge]', e.message)); break;
      }
      return;
    }

    // Color/dimmer: #COLORSET,{id},1,{level},{R},{G},{B},{W},{fade},{delay}
    // Savant does not serialize bleColor to TCP params — RGBW fields will be empty.
    // level=0 from Savant color wheel means "keep current brightness" (sentinel).
    // Use (\d*) for RGBW so empty fields are captured as "" not misread as commas.
    const colorSetMatch = cmd.match(/^#COLORSET,\s*(\d+),1,(\d+),(\d*),(\d*),(\d*),(\d*)(?:,(\S+))?(?:,(\S+))?/);
    if (colorSetMatch) {
      const zoneId = parseInt(colorSetMatch[1]);
      const level  = parseInt(colorSetMatch[2]);
      const rStr = colorSetMatch[3], gStr = colorSetMatch[4],
            bStr = colorSetMatch[5], wStr = colorSetMatch[6];
      const fade  = colorSetMatch[7];
      const delay = colorSetMatch[8];

      const hasColor = rStr !== '' || gStr !== '' || bStr !== '' || wStr !== '';
      if (!hasColor) {
        // RGBW empty — Savant didn't serialize bleColor (TCP limitation).
        // level=0 here is Savant's sentinel for "color wheel fired, don't dim".
        // Only act if there is an explicit non-zero brightness.
        if (level > 0) {
          controller.setZoneLevel(zoneId, level, fade, delay)
            .then(() => this._send(socket, `~OUTPUT,${zoneId},1,${level}.`))
            .catch(e => console.error('[bridge]', e.message));
        }
      } else {
        // RGBW values present — convert RGB→HSV and set color.
        // Use zone's current level if Savant sent 0 (keep-brightness sentinel).
        const r = parseInt(rStr) || 0, g = parseInt(gStr) || 0,
              b = parseInt(bStr) || 0, w = parseInt(wStr) || 0;
        const zone = controller.zones.get(zoneId);
        const effectiveLevel = level > 0 ? level : Math.round(zone?.level ?? 100);
        const { hue, saturation } = rgbToHsv(r, g, b);
        controller.setZoneSpectrum(zoneId, { level: effectiveLevel, hue, saturation })
          .then(() => this._send(socket, `~COLORSET,${zoneId},1,${effectiveLevel},${r},${g},${b},${w}`))
          .catch(e => console.error('[bridge]', e.message));
      }
      return;
    }

    // Color temperature: #COLORTEMP,{id},1,{0-100}  → 1400-10000K
    const cctMatch = cmd.match(/^#COLORTEMP,\s*(\d+),1,(\S+)/);
    if (cctMatch) {
      const zoneId = parseInt(cctMatch[1]);
      const level = parseFloat(cctMatch[2]) || 0;
      const kelvin = Math.round(1400 + (level / 100) * 8600); // 0-100 → 1400-10000K
      controller.setZoneSpectrum(zoneId, { colorTemp: kelvin })
        .then(() => this._send(socket, `~COLORTEMP,${zoneId},1,${Math.round(level)}`))
        .catch(e => console.error('[bridge]', e.message));
      return;
    }

    const qMatch = cmd.match(/^\?OUTPUT,\s*(\d+)/);
    if (qMatch) {
      const zone = controller.zones.get(parseInt(qMatch[1]));
      if (zone?.level !== null) {
        this._send(socket, `~OUTPUT,${zone.id},1,${Math.round(zone.level)}.`);
      }
      return;
    }

    const qShadeMatch = cmd.match(/^\?SHADEGRP,\s*(\d+)/);
    if (qShadeMatch) {
      const zone = controller.zones.get(parseInt(qShadeMatch[1]));
      if (zone?.level !== null) {
        this._send(socket, `~SHADEGRP,${zone.id},1,${Math.round(zone.level)}.`);
      }
    }
  }

  _resolveButtonHref(deviceId, buttonNumber, controller) {
    for (const bg of controller.buttonGroups.values()) {
      if (bg.deviceId === deviceId) {
        const btn = bg.buttons.find(b => b.number === buttonNumber);
        if (btn) return btn.href;
      }
    }
    return null;
  }

  _resolveLedHref(ledHref, controller) {
    if (!ledHref || !controller) return { deviceId: null, buttonNum: null };
    for (const bg of controller.buttonGroups.values()) {
      for (const btn of bg.buttons) {
        if (btn.ledHref === ledHref) return { deviceId: bg.deviceId, buttonNum: btn.number };
      }
    }
    return { deviceId: null, buttonNum: null };
  }

  _send(socket, msg) {
    try {
      console.log(`\x1b[35m[→ savant]\x1b[0m ${msg}`);
      socket.write(msg + '\r\n');
    } catch {}
  }

  _broadcast(msg) {
    if (this.clients.size > 0) {
      console.log(`\x1b[35m[→ savant]\x1b[0m ${msg}`);
    }
    for (const socket of this.clients) {
      try { socket.write(msg + '\r\n'); } catch {}
    }
  }
}

// RGB (0-255 each) → { hue: 0-360, saturation: 0-100 }
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r)      hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else                hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { hue: Math.round(hue), saturation: Math.round(max === 0 ? 0 : (delta / max) * 100) };
}

const bridge = new ProxyBridge(controllerHolder);
bridge.start();

// ── Auto-connect if already paired ────────────────────────────────────────────

const cfg = config.load();
if (cfg.processor && config.hasCerts(cfg.processor.id)) {
  console.log(`[app] Auto-connecting to ${cfg.processor.host}...`);
  controllerHolder.reconnect().catch((err) => {
    console.error('[app] Auto-connect failed:', err.message);
  });
} else {
  console.log('[app] No paired processor. Open http://localhost:47200 to set up.');
}
