/**
 * Companion pairing.
 *
 * Pair-setup (once per Apple TV): the TV shows a 4-digit PIN; SRP proves we know it, then
 * both sides exchange long-term Ed25519 keys over an encrypted channel. The result is a
 * set of credentials stored in data/appletv/settings.json.
 *
 * Pair-verify (every connection): an X25519 exchange signed with those long-term keys
 * gives fresh session keys for ChaCha20-Poly1305.
 */
const nodeCrypto = require('crypto');

const opack = require('./opack');
const { Tlv, encode: tlv, decode: untlv, throwIfError } = require('./tlv8');
const { srpClient } = require('./srp');
const c = require('./crypto');
const { FrameType } = require('./connection');

function pairingData(message) {
  const data = message._pd;
  if (!Buffer.isBuffer(data)) throw new Error('The Apple TV sent no pairing data');
  const fields = untlv(data);
  throwIfError(fields);
  return fields;
}

function field(fields, type, what) {
  const value = fields.get(type);
  if (!value) throw new Error(`The Apple TV's pairing response is missing the ${what}`);
  return value;
}

// ── Pair-setup ───────────────────────────────────────────────────────────────

/** M1 → M2. The Apple TV shows a PIN once this resolves. */
async function pairSetupStart(client) {
  const m2 = pairingData(await client.exchangeAuth(FrameType.PS_Start, {
    _pd: tlv([[Tlv.Method, [0x00]], [Tlv.State, [0x01]]]),
    _pwTy: 1,
  }));
  return { salt: field(m2, Tlv.Salt, 'salt'), serverPublic: field(m2, Tlv.PublicKey, 'public key') };
}

/**
 * M3 → M6 with the PIN the user read off the TV.
 * @returns credentials to store: { clientId, clientSecret, clientPublic, atvId, atvPublic } (hex/strings)
 */
async function pairSetupFinish(client, { salt, serverPublic }, pin, displayName, log) {
  const srp = srpClient({ pin: String(pin).trim(), salt, serverPublic });

  const m4 = pairingData(await client.exchangeAuth(FrameType.PS_Next, {
    _pd: tlv([[Tlv.State, [0x03]], [Tlv.PublicKey, srp.A], [Tlv.Proof, srp.M1]]),
    _pwTy: 1,
  }));
  if (!field(m4, Tlv.Proof, 'proof').equals(srp.expectedM2)) {
    log?.warn('The Apple TV\'s pairing proof did not match — continuing, as it accepted the PIN');
  }

  const keys = c.ed25519KeyPair();
  const pairingId = Buffer.from(nodeCrypto.randomUUID());
  const controllerX = c.hkdf(srp.K, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info');
  const sessionKey = c.hkdf(srp.K, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
  const signature = c.ed25519Sign(keys.secret, Buffer.concat([controllerX, pairingId, keys.public]));

  const m5 = tlv([
    [Tlv.Identifier, pairingId],
    [Tlv.PublicKey, keys.public],
    [Tlv.Signature, signature],
    [Tlv.Name, opack.encode({ name: displayName })],
  ]);
  const m6 = pairingData(await client.exchangeAuth(FrameType.PS_Next, {
    _pd: tlv([[Tlv.State, [0x05]], [Tlv.EncryptedData, c.seal(sessionKey, c.labelNonce('PS-Msg05'), m5)]]),
    _pwTy: 1,
  }));

  const device = untlv(c.open(sessionKey, c.labelNonce('PS-Msg06'), field(m6, Tlv.EncryptedData, 'encrypted data')));
  const atvId = field(device, Tlv.Identifier, 'identifier');
  const atvPublic = field(device, Tlv.PublicKey, 'long-term key');
  const accessoryX = c.hkdf(srp.K, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info');
  if (!c.ed25519Verify(atvPublic, Buffer.concat([accessoryX, atvId, atvPublic]), device.get(Tlv.Signature) || Buffer.alloc(64))) {
    log?.warn('Could not verify the Apple TV\'s pairing signature — continuing');
  }

  return {
    clientId: pairingId.toString('utf8'),
    clientSecret: keys.secret.toString('hex'),
    clientPublic: keys.public.toString('hex'),
    atvId: atvId.toString('hex'),
    atvPublic: atvPublic.toString('hex'),
  };
}

// ── Pair-verify ──────────────────────────────────────────────────────────────

/** @returns {{ outKey: Buffer, inKey: Buffer }} session keys */
async function pairVerify(client, credentials) {
  const clientId = Buffer.from(credentials.clientId, 'utf8');
  const clientSecret = Buffer.from(credentials.clientSecret, 'hex');
  const atvId = Buffer.from(credentials.atvId, 'hex');
  const atvPublic = Buffer.from(credentials.atvPublic, 'hex');
  const ephemeral = c.x25519KeyPair();

  const m2 = pairingData(await client.exchangeAuth(FrameType.PV_Start, {
    _pd: tlv([[Tlv.State, [0x01]], [Tlv.PublicKey, ephemeral.public]]),
    _auTy: 4,
  }));
  const atvEphemeral = field(m2, Tlv.PublicKey, 'session key');
  const shared = c.x25519Shared(ephemeral.secret, atvEphemeral);
  const sessionKey = c.hkdf(shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');

  const inner = untlv(c.open(sessionKey, c.labelNonce('PV-Msg02'), field(m2, Tlv.EncryptedData, 'encrypted data')));
  const identifier = inner.get(Tlv.Identifier);
  if (!identifier || !identifier.equals(atvId)) {
    throw new Error('A different Apple TV answered at this address — pair it again');
  }
  if (!c.ed25519Verify(atvPublic, Buffer.concat([atvEphemeral, identifier, ephemeral.public]), inner.get(Tlv.Signature) || Buffer.alloc(64))) {
    throw new Error('The Apple TV failed verification — pair it again');
  }

  const proof = tlv([
    [Tlv.Identifier, clientId],
    [Tlv.Signature, c.ed25519Sign(clientSecret, Buffer.concat([ephemeral.public, clientId, atvEphemeral]))],
  ]);
  try {
    pairingData(await client.exchangeAuth(FrameType.PV_Next, {
      _pd: tlv([[Tlv.State, [0x03]], [Tlv.EncryptedData, c.seal(sessionKey, c.labelNonce('PV-Msg03'), proof)]]),
    }));
  } catch (err) {
    if (err.tlvError === 0x02) throw new Error('The Apple TV no longer accepts this pairing (removed in its settings?) — pair it again');
    throw err;
  }

  return {
    outKey: c.hkdf(shared, '', 'ClientEncrypt-main'),
    inKey: c.hkdf(shared, '', 'ServerEncrypt-main'),
  };
}

module.exports = { pairSetupStart, pairSetupFinish, pairVerify };
