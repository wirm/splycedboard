/**
 * The TV tools' pure parts: which year a model number is from (Samsung, LG, Sony), LG's
 * IP control encryption (checked against a second AES implementation), and the network
 * helpers (MAC addresses, Wake-on-LAN packets, subnets).
 */
require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { ecb, cbc } = require('@noble/ciphers/aes');

const lan = require('../SplycedBoard/src/core/lan');
const samsungModels = require('../SplycedBoard/src/integrations/samsungtv/models');
const lgDriver = require('../SplycedBoard/src/integrations/lgtv/driver');
const lgIp = require('../SplycedBoard/src/integrations/lgtv/ipcontrol');
const sonyDriver = require('../SplycedBoard/src/integrations/sonytv/driver');
const samsungDriver = require('../SplycedBoard/src/integrations/samsungtv/driver');

test('Samsung model years: the Tizen code when there is one, else the model number\'s letter', () => {
  assert.equal(samsungModels.yearFromApiModel('18_KANTM2_FRAME'), 2018);
  assert.equal(samsungModels.yearFromApiModel('24_PONTUSM_QTV'), 2024);
  assert.equal(samsungModels.yearFromApiModel('UN55LS03N'), null);
  const cases = {
    'LN32A550': 2008, 'LN-T3253H': 2007, 'PN50C450': 2010,
    'UN55C8000': 2010, 'UN46D7000': 2011, 'UN55ES8000': 2012, 'UN32F6300': 2013, 'UN55HU8550': 2014,
    'UN40J5200': 2015, 'UN85JU7100': 2015, 'UN55KS8000': 2016, 'UN55MU8000': 2017, 'QN65Q9FAMFXZA': 2017,
    'QN65Q7FNAFXZA': 2018, 'UN55NU8000': 2018, 'UN55LS03N': 2018, 'UN55LS003AFXZA': 2017, 'QN65Q60RAFXZA': 2019,
    'UN65TU8000FXZA': 2020, 'QN65Q60TAFXZA': 2020, 'QN55LS03TAFXZA': 2020, 'QN65QN90AAFXZA': 2021, 'UN55AU8000': 2021,
    'QN65QN90BAFXZA': 2022, 'QN65S95CAFXZA': 2023, 'UN55CU7000': 2023, 'QN65QN90DAFXZA': 2024, 'UN55DU8000': 2024,
    'QN65QN90FAFXZA': 2025, 'UN65U8000FFXZA': 2025, 'QN(XX)Q60T': 2020, '': null, 'HW-Q990D': null,
  };
  for (const [model, year] of Object.entries(cases)) assert.equal(samsungModels.yearFromModel(model), year, model);
  assert.deepEqual([2012, 2016, 2019, 2020, 2025].map(samsungModels.generation), ['legacy', 'smart-view', 'smart-view', 'ip-control', 'ip-control']);
});

test('LG and Sony model years', () => {
  const lg = {
    OLED55B6P: 2016, OLED55B7A: 2017, OLED65C8PUA: 2018, OLED65C9PUA: 2019, OLED65CXPUA: 2020, OLED65G1PUA: 2021,
    OLED65C2PUA: 2022, OLED77C3PUA: 2023, OLED65C4PUA: 2024, OLED65C5PUA: 2025,
    '55UH6030': 2016, '65SK8000PUA': 2018, '65UM7300PUA': 2019, '86UQ7590PUD': 2022,
    '65NANO85UNA': 2020, NANO75UPA: 2021, QNED80URA: 2023, 'LG Smart TV': null,
  };
  for (const [model, year] of Object.entries(lg)) assert.equal(lgDriver.yearFromModel(model), year, model);
  assert.equal(lgDriver.modelIn('1.0', 'LG Smart TV', '[LG] webOS TV OLED65C8PUA'), 'OLED65C8PUA');
  assert.equal(lgDriver.modelIn('LG TV', null), null);

  const sony = {
    'KDL-40W600B': 2014, 'XBR-55X810C': 2015, 'XBR-65X900E': 2017, 'XBR-65X900F': 2018, 'XBR-65A9G': 2019,
    'KD-55X750H': 2020, 'XR-65A80J': 2021, 'XR-65X90K': 2022, 'XR-65A95L': 2023, 'K-65XR90': 2024, 'K-65XR80M2': 2025,
  };
  for (const [model, year] of Object.entries(sony)) assert.equal(sonyDriver.yearFromModel(model), year, model);
});

