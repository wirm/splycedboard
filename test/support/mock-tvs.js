/**
 * Mock TVs for the TV tools' tests, all on 127.0.0.1 (each on its own port; the tests point
 * the drivers' PORTS at them):
 *
 *   samsungInfo      a Tizen TV's description, http://…/api/v2/ (every 2016+ Samsung has it)
 *   samsungIpControl 2020+ IP Control: JSON-RPC over HTTPS, createAccessToken
 *   samsungSmartView 2016–2019 Smart View: the remote channel over WSS, token on Allow
 *   samsungLegacy    pre-2016 remote on TCP: authentication, then key presses
 *   lg               Network IP Control, encrypted with a keycode
 *   sony             BRAVIA REST + IRCC with a Pre-Shared Key
 *
 * Test doubles shaped by what the drivers parse, not protocol references.
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const WebSocket = require('ws');

const { selfSigned } = require('./mock-leap');
const legacy = require('../../SplycedBoard/src/integrations/samsungtv/legacy');

let certificate = null;
const tlsOptions = () => (certificate ||= selfSigned('mock-tv'));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closer(server, sockets = new Set()) {
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  return () => new Promise((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => resolve(body));
  });
}

// ── Samsung ──────────────────────────────────────────────────────────────────

async function samsungInfo({ model = '18_KANTM2_FRAME', modelName = 'UN55LS03N', name = '[TV] Living Room', mac = '70:2a:d5:b9:18:fe', tokenAuth = true, frame = true, powerState } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/v2/') {
      res.writeHead(404).end();
      return;
    }
    const device = {
      FrameTVSupport: String(frame), OS: 'Tizen', TokenAuthSupport: String(tokenAuth), model, modelName, name,
      networkType: 'wired', wifiMac: mac, firmwareVersion: 'Unknown', resolution: '3840x2160', type: 'Samsung SmartTV',
    };
    if (powerState) device.PowerState = powerState;
    res.end(JSON.stringify({ device, name, remote: '1.0', type: 'Samsung SmartTV', version: '2.0.25' }));
  });
  const close = closer(server);
  return { port: await listen(server), close };
}

async function samsungIpControl({ token = 'TOKEN-1234', allow = true, delayMs = 50 } = {}) {
  const calls = [];
  const state = { power: 'powerOn', volume: 12, mute: 'muteOff', input: 'HDMI1' };
  const mock = { calls, state, allow, token };
  const server = https.createServer(tlsOptions(), async (req, res) => {
    const msg = JSON.parse(await readBody(req));
    calls.push(msg);
    const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    const fail = (message) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } }));
    if (msg.method === 'createAccessToken') {
      setTimeout(() => (mock.allow ? reply({ AccessToken: mock.token }) : fail('Unauthorized')), delayMs);
      return;
    }
    const p = msg.params || {};
    if (p.AccessToken !== mock.token) {
      fail('Unauthorized');
      return;
    }
    switch (msg.method) {
      case 'powerControl': if (p.power) state.power = p.power; reply({ power: state.power }); return;
      case 'directVolumeControl': if (p.volume !== undefined) state.volume = p.volume; reply({ volume: state.volume }); return;
      case 'muteControl': if (p.mute) state.mute = p.mute; reply({ mute: state.mute }); return;
      case 'volumeUpDnControl': state.volume += p.control === 'volumeUp' ? 1 : -1; reply({}); return;
      case 'inputSourceControl': state.input = p.inputSource; reply({}); return;
      default: reply({});
    }
  });
  mock.close = closer(server);
  mock.port = await listen(server);
  return mock;
}

async function samsungSmartView({ token = 'SV-5678', allow = true } = {}) {
  const connections = [];
  const keys = [];
  const mock = { connections, keys, token, allow };
  const server = https.createServer(tlsOptions());
  const wss = new WebSocket.Server({ server });
  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, 'https://tv');
    connections.push(url);
    socket.on('message', (data) => {
      const msg = JSON.parse(String(data));
      keys.push(`${msg.params.Cmd}:${msg.params.DataOfCmd}`);
    });
    if (url.searchParams.get('token') === mock.token) {
      socket.send(JSON.stringify({ event: 'ms.channel.connect', data: { clients: [], id: 'x' } }));
    } else if (mock.allow) {
      setTimeout(() => socket.send(JSON.stringify({ event: 'ms.channel.connect', data: { clients: [], id: 'x', token: mock.token } })), 50);
    } else {
      socket.send(JSON.stringify({ event: 'ms.channel.unauthorized' }));
    }
  });
  const close = closer(server);
  mock.close = async () => {
    for (const c of wss.clients) c.terminate();
    await close();
  };
  mock.port = await listen(server);
  return mock;
}

/** Replies are 0x00, the app name, then the payload, as legacy.js reads them. */
function legacyReply(payload) {
  const app = Buffer.from('iapp.samsung');
  const out = Buffer.alloc(1 + 2 + app.length + 2 + payload.length);
  out[0] = 0x00;
  out.writeUInt16LE(app.length, 1);
  app.copy(out, 3);
  out.writeUInt16LE(payload.length, 3 + app.length);
  Buffer.from(payload).copy(out, 5 + app.length);
  return out;
}

