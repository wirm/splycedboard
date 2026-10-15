/**
 * ITv2 message payloads: building the commands SplycedBoard sends, and reading what the panel
 * reports into a PanelState. Layouts are those of Savant's own DSC PowerSeries Neo profile.
 *
 * Numbers (partition, zone, user…) travel length-prefixed: one byte saying how many bytes
 * follow, then the number big-endian, e.g. partition 1 is 01 01, zone 300 would be 02 01 2C.
 * Every reader returns a one-line description for the message log. Layouts are confirmed by the
 * open-source ITv2 servers (NeoHub, LawPaul's dsc-itv2) where they differ from Savant's profile.
 */
const { name, RESPONSE, NACK, ARMING, ARM_METHOD, READY, ENTRY_DELAY, ALARM_TYPE } = require('./codes');

// ── Building ─────────────────────────────────────────────────────────────────

/** A number as ITv2 sends it: its length, then the number. */
function num(n) {
  const bytes = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return Buffer.from([bytes.length, ...bytes]);
}

/** A user code as BCD, two digits a byte: "1234" → 12 34, "123456" → 12 34 56. */
function bcd(code) {
  const digits = String(code);
  if (!/^\d+$/.test(digits) || digits.length % 2) throw new Error('User code must be an even number of digits');
  return Buffer.from(digits.match(/../g).map((pair) => parseInt(pair, 16)));
}

const u16 = (v) => Buffer.from([(v >> 8) & 0xff, v & 0xff]);

const build = {
  arm: (partition, modeCode, code) => Buffer.concat([num(partition), Buffer.from([modeCode]), bcd(code)]),
  disarm: (partition, code) => Buffer.concat([num(partition), bcd(code)]),
  /** 0800: ask for something, by its code (e.g. 0811 zone status). */
  request: (code, rest = Buffer.alloc(0)) => Buffer.concat([u16(code), rest]),
  /** How many zones, users, partitions…: six zeros, as the panel's answer has six numbers. */
  capabilities: () => build.request(0x0613, Buffer.concat(Array.from({ length: 6 }, () => num(0)))),
  zoneStatus: (first, count) => build.request(0x0811, Buffer.concat([num(first), num(count)])),
  partitionStatus: (partition) => build.request(0x0812, Buffer.concat([num(partition), Buffer.from([0x00])])),
  /** Labels first…last: zone labels are collection D1, partition labels D3. */
  labels: (kind, first, last) => build.request(0x0771, Buffer.concat([num(kind === 'zone' ? 0xd1 : 0xd3), num(first), num(last), num(0)])),
};