test('LG encryption: PBKDF2 key, IV sent under ECB, message under CBC, padded the way the TV pads', () => {
  const keycode = 'A1B2C3D4';
  const key = lgIp.deriveKey(keycode);
  assert.deepEqual(key, crypto.pbkdf2Sync(keycode, lgIp.SALT, 16384, 16, 'sha256'));
  assert.equal(lgIp.SALT.toString('hex'), '6361b80e9bdca6638d0720f2cc568fb9');

  // Padding: to whole 16-byte blocks with the pad length; a message that fills its blocks gets a space first.
  assert.equal(lgIp.pad('POWER off\r'), `POWER off\r${'\x06'.repeat(6)}`);
  assert.equal(lgIp.pad('KEY_ACTION exit\r'), `KEY_ACTION exit\r ${'\x0f'.repeat(15)}`);

  // Decrypted by an independent AES implementation
  const iv = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const wire = lgIp.encrypt('CURRENT_VOL', keycode, iv);
  assert.equal(wire.length, 32);
  const ivBack = Buffer.from(ecb(key, { disablePadding: true }).decrypt(wire.subarray(0, 16)));
  assert.deepEqual(ivBack, iv);
  const plain = Buffer.from(cbc(key, iv, { disablePadding: true }).decrypt(wire.subarray(16))).toString('latin1');
  assert.equal(plain, `CURRENT_VOL\r${'\x04'.repeat(4)}`);

  // …and the TV's answer read back, up to its newline
  const answerIv = crypto.randomBytes(16);
  const body = Buffer.from(`VOL:12\n${'\x09'.repeat(9)}`, 'latin1');
  const answer = Buffer.concat([
    Buffer.from(ecb(key, { disablePadding: true }).encrypt(answerIv)),
    Buffer.from(cbc(key, answerIv, { disablePadding: true }).encrypt(body)),
  ]);
  assert.equal(lgIp.decrypt(answer, keycode), 'VOL:12');
  assert.equal(lgIp.decrypt(answer, 'WRONGKEY'), null, 'a wrong keycode reads as noise');
  assert.equal(lgIp.decrypt(answer.subarray(0, 20), keycode), null, 'not whole yet');
});

test('which Blueprint components each tool takes as its TVs, and where their key is', () => {
  const c = (manufacturer, model, deviceType = 'HD_monitor') => ({ manufacturer, model, deviceType });
  assert.equal(samsungDriver.isBlueprintTv(c('Samsung', 'TV (2025)')), true);
  assert.equal(samsungDriver.isBlueprintTv(c('Samsung', 'BD-C5500', 'EnhancedDVD_player')), false);
  assert.equal(samsungDriver.isBlueprintTv(c('Samsung', 'Soundbar (2025)', 'Surround_speaker_system')), false);
  assert.equal(lgDriver.isBlueprintTv(c('LG', 'OLED(XX)CXPUB')), true);
  assert.equal(lgDriver.isBlueprintTv(c('Samsung', 'TV (2025)')), false);
  assert.equal(sonyDriver.isBlueprintTv(c('Sony', 'K-(xx)XR90 (splyced)')), true);
  assert.equal(sonyDriver.isBlueprintTv(c('Sony', 'VPL-VW695ES')), false, 'projectors');

  assert.deepEqual(samsungDriver.blueprintKey('<state_variable name="AccessToken" user_editable="yes"/>'), { variable: 'AccessToken', fixed: null });
  assert.deepEqual(samsungDriver.blueprintKey('<ir ir_command_format_type="racepointmedia"/>'), { variable: null, fixed: null }, 'IR-only profiles have no key');
  assert.deepEqual(lgDriver.blueprintKey('<state_variable name="AccessToken" state_center_binding="AccessToken"/>'), { variable: 'AccessToken', fixed: null });
  assert.deepEqual(sonyDriver.blueprintKey('<http_header name="X-Auth-PSK">1234</http_header>'), { variable: null, fixed: '1234' });
  assert.equal(lgDriver.validateKey('A1B2C3D4'), null);
  assert.match(lgDriver.validateKey('A1B2'), /8 letters and digits/);
});

test('MAC addresses, Wake-on-LAN packets, subnets', () => {
  assert.equal(lan.normalizeMac('0:11:2:aa:bb:c'), '00:11:02:AA:BB:0C');
  assert.equal(lan.normalizeMac('04-5d-4b-aa-bb-cc'), '04:5D:4B:AA:BB:CC');
  assert.equal(lan.normalizeMac('045d4baabbcc'), '04:5D:4B:AA:BB:CC');
  assert.equal(lan.normalizeMac('00:00:00:00:00:00'), null);
  assert.equal(lan.normalizeMac('not a mac'), null);

  const packet = lan.magicPacket('70:2A:D5:B9:18:FE');
  assert.equal(packet.length, 102);
  assert.deepEqual(packet.subarray(0, 6), Buffer.alloc(6, 0xff));
  for (let i = 0; i < 16; i++) assert.equal(packet.subarray(6 + i * 6, 12 + i * 6).toString('hex'), '702ad5b918fe');
  assert.throws(() => lan.magicPacket('nope'), /isn't a MAC address/);

  const interfaces = {
    lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    en0: [{ address: '192.168.5.139', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    en1: [{ address: '10.1.2.3', netmask: '255.255.0.0', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    bridge0: [{ address: '169.254.10.1', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
  };
  assert.deepEqual(lan.localSubnets(interfaces), ['192.168.5', '10.1.2']);
  assert.deepEqual(lan.localInterfaces(interfaces).map((i) => i.broadcast), ['192.168.5.255', '10.1.255.255']);
  assert.equal(lan.isIPv4('192.168.5.300'), false);
  assert.equal(lan.isIPv4('192.168.5.30'), true);
});
