/**
 * One paired Apple TV.
 *
 * Keeps an encrypted Companion connection open so Savant commands go out immediately and
 * power/playback changes are pushed to us. Reconnects with backoff, and if a command hits
 * a connection that went stale, reconnects and retries it once.
 *
 * Events: 'change' (state or record changed)
 */
const { EventEmitter } = require('events');

const { AppleTvRemote, Hid, MediaControl, MediaFlags } = require('./companion/remote');
const { probe } = require('./discovery');

const ATTENTION = { 0: 'unknown', 1: 'asleep', 2: 'screensaver', 3: 'awake', 4: 'idle' };
const CONNECT_TIMEOUT_MS = 5000;
const READY_TIMEOUT_MS = 8000;
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 60000;
const FAIL_FAST_MS = 2000;
const DEFAULT_SKIP_SECONDS = 10;
// Nothing we knew about the Apple TV holds once the connection is gone.
const DISCONNECTED = { connection: 'disconnected', attention: 'unknown', power: 'unknown', mediaFlags: null };
// Errors worth asking the Apple TV (via DNS-SD) whether its Companion port moved.
const PORT_ERRORS = new Set(['ECONNREFUSED', 'ETIMEDOUT']);

/** Remote buttons: command name → HID code */
const BUTTONS = {
  up: Hid.Up,
  down: Hid.Down,
  left: Hid.Left,
  right: Hid.Right,
  select: Hid.Select,
  menu: Hid.Menu,
  back: Hid.Menu,
  home: Hid.Home,
  playpause: Hid.PlayPause,
  volumeup: Hid.VolumeUp,
  volumedown: Hid.VolumeDown,
  siri: Hid.Siri,
  screensaver: Hid.Screensaver,
  channelup: Hid.ChannelIncrement,
  channeldown: Hid.ChannelDecrement,
  guide: Hid.Guide,
  pageup: Hid.PageUp,
  pagedown: Hid.PageDown,
};

const OTHER_COMMANDS = [
  'play', 'pause', 'stop', 'next', 'previous', 'skipforward', 'skipbackward',
  'poweron', 'poweroff', 'powertoggle', 'release',
];

const COMMANDS = [...Object.keys(BUTTONS), ...OTHER_COMMANDS];

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const isConnectionError = (err) => !!err.timeout || /not connected|connection closed/i.test(err.message);

class AppleTvDevice extends EventEmitter {
  /**
   * @param record    { id, name, address, host?, port, model, pairedAt, credentials }
   *                  address = what Savant sends; host (optional) = where to connect if different
   * @param identity  how SplycedBoard introduces itself to the Apple TV
   */
  constructor(record, { identity, log }) {
    super();
    this.record = record;
    this.identity = identity;
    this.log = log;
    this.remote = null;
    this.connecting = null;
    this.running = false;
    this.timer = null;
    this.delay = RECONNECT_MIN_MS;
    this.failures = 0;
    this.lastFailure = null; // { at, message } of the last failed connect
    this.queue = Promise.resolve(); // commands to one Apple TV run one at a time
    this.state = { ...DISCONNECTED, error: null };
  }

  get id() {
    return this.record.id;
  }

  get label() {
    return `${this.record.name} (${this.record.address})`;
  }

  get host() {
    return this.record.host || this.record.address;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    this.running = true;
    this._connect().catch(() => {});
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    const remote = this.remote;
    this.remote = null;
    if (remote) await remote.close();
    this._set(DISCONNECTED);
  }

  _connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this._doConnect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async _doConnect() {
    this._set({ connection: 'connecting' });
    const { port, credentials } = this.record;
    const remote = new AppleTvRemote({ host: this.host, port, credentials, identity: this.identity, log: this.log });
    remote.on('attention', (state) => this._setAttention(state));
    remote.on('mediaFlags', (flags) => this._set({ mediaFlags: flags }));
    remote.on('close', (reason) => this._onClose(remote, reason));

    try {
      await remote.connect({ timeoutMs: CONNECT_TIMEOUT_MS });
    } catch (err) {
      this.lastFailure = { at: Date.now(), message: err.message };
      this._set({ connection: 'error', error: err.message });
      if (this.running) {
        this.failures += 1;
        // An unplugged Apple TV shouldn't fill the log: first failure, then every 10th.
        const level = this.failures === 1 || this.failures % 10 === 0 ? 'warn' : 'debug';
        this.log[level](`${this.label}: ${err.message}`);
        if (PORT_ERRORS.has(err.code)) this._refreshPort().catch(() => {});
        this._scheduleReconnect();
      }
      throw err;
    }

    if (!this.running) {
      await remote.close();
      throw new Error('Apple TV control is switched off');
    }

    this.remote = remote;
    this.delay = RECONNECT_MIN_MS;
    this.failures = 0;
    this.lastFailure = null;
    this._set({ connection: 'connected', error: null });
    this.log.info(`Connected to ${this.label}`);

    const attention = await remote.attentionState().catch(() => null);
    if (attention !== null) this._setAttention(attention);
    return remote;
  }

