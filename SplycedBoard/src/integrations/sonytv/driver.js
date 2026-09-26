/**
 * Sony BRAVIA TVs over IP control, the way Savant's Sony profiles control them.
 *
 * The key is a Pre-Shared Key set on the TV (Network → Home network setup → IP Control →
 * Pre-Shared Key). Savant's profiles have it written in as 1234, so that's what the TV
 * needs for Savant; a profile with another one is read from Blueprint's configuration.
 * Switching on needs the TV's Remote Start on (and Wake-on-LAN helps).
 */
const lan = require('../../core/lan');
const bravia = require('./bravia');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const SAVANT_PSK = '1234';

// The remote's commands → IRCC codes (as in Savant's Sony profiles) and, when the TV lists its
// own codes (getRemoteControllerInfo), the name to take from that list instead.
const IRCC = {
  power_toggle: ['TvPower', 'AAAAAQAAAAEAAAAVAw=='],
  vol_up: ['VolumeUp', 'AAAAAQAAAAEAAAASAw=='],
  vol_down: ['VolumeDown', 'AAAAAQAAAAEAAAATAw=='],
  mute_toggle: ['Mute', 'AAAAAQAAAAEAAAAUAw=='],
  up: ['Up', 'AAAAAgAAAJcAAABPAw=='],
  down: ['Down', 'AAAAAgAAAJcAAABQAw=='],
  left: ['Left', 'AAAAAgAAAJcAAABNAw=='],
  right: ['Right', 'AAAAAgAAAJcAAABOAw=='],
  ok: ['Confirm', 'AAAAAgAAAJcAAABKAw=='],
  back: ['Return', 'AAAAAgAAAJcAAAAjAw=='],
  exit: ['Exit', 'AAAAAQAAAAEAAABjAw=='],
  home: ['Home', 'AAAAAQAAAAEAAABgAw=='],
  input: ['Input', 'AAAAAQAAAAEAAAAlAw=='],
  options: ['Options', 'AAAAAgAAAJcAAAA2Aw=='],
  info: ['Display', 'AAAAAQAAAAEAAAA6Aw=='],
  guide: ['GGuide', 'AAAAAQAAAAEAAAAOAw=='],
  ch_up: ['ChannelUp', 'AAAAAQAAAAEAAAAQAw=='],
  ch_down: ['ChannelDown', 'AAAAAQAAAAEAAAARAw=='],
  play: ['Play', 'AAAAAgAAAJcAAAAaAw=='],
  pause: ['Pause', 'AAAAAgAAAJcAAAAZAw=='],
  stop: ['Stop', 'AAAAAgAAAJcAAAAYAw=='],
  rewind: ['Rewind', 'AAAAAgAAAJcAAAAbAw=='],
  ff: ['Forward', 'AAAAAgAAAJcAAAAcAw=='],
  red: ['Red', 'AAAAAgAAAJcAAAAlAw=='],
  green: ['Green', 'AAAAAgAAAJcAAAAmAw=='],
  yellow: ['Yellow', 'AAAAAgAAAJcAAAAnAw=='],
  blue: ['Blue', 'AAAAAgAAAJcAAAAkAw=='],
  cc: ['ClosedCaption', 'AAAAAgAAAKQAAAAQAw=='],
  hdmi1: [null, 'AAAAAgAAABoAAABaAw=='],
  hdmi2: [null, 'AAAAAgAAABoAAABbAw=='],
  hdmi3: [null, 'AAAAAgAAABoAAABcAw=='],
  hdmi4: [null, 'AAAAAgAAABoAAABdAw=='],
  num1: ['Num1', 'AAAAAQAAAAEAAAAAAw=='],
  num2: ['Num2', 'AAAAAQAAAAEAAAABAw=='],
  num3: ['Num3', 'AAAAAQAAAAEAAAACAw=='],
  num4: ['Num4', 'AAAAAQAAAAEAAAADAw=='],
  num5: ['Num5', 'AAAAAQAAAAEAAAAEAw=='],
  num6: ['Num6', 'AAAAAQAAAAEAAAAFAw=='],
  num7: ['Num7', 'AAAAAQAAAAEAAAAGAw=='],
  num8: ['Num8', 'AAAAAQAAAAEAAAAHAw=='],
  num9: ['Num9', 'AAAAAQAAAAEAAAAIAw=='],
  num0: ['Num0', 'AAAAAQAAAAEAAAAJAw=='],
};

