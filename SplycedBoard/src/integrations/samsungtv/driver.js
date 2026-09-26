/**
 * Samsung TVs, every generation:
 *
 *   IP Control       with "IP Remote" on: port 1516 on 2020 and newer, port 1515 on the 2016–2019
 *                    models that have it (MU, NU, RU, Q7F–Q9F, Q50R–Q950R, The Frame…). The
 *                    AccessToken Savant's profiles use: SplycedBoard asks the TV for it, and
 *                    someone picks Allow on the TV.
 *   Smart View       ports 8001/8002, every Tizen TV (2016 and newer): SplycedBoard's own remote
 *                    when IP Control is off or missing. Its token isn't one Savant uses.
 *   2010–2015        the legacy remote (port 55000): the TV asks once whether to allow it.
 *
 * A TV's record (core/tv/tool.js) keeps the AccessToken as `key`, `info.ipControlPort`, and in
 * `extra`: smartViewToken, smartViewPaired, legacyAllowed.
 */
const crypto = require('crypto');
const os = require('os');

const lan = require('../../core/lan');
const { tryConnect } = require('../../core/local-network');
const ipcontrol = require('./ipcontrol');
const smartview = require('./smartview');
const legacy = require('./legacy');
const { yearFromApiModel, yearFromModel } = require('./models');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const NUMBERS = Object.fromEntries([...Array(10).keys()].map((n) => [`num${n}`, n]));

// The remote's commands → IP Control [method, params] (the same strings as Savant's profile)
const IP_CONTROL = {
  power_off: ['powerControl', { power: 'powerOff' }],
  power_toggle: ['remoteKeyControl', { remoteKey: 'power' }],
  vol_up: ['volumeUpDnControl', { control: 'volumeUp' }],
  vol_down: ['volumeUpDnControl', { control: 'volumeDn' }],
  mute_on: ['muteControl', { mute: 'muteOn' }],
  mute_off: ['muteControl', { mute: 'muteOff' }],
  mute_toggle: null, // reads the mute state, then sets the other
  set_volume: null,
  up: ['remoteKeyControl', { remoteKey: 'cursorUp' }],
  down: ['remoteKeyControl', { remoteKey: 'cursorDn' }],
  left: ['remoteKeyControl', { remoteKey: 'cursorLeft' }],
  right: ['remoteKeyControl', { remoteKey: 'cursorRight' }],
  ok: ['remoteKeyControl', { remoteKey: 'enter' }],
  back: ['remoteKeyControl', { remoteKey: 'return' }],
  exit: ['remoteKeyControl', { remoteKey: 'exit' }],
  home: ['remoteKeyControl', { remoteKey: 'firstScreen' }],
  menu: ['remoteKeyControl', { remoteKey: 'menu' }],
  ch_up: ['channelUpDnControl', { control: 'channelUp' }],
  ch_down: ['channelUpDnControl', { control: 'channelDn' }],
  dash: ['remoteKeyControl', { remoteKey: 'dash' }],
  play: ['remoteKeyControl', { remoteKey: 'play' }],
  pause: ['remoteKeyControl', { remoteKey: 'pause' }],
  stop: ['remoteKeyControl', { remoteKey: 'stop' }],
  rewind: ['remoteKeyControl', { remoteKey: 'rewind' }],
  ff: ['remoteKeyControl', { remoteKey: 'fastforward' }],
  red: ['remoteKeyControl', { remoteKey: 'red' }],
  green: ['remoteKeyControl', { remoteKey: 'green' }],
  yellow: ['remoteKeyControl', { remoteKey: 'yellow' }],
  blue: ['remoteKeyControl', { remoteKey: 'blue' }],
  cc: ['remoteKeyControl', { remoteKey: 'caption' }],
  hdmi1: ['inputSourceControl', { inputSource: 'HDMI1' }],
  hdmi2: ['inputSourceControl', { inputSource: 'HDMI2' }],
  hdmi3: ['inputSourceControl', { inputSource: 'HDMI3' }],
  hdmi4: ['inputSourceControl', { inputSource: 'HDMI4' }],
  tv: ['inputSourceControl', { inputSource: 'TV' }],
  ...Object.fromEntries(Object.entries(NUMBERS).map(([id, n]) => [id, ['remoteKeyControl', { remoteKey: `number${n}` }]])),
};