  _onClose(remote, reason) {
    if (this.remote !== remote) return;
    this.remote = null;
    this._set(DISCONNECTED);
    if (!this.running) return;
    this.log.warn(`${this.label}: ${reason} — reconnecting`);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._connect().catch(() => {});
    }, this.delay);
    this.delay = Math.min(this.delay * 2, RECONNECT_MAX_MS);
  }

  /** The Companion port can change (e.g. after a tvOS update) — ask the Apple TV. */
  async _refreshPort() {
    const found = await probe(this.host).catch(() => null);
    if (!this.running || !found || found.port === this.record.port) return;
    this.log.info(`${this.label}: Companion port changed ${this.record.port} → ${found.port}`);
    this.record.port = found.port;
    this.emit('change', { recordChanged: true });
    clearTimeout(this.timer);
    this.timer = null;
    this.delay = RECONNECT_MIN_MS;
    this._connect().catch(() => {});
  }

  /** Connected remote, connecting now if needed. */
  async _ready() {
    if (this.remote?.connected) return this.remote;
    if (!this.running) throw new Error('Apple TV control is switched off');
    // A connect just failed: fail at once rather than make every queued command wait
    // out another connect timeout.
    if (!this.connecting && this.lastFailure && Date.now() - this.lastFailure.at < FAIL_FAST_MS) {
      throw new Error(`${this.label} is not reachable: ${this.lastFailure.message}`);
    }
    clearTimeout(this.timer);
    this.timer = null;
    return withTimeout(this._connect(), READY_TIMEOUT_MS, `${this.label} is not reachable`);
  }

  /** Drop a connection that went stale — unless a newer one has replaced it already. */
  _dropConnection(remote) {
    if (this.remote !== remote) return;
    this.remote = null;
    remote.close();
  }

  _enqueue(task) {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  _set(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (this.state[k] !== v) {
        this.state[k] = v;
        changed = true;
      }
    }
    if (changed) this.emit('change', {});
  }

  _setAttention(code) {
    const attention = ATTENTION[code] || 'unknown';
    const patch = { attention };
    if (attention === 'asleep') patch.power = 'off';
    else if (attention !== 'unknown') patch.power = 'on';
    this._set(patch);
  }

  get playing() {
    const flags = this.state.mediaFlags;
    return flags === null ? null : !!(flags & MediaFlags.Pause);
  }

  snapshot() {
    const { id, name, address, port, model, pairedAt } = this.record;
    const { connection, power, attention, error } = this.state;
    return { id, name, address, port, model, pairedAt, connection, power, attention, playing: this.playing, error };
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  /**
   * @param command  one of COMMANDS
   * @param options  { action: 'press' | 'hold' | 'double', seconds }
   */
  async run(command, options = {}) {
    if (!COMMANDS.includes(command)) {
      throw Object.assign(new Error(`Unknown command "${command}"`), { status: 400 });
    }
    if (command === 'release') return undefined; // Savant's RepeatStop — every press is already complete
    return this._enqueue(() => this._withRetry(command, (remote) => this._execute(remote, command, options)));
  }

  /** Run `fn` on the connection; if that connection turns out to be stale, reconnect and retry once. */
  async _withRetry(what, fn) {
    const remote = await this._ready();
    try {
      return await fn(remote);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      this.log.debug(`${this.label}: ${err.message} — reconnecting and retrying ${what}`);
      this._dropConnection(remote);
      return fn(await this._ready());
    }
  }

  async _execute(remote, command, { action = 'press', seconds } = {}) {
    this.log.debug(`→ ${this.record.name} ${command}${action !== 'press' ? ` (${action})` : ''}`);

    if (BUTTONS[command] !== undefined) return remote.button(BUTTONS[command], action);

    const flags = this.state.mediaFlags;
    switch (command) {
      case 'poweron':
        await remote.wake();
        this._set({ power: 'on' });
        return;
      case 'poweroff':
        await remote.sleep();
        this._set({ power: 'off' });
        return;
      case 'powertoggle':
        return this._execute(remote, this.state.power === 'off' ? 'poweron' : 'poweroff');
      case 'play':
        if (flags !== null && flags & MediaFlags.Pause && !(flags & MediaFlags.Play)) return; // already playing
        return remote.mediaControl(MediaControl.Play).catch((err) => this._playPauseFallback(remote, err));
      case 'pause':
      case 'stop':
        if (flags !== null && flags & MediaFlags.Play && !(flags & MediaFlags.Pause)) return; // already paused
        return remote.mediaControl(MediaControl.Pause).catch((err) => this._playPauseFallback(remote, err));
      case 'next':
        return remote.mediaControl(MediaControl.NextTrack);
      case 'previous':
        return remote.mediaControl(MediaControl.PreviousTrack);
      case 'skipforward':
        return remote.skip(Math.abs(Number(seconds) || DEFAULT_SKIP_SECONDS));
      case 'skipbackward':
        return remote.skip(-Math.abs(Number(seconds) || DEFAULT_SKIP_SECONDS));
      default:
        throw new Error(`Unhandled command ${command}`);
    }
  }

  /** Apps that don't take media commands still react to the Play/Pause button. */
  _playPauseFallback(remote, err) {
    if (isConnectionError(err)) throw err;
    return remote.button(Hid.PlayPause);
  }

  async apps() {
    const list = await this._enqueue(() => this._withRetry('app list', (remote) => remote.apps()));
    return Object.entries(list)
      .map(([bundleId, name]) => ({ bundleId, name: String(name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  launch(target) {
    this.log.debug(`→ ${this.record.name} launch ${target}`);
    return this._enqueue(() => this._withRetry('launch', (remote) => remote.launch(target)));
  }
}

module.exports = { AppleTvDevice, COMMANDS };