// XR-65A80J → 2021, XBR-65X900F → 2018, KD-55X750H → 2020, K-65XR90 → 2024, K-65XR80M2 → 2025
const LETTER_YEARS = { B: 2014, C: 2015, D: 2016, E: 2017, F: 2018, G: 2019, H: 2020, J: 2021, K: 2022, L: 2023 };

function yearFromModel(model) {
  // "(xx)" is where Blueprint's profile names leave the screen size; "(splyced)" and the like go
  const s = String(model || '').toUpperCase().replace(/\(X+\)/g, '65').replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, '');
  let m;
  if ((m = /^K-?\d{2,3}[A-Z]{1,2}\d{1,2}(M\d)?/.exec(s))) return m[1] ? 2025 : 2024;
  if ((m = /-?\d{2,3}([A-Z]{1,2}\d{1,4})([A-Z])(?:[A-Z]{0,2})?$/.exec(s))) return LETTER_YEARS[m[2]] ?? null;
  return null;
}

const codeLists = new Map(); // tv id → { name → code } from the TV itself

async function remoteCodes(tv) {
  if (codeLists.has(tv.id)) return codeLists.get(tv.id);
  let list = {};
  try {
    // The answer is [info, [{ name, value }, …]].
    const result = await bravia.call(tv.address, 'system', 'getRemoteControllerInfo', [], { psk: tv.key, timeoutMs: 2500, raw: true });
    const codes = Array.isArray(result?.[1]) ? result[1] : [];
    list = Object.fromEntries(codes.filter((c) => c?.name && c?.value).map((c) => [c.name, c.value]));
  } catch { /* the built-in table will do */ }
  codeLists.set(tv.id, list);
  return list;
}

async function press(tv, id) {
  const [name, fallback] = IRCC[id];
  const codes = await remoteCodes(tv);
  await bravia.ircc(tv.address, (name && codes[name]) || fallback, { psk: tv.key });
}

