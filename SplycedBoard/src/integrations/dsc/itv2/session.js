/**
 * The ITv2 integration session. The panel's communicator dials SplycedBoard (the integration
 * server it's programmed with, [851][428]/[429]); SplycedBoard listens, opens the session
 * (handshake.js), keeps it alive, decodes what the panel reports into a PanelState, and sends
 * the dashboard's commands.
 *
 * Sequence numbers, as the working open-source servers use them:
 *   - our packet sequence starts at 1; answers (CommandResponse, Simple Ack) reuse it, every
 *     new message we start (a command, a poll) adds one first
 *   - an answer's ack field is the sequence of the packet it answers; a new message's, the
 *     last sequence the panel sent
 *   - the command sequence is shared: we take the panel's whenever it sends a command, and
 *     add one for each command we send. A CommandResponse repeats the one it answers.
 *
 * Every packet is logged both ways (onMessage), decoded, with user codes masked.
 */
const net = require('net');

const { listen, close } = require('../../../core/net');
const { frame, Deframer, toHex } = require('./frame');
const { encode, decodeAll } = require('./packet');
const { build, read, unpack } = require('./messages');
const { name, ARM_MODE, RESPONSE, NACK } = require('./codes');
const { Handshake, validateCredentials } = require('./handshake');

const DEFAULT_PORT = 3072;
const TIMING = {
  responseMs: 12000, // a command's CommandResponse (a Pro took 8s to answer a status request)
  quietMs: 2000, // after opening, the panel replays what it queued and ignores us until it's done
  pollMs: 50 * 1000, // the communicator drops a session that's quiet for its inactivity timeout ([851][711])
  idleMs: 4 * 60 * 1000, // nothing from the panel for this long: drop the connection
};
// Shown in the message log only when asked for
const ROUTINE = new Set([0x0600]);
// Commands whose payload ends with a user code: masked in the log
const WITH_CODE = new Set([0x0900, 0x0901]);

const next = (n) => (n + 1) & 0xff;
// A request's answer can come back as 4xxx (a "response") rather than 0xxx
const base = (cmd) => ((cmd & 0xf000) === 0x4000 ? cmd & 0x0fff : cmd);

class Itv2Session {
  constructor({ log, panel, port, integrationId, accessCode, onStatus = () => {}, onMessage = () => {}, timing = {}, random }) {
    Object.assign(this, { log, panel, port, integrationId, accessCode, onStatus, onMessage });
    this.timing = { ...TIMING, ...timing };
    this.random = random;
    this.server = null;
    this.socket = null;
    this.timers = {};
    this.state = 'idle'; // idle | listening | handshaking | connected | error
    this.error = null;
    this.peer = null;
    this.since = null;
    this.lastMessageAt = null;
    this.panelId = null; // the 12-character header the panel's messages carry
    this.queue = []; // commands waiting their turn: { cmd, payload, describe, query, resolve, reject }
    this.inFlight = null; // the one sent, until it's answered
    this._newSession();
  }

