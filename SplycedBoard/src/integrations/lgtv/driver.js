/**
 * LG TVs over Network IP Control (port 9761), the way Savant's LG profiles control them.
 *
 * The key is the keycode the TV shows on its hidden IP Control Setup screen ("Generate
 * Keycode"): it's typed in, not asked for. Blueprint keeps it in the TV's AccessToken state
 * variable. 2018 and newer TVs need it; 2016–2017 ones work without.
 * Switching on is Wake-on-LAN (the TV's "Wake On LAN" / "Turn on via Wi-Fi" setting).
 */
const lan = require('../../core/lan');
const { tryConnect } = require('../../core/local-network');
const { PORTS, Client } = require('./ipcontrol');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const NUMBERS = Object.fromEntries([...Array(10).keys()].map((n) => [`num${n}`, `KEY_ACTION number${n}`]));

// The remote's commands → IP Control commands (key names as LG's and Savant's lists have them)
const COMMANDS = {
  power_off: 'POWER off',
  vol_up: 'KEY_ACTION volumeup',
  vol_down: 'KEY_ACTION volumedown',
  mute_toggle: 'KEY_ACTION volumemute',
  mute_on: 'VOLUME_MUTE on',
  mute_off: 'VOLUME_MUTE off',
  set_volume: null, // VOLUME_CONTROL <0–100>
  up: 'KEY_ACTION arrowup',
  down: 'KEY_ACTION arrowdown',
  left: 'KEY_ACTION arrowleft',
  right: 'KEY_ACTION arrowright',
  ok: 'KEY_ACTION ok',
  back: 'KEY_ACTION returnback',
  exit: 'KEY_ACTION exit',
  home: 'KEY_ACTION myapp',
  menu: 'KEY_ACTION settingmenu',
  options: 'KEY_ACTION quickmenu',
  input: 'KEY_ACTION deviceinput',
  info: 'KEY_ACTION programminfo',
  guide: 'KEY_ACTION programguide',
  ch_up: 'KEY_ACTION channelup',
  ch_down: 'KEY_ACTION channeldown',
  play: 'KEY_ACTION play',
  pause: 'KEY_ACTION pause',
  stop: 'KEY_ACTION stop',
  rewind: 'KEY_ACTION rewind',
  ff: 'KEY_ACTION fastforward',
  red: 'KEY_ACTION redbutton',
  green: 'KEY_ACTION greenbutton',
  yellow: 'KEY_ACTION yellowbutton',
  blue: 'KEY_ACTION bluebutton',
  cc: 'KEY_ACTION captionsubtitle',
  hdmi1: 'INPUT_SELECT hdmi1',
  hdmi2: 'INPUT_SELECT hdmi2',
  hdmi3: 'INPUT_SELECT hdmi3',
  hdmi4: 'INPUT_SELECT hdmi4',
  ...NUMBERS,
};

// OLED65C8PUA → C8 → 2018; OLED65CXPUA → 2020; 65UM7300 → 2019; NANO75UPA → 2021; QNED80URA → 2023
const OLED_YEARS = { 6: 2016, 7: 2017, 8: 2018, 9: 2019, X: 2020, 1: 2021, 2: 2022, 3: 2023, 4: 2024, 5: 2025 };
const LCD_YEARS = { H: 2016, J: 2017, K: 2018, M: 2019, N: 2020, P: 2021, Q: 2022, R: 2023, T: 2024, A: 2025 };

function yearFromModel(model) {
  // "(XX)" is where Blueprint's profile names leave the screen size
  const s = String(model || '').toUpperCase().replace(/\(X+\)/g, '65').replace(/[\s-]+/g, '');
  let m;
  if ((m = /OLED\d{2,3}[A-Z]([0-9X])/.exec(s))) return OLED_YEARS[m[1]] ?? null;
  if ((m = /(?:NANO|QNED)\d{2,3}[A-Z]?U?([A-Z])[A-Z]?$/.exec(s))) return LCD_YEARS[m[1]] ?? null;
  if ((m = /^\d{2,3}(?:U|S)([A-Z])\d/.exec(s))) return LCD_YEARS[m[1]] ?? null;
  return null;
}

/** An LG model number in a UPnP description: "OLED65C8PUA", "65UM7300PUA", "NANO75UPA"… */
function modelIn(...texts) {
  for (const t of texts) {
    const m = /\b((?:OLED|NANO|QNED)?\d{2,3}[A-Z]{1,5}\d{0,4}[A-Z0-9]*|(?:NANO|QNED)\d{2,3}[A-Z0-9]+)\b/.exec(String(t || '').toUpperCase());
    if (m && /\d/.test(m[1]) && /[A-Z]/.test(m[1]) && m[1].length >= 7) return m[1];
  }
  return null;
}

const clients = new Map(); // tv id → Client

function client(tv) {
  let c = clients.get(tv.id);
  if (c && (c.address !== tv.address || c.keycode !== (tv.key || null))) {
    c.close();
    c = null;
  }
  if (!c) {
    c = new Client(tv.address, { keycode: tv.key || null });
    clients.set(tv.id, c);
  }
  return c;
}

