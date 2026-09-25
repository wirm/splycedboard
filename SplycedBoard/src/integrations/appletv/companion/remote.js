/**
 * Remote control of one Apple TV over an encrypted Companion session.
 *
 * connect() = TCP → pair-verify → encryption → the session setup the Remote app does
 * (system info, touch/text-input sessions, remote session) → subscribe to power and
 * playback events.
 *
 * Events: 'attention' (0 unknown · 1 asleep · 2 screensaver · 3 awake · 4 idle),
 *         'mediaFlags' (bitmask of what the current app accepts), 'close' (reason)
 */
const { EventEmitter } = require('events');

const opack = require('./opack');
const { CompanionClient } = require('./client');
const { pairVerify } = require('./pairing');
const { randomBytes } = require('./crypto');

const Hid = {
  Up: 1, Down: 2, Left: 3, Right: 4, Menu: 5, Select: 6, Home: 7,
  VolumeUp: 8, VolumeDown: 9, Siri: 10, Screensaver: 11, Sleep: 12, Wake: 13,
  PlayPause: 14, ChannelIncrement: 15, ChannelDecrement: 16, Guide: 17, PageUp: 18, PageDown: 19,
};

const MediaControl = {
  Play: 1, Pause: 2, NextTrack: 3, PreviousTrack: 4, SkipBy: 7,
};

const MediaFlags = {
  Play: 0x0001, Pause: 0x0002, NextTrack: 0x0004, PreviousTrack: 0x0008,
  FastForward: 0x0010, Rewind: 0x0020, Volume: 0x0100, SkipForward: 0x0200, SkipBackward: 0x0400,
};

const REMOTE_SERVICE = 'com.apple.tvremoteservices';
const EVENTS = ['_iMC', 'SystemStatus', 'TVSystemStatus'];
const HOLD_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AppleTvRemote extends EventEmitter {
  /**
   * @param identity  how we introduce ourselves: { name, model, rpId, deviceId }
   */
  constructor({ host, port, credentials, identity, log }) {
    super();
    this.host = host;
    this.port = port;
    this.credentials = credentials;
    this.identity = identity;
    this.log = log;
    this.client = null;
    this.sid = null;
  }

  get connected() {
    return !!this.client?.connected;
  }

  async connect({ timeoutMs = 5000 } = {}) {
    const client = new CompanionClient({ host: this.host, port: this.port, log: this.log });
    this.client = client;
    client.on('event', (id, content) => this._onEvent(id, content));
    client.on('close', (reason) => this.emit('close', reason));

    try {
      await client.open({ timeoutMs });
      const { outKey, inKey } = await pairVerify(client, this.credentials);
      client.enableEncryption(outKey, inKey);
      await this._startSession();
    } catch (err) {
      client.close();
      throw err;
    }
  }

  async _startSession() {
    const { name, model, rpId, deviceId } = this.identity;
    await this.client.request('_systemInfo', {
      _bf: 0,
      _cf: 512,
      _clFl: 128,
      _i: rpId,
      _idsID: Buffer.from(this.credentials.clientId, 'utf8'),
      _pubID: deviceId,
      _sf: 256,
      _sv: '170.18',
      model,
      name,
    });
    await this._optional('_touchStart', { _height: opack.float(1000), _tFl: 0, _width: opack.float(1000) });

    const localSid = randomBytes(4).readUInt32BE();
    const session = await this.client.request('_sessionStart', { _srvT: REMOTE_SERVICE, _sid: localSid });
    this.sid = (BigInt(session._sid ?? 0) << 32n) | BigInt(localSid);

    await this._optional('TVRCSessionStart', { ProtocolVersionKey: '1.2' });
    await this._optional('_tiStart', {});
    for (const event of EVENTS) this.client.sendEvent('_interest', { _regEvents: [event] });
  }

  /** Session steps older/newer tvOS versions may not answer. */
  async _optional(identifier, content) {
    try {
      return await this.client.request(identifier, content);
    } catch (err) {
      this.log?.debug(`${identifier} not supported: ${err.message}`);
      return null;
    }
  }

  _onEvent(id, content) {
    if (id === 'SystemStatus' || id === 'TVSystemStatus') {
      if (content.state !== undefined) this.emit('attention', Number(content.state));
    } else if (id === '_iMC') {
      if (content._mcF !== undefined) this.emit('mediaFlags', Number(content._mcF));
    } else {
      this.log?.debug(`Event ${id}`);
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  hid(code, down) {
    return this.client.request('_hidC', { _hBtS: down ? 1 : 2, _hidC: code });
  }

  /** @param action 'press' | 'hold' | 'double' */
  async button(code, action = 'press') {
    if (action === 'hold') {
      await this.hid(code, true);
      await sleep(HOLD_MS);
      await this.hid(code, false);
      return;
    }
    await this.hid(code, true);
    await this.hid(code, false);
    if (action === 'double') {
      await this.hid(code, true);
      await this.hid(code, false);
    }
  }

  wake() {
    return this.hid(Hid.Wake, false);
  }

  sleep() {
    return this.hid(Hid.Sleep, false);
  }

  mediaControl(command, args = {}) {
    return this.client.request('_mcc', { _mcc: command, ...args });
  }

  skip(seconds) {
    return this.mediaControl(MediaControl.SkipBy, { _skpS: opack.float(seconds) });
  }

  /** @returns attention state number, or null if this tvOS doesn't answer */
  async attentionState() {
    const content = await this._optional('FetchAttentionState', {});
    return content && content.state !== undefined ? Number(content.state) : null;
  }

  /** @returns { bundleId: appName } */
  apps() {
    return this.client.request('FetchLaunchableApplicationsEvent', {});
  }

  launch(target) {
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
    return this.client.request('_launchApp', isUrl ? { _urlS: target } : { _bundleID: target });
  }

  async close() {
    const client = this.client;
    if (!client) return;
    if (client.connected && this.sid !== null) {
      try {
        await client.request('_sessionStop', { _srvT: REMOTE_SERVICE, _sid: this.sid }, { timeoutMs: 1000 });
      } catch { /* closing anyway */ }
    }
    client.close();
  }
}

module.exports = { AppleTvRemote, Hid, MediaControl, MediaFlags };
