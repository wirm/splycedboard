/**
 * Savant TCP Bridge — port 8023
 *
 * Speaks the same protocol as Lutron HomeworksQS telnet, so Savant profiles
 * written for HomeworksQS work unchanged (just point Address/Host to this bridge).
 *
 * Inbound commands from Savant:
 *   #OUTPUT, {zoneId},1,{level},{fade},{delay}  → set zone level
 *   #OUTPUT, {zoneId},2                          → raise zone
 *   #OUTPUT, {zoneId},3                          → lower zone
 *   #OUTPUT, {zoneId},4                          → stop zone
 *   #DEVICE, {deviceId},{component},{action}     → button press/release
 *   #AREA, {areaId},1,{level},{fade},{delay}     → set area level
 *   #VIRTUALBUTTON, {vbId},3                     → recall scene
 *
 * Outbound feedback to Savant:
 *   ~OUTPUT,{zoneId},1,{level}.
 *   ~DEVICE,{deviceId},{buttonNum},09,{ledState}
 *   ~AREA,{areaId},1,{level}.
 */
const net = require('net');

const BRIDGE_PORT = 8023;

class SavantTcpBridge {
  constructor(controller) {
    this.controller = controller;
    this.server = null;
    this.clients = new Set();

    // Forward zone updates to all connected Savant clients
    controller.on('zoneUpdate', ({ zone }) => {
      this._broadcast(`~OUTPUT,${zone.id},1,${Math.round(zone.level ?? 0)}.`);
    });

    // Forward LED/device events
    controller.on('ledUpdate', ({ ledHref, state }) => {
      // Map LED href back to device + button IDs
      const { deviceId, buttonNum } = this._resolveLedHref(ledHref);
      if (deviceId !== null) {
        const stateCode = state === 'On' ? '01' : '00';
        this._broadcast(`~DEVICE,${deviceId},${buttonNum},09,${stateCode}`);
      }
    });
  }

  start() {
    this.server = net.createServer((socket) => this._onClient(socket));
    this.server.listen(BRIDGE_PORT, '0.0.0.0', () => {
      console.log(`[bridge] Savant TCP bridge listening on port ${BRIDGE_PORT}`);
    });
    this.server.on('error', (err) => {
      console.error('[bridge] Server error:', err.message);
    });
  }

