/**
 * Apple TV Companion protocol building blocks, checked against independent references:
 * pyatv's OPACK test vectors, fast-srp-hap (HAP-NodeJS's SRP), and Node's own HKDF.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { SRP, SrpServer } = require('fast-srp-hap');

const opack = require('../SplycedBoard/src/integrations/appletv/companion/opack');
const tlv8 = require('../SplycedBoard/src/integrations/appletv/companion/tlv8');
const { srpClient, N, g } = require('../SplycedBoard/src/integrations/appletv/companion/srp');
const c = require('../SplycedBoard/src/integrations/appletv/companion/crypto');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const repeat = (byte, n) => Buffer.alloc(n, byte);

// Pack vectors from pyatv's tests/support/test_opack.py
const PACK_VECTORS = [
  [true, '01'],
  [false, '02'],
  [null, '04'],
  [0, '08'],
  [0xf, '17'],
  [0x27, '2f'],
  [0x28, '30 28'],
  [0x1ff, '31 ff 01'],
  [0x1ffffff, '32 ff ff ff 01'],
  [0x1ffffffffffffffn, '33 ff ff ff ff ff ff ff 01'],
  [opack.float(1.0), '36 00 00 00 00 00 00 f0 3f'],
  ['a', '41 61'],
  ['abc', '43 61 62 63'],
  ['a'.repeat(0x20), Buffer.concat([hex('60'), repeat(0x61, 32)])],
  ['a'.repeat(33), Buffer.concat([hex('61 21'), repeat(0x61, 33)])],
  ['a'.repeat(256), Buffer.concat([hex('62 00 01'), repeat(0x61, 256)])],
  [hex('ac'), '71 ac'],
  [hex('12 34 56'), '73 12 34 56'],
  [repeat(0xad, 32), Buffer.concat([hex('90'), repeat(0xad, 32)])],
  [repeat(0x61, 33), Buffer.concat([hex('91 21'), repeat(0x61, 33)])],
  [repeat(0x61, 256), Buffer.concat([hex('92 00 01'), repeat(0x61, 256)])],
  [repeat(0x61, 65536), Buffer.concat([hex('93 00 00 01 00'), repeat(0x61, 65536)])],
  [[], 'd0'],
  [[1, 'test', false], 'd3 09 44 74 65 73 74 02'],
  [[[true]], 'd1 d1 01'],
  [Array(15).fill('a'), Buffer.concat([hex('df 41 61'), repeat(0xa0, 14), hex('03')])],
  [{}, 'e0'],
  [['a', 'a'], 'd2 41 61 a0'],
  [['foo', 'bar', 'foo', 'bar'], 'd4 43 66 6f 6f 43 62 61 72 a0 a1'],
  [{ a: 'b', c: { d: 'a' }, d: true }, 'e3 41 61 41 62 41 63 e1 41 64 a0 a3 01'],
];

// Unpack-only vectors (floats in both widths, 1-byte back-reference, open-ended list)
const UNPACK_VECTORS = [
  ['35 00 00 80 3f', 1.0],
  ['36 00 00 00 00 00 00 f0 3f', 1.0],
  ['e2 41 61 14 02 04', { a: 12, false: null }],
  ['e1 01 e1 41 61 0a', { true: { a: 2 } }],
  ['df 30 01 30 02 c1 01 03', [1, 2, 2]],
  ['05 12 34 56 78 12 34 56 78 12 34 56 78 12 34 56 78', '12345678-1234-5678-1234-567812345678'],
];

test('OPACK encoding matches pyatv byte for byte', () => {
  for (const [value, expected] of PACK_VECTORS) {
    const want = Buffer.isBuffer(expected) ? expected : hex(expected);
    assert.deepEqual(opack.encode(value), want, `encode ${String(value).slice(0, 40)}`);
  }
});

test('OPACK decoding round-trips pyatv vectors', () => {
  for (const [value, expected] of PACK_VECTORS) {
    const bytes = Buffer.isBuffer(expected) ? expected : hex(expected);
    const plain = value && value.constructor?.name === 'OpackFloat' ? value.value : value;
    const want = typeof plain === 'bigint' ? Number(plain) : plain;
    assert.deepEqual(opack.decode(bytes), want);
  }
  for (const [bytes, want] of UNPACK_VECTORS) assert.deepEqual(opack.decode(hex(bytes)), want);
});

test('OPACK round-trips a realistic Companion message', () => {
  const message = { _i: '_hidC', _t: 2, _c: { _hBtS: 1, _hidC: 6 }, _x: 40123 };
  const bytes = opack.encode(message);
  assert.equal(bytes.toString('hex').includes('a1'), true, 'repeated "_hidC" is a back-reference');
  assert.deepEqual(opack.decode(bytes), message);
  assert.deepEqual(opack.decode(opack.encode({ _sid: 0x123456789abcdef0n })), { _sid: Number(0x123456789abcdef0n) });
});

test('TLV8 splits values over 255 bytes and joins them back', () => {
  const big = crypto.randomBytes(384);
  const bytes = tlv8.encode([[tlv8.Tlv.State, [1]], [tlv8.Tlv.PublicKey, big]]);
  assert.equal(bytes.length, 3 + (2 + 255) + (2 + 129));
  const back = tlv8.decode(bytes);
  assert.deepEqual(back.get(tlv8.Tlv.PublicKey), big);
  assert.throws(() => tlv8.throwIfError(tlv8.decode(tlv8.encode([[tlv8.Tlv.Error, [2]]]))), /Wrong PIN/);
});

test('SRP group is RFC 5054 3072-bit with g = 5 (same prime as Node\'s modp15)', () => {
  assert.equal(N.toString(16), crypto.getDiffieHellman('modp15').getPrime('hex'));
  assert.equal(g, 5n);
});

test('SRP client agrees with an independent HAP SRP server, including leading-zero edge cases', async () => {
  for (let i = 0; i < 25; i++) {
    const salt = crypto.randomBytes(16);
    if (i % 4 === 0) salt[0] = 0;
    const pin = String(1000 + i * 7);
    const server = new SrpServer(SRP.params.hap, salt, Buffer.from('Pair-Setup'), Buffer.from(pin), await SRP.genKey(32));
    const client = srpClient({ pin, salt, serverPublic: server.computeB() });
    server.setA(client.A);
    assert.doesNotThrow(() => server.checkM1(client.M1));
    assert.deepEqual(client.K, server.computeK());
    assert.deepEqual(client.expectedM2, server.computeM2());
  }
});

test('a wrong PIN produces a proof the server rejects', async () => {
  const salt = crypto.randomBytes(16);
  const server = new SrpServer(SRP.params.hap, salt, Buffer.from('Pair-Setup'), Buffer.from('1234'), await SRP.genKey(32));
  const client = srpClient({ pin: '9999', salt, serverPublic: server.computeB() });
  server.setA(client.A);
  assert.throws(() => server.checkM1(client.M1));
});

test('HKDF-SHA512 matches Node\'s implementation, including the empty salt', () => {
  const ikm = crypto.randomBytes(32);
  for (const [salt, info] of [['Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info'], ['', 'ClientEncrypt-main']]) {
    const expected = Buffer.from(crypto.hkdfSync('sha512', ikm, Buffer.from(salt), Buffer.from(info), 32));
    assert.deepEqual(c.hkdf(ikm, salt, info), expected);
  }
});

test('ChaCha20-Poly1305 nonces: label form and 12-byte counter form', () => {
  assert.deepEqual(c.labelNonce('PV-Msg02'), Buffer.concat([Buffer.alloc(4), Buffer.from('PV-Msg02')]));
  assert.deepEqual(c.counterNonce(1), hex('01 00 00 00 00 00 00 00 00 00 00 00'));
  const key = crypto.randomBytes(32);
  const aad = hex('08 00 00 20');
  const sealed = c.seal(key, c.counterNonce(7), Buffer.from('hello'), aad);
  assert.equal(sealed.length, 5 + 16);
  assert.equal(c.open(key, c.counterNonce(7), sealed, aad).toString(), 'hello');
  assert.throws(() => c.open(key, c.counterNonce(8), sealed, aad));
  // Must interoperate with Node's own ChaCha20-Poly1305
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, c.counterNonce(7), { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: 5 });
  const nodeSealed = Buffer.concat([cipher.update(Buffer.from('hello')), cipher.final(), cipher.getAuthTag()]);
  assert.deepEqual(sealed, nodeSealed);
});

test('Ed25519 and X25519 behave as expected', () => {
  const keys = c.ed25519KeyPair();
  const sig = c.ed25519Sign(keys.secret, Buffer.from('m'));
  assert.equal(c.ed25519Verify(keys.public, Buffer.from('m'), sig), true);
  assert.equal(c.ed25519Verify(keys.public, Buffer.from('x'), sig), false);
  const a = c.x25519KeyPair();
  const b = c.x25519KeyPair();
  assert.deepEqual(c.x25519Shared(a.secret, b.public), c.x25519Shared(b.secret, a.public));
  // Cross-check X25519 against Node
  const nodeKey = crypto.createPrivateKey({ key: Buffer.concat([hex('302e020100300506032b656e04220420'), a.secret]), format: 'der', type: 'pkcs8' });
  const nodePub = crypto.createPublicKey(nodeKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  assert.deepEqual(nodePub, a.public);
});