// → Smart View key codes
const SMART_VIEW = {
  power_off: 'KEY_POWER',
  power_toggle: 'KEY_POWER',
  vol_up: 'KEY_VOLUP',
  vol_down: 'KEY_VOLDOWN',
  mute_toggle: 'KEY_MUTE',
  up: 'KEY_UP',
  down: 'KEY_DOWN',
  left: 'KEY_LEFT',
  right: 'KEY_RIGHT',
  ok: 'KEY_ENTER',
  back: 'KEY_RETURN',
  exit: 'KEY_EXIT',
  home: 'KEY_HOME',
  menu: 'KEY_MENU',
  input: 'KEY_SOURCE',
  info: 'KEY_INFO',
  guide: 'KEY_GUIDE',
  ch_up: 'KEY_CHUP',
  ch_down: 'KEY_CHDOWN',
  play: 'KEY_PLAY',
  pause: 'KEY_PAUSE',
  stop: 'KEY_STOP',
  rewind: 'KEY_REWIND',
  ff: 'KEY_FF',
  red: 'KEY_RED',
  green: 'KEY_GREEN',
  yellow: 'KEY_YELLOW',
  blue: 'KEY_CYAN',
  cc: 'KEY_CAPTION',
  ...Object.fromEntries(Object.entries(NUMBERS).map(([id, n]) => [id, `KEY_${n}`])),
};

// → legacy key codes
const LEGACY = {
  ...SMART_VIEW,
  power_off: 'KEY_POWEROFF',
  power_toggle: 'KEY_POWEROFF',
  home: 'KEY_CONTENTS',
  hdmi1: 'KEY_HDMI1',
  hdmi2: 'KEY_HDMI2',
  hdmi3: 'KEY_HDMI3',
  hdmi4: 'KEY_HDMI4',
};

