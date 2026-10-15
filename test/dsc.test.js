/**
 * DSC PowerSeries Pro (ITv2): framing, packets and message decoding against the layouts in
 * Savant's own DSC PowerSeries Neo profile. Remove with src/integrations/dsc/.
 */
require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const DSC = '../SplycedBoard/src/integrations/dsc';
const { frame, Deframer, escape, unescape, crc16 } = require(`${DSC}/itv2/frame`);
const { encode, decodeAll } = require(`${DSC}/itv2/packet`);
const { build, read, unpack } = require(`${DSC}/itv2/messages`);
const { ARM_MODE } = require(`${DSC}/itv2/codes`);
const { PanelState } = require(`${DSC}/panel`);

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

test('frames: <header> 7E <body> 7F, escaped, and read back out of a stream in pieces', () => {
  const body = hex('01 7E 02 7F 03 7D 04');
  assert.deepEqual(escape(body), hex('01 7D01 02 7D02 03 7D00 04'));
  assert.deepEqual(unescape(escape(body)), body);
  const id = Buffer.from('123456789012');
  const wire = Buffer.concat([frame(body, id), frame(hex('AA'))]);
  assert.deepEqual(wire.subarray(0, 13), Buffer.concat([id, hex('7E')]), 'the integration ID goes before the separator');
  const errors = [];
  const d = new Deframer({ onError: (e) => errors.push(e) });
  const got = [...d.push(wire.subarray(0, 5)), ...d.push(wire.subarray(5))];
  assert.deepEqual(got, [{ header: id, body }, { header: Buffer.alloc(0), body: hex('AA') }]);
  assert.deepEqual(d.push(hex('7E 01 7D 09 7F')), [], 'a bad escape is skipped');
  assert.deepEqual(d.push(hex('01 02 7F')), [], 'so is a message with no separator');
  assert.equal(errors.length, 2);
});

test('the CRC is CRC-16/CCITT-FALSE', () => {
  assert.equal(crc16(Buffer.from('123456789')), 0x29b1, 'its standard check value');
});

test("packets come out the lengths Savant's own DSC profile sends", () => {
  const len = (p) => encode(p)[0];
  assert.equal(len({ seq: 1, ack: 2, cmd: 0x0900, appSeq: 3, payload: build.arm(1, ARM_MODE.away, '1234') }), 0x0c, 'Arm');
  assert.equal(len({ seq: 1, ack: 2, cmd: 0x0901, appSeq: 3, payload: build.disarm(1, '1234') }), 0x0b, 'Disarm');
  assert.equal(len({ seq: 1, ack: 2, cmd: 0x0600 }), 0x06, 'Poll');
  assert.equal(len({ seq: 1, ack: 2 }), 0x04, 'a bare acknowledgement');
  assert.equal(len({ seq: 1, ack: 2, cmd: 0x0800, appSeq: 3, payload: build.request(0x0810) }), 0x09, 'Request global status');

  const arm = encode({ seq: 5, ack: 9, cmd: 0x0900, appSeq: 7, payload: build.arm(2, ARM_MODE.stay, '123456') });
  const [p] = decodeAll(arm);
  assert.equal(p.crcOk, true);
  assert.deepEqual([p.seq, p.ack, p.cmd, p.appSeq], [5, 9, 0x0900, 7]);
  assert.deepEqual(p.payload, hex('01 02 01 12 34 56'), 'partition 2, stay, the code in BCD');

  const long = encode({ seq: 1, ack: 1, cmd: 0x0771, payload: Buffer.alloc(200) });
  assert.equal(long[0], 0x80, 'more than 127 bytes: two-byte length');
  assert.equal(decodeAll(Buffer.concat([long, Buffer.alloc(5)]))[0].payload.length, 200, 'padding after a packet is ignored');
});

test('packets captured from real communicators decode, CRCs and all', () => {
  // A TL2803G (firmware 5.63) opening a session, with the 4-byte type 3 offer at the end
  const [open] = decodeAll(hex('19 00 00 06 0A DC 02 03 2B 05 63 02 23 02 00 02 00 00 02 01 03 03 02 01 E3 5C'));
  assert.deepEqual([open.crcOk, open.cmd, open.appSeq, open.payload.length], [true, 0x060a, 0xdc, 18]);
  // A server's CommandResponse, a Simple Ack, and a panel refusing an Open Session
  const [response] = decodeAll(hex('08 01 00 05 02 91 00 DE 3C'));
  assert.deepEqual([response.crcOk, response.cmd, [...response.payload]], [true, 0x0502, [0x91, 0x00]]);
  const [simpleAck] = decodeAll(hex('04 02 01 66 1F'));
  assert.deepEqual([simpleAck.crcOk, simpleAck.cmd, simpleAck.seq, simpleAck.ack], [true, null, 2, 1]);
  const [refused] = decodeAll(hex('09 00 02 05 01 06 0A 01 FB DE'));
  assert.equal(refused.crcOk, true);
  assert.match(read(refused.cmd, refused.payload, new PanelState()), /Refused OpenSession: Command length wrong/);
  // and we build that same CommandResponse byte for byte
  assert.deepEqual(encode({ seq: 1, ack: 0, cmd: 0x0502, payload: hex('91 00') }), hex('08 01 00 05 02 91 00 DE 3C'));
});