  _newSession() {
    this.seq = 1;
    this.remoteSeq = 0;
    this.cmdSeq = 0;
    this.header = Buffer.alloc(0);
    this.handshake = new Handshake({ integrationId: this.integrationId, accessCode: this.accessCode, random: this.random });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start() {
    const problem = validateCredentials(this.integrationId, this.accessCode);
    if (problem) {
      this._setState('idle', problem);
      return;
    }
    this.server = net.createServer((socket) => this._accept(socket));
    try {
      await listen(this.server, this.port);
    } catch (err) {
      this.server = null;
      this._setState('error', err.message);
      return;
    }
    this._info(`Listening on port ${this.port} for the panel`);
    this._setState('listening', null);
  }

  async stop() {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
    this._failPending(new Error('Session closed'));
    const socket = this.socket;
    this.socket = null;
    await close(this.server, socket ? [socket] : []);
    this.server = null;
    this.state = 'idle';
  }

  status() {
    const connected = this.state === 'connected';
    const text = {
      idle: this.error || 'Not set up',
      listening: `Waiting for the panel to connect on port ${this.port}`,
      handshaking: `Panel connected (${this.peer}), opening the session…`,
      connected: `Connected to the panel (${this.peer})`,
      error: this.error || 'Error',
    }[this.state];
    const level = { idle: 'idle', listening: 'warn', handshaking: 'warn', connected: 'ok', error: 'error' }[this.state];
    return {
      level, text, connected,
      state: this.state,
      peer: this.peer,
      panelId: this.panelId,
      since: this.since,
      lastMessageAt: this.lastMessageAt,
      encryption: this.handshake.describe(),
      error: this.error,
    };
  }

  _setState(state, error) {
    this.state = state;
    if (error !== undefined) this.error = error;
    this.onStatus();
  }

  // ── The connection ───────────────────────────────────────────────────────

  _accept(socket) {
    const from = `${String(socket.remoteAddress || '').replace(/^::ffff:/, '')}:${socket.remotePort}`;
    if (this.socket) {
      this._info(`A new connection from ${from} replaces the one from ${this.peer}`);
      this.socket.destroy();
    }
    this._failPending(new Error('The panel reconnected'));
    this._newSession();
    this.socket = socket;
    this.peer = from;
    this.since = Date.now();
    socket.setNoDelay(true);
    const deframer = new Deframer({ onError: (err) => this._error(`Unreadable frame: ${err.message}`) });
    socket.on('data', (chunk) => {
      if (this.socket !== socket) return;
      for (const message of deframer.push(chunk)) this._onMessage(message);
    });
    socket.on('error', (err) => this._info(`Connection error: ${err.message}`));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this._failPending(new Error('The panel disconnected'));
      for (const t of ['poll', 'idle', 'quiet', 'status']) clearTimeout(this.timers[t]);
      this.panel.clearLive();
      this._info(`The panel disconnected (${from})`);
      if (this.server) this._setState('listening', null);
    });
    this._info(`The panel connected from ${from}`);
    this._setState('handshaking', null);
    this._touch();
  }

  // ── Receiving ────────────────────────────────────────────────────────────

  _onMessage({ header, body }) {
    this._touch();
    if (header.length) {
      this.header = header; // sent back on everything we send
      const id = header.toString('latin1');
      if (id !== this.panelId) {
        this.panelId = id;
        this._info(`Panel integration ID ${id}${id.toUpperCase() === String(this.integrationId).toUpperCase() ? '' : ` (settings say ${this.integrationId})`}`);
        this.onStatus();
      }
    }
    const plain = this.handshake.decrypt(body);
    const packets = decodeAll(plain);
    if (!packets.length) {
      this._error(`Unreadable message${plain === body ? '' : ' (decrypted)'}: ${toHex(plain)}${this.handshake.rxKey ? ' — wrong access code?' : ''}`);
      return;
    }
    for (const p of packets) this._onPacket(p);
  }

  _onPacket(p) {
    if (!p.crcOk) {
      this._log('in', p, `CRC mismatch, ignored${this.handshake.rxKey ? ' (wrong access code?)' : ''}`);
      return;
    }
    this.remoteSeq = p.seq;
    if (p.appSeq != null) this.cmdSeq = p.appSeq; // the panel's command: its sequence is ours now

    if (!this.handshake.ready || p.cmd === 0x060a) {
      const wasReady = this.handshake.ready;
      const { replies, description, ready, failed } = this.handshake.receive(p);
      this._log('in', p, description, p.cmd == null);
      if (wasReady && p.cmd === 0x060a) {
        this._info('The panel started the session over');
        this._setState('handshaking', null);
        this._failPending(new Error('The panel started the session over'));
      }
      for (const r of replies) this._reply(p, r);
      if (failed) this._error(failed);
      if (ready) this._sessionOpen();
      return;
    }

    // An open session.
    if (p.cmd == null) {
      this._log('in', p, 'Ack', true);
      return;
    }
    const cmd = base(p.cmd);
    if (cmd === 0x0623) {
      // Several messages in one: read each, acknowledge the lot once.
      const parts = unpack(p.payload);
      this._log('in', p, `${parts.length} messages in one`);
      for (const part of parts) {
        const sub = base(part.cmd);
        this.onMessage({ dir: 'in', text: `  · ${this._read(sub, part.body)}`, hex: null, routine: ROUTINE.has(sub), cmd: sub });
      }
    } else {
      let text;
      if (cmd === 0x0502) text = this._settle(p);
      else if (cmd === 0x0501) text = this._refused(p);
      else text = this._read(cmd, p.payload);
      this._log('in', p, text, ROUTINE.has(cmd));
    }
    // The panel's commands get a CommandResponse, everything else an ack.
    this._reply(p, p.appSeq != null ? { type: 'respond', code: 0 } : { type: 'ack' });
    this._quietThenRefresh();
  }

  /** A panel message, applied to the panel state; its description for the log. */
  _read(cmd, payload) {
    const text = read(cmd, payload, this.panel) ?? `${name(cmd)} ${toHex(payload)}`;
    if (cmd === 0x0613) this._askStatus(); // now we know how many zones and partitions to ask about
    return text;
  }

  _sessionOpen() {
    this._setState('connected', null);
    this._info(`Session open (${this.handshake.describe()})`);
    this.refreshWanted = true;
    this._quietThenRefresh();
    this._schedulePoll();
  }

  /** Asks for the panel's status once it has gone quiet: it ignores us while replaying. */
  _quietThenRefresh() {
    if (!this.refreshWanted) return;
    clearTimeout(this.timers.quiet);
    this.timers.quiet = setTimeout(() => {
      if (this.state !== 'connected' || !this.refreshWanted) return;
      this.refreshWanted = false;
      this.refresh();
    }, this.timing.quietMs);
  }

  _settle(p) {
    const [cmdSeq, code] = p.payload;
    const c = this.inFlight?.cmdSeq === cmdSeq ? this.inFlight : null;
    const result = RESPONSE[code] || `code ${code}`;
    // A request's CommandResponse only says it was taken (the data follows on its own), and
    // code 01 there isn't a failure either.
    if (c) this._finish(c, code === 0 || (c.query && code === 0x01) ? null : new Error(result));
    return `Response to #${cmdSeq}${c ? ` (${c.describe})` : ''}: ${result}`;
  }

  _refused(p) {
    const failed = p.payload.length >= 2 ? p.payload.readUInt16BE(0) : null;
    const why = NACK[p.payload[2]] || `code ${p.payload[2]}`;
    if (this.inFlight && this.inFlight.cmd === failed) this._finish(this.inFlight, new Error(`The panel refused it: ${why}`));
    return `Refused ${failed == null ? '?' : name(failed)}: ${why}`;
  }

  _failPending(err) {
    const all = [...(this.inFlight ? [this.inFlight] : []), ...this.queue];
    if (this.inFlight) clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    this.queue = [];
    for (const c of all) c.reject(Object.assign(new Error(err.message), { status: 409 }));
  }

  _touch() {
    this.lastMessageAt = Date.now();
    clearTimeout(this.timers.idle);
    this.timers.idle = setTimeout(() => {
      this._error(`Nothing from the panel for ${Math.round(this.timing.idleMs / 1000)}s; dropping the connection`);
      this.socket?.destroy();
    }, this.timing.idleMs);
  }

  _schedulePoll() {
    clearTimeout(this.timers.poll);
    this.timers.poll = setTimeout(() => {
      if (this.state !== 'connected') return;
      this._start(0x0600, null, { describe: 'Poll' });
      this._schedulePoll();
    }, this.timing.pollMs);
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  /** Answers packet p: { type: 'respond', code } | { type: 'ack' } | { type: 'send', cmd, payload, describe } */
  _reply(p, r) {
    if (r.type === 'send') {
      this._start(r.cmd, r.payload, { describe: r.describe, withCmdSeq: true });
    } else if (r.type === 'respond') {
      this._write({ seq: this.seq, ack: p.seq, cmd: 0x0502, payload: Buffer.from([p.appSeq ?? 0, r.code]) }, `Response: ${RESPONSE[r.code] || `code ${r.code}`}`);
    } else {
      this._write({ seq: this.seq, ack: p.seq }, 'Ack', true);
    }
  }

  /** A new message of ours; returns its command sequence, if it has one. */
  _start(cmd, payload, { describe, withCmdSeq = false } = {}) {
    this.seq = next(this.seq);
    let appSeq = null;
    if (withCmdSeq) {
      this.cmdSeq = next(this.cmdSeq);
      appSeq = this.cmdSeq;
    }
    this._write({ seq: this.seq, ack: this.remoteSeq, cmd, appSeq, payload: payload || Buffer.alloc(0) }, describe || name(cmd), ROUTINE.has(cmd));
    return appSeq;
  }

  _write(packet, text, routine = false) {
    if (!this.socket) return;
    const plain = encode(packet);
    this._log('out', { ...packet, raw: plain }, text, routine);
    try {
      this.socket.write(frame(this.handshake.encrypt(plain), this.header));
    } catch (err) {
      this._error(`Couldn't send: ${err.message}`);
    }
  }

  /**
   * Sends a command and waits for its CommandResponse. Commands go one at a time, each once the
   * one before is answered (or times out), as the open-source servers do.
   */
  _command(cmd, payload, describe, { query = false } = {}) {
    if (this.state !== 'connected') return Promise.reject(Object.assign(new Error('The panel is not connected'), { status: 409 }));
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, payload, describe, query, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    if (this.inFlight || !this.queue.length || this.state !== 'connected') return;
    const c = this.queue.shift();
    this.inFlight = c;
    c.cmdSeq = this._start(c.cmd, c.payload, { describe: c.describe, withCmdSeq: true });
    c.timer = setTimeout(() => this._finish(c, Object.assign(new Error('The panel did not answer'), { status: 504 })), this.timing.responseMs);
  }

  _finish(c, err) {
    if (this.inFlight !== c) return;
    clearTimeout(c.timer);
    this.inFlight = null;
    if (err) c.reject(Object.assign(err, { status: err.status || 409 }));
    else c.resolve(RESPONSE[0]);
    this._pump();
  }

  arm(partition, mode, code) {
    return this._command(0x0900, build.arm(partition, ARM_MODE[mode], code), `Arm ${mode}, partition ${partition}`);
  }

  disarm(partition, code) {
    return this._command(0x0901, build.disarm(partition, code), `Disarm partition ${partition}`);
  }

  /**
   * Asks for everything the dashboard shows; the answers arrive as messages. First how many
   * zones and partitions the panel has (its answer sends the rest of the questions), then,
   * should it not answer, as if it had one partition and 64 zones.
   */
  refresh() {
    if (this.state !== 'connected') return;
    this.statusAsked = false;
    this._ask(build.capabilities(), 'Request system capabilities');
    clearTimeout(this.timers.status);
    this.timers.status = setTimeout(() => this._askStatus(), this.timing.responseMs + 1000);
  }

  /** Status first, then labels: partitions one by one, zones 128 a time, zone labels 8 a time. */
  _askStatus() {
    clearTimeout(this.timers.status);
    if (this.state !== 'connected' || this.statusAsked) return;
    this.statusAsked = true;
    const partitions = Math.min(this.panel.info.maxPartitions || 1, 32);
    const zones = Math.min(this.panel.info.maxZones || 64, 248);
    for (let p = 1; p <= partitions; p++) this._ask(build.partitionStatus(p), `Request partition ${p} status`);
    for (let first = 1; first <= zones; first += 128) {
      const count = Math.min(128, zones - first + 1);
      this._ask(build.zoneStatus(first, count), `Request zones ${first}–${first + count - 1}`);
    }
    this._ask(build.labels('partition', 1, partitions), 'Request partition labels');
    for (let first = 1; first <= zones; first += 8) {
      const last = Math.min(first + 7, zones);
      this._ask(build.labels('zone', first, last), `Request zone labels ${first}–${last}`);
    }
  }

  _ask(payload, what) {
    this._command(0x0800, payload, what, { query: true }).catch((err) => this._info(`${what}: ${err.message}`));
  }

  // ── Log ──────────────────────────────────────────────────────────────────

  _log(dir, p, text, routine = false) {
    let raw = p.raw ? Buffer.from(p.raw) : null;
    let shown = text;
    if (raw && dir === 'out' && WITH_CODE.has(p.cmd)) {
      // The user code is the payload's last bytes, just before the CRC.
      const codeBytes = p.payload.length - (p.cmd === 0x0900 ? 3 : 2);
      for (let i = raw.length - 2 - codeBytes; i < raw.length - 2; i++) raw[i] = 0;
      shown = `${text} (code masked)`;
    }
    this.onMessage({ dir, text: shown, hex: raw ? toHex(raw) : null, routine, cmd: p.cmd ?? null });
  }

  _info(text) {
    this.log.info(text);
    this.onMessage({ dir: 'info', text });
  }

  _error(text) {
    this.log.warn(text);
    this.onMessage({ dir: 'error', text });
  }
}

module.exports = { Itv2Session, DEFAULT_PORT, TIMING, validateCredentials };