/** 0623: several messages in one, each [length][command: 2][body], the length as a packet's. */
function unpack(payload) {
  const out = [];
  let pos = 0;
  while (pos < payload.length) {
    let len = payload[pos];
    let head = 1;
    if (len & 0x80) {
      len = ((len & 0x7f) << 8) | payload[pos + 1];
      head = 2;
    }
    if (len < 2 || pos + head + len > payload.length) break;
    const sub = payload.subarray(pos + head, pos + head + len);
    out.push({ cmd: sub.readUInt16BE(0), body: sub.subarray(2) });
    pos += head + len;
  }
  return out;
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** Reads fields off a payload in order; past the end, numbers are null. */
class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  get left() {
    return this.buf.length - this.pos;
  }

  byte() {
    return this.pos < this.buf.length ? this.buf[this.pos++] : null;
  }

  u16() {
    if (this.left < 2) return null;
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  /** A length-prefixed number. */
  num() {
    const len = this.byte();
    if (len == null || len > 4 || this.left < len) return null;
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + this.buf[this.pos++];
    return v;
  }

  bytes(n) {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += out.length;
    return out;
  }
}

/** Labels come as fixed-width text, UTF-16 big-endian on newer firmware, else one byte a letter. */
function text(buf) {
  const utf16 = buf.length % 2 === 0 && buf.length > 1 && [...buf].filter((b, i) => i % 2 === 0).every((b) => b === 0);
  const s = utf16 ? Buffer.from(buf).swap16().toString('utf16le') : buf.toString('latin1');
  return s.replace(/\0+/g, ' ').trim();
}

const ZONE_BITS = [
  [0x80, 'bypassed'], [0x40, 'alarm memory'], [0x20, 'alarm'], [0x10, 'delinquency'],
  [0x08, 'low battery'], [0x04, 'fault'], [0x02, 'tamper'], [0x01, 'open'],
];

/**
 * What the panel says, applied to `panel`. `payload` is everything after the command code.
 * Returns a description for the log, or null for a code it doesn't read.
 */
function read(code, payload, panel) {
  const r = new Reader(payload);
  switch (code) {
    case 0x0502: {
      // the answer to one of our commands: [app sequence answered][result]
      const app = r.byte();
      const result = r.byte();
      return `Response to #${app}: ${RESPONSE[result] || `code ${result}`}`;
    }
    case 0x0501: {
      const failed = r.u16();
      const why = r.byte();
      return `Refused ${failed == null ? '?' : name(failed)}: ${NACK[why] || `code ${why}`}`;
    }
    case 0x0210: {
      const zone = r.num();
      const status = r.byte();
      if (zone == null || status == null) return 'Zone status (short)';
      panel.setZoneOpen(zone, Boolean(status & 0x01));
      return `Zone ${zone} ${status & 0x01 ? 'open' : 'closed'}`;
    }
    case 0x0230: {
      // [partition][flags: 01 audible, 02 restarted, 04 urgent, 80 running][seconds]
      const partition = r.num();
      const flags = r.byte();
      const seconds = r.num();
      const running = Boolean(flags & 0x80) || (flags !== 0 && seconds > 0);
      panel.setExitDelay(partition, running ? seconds || 1 : 0);
      return `Partition ${partition}: exit delay ${running ? `${seconds}s${flags & 0x04 ? ', urgent' : ''}` : 'over'}`;
    }
    case 0x0231: {
      // same layout as the exit delay
      const partition = r.num();
      const flags = r.byte();
      const seconds = r.num();
      panel.setEntryDelay(partition, flags ? (flags & 0x04 ? 0x03 : 0x01) : 0x00);
      return `Partition ${partition}: entry delay ${flags ? `${ENTRY_DELAY[flags & 0x04 ? 3 : 1]}${seconds ? ` (${seconds}s)` : ''}` : 'over'}`;
    }
    case 0x0232: {
      const partition = r.num();
      const state = r.byte();
      const method = r.byte();
      const user = r.num();
      panel.setArming(partition, state, method, user);
      const a = ARMING[state];
      return `Partition ${partition}: ${a ? a.text : `arming state ${state}`}`
        + (method != null ? ` (${ARM_METHOD[method] || 'unknown'}${user != null ? `, user ${user}` : ''})` : '');
    }
    case 0x0239: {
      const partition = r.num();
      const ready = r.byte();
      panel.setReady(partition, ready);
      return `Partition ${partition}: ${(READY[ready] || READY[0]).text}`;
    }
    case 0x023b: {
      const partition = r.num();
      const on = r.byte();
      panel.setPartitionFlag(partition, 'bell', Boolean(on));
      return `Partition ${partition}: siren ${on ? 'on' : 'off'}`;
    }
    case 0x023c: {
      const partition = r.num();
      const on = r.byte();
      panel.setPartitionFlag(partition, 'alarmMemory', Boolean(on));
      return `Partition ${partition}: ${on ? 'alarm in memory' : 'alarm memory cleared'}`;
    }
    case 0x023f: {
      const partition = r.num();
      const on = r.byte();
      panel.setPartitionFlag(partition, 'trouble', Boolean(on));
      return `Partition ${partition}: ${on ? 'trouble' : 'no trouble'}`;
    }
    case 0x0840: {
      const partition = r.num();
      r.num(); // how many zones this message covers
      const zone = r.num();
      const type = r.byte();
      const active = r.byte();
      panel.setZoneAlarm(zone, type, Boolean(active));
      return `Partition ${partition}, zone ${zone}: ${ALARM_TYPE[type] || 'alarm'} ${active ? 'alarm' : 'restored'}`;
    }
    case 0x0811: {
      // [first zone][count][bytes a zone], then the zones
      const first = r.num();
      const count = r.num();
      const width = r.byte() || 1;
      if (first == null || count == null) return 'Zone status (short)';
      const open = [];
      for (let i = 0; i < count && r.left >= width; i++) {
        const status = r.bytes(width)[0]; // a PowerSeries Pro sends 2 bytes a zone: the flags come first
        const zone = first + i;
        panel.setZoneOpen(zone, Boolean(status & 0x01));
        if (status & 0x20) panel.setZoneAlarm(zone, 0, true);
        if (status) open.push(`${zone} ${ZONE_BITS.filter(([bit]) => status & bit).map(([, n]) => n).join('+')}`);
      }
      return `Zones ${first}–${first + count - 1}: ${open.length ? open.join(', ') : 'all closed'}`;
    }
    case 0x0812: {
      // [partition][status byte count][status bytes]
      const partition = r.num();
      r.byte();
      const s1 = r.byte();
      const s2 = r.byte();
      if (partition == null || s1 == null) return 'Partition status (short)';
      const armed = Boolean(s1 & 0x01);
      if (armed) {
        const code = s1 & 0x10 ? 0x11 : s1 & 0x08 ? 0x04 : s1 & 0x04 ? 0x02 : s1 & 0x02 ? 0x01 : 0x06;
        panel.setArming(partition, code, null, null);
      } else {
        panel.setArming(partition, 0x00, null, null);
        panel.setReady(partition, s1 & 0x08 ? 0x03 : s1 & 0x04 ? 0x02 : s1 & 0x02 ? 0x01 : 0x00);
      }
      if (s2 != null) {
        panel.setPartitionFlag(partition, 'bell', Boolean(s2 & 0x40));
        panel.setPartitionFlag(partition, 'alarmMemory', Boolean(s2 & 0x10));
        panel.setPartitionFlag(partition, 'trouble', Boolean(s2 & 0x02));
      }
      const p = panel.partition(partition);
      return `Partition ${partition}: ${p.armingText}${armed ? '' : `, ${p.readyText}`}`
        + `${s1 & 0x20 ? ', exit delay' : ''}${s1 & 0x40 ? ', entry delay' : ''}${s2 & 0x01 ? ', ALARM' : ''}`;
    }
    case 0x0771: {
      // [01D1 zones | 01D3 partitions][first][last][name length…][names]
      const kind = r.u16() === 0x01d1 ? 'zone' : 'partition';
      const first = r.num();
      const last = r.num();
      const width = r.num();
      if (first == null || last == null || !width) return `${kind} labels (short)`;
      const got = [];
      for (let n = first; n <= last && r.left >= width; n++) {
        const label = text(r.bytes(width));
        panel.setLabel(kind, n, label);
        if (label) got.push(`${n} "${label}"`);
      }
      return `${kind === 'zone' ? 'Zone' : 'Partition'} labels ${first}–${last}: ${got.join(', ') || '(blank)'}`;
    }
    case 0x0613: {
      const [maxZones, maxUsers, maxPartitions] = [r.num(), r.num(), r.num()];
      panel.setInfo({ maxZones, maxUsers, maxPartitions });
      return `Capabilities: ${maxZones} zones, ${maxUsers} users, ${maxPartitions} partitions`;
    }
    case 0x060d: {
      const v = [...payload.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0'));
      const version = `${parseInt(v[0], 10)}.${v[1]} build ${v[2]}${v[3] && v[3] !== '00' ? ` test ${v[3]}` : ''}`;
      panel.setInfo({ softwareVersion: version });
      return `Software version ${version}`;
    }
    case 0x0614: {
      const status = r.byte();
      const product = r.u16();
      panel.setInfo({ panelStatus: status, productId: product });
      return `Panel status ${status}, product 0x${(product || 0).toString(16)}`;
    }
    default:
      return null;
  }
}

module.exports = { build, read, unpack, num, bcd, Reader, text };
