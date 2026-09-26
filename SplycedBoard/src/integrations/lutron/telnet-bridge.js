/**
 * Savant telnet bridge — TCP port 8023
 *
 * Speaks the Lutron HomeWorks QS integration (telnet) protocol, so anything that
 * talks to a HomeWorks QS processor — e.g. a TCP Savant profile, or a monitoring
 * connection that wants push feedback — can drive the LEAP system through here.
 *
 * Commands (Savant → bridge):
 *   #OUTPUT,{zone},1,{level}[,{fade},{delay}]       set zone level
 *   #OUTPUT,{zone},2 | 3 | 4                         raise | lower | stop
 *   #AREA,{area},1,{level}...                        set area level (falls back to a zone with that ID)
 *   #SHADEGRP,{zone},1,{level}... / 2 | 3 | 4        shade level | raise | lower | stop
 *   #DEVICE,{device},{button},3 | 4                  keypad button press | release
 *   #VIRTUALBUTTON,{id},3                            recall scene
 *   #COLORSET,{zone},1,{level},{R},{G},{B},{W}...    Ketra color (level 0 = keep brightness)
 *   #COLORTEMP,{zone},1,{0-100}                      color temperature, 1400–10000 K
 *   ?OUTPUT,{zone} | ?SHADEGRP,{zone}                query level
 *
 * Feedback (bridge → Savant):
 *   ~OUTPUT,{zone},1,{level}.    ~SHADEGRP,{zone},1,{level}.    ~DEVICE,{device},{button},09,{01|00}
 *   ~DEVICE,{device},{button},3 | 4 | 5 | 6                     button press | release | hold | multi-tap
 *   ~COLORSET,{zone},1,{level},{R},{G},{B},{W}                  ~COLORTEMP,{zone},1,{0-100}
 */
const net = require('net');

const { listen, close } = require('../../core/net');
const { rgbToHsv, cctLevelToKelvin } = require('./color');

const TELNET_PORT = 8023;

class TelnetBridge {
  /**
   * @param getController  () => LeapController | null — the controller can be replaced on re-pair
   */
  constructor({ port = TELNET_PORT, log, getController }) {
    this.port = port;
    this.log = log;
    this.getController = getController;
    this.server = null;
    this.clients = new Set();
  }

  async start() {
    this.server = net.createServer((socket) => this._onClient(socket));
    await listen(this.server, this.port);
    this.server.on('error', (err) => this.log.error('Server error:', err.message));
    this.log.info(`Listening on port ${this.port}`);
  }

  async stop() {
    await close(this.server, this.clients);
    this.clients.clear();
    this.server = null;
  }

  // ── Feedback, driven by controller events ──────────────────────────────────

  zoneChanged(zone) {
    this._broadcast(levelFeedback(zone));
  }

  ledChanged(ledHref, state) {
    const btn = this.getController()?.findLedButton(ledHref);
    if (btn) this._broadcast(`~DEVICE,${btn.deviceId},${btn.buttonNumber},09,${state === 'On' ? '01' : '00'}`);
  }

  /** A keypad button event, numbered as the HomeWorks QS protocol numbers them. */
  buttonEvent(deviceId, buttonNumber, event) {
    const action = { Press: 3, Release: 4, Hold: 5, LongHold: 5, MultiTap: 6 }[event];
    if (action) this._broadcast(`~DEVICE,${deviceId},${buttonNumber},${action}`);
  }

  /** Push every known zone level — on connect, and whenever the controller (re)loads inventory. */
  sendInitialState(socket = null) {
    const controller = this.getController();
    if (!controller?.ready) return;
    for (const zone of controller.zones.values()) {
      if (zone.level === null) continue;
      if (socket) this._send(socket, levelFeedback(zone));
      else this._broadcast(levelFeedback(zone));
    }
  }

  // ── Connections ────────────────────────────────────────────────────────────

  _onClient(socket) {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    this.log.info(`Savant connected from ${addr}`);
    this.clients.add(socket);
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30000);