module.exports = {
  brand: 'Sony',
  keyLabel: 'Pre-Shared Key',
  defaultKey: SAVANT_PSK,
  scanPorts: [bravia.PORTS.http],
  ssdpTargets: ['urn:schemas-sony-com:service:ScalarWebAPI:1', 'urn:schemas-sony-com:service:IRCC:1'],

  isBlueprintTv: (c) => /sony/i.test(c.manufacturer)
    && /monitor|television|display/i.test(c.deviceType || 'HD_monitor')
    && !/^VPL/i.test(c.model), // projectors

  /** Savant's Sony profiles write the key into every request's X-Auth-PSK header. */
  blueprintKey: (xml) => {
    const m = xml.match(/<http_header\s+name="X-Auth-PSK"\s*>([^<]*)<\/http_header>/i);
    return { variable: null, fixed: m ? m[1].trim() : null };
  },

  validateKey(key) {
    return key.length > 64 ? 'That\'s too long for a Pre-Shared Key' : null;
  },

  async probe(address) {
    let iface;
    try {
      iface = await bravia.call(address, 'system', 'getInterfaceInformation', [], { timeoutMs: 1500 });
    } catch {
      return null;
    }
    if (!iface || !/tv/i.test(iface.productCategory || '')) return null;
    let power = null;
    try {
      const p = await bravia.call(address, 'system', 'getPowerStatus', [], { timeoutMs: 1500 });
      power = p?.status === 'active' ? 'on' : p?.status ? 'standby' : null;
    } catch { /* needs the key on some models */ }
    return {
      name: iface.modelName ? `${iface.productName || 'BRAVIA'} ${iface.modelName}` : null,
      model: iface.modelName || null,
      year: yearFromModel(iface.modelName),
      mac: null,
      power,
      info: { product: iface.productName || null, apiVersion: iface.interfaceVersion || null },
    };
  },

  async checkKey(tv) {
    try {
      const info = await bravia.call(tv.address, 'system', 'getSystemInformation', [], { psk: tv.key });
      codeLists.delete(tv.id);
      return { ok: true, message: '', mac: lan.normalizeMac(info?.macAddr) };
    } catch (err) {
      if (err.auth) {
        return {
          ok: false,
          message: `The TV turned down Pre-Shared Key "${tv.key || ''}". On the TV: Network → Home network setup → IP Control → Authentication "Normal and Pre-Shared Key", and Pre-Shared Key ${tv.key || SAVANT_PSK}. `
            + 'After a firmware update, clear the field completely (a hidden space can sneak in) and type it again.',
        };
      }
      return { ok: null, message: `Couldn't check the Pre-Shared Key: ${err.message}` };
    }
  },

  commands(tv) {
    return ['power_on', 'power_off', ...Object.keys(IRCC), 'mute_on', 'mute_off', 'set_volume'];
  },

  async command(tv, id, value) {
    const psk = tv.key;
    if (id === 'power_on') {
      const sent = tv.mac ? await lan.wake(tv.mac, { address: tv.address }) : 0;
      try {
        await bravia.call(tv.address, 'system', 'setPowerStatus', [{ status: true }], { psk });
      } catch (err) {
        if (!sent) throw httpError(502, `${err.message} To switch it on over the network, the TV needs Remote Start on (Network → Remote Start).`);
      }
      return { sent };
    }
    if (id === 'power_off') {
      await bravia.call(tv.address, 'system', 'setPowerStatus', [{ status: false }], { psk });
      return {};
    }
    if (id === 'mute_on' || id === 'mute_off') {
      await bravia.call(tv.address, 'audio', 'setAudioMute', [{ status: id === 'mute_on' }], { psk });
      return {};
    }
    if (id === 'set_volume') {
      const volume = Math.round(Number(value));
      if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw httpError(400, 'Volume is 0–100');
      await bravia.call(tv.address, 'audio', 'setAudioVolume', [{ target: 'speaker', volume: String(volume) }], { psk });
      return {};
    }
    await press(tv, id);
    return {};
  },

  async state(tv) {
    const psk = tv.key;
    let power;
    try {
      const p = await bravia.call(tv.address, 'system', 'getPowerStatus', [], { psk, timeoutMs: 2500 });
      power = p?.status === 'active' ? 'on' : 'standby';
    } catch (err) {
      return { power: err.auth ? 'unknown' : 'unreachable', error: err.message };
    }
    if (power !== 'on') return { power };
    const [volume, playing] = await Promise.all([
      bravia.call(tv.address, 'audio', 'getVolumeInformation', [], { psk, timeoutMs: 2500 }).catch(() => null),
      bravia.call(tv.address, 'avContent', 'getPlayingContentInfo', [], { psk, timeoutMs: 2500 }).catch(() => null),
    ]);
    const speaker = Array.isArray(volume) ? volume.find((v) => v.target === 'speaker') || volume[0] : null;
    return {
      power,
      volume: Number.isFinite(Number(speaker?.volume)) ? Number(speaker.volume) : null,
      mute: typeof speaker?.mute === 'boolean' ? speaker.mute : null,
      source: playing?.title || playing?.source || null,
    };
  },

  warnings(tv) {
    const w = [];
    const savantKey = tv.blueprint?.key; // written into the TV's profile in Blueprint
    if (tv.blueprint && savantKey && tv.key !== savantKey) {
      w.push(`Savant's profile for "${tv.blueprint.component}" sends Pre-Shared Key ${savantKey}, not ${tv.key || 'none'}. Set the TV's Pre-Shared Key to ${savantKey}.`);
    }
    return w;
  },

  close(tv) {
    codeLists.delete(tv.id);
  },

  closeAll() {
    codeLists.clear();
  },

  yearFromModel,
};