async function samsungLegacy({ allow = true } = {}) {
  const keys = [];
  const remotes = [];
  const mock = { keys, remotes, allow };
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let authed = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const packets = [...legacy.replies(buf)];
      if (!packets.length) return;
      buf = buf.subarray(packets[packets.length - 1].end);
      for (const { payload } of packets) {
        if (!authed && payload[0] === 0x64) {
          // Three base64 strings: description, id, name
          const strings = [];
          let i = 2;
          while (i + 2 <= payload.length) {
            const len = payload.readUInt16LE(i);
            strings.push(Buffer.from(payload.subarray(i + 2, i + 2 + len).toString(), 'base64').toString());
            i += 2 + len;
          }
          remotes.push(strings);
          socket.write(legacyReply([0x0a, 0x00, 0x02, 0x00])); // asking on screen…
          setTimeout(() => {
            authed = mock.allow;
            socket.write(legacyReply(mock.allow ? [0x64, 0x00, 0x01, 0x00] : [0x64, 0x00, 0x00, 0x00]));
          }, 30);
        } else if (authed) {
          const len = payload.readUInt16LE(3);
          keys.push(Buffer.from(payload.subarray(5, 5 + len).toString(), 'base64').toString());
          socket.write(legacyReply([0x00, 0x00, 0x00, 0x00]));
        }
      }
    });
  });
  mock.close = closer(server);
  mock.port = await listen(server);
  return mock;
}

// ── LG ───────────────────────────────────────────────────────────────────────

const LG_SALT = Buffer.from([0x63, 0x61, 0xb8, 0x0e, 0x9b, 0xdc, 0xa6, 0x63, 0x8d, 0x07, 0x20, 0xf2, 0xcc, 0x56, 0x8f, 0xb9]);

function lgKey(keycode) {
  return crypto.pbkdf2Sync(keycode, LG_SALT, 16384, 16, 'sha256');
}

/** The TV's end: IV (ECB) + message (CBC), the text padded like the TV pads it. */
function lgEncrypt(text, key) {
  const iv = crypto.randomBytes(16);
  let t = text;
  if (t.length % 16 === 0) t += ' ';
  if (t.length % 16) t += String.fromCharCode(16 - (t.length % 16)).repeat(16 - (t.length % 16));
  const ecb = crypto.createCipheriv('aes-128-ecb', key, Buffer.alloc(0));
  ecb.setAutoPadding(false);
  const cbc = crypto.createCipheriv('aes-128-cbc', key, iv);
  cbc.setAutoPadding(false);
  return Buffer.concat([ecb.update(iv), ecb.final(), cbc.update(Buffer.from(t, 'latin1')), cbc.final()]);
}

function lgDecrypt(buf, key) {
  const ecb = crypto.createDecipheriv('aes-128-ecb', key, Buffer.alloc(0));
  ecb.setAutoPadding(false);
  const iv = Buffer.concat([ecb.update(buf.subarray(0, 16)), ecb.final()]);
  const cbc = crypto.createDecipheriv('aes-128-cbc', key, iv);
  cbc.setAutoPadding(false);
  return Buffer.concat([cbc.update(buf.subarray(16)), cbc.final()]).toString('latin1');
}