    this.sendInitialState(socket);

    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.log.debug(`← savant ${trimmed}`);
        this._handleCommand(socket, trimmed);
      }
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      this.log.info(`Savant disconnected from ${addr}`);
    });
    socket.on('error', () => this.clients.delete(socket));
  }

  _send(socket, msg) {
    this.log.debug(`→ savant ${msg}`);
    try { socket.write(msg + '\r\n'); } catch { /* socket closing */ }
  }

  _broadcast(msg) {
    if (!this.clients.size) return;
    this.log.debug(`→ savant ${msg}`);
    for (const socket of this.clients) {
      try { socket.write(msg + '\r\n'); } catch { /* socket closing */ }
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  _handleCommand(socket, line) {
    const controller = this.getController();
    if (!controller) return;

    const cmd = line.replace(/^QNET>\s*/, '').trim().toUpperCase();
    const fail = (e) => this.log.error(`${cmd}: ${e.message}`);
    let m;

    if ((m = cmd.match(/^#OUTPUT,\s*(\d+),(\d+)(?:,(\S+))?/))) {
      const [, id, action, lvl] = m;
      zoneAction(controller, parseInt(id, 10), action, lvl)?.catch(fail);
      return;
    }

    if ((m = cmd.match(/^#AREA,\s*(\d+),(\d+)(?:,(\S+))?/))) {
      const [, id, action, lvl] = m;
      if (action !== '1') return;
      const areaId = parseInt(id, 10);
      const level = parseFloat(lvl) || 0;
      if (controller.areas.has(areaId)) {
        controller.setAreaLevel(areaId, level).catch(fail);
      } else if (controller.zones.has(areaId)) {
        controller.setZoneLevel(areaId, level).catch(fail); // ID is a zone, not an area
      } else {
        this.log.warn(`#AREA ${areaId} not found as area or zone`);
      }
      return;
    }

    if ((m = cmd.match(/^#DEVICE,\s*(\d+),(\d+),(\d+)/))) {
      const [, deviceId, component, action] = m;
      const href = controller.findButtonHref(parseInt(deviceId, 10), parseInt(component, 10));
      if (!href) {
        this.log.warn(`Button not found: device ${deviceId} button ${component}`);
      } else if (action === '3') {
        controller.pressButton(href).catch(fail);
      } else if (action === '4') {
        controller.releaseButton(href).catch(fail);
      }
      return;
    }

    if ((m = cmd.match(/^#VIRTUALBUTTON,\s*(\d+),3/))) {
      controller.pressVirtualButton(parseInt(m[1], 10)).catch(fail);
      return;
    }

    if ((m = cmd.match(/^#SHADEGRP,\s*(\d+),(\d+)(?:,(\S+))?/))) {
      const [, id, action, lvl] = m;
      zoneAction(controller, parseInt(id, 10), action, lvl)?.catch(fail);
      return;
    }

    // #COLORSET,{id},1,{level},{R},{G},{B},{W}[,{fade},{delay}]
    // Savant can't serialize bleColor values over TCP, so RGBW usually arrive empty;
    // (\d*) keeps empty fields as "" instead of misreading the commas.
    if ((m = cmd.match(/^#COLORSET,\s*(\d+),1,(\d+),(\d*),(\d*),(\d*),(\d*)/))) {
      const zoneId = parseInt(m[1], 10);
      const level = parseInt(m[2], 10);
      const [rStr, gStr, bStr, wStr] = m.slice(3, 7);

      if (rStr === '' && gStr === '' && bStr === '' && wStr === '') {
        // No color values. Level 0 here is Savant's "color wheel fired, don't dim"
        // sentinel, so only act on an explicit brightness.
        if (level > 0) {
          controller.setZoneLevel(zoneId, level)
            .then(() => this._send(socket, `~OUTPUT,${zoneId},1,${level}.`))
            .catch(fail);
        }
        return;
      }

      const r = parseInt(rStr, 10) || 0;
      const g = parseInt(gStr, 10) || 0;
      const b = parseInt(bStr, 10) || 0;
      const w = parseInt(wStr, 10) || 0;
      const zone = controller.zones.get(zoneId);
      const effectiveLevel = level > 0 ? level : Math.round(zone?.level ?? 100);
      const { hue, saturation } = rgbToHsv(r, g, b);
      controller.setZoneSpectrum(zoneId, { level: effectiveLevel, hue, saturation })
        .then(() => this._send(socket, `~COLORSET,${zoneId},1,${effectiveLevel},${r},${g},${b},${w}`))
        .catch(fail);
      return;
    }

    if ((m = cmd.match(/^#COLORTEMP,\s*(\d+),1,(\S+)/))) {
      const zoneId = parseInt(m[1], 10);
      const level = parseFloat(m[2]) || 0;
      controller.setZoneSpectrum(zoneId, { colorTemp: cctLevelToKelvin(level) })
        .then(() => this._send(socket, `~COLORTEMP,${zoneId},1,${Math.round(level)}`))
        .catch(fail);
      return;
    }

    if ((m = cmd.match(/^\?(OUTPUT|SHADEGRP),\s*(\d+)/))) {
      const zone = controller.zones.get(parseInt(m[2], 10));
      if (zone && zone.level !== null) this._send(socket, `~${m[1]},${zone.id},1,${Math.round(zone.level)}.`);
      return;
    }

    this.log.debug(`Ignored unsupported command: ${cmd}`);
  }
}

function levelFeedback(zone) {
  const level = Math.round(zone.level ?? 0);
  return zone.type === 'shade' ? `~SHADEGRP,${zone.id},1,${level}.` : `~OUTPUT,${zone.id},1,${level}.`;
}

/** Shared by #OUTPUT and #SHADEGRP: 1 = set level, 2 = raise, 3 = lower, 4 = stop. */
function zoneAction(controller, zoneId, action, lvl) {
  switch (action) {
    case '1': return controller.setZoneLevel(zoneId, parseFloat(lvl) || 0);
    case '2': return controller.raiseZone(zoneId);
    case '3': return controller.lowerZone(zoneId);
    case '4': return controller.stopZone(zoneId);
    default: return null;
  }
}

module.exports = { TelnetBridge, TELNET_PORT };