// How this host introduces itself to legacy TVs, which remember remotes by this id.
const IDENTITY = (() => {
  const hash = crypto.createHash('sha256').update(`splycedboard:${os.hostname()}`).digest();
  hash[0] = (hash[0] | 0x02) & 0xfe;
  return {
    description: 'SplycedBoard',
    id: [...hash.subarray(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join(':'),
    name: 'SplycedBoard',
  };
})();

const sessions = new Map(); // tv id → smartview.Session

/** How SplycedBoard reaches this TV right now: 'ip-control' | 'smart-view' | 'legacy' | null */
function route(tv) {
  if (tv.key && tv.info?.ipControl !== false) return 'ip-control';
  if (tv.extra?.smartViewPaired && tv.info?.smartView !== false) return 'smart-view';
  if (tv.extra?.legacyAllowed) return 'legacy';
  return null;
}

function session(tv) {
  const secure = tv.info?.tokenAuth !== false;
  const token = tv.extra?.smartViewToken || null;
  let s = sessions.get(tv.id);
  if (s && (s.address !== tv.address || s.token !== token || s.secure !== secure)) {
    s.close();
    s = null;
  }
  if (!s) {
    s = new smartview.Session(tv.address, { secure, token });
    sessions.set(tv.id, s);
  }
  return s;
}

/** The TV's IP Control port: found by probing; 1516 when it hasn't been (2020+). */
const portOf = (tv) => tv.info?.ipControlPort || ipcontrol.PORTS.ipControl;

const cleanName = (name) => String(name || '').replace(/^\[TV\]\s*/i, '').trim() || null;

async function portOpen(address, port, known) {
  if (known?.includes(port)) return true;
  return (await tryConnect(address, port, 900)).ok;
}

module.exports = {
  brand: 'Samsung',
  keyLabel: 'AccessToken',
  defaultKey: null,
  keyOptional: true,
  scanPorts: [smartview.PORTS.api, ipcontrol.PORTS.ipControl, ipcontrol.PORTS.ipControl2016, legacy.PORTS.legacy],
  ssdpTargets: ['urn:samsung.com:device:RemoteControlReceiver:1', 'urn:dial-multiscreen-org:service:dial:1'],

  isBlueprintTv: (c) => /samsung/i.test(c.manufacturer) && /monitor|television|display/i.test(c.deviceType || 'HD_monitor'),

  /** Savant's 2020+ profiles keep the token in the AccessToken state variable; older ones have none. */
  blueprintKey: (xml) => ({ variable: /<state_variable\b[^>]*\bname="AccessToken"/.test(xml) ? 'AccessToken' : null, fixed: null }),

  async probe(address, hint = {}) {
    const ports = hint.ports || [];
    const [api, open1516, open1515, legacyOpen] = await Promise.all([
      smartview.info(address),
      portOpen(address, ipcontrol.PORTS.ipControl, ports),
      portOpen(address, ipcontrol.PORTS.ipControl2016, ports),
      portOpen(address, legacy.PORTS.legacy, ports),
    ]);
    const ipControlPort = open1516 ? ipcontrol.PORTS.ipControl : open1515 ? ipcontrol.PORTS.ipControl2016 : null;
    const ipControl = Boolean(ipControlPort);
    let upnp = null;
    if (!api) {
      // Not a Tizen TV (or not on). Its UPnP description says what it is; Samsung's remote
      // ports (1516, 55000) are enough when it doesn't answer that.
      const location = hint.ssdp?.location
        || (await lan.ssdp(['urn:samsung.com:device:RemoteControlReceiver:1', 'ssdp:all'], { address, timeoutMs: lan.timing.probeSsdpMs })).get(address)?.location;
      upnp = location ? await lan.describe(location) : null;
      if (upnp && !/samsung/i.test(upnp.manufacturer || '')) return null;
      if (!upnp && !ipControl && !legacyOpen) return null;
      if (upnp && !ipControl && !legacyOpen && !/tv|rcr|remote/i.test(`${upnp.modelDescription} ${upnp.friendlyName} ${hint.ssdp?.targets || ''}`)) return null;
    }
    const d = api?.device || {};
    const model = d.modelName || upnp?.modelName || null;
    return {
      name: cleanName(d.name || upnp?.friendlyName),
      model,
      year: yearFromApiModel(d.model) || yearFromModel(model),
      mac: lan.normalizeMac(d.wifiMac),
      power: d.PowerState === 'standby' ? 'standby' : 'on',
      info: {
        ipControl,
        ipControlPort,
        smartView: Boolean(api),
        tokenAuth: api ? d.TokenAuthSupport === 'true' : null,
        legacy: legacyOpen,
        frame: d.FrameTVSupport === 'true',
        network: d.networkType || null,
        firmware: d.firmwareVersion && d.firmwareVersion !== 'Unknown' ? d.firmwareVersion : null,
        resolution: d.resolution || null,
        modelCode: d.model || null,
      },
    };
  },

  async pair(tv, { progress }) {
    const found = await this.probe(tv.address, {});
    if (!found) throw httpError(502, `The TV at ${tv.address} didn't answer. Is it on?`);
    Object.assign(tv.info, found.info);
    tv.model = found.model || tv.model;
    tv.year = found.year || tv.year;

    if (found.info.ipControl) {
      progress('Look at the TV and pick Allow. You have 30 seconds.');
      const key = await ipcontrol.createAccessToken(tv.address, { port: found.info.ipControlPort });
      return { key, message: 'The TV gave its AccessToken. Copy it into Blueprint: inspect the TV, show State Variables, AccessToken.' };
    }
    if (found.info.smartView) {
      progress('Look at the TV and pick Allow for "SplycedBoard". You have 30 seconds.');
      const token = await smartview.pair(tv.address, { secure: found.info.tokenAuth !== false });
      sessions.get(tv.id)?.close();
      sessions.delete(tv.id);
      return {
        extra: { smartViewPaired: true, smartViewToken: token },
        message: 'Paired SplycedBoard\'s remote over Smart View. That token isn\'t one Savant uses: this TV has IP Remote off (or none). '
          + `For Savant's AccessToken, turn on IP Remote (${ipcontrol.ipRemoteSetting(found.year)}) if the TV has it, then Check and Request token again.`,
      };
    }
    if (found.info.legacy) {
      progress('Look at the TV and pick Allow for "SplycedBoard".');
      await legacy.pair(tv.address, IDENTITY);
      return { extra: { legacyAllowed: true }, message: 'The TV allowed SplycedBoard. Pre-2016 TVs have no token: Savant controls them by IR or RS-232.' };
    }
    throw httpError(502, `The TV at ${tv.address} answers, but not on a Samsung remote port (1516, 8001/8002 or 55000).`);
  },

  async checkKey(tv) {
    if (!tv.key) return { ok: null, message: '' };
    try {
      await ipcontrol.call(tv.address, 'powerControl', {}, { token: tv.key, port: portOf(tv) });
      return { ok: true, message: '' };
    } catch (err) {
      if (/didn't answer|isn't taking|Couldn't reach/.test(err.message)) return { ok: null, message: `Couldn't check the AccessToken: ${err.message}` };
      return { ok: false, message: `The TV turned down the AccessToken (${err.message.replace(/^The TV said: /, '')}). Request a new one.` };
    }
  },

  commands(tv) {
    const via = route(tv);
    const map = { 'ip-control': IP_CONTROL, 'smart-view': SMART_VIEW, legacy: LEGACY }[via] || {};
    const list = Object.keys(map);
    // Wake-on-LAN needs the MAC; IP Control can also switch on a TV in network standby.
    if (tv.mac || via === 'ip-control') list.unshift('power_on');
    return list;
  },

  async command(tv, id, value) {
    const via = route(tv);
    if (id === 'power_on') {
      const sent = tv.mac ? await lan.wake(tv.mac, { address: tv.address }) : 0;
      if (via === 'ip-control') await ipcontrol.call(tv.address, 'powerControl', { power: 'powerOn' }, { token: tv.key, port: portOf(tv), timeoutMs: 2000 }).catch(() => {});
      return { sent };
    }
    if (via === 'ip-control') {
      if (id === 'mute_toggle') {
        const { mute } = await ipcontrol.call(tv.address, 'muteControl', {}, { token: tv.key, port: portOf(tv) });
        await ipcontrol.call(tv.address, 'muteControl', { mute: mute === 'muteOn' ? 'muteOff' : 'muteOn' }, { token: tv.key, port: portOf(tv) });
        return {};
      }
      if (id === 'set_volume') {
        const volume = Math.round(Number(value));
        if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw httpError(400, 'Volume is 0–100');
        await ipcontrol.call(tv.address, 'directVolumeControl', { volume }, { token: tv.key, port: portOf(tv) });
        return {};
      }
      const [method, params] = IP_CONTROL[id];
      await ipcontrol.call(tv.address, method, params, { token: tv.key, port: portOf(tv) });
      return {};
    }
    if (via === 'smart-view') {
      const s = session(tv);
      if (id === 'power_off' && tv.info?.frame) {
        // A Frame goes to Art Mode on a press; holding the button turns it off.
        await s.key('KEY_POWER', 'Press');
        await new Promise((r) => setTimeout(r, 3000));
        await s.key('KEY_POWER', 'Release');
        return {};
      }
      await s.key(SMART_VIEW[id]);
      return {};
    }
    if (via === 'legacy') {
      await legacy.send(tv.address, LEGACY[id], IDENTITY);
      return {};
    }
    throw httpError(409, 'Pair SplycedBoard with this TV first (Request token), then pick Allow on the TV.');
  },

  async state(tv) {
    if (route(tv) === 'ip-control') {
      const ask = (method) => ipcontrol.call(tv.address, method, {}, { token: tv.key, port: portOf(tv), timeoutMs: 2500 }).catch(() => null);
      const [power, volume, mute] = await Promise.all([ask('powerControl'), ask('directVolumeControl'), ask('muteControl')]);
      if (!power) return { power: 'unreachable' };
      return {
        power: power.power === 'powerOn' ? 'on' : 'standby',
        volume: Number.isFinite(Number(volume?.volume)) ? Number(volume.volume) : null,
        mute: mute?.mute ? mute.mute === 'muteOn' : null,
      };
    }
    const api = await smartview.info(tv.address);
    if (api) return { power: api.device?.PowerState === 'standby' ? 'standby' : 'on' };
    if (tv.extra?.legacyAllowed && (await tryConnect(tv.address, legacy.PORTS.legacy, 1500)).ok) return { power: 'on' };
    return { power: 'unreachable' };
  },

  warnings(tv) {
    const w = [];
    const ipOff = tv.info?.smartView && tv.info.ipControl === false;
    if (ipOff && ((tv.year || 0) >= 2020 || tv.blueprint?.keyVariable)) {
      w.push(`IP Remote is off on this TV, so Savant can't control it over IP and it can't give an AccessToken. On the TV: ${ipcontrol.ipRemoteSetting(tv.year)} → IP Remote → Enable, then Check.`);
    }
    return w;
  },

  yearFromModel,

  close(tv) {
    sessions.get(tv.id)?.close();
    sessions.delete(tv.id);
  },

  closeAll() {
    for (const s of sessions.values()) s.close();
    sessions.clear();
  },
};