async function ask(tv, command, opts) {
  const answer = await client(tv).send(command, opts);
  if (/^(ERROR|FAIL|NG)\b/i.test(answer)) throw httpError(502, `The TV said ${answer} to "${command}"`);
  return answer;
}

module.exports = {
  brand: 'LG',
  keyLabel: 'Keycode',
  defaultKey: null,
  keyOptional: true,
  scanPorts: [PORTS.ipControl],
  ssdpTargets: ['urn:lge-com:service:webos-second-screen:1', 'urn:schemas-upnp-org:device:MediaRenderer:1', 'urn:dial-multiscreen-org:service:dial:1'],

  isBlueprintTv: (c) => /^lg\b|lg electronics/i.test(c.manufacturer) && /monitor|television|display/i.test(c.deviceType || 'HD_monitor'),

  /** Savant's LG profiles keep the keycode in the AccessToken state variable. */
  blueprintKey: (xml) => ({ variable: /<state_variable\b[^>]*\bname="AccessToken"/.test(xml) ? 'AccessToken' : null, fixed: null }),

  validateKey(key) {
    return /^[A-Za-z0-9]{8}$/.test(key) ? null : 'The keycode is the 8 letters and digits the TV shows under Generate Keycode.';
  },

  async probe(address, hint = {}) {
    const ipControl = hint.ports?.includes(PORTS.ipControl) || (await tryConnect(address, PORTS.ipControl, 900)).ok;
    const location = hint.ssdp?.location
      || (await lan.ssdp(['urn:lge-com:service:webos-second-screen:1', 'ssdp:all'], { address, timeoutMs: lan.timing.probeSsdpMs })).get(address)?.location;
    const upnp = location ? await lan.describe(location) : null;
    const isLg = /\bLG\b|LG Electronics/i.test(`${upnp?.manufacturer || ''} ${upnp?.friendlyName || ''}`);
    // Port 9761 is LG's own; anything else has to say it's an LG.
    if (!isLg && !ipControl) return null;
    if (upnp && !isLg) return null;
    const model = modelIn(upnp?.modelNumber, upnp?.modelName, upnp?.friendlyName, upnp?.modelDescription);
    const name = String(upnp?.friendlyName || '').replace(/^\[LG\]\s*/i, '').trim() || null;
    return {
      name,
      model,
      year: yearFromModel(model),
      mac: null,
      power: 'on',
      info: { ipControl },
    };
  },

  async checkKey(tv) {
    if (!(await tryConnect(tv.address, PORTS.ipControl, 1500)).ok) {
      return { ok: null, message: `Couldn't check the keycode: the TV at ${tv.address} isn't answering on port ${PORTS.ipControl}.` };
    }
    try {
      const mac = await ask(tv, 'GET_MACADDRESS wired');
      return { ok: true, message: '', mac: lan.normalizeMac(mac) };
    } catch (err) {
      return {
        ok: false,
        message: tv.key
          ? `The TV didn't accept keycode ${tv.key}. Check it on the TV's IP Control Setup screen (it's case sensitive).`
          : `The TV didn't answer without a keycode (${err.message}). 2018 and newer LG TVs need the keycode from IP Control Setup.`,
      };
    }
  },

  commands(tv) {
    const list = Object.keys(COMMANDS);
    if (tv.mac) list.unshift('power_on');
    return list;
  },

  async command(tv, id, value) {
    if (id === 'power_on') return { sent: await lan.wake(tv.mac, { address: tv.address }) };
    if (id === 'set_volume') {
      const volume = Math.round(Number(value));
      if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw httpError(400, 'Volume is 0–100');
      await ask(tv, `VOLUME_CONTROL ${volume}`);
      return {};
    }
    await ask(tv, COMMANDS[id]);
    return {};
  },

  async state(tv) {
    if (!(await tryConnect(tv.address, PORTS.ipControl, 1500)).ok) return { power: 'unreachable' };
    const get = (command) => ask(tv, command, { timeoutMs: 2500 }).catch(() => null);
    const volume = await get('CURRENT_VOL');
    const mute = await get('MUTE_STATE');
    const app = await get('CURRENT_APP');
    return {
      power: volume || app ? 'on' : 'unknown',
      volume: /^VOL:(\d+)/.test(volume || '') ? Number(volume.slice(4)) : null,
      mute: /^MUTE:(on|off)/i.test(mute || '') ? /on/i.test(mute.slice(5)) : null,
      source: /^APP:/.test(app || '') ? app.slice(4) : null,
    };
  },

  warnings(tv) {
    const w = [];
    if (tv.info?.ipControl === false) {
      w.push('Network IP Control is off on this TV (port 9761 is closed), so Savant can\'t control it over IP. Turn it on in the TV\'s IP Control Setup menu: see "How to get the keycode".');
    } else if (!tv.key && (tv.year || 0) >= 2018) {
      w.push('2018 and newer LG TVs need the keycode from the IP Control Setup screen. See "How to get the keycode".');
    }
    return w;
  },

  close(tv) {
    clients.get(tv.id)?.close();
    clients.delete(tv.id);
  },

  closeAll() {
    for (const c of clients.values()) c.close();
    clients.clear();
  },

  yearFromModel,
  modelIn,
};