test('arming, readiness and zone notifications update the panel', () => {
  const panel = new PanelState();
  assert.match(read(0x0232, hex('01 01 02 01 01 03'), panel), /Partition 1: Armed Away \(access code, user 3\)/);
  assert.equal(panel.partition(1).arming, 'away');
  read(0x0239, hex('01 02 03'), panel);
  assert.equal(panel.partition(2).ready, false);
  assert.equal(read(0x0210, hex('01 05 01'), panel), 'Zone 5 open');
  assert.equal(panel.zone(5).open, true);
  read(0x0210, hex('01 05 00'), panel);
  assert.equal(panel.zone(5).open, false);
  read(0x0840, hex('01 01 01 01 01 07 01 01'), panel);
  assert.deepEqual([panel.zone(7).alarm, panel.zone(7).alarmType], [true, 'Burglary']);
  assert.match(read(0x0502, hex('07 11'), panel), /#7: Invalid access code/);
});

test('status answers: a block of zones, and a partition', () => {
  const panel = new PanelState();
  // zones 1–4: open, closed, tamper, bypassed
  assert.match(read(0x0811, hex('01 01 01 04 01 01 00 02 80'), panel), /1 open, 3 tamper, 4 bypassed/);
  assert.deepEqual([1, 2, 3, 4].map((z) => panel.zone(z).open), [true, false, false, false]);
  // partition 2, disarmed and ready; then partition 1 armed away with the siren on
  read(0x0812, hex('01 02 03 02 00 00'), panel);
  assert.deepEqual([panel.partition(2).arming, panel.partition(2).ready], ['disarmed', true]);
  read(0x0812, hex('01 01 03 05 41 00'), panel);
  assert.deepEqual([panel.partition(1).arming, panel.partition(1).bell], ['away', true]);
});

test("a PowerSeries Pro's zone status: two bytes a zone, the flags first", () => {
  const panel = new PanelState();
  read(0x0811, hex('01 01 01 03 02 01 00 00 00 21 00'), panel);
  assert.deepEqual([1, 2, 3].map((z) => panel.zone(z).open), [true, false, true]);
  assert.equal(panel.zone(3).alarm, true);
});

test('exit and entry delays: [partition][flags][seconds]', () => {
  const panel = new PanelState({ now: () => 1000 });
  assert.equal(read(0x0230, hex('01 01 81 01 3C'), panel), 'Partition 1: exit delay 60s');
  assert.equal(panel.snapshot().partitions[0].exitDelaySeconds, 60);
  assert.equal(read(0x0230, hex('01 01 00 01 00'), panel), 'Partition 1: exit delay over');
  assert.equal(panel.partition(1).exitDelayUntil, null);
  assert.match(read(0x0231, hex('01 01 80 01 1E'), panel), /Partition 1: entry delay running \(30s\)/);
  assert.ok(panel.partition(1).entryDelay);
});

test('requests: what the open-source servers send', () => {
  assert.deepEqual(build.capabilities(), hex('06 13 01 00 01 00 01 00 01 00 01 00 01 00'));
  assert.deepEqual(build.zoneStatus(1, 128), hex('08 11 01 01 01 80'));
  assert.deepEqual(build.partitionStatus(3), hex('08 12 01 03 00'));
  assert.deepEqual(build.labels('zone', 9, 16), hex('07 71 01 D1 01 09 01 10 01 00'));
  assert.deepEqual(unpack(hex('05 02 10 01 05 01  04 02 39 01 01')), [
    { cmd: 0x0210, body: hex('01 05 01') },
    { cmd: 0x0239, body: hex('01 01') },
  ]);
});

test('labels: one byte a letter, or UTF-16', () => {
  const panel = new PanelState();
  const ascii = Buffer.concat([hex('01D1 01 01 01 02 01 08'), Buffer.from('Front Dr'), Buffer.from('Kitchen ')]);
  read(0x0771, ascii, panel);
  assert.deepEqual([panel.zone(1).label, panel.zone(2).label], ['Front Dr', 'Kitchen']);
  const utf16 = Buffer.concat([hex('01D3 01 01 01 01 01 08'), Buffer.from('Home', 'utf16le').swap16()]);
  read(0x0771, utf16, panel);
  assert.equal(panel.partition(1).label, 'Home');
});