async function lg({ keycode = 'A1B2C3D4', mac = 'a8:23:fe:01:02:03' } = {}) {
  const commands = [];
  const state = { volume: 12, mute: 'off', app: 'com.webos.app.hdmi1', power: 'on' };
  const mock = { commands, state, keycode, raw: [] };
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 32 || buf.length % 16) return;
      const text = lgDecrypt(buf, lgKey(mock.keycode));
      buf = Buffer.alloc(0);
      const end = text.indexOf('\r');
      const command = end >= 0 ? text.slice(0, end) : null;
      // A wrong keycode decrypts to noise: a real TV drops it.
      if (!command || !/^[\x20-\x7e]+$/.test(command)) {
        socket.destroy();
        return;
      }
      commands.push(command);
      let answer = 'OK';
      if (command === 'GET_MACADDRESS wired') answer = mac;
      else if (command === 'CURRENT_VOL') answer = `VOL:${state.volume}`;
      else if (command === 'MUTE_STATE') answer = `MUTE:${state.mute}`;
      else if (command === 'CURRENT_APP') answer = `APP:${state.app}`;
      else if (command.startsWith('VOLUME_CONTROL ')) state.volume = Number(command.split(' ')[1]);
      else if (command.startsWith('VOLUME_MUTE ')) state.mute = command.split(' ')[1];
      else if (command === 'POWER off') state.power = 'off';
      else if (!/^(KEY_ACTION|INPUT_SELECT|APP_LAUNCH) /.test(command)) answer = 'ERROR';
      socket.write(lgEncrypt(`${answer}\n`, lgKey(mock.keycode)));
    });
  });
  mock.close = closer(server);
  mock.port = await listen(server);
  return mock;
}

// ── Sony ─────────────────────────────────────────────────────────────────────

const SONY_CODES = [
  { name: 'VolumeUp', value: 'TV-VOLUP' },
  { name: 'Confirm', value: 'TV-CONFIRM' },
  { name: 'Up', value: 'TV-UP' },
];

async function sony({ psk = '1234', model = 'XR-65A80J', mac = '04-5d-4b-aa-bb-cc' } = {}) {
  const calls = [];
  const ircc = [];
  const state = { power: 'active', volume: 15, mute: false };
  const mock = { calls, ircc, state, psk };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const authed = req.headers['x-auth-psk'] === mock.psk;
    if (req.url === '/sony/ircc') {
      if (!authed) {
        res.writeHead(403).end();
        return;
      }
      ircc.push(body.match(/<IRCCCode>([^<]*)<\/IRCCCode>/)?.[1]);
      res.end('<?xml version="1.0"?><s:Envelope/>');
      return;
    }
    const msg = JSON.parse(body);
    calls.push(`${req.url} ${msg.method}`);
    const reply = (result) => res.end(JSON.stringify({ result, id: msg.id }));
    if (msg.method === 'getInterfaceInformation') {
      reply([{ productCategory: 'tv', productName: 'BRAVIA', modelName: model, serverName: '', interfaceVersion: '6.1.0' }]);
      return;
    }
    if (!authed) {
      res.end(JSON.stringify({ error: [403, 'Forbidden'], id: msg.id }));
      return;
    }
    const p = msg.params?.[0] || {};
    switch (msg.method) {
      case 'getSystemInformation': reply([{ product: 'TV', model, macAddr: mac, name: 'BRAVIA' }]); return;
      case 'getPowerStatus': reply([{ status: state.power }]); return;
      case 'setPowerStatus': state.power = p.status ? 'active' : 'standby'; reply([]); return;
      case 'getVolumeInformation': reply([[{ target: 'speaker', volume: state.volume, mute: state.mute, maxVolume: 100, minVolume: 0 }]]); return;
      case 'setAudioVolume': state.volume = Number(p.volume); reply([0]); return;
      case 'setAudioMute': state.mute = p.status; reply([0]); return;
      case 'getRemoteControllerInfo': reply([{ bundled: true, type: 'RM-J1100' }, SONY_CODES]); return;
      case 'getPlayingContentInfo': reply([{ uri: 'extInput:hdmi?port=2', source: 'extInput:hdmi', title: 'HDMI 2' }]); return;
      default: res.end(JSON.stringify({ error: [12, 'No Such Method'], id: msg.id }));
    }
  });
  mock.close = closer(server);
  mock.port = await listen(server);
  return mock;
}

module.exports = { samsungInfo, samsungIpControl, samsungSmartView, samsungLegacy, lg, sony, lgKey, lgEncrypt, lgDecrypt };