  _onClient(socket) {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[bridge] Savant connected from ${addr}`);
    this.clients.add(socket);

    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30000);

    // Send current zone levels on connect
    if (this.controller.ready) {
      this._sendInitialState(socket);
    }

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this._handleCommand(socket, trimmed);
      }
    });

    socket.on('close', () => {
      console.log(`[bridge] Savant disconnected from ${addr}`);
      this.clients.delete(socket);
    });

    socket.on('error', (err) => {
      console.error(`[bridge] Client error from ${addr}: ${err.message}`);
      this.clients.delete(socket);
    });
  }

  _sendInitialState(socket) {
    for (const zone of this.controller.zones.values()) {
      if (zone.level !== null) {
        this._send(socket, `~OUTPUT,${zone.id},1,${Math.round(zone.level)}.`);
      }
    }
  }

  _handleCommand(socket, line) {
    // Remove trailing whitespace and handle QNET> prompt prefix if present
    const cmd = line.replace(/^QNET>\s*/, '').trim().toUpperCase();

    // ── #OUTPUT ──────────────────────────────────────────────────────────────
    // #OUTPUT, {id},{action}[,{level},{fade},{delay}]
    const outputMatch = cmd.match(/^#OUTPUT,\s*(\d+),(\d+)(?:,(\S+))?(?:,(\S+))?(?:,(\S+))?/);
    if (outputMatch) {
      const [, idStr, action, levelStr, fadeStr, delayStr] = outputMatch;
      const zoneId = parseInt(idStr, 10);
      this._handleOutput(zoneId, action, levelStr, fadeStr, delayStr);
      return;
    }

    // ── #AREA ─────────────────────────────────────────────────────────────────
    const areaMatch = cmd.match(/^#AREA,\s*(\d+),(\d+)(?:,(\S+))?(?:,(\S+))?(?:,(\S+))?/);
    if (areaMatch) {
      const [, idStr, action, levelStr, fadeStr, delayStr] = areaMatch;
      const areaId = parseInt(idStr, 10);
      this._handleArea(areaId, action, levelStr, fadeStr, delayStr);
      return;
    }

    // ── #DEVICE ───────────────────────────────────────────────────────────────
    // #DEVICE, {deviceId},{component},{action}
    const deviceMatch = cmd.match(/^#DEVICE,\s*(\d+),(\d+),(\d+)/);
    if (deviceMatch) {
      const [, deviceIdStr, componentStr, actionStr] = deviceMatch;
      this._handleDevice(parseInt(deviceIdStr, 10), parseInt(componentStr, 10), parseInt(actionStr, 10));
      return;
    }

    // ── #VIRTUALBUTTON ────────────────────────────────────────────────────────
    const vbMatch = cmd.match(/^#VIRTUALBUTTON,\s*(\d+),(\d+)/);
    if (vbMatch) {
      const [, idStr, action] = vbMatch;
      if (action === '3') {
        this.controller.pressVirtualButton(parseInt(idStr, 10)).catch(console.error);
      }
      return;
    }

    // Query commands — respond with current state
    const qOutputMatch = cmd.match(/^\?OUTPUT,\s*(\d+)/);
    if (qOutputMatch) {
      const zoneId = parseInt(qOutputMatch[1], 10);
      const zone = this.controller.zones.get(zoneId);
      if (zone && zone.level !== null) {
        this._send(socket, `~OUTPUT,${zoneId},1,${Math.round(zone.level)}.`);
      }
      return;
    }
  }

  _handleOutput(zoneId, action, levelStr, fadeStr, delayStr) {
    const ctrl = this.controller;
    switch (action) {
      case '1': {
        const level = parseFloat(levelStr) || 0;
        ctrl.setZoneLevel(zoneId, level, fadeStr, delayStr).catch((e) =>
          console.error(`[bridge] setZoneLevel ${zoneId} error: ${e.message}`)
        );
        break;
      }
      case '2':
        ctrl.raiseZone(zoneId).catch((e) =>
          console.error(`[bridge] raise ${zoneId} error: ${e.message}`)
        );
        break;
      case '3':
        ctrl.lowerZone(zoneId).catch((e) =>
          console.error(`[bridge] lower ${zoneId} error: ${e.message}`)
        );
        break;
      case '4':
        ctrl.stopZone(zoneId).catch((e) =>
          console.error(`[bridge] stop ${zoneId} error: ${e.message}`)
        );
        break;
      default:
        console.warn(`[bridge] Unknown OUTPUT action: ${action}`);
    }
  }

  _handleArea(areaId, action, levelStr, fadeStr, delayStr) {
    if (action === '1') {
      const level = parseFloat(levelStr) || 0;
      this.controller
        .setAreaLevel(areaId, level, fadeStr, delayStr)
        .catch((e) => console.error(`[bridge] setAreaLevel ${areaId} error: ${e.message}`));
    }
  }

  _handleDevice(deviceId, component, action) {
    // Find button href from button group
    const href = this._resolveButtonHref(deviceId, component);
    if (!href) {
      console.warn(`[bridge] Button not found: device ${deviceId} component ${component}`);
      return;
    }
    if (action === 3) {
      this.controller.pressButton(href).catch(console.error);
    } else if (action === 4) {
      this.controller.releaseButton(href).catch(console.error);
    } else if (action === 0) {
      // Press and release
      this.controller.pressButton(href)
        .then(() => new Promise(r => setTimeout(r, 100)))
        .then(() => this.controller.releaseButton(href))
        .catch(console.error);
    }
  }

  _resolveButtonHref(deviceId, buttonNumber) {
    for (const bg of this.controller.buttonGroups.values()) {
      if (bg.deviceId === deviceId) {
        const btn = bg.buttons.find((b) => b.number === buttonNumber);
        if (btn) return btn.href;
      }
    }
    return null;
  }

  _resolveLedHref(ledHref) {
    if (!ledHref) return { deviceId: null, buttonNum: null };
    for (const bg of this.controller.buttonGroups.values()) {
      for (const btn of bg.buttons) {
        if (btn.ledHref === ledHref) {
          return { deviceId: bg.deviceId, buttonNum: btn.number };
        }
      }
    }
    return { deviceId: null, buttonNum: null };
  }

  _send(socket, msg) {
    try {
      socket.write(msg + '\r\n');
    } catch {}
  }

  _broadcast(msg) {
    for (const socket of this.clients) {
      this._send(socket, msg);
    }
  }

  stop() {
    this.server?.close();
  }
}

module.exports = { SavantTcpBridge, BRIDGE_PORT };
