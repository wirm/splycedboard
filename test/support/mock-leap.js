/**
 * Mock Lutron LEAP processor (QSX-style) for the test suite.
 *
 * Behaves like a HomeWorks QSX where the Lutron integration depends on it: /zone and
 * /device answer 405 so the controller takes its per-area fallback paths, button
 * groups hang off each keypad device, and zone changes are pushed to subscribers.
 * Payload shapes follow what src/integrations/lutron/controller.js parses — this is a
 * test double, not a protocol reference.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const forge = require('node-forge');

// ── Certificates ─────────────────────────────────────────────────────────────

function selfSigned(commonName) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: privateKey };
}

/** Client certificate set shaped like what pairing stores: { ca, cert, key }. */
function makeClientCerts() {
  const { cert, key } = selfSigned('SplycedBoard test client');
  return { ca: cert, cert, key };
}

// ── Inventory ────────────────────────────────────────────────────────────────

function createState() {
  // Areas nest as on a real system: the project, floors, then rooms.
  const areas = [
    { id: 100, name: 'Home' },
    { id: 110, name: 'Main Floor', parent: 100 },
    { id: 120, name: 'Upstairs', parent: 100 },
    { id: 1, name: 'Kitchen', parent: 110 },
    { id: 2, name: 'Living Room', parent: 110 },
    { id: 3, name: 'Primary Suite', parent: 120 },
  ];
  const zones = [
    { id: 101, area: 1, name: 'Kitchen Cans', type: 'Dimmed', level: 75 },
    { id: 102, area: 1, name: 'Pendants', type: 'Switched', level: 0 },
    { id: 201, area: 2, name: 'Window Shades', type: 'Shade', level: 50 },
    { id: 202, area: 2, name: 'Cove Ketra', type: 'SpectrumTune', level: 40 },
    { id: 203, area: 2, name: 'Ceiling Fan', type: 'FanSpeed', level: 0 },
    { id: 301, area: 3, name: 'Vanity Rania', type: 'WhiteTune', level: 60 },
    {
      id: 302, area: 3, name: 'Primary Thermostat', type: 'DualSetPointHVAC',
      hvac: { temp: 71, heat: 68, cool: 76, mode: 'Auto', fan: 'Auto', state: 'Idle' },
    },
  ];
  // Keypads as a QSX lists them: a control station ("Entry") holds a device ("Device 1") of a
  // type and model; buttons carry their faceplate position as ButtonNumber. Raise/lower (16/17,
  // 18/19) have no LED and no programming model.
  const keypads = [
    {
      deviceId: 501, stationId: 401, area: 1, station: 'Entry', type: 'SeeTouchKeypad', model: 'HQWD-W4S', buttonGroupId: 601,
      buttons: [
        { id: 701, number: 1, engraving: 'Welcome', led: 801, ledState: 'Off' },
        { id: 702, number: 2, engraving: 'Cooking', led: 802, ledState: 'Off' },
        { id: 703, number: 3, engraving: 'Dinner', led: 803, ledState: 'Off' },
        { id: 704, number: 4, engraving: 'Night', led: 804, ledState: 'Off' },
        { id: 706, number: 6, engraving: 'All Off', led: 806, ledState: 'On' },
        { id: 718, number: 18 },
        { id: 719, number: 19 },
      ],
    },
    {
      deviceId: 502, stationId: 402, area: 3, station: 'Bedside', type: 'PalladiomKeypad', model: 'HQWT-U-PRW', buttonGroupId: 602,
      buttons: [
        { id: 711, number: 1, engraving: 'Bright', led: 811, ledState: 'Off' },
        { id: 712, number: 2, engraving: '', led: 812, ledState: 'Off' },
        { id: 713, number: 3, engraving: 'Off', led: 813, ledState: 'Off' },
        { id: 716, number: 16 },
        { id: 717, number: 17 },
      ],
    },
  ];
  const keypad = keypads[0];
  const scenes = [
    { id: 1, name: 'All Off', programmed: true },
    { id: 2, name: 'Movie', programmed: true },
    { id: 3, name: 'Unused', programmed: false },
  ];
  return { areas, zones, keypads, keypad, scenes };
}

// ── Server ───────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ port, state, received: object[], close(), push(msg) }>}
 *   received — every request the controller sent, for assertions
 */
function startMockProcessor({ port = 0, host = '127.0.0.1' } = {}) {
  const state = createState();
  const received = [];
  const sockets = new Set();
  const { cert, key } = selfSigned('mock-qsx');

  const zoneById = (id) => state.zones.find((z) => z.id === id);
  const keypadByDevice = (id) => state.keypads.find((k) => k.deviceId === id);
  const buttonById = (id) => state.keypads.flatMap((k) => k.buttons).find((b) => b.id === id);
  const ledStatus = (led) => {
    const b = state.keypads.flatMap((k) => k.buttons).find((x) => x.led === led);
    return b && { LEDStatus: { href: `/led/${led}/status`, LED: { href: `/led/${led}` }, State: b.ledState } };
  };
  const areaHref = (id) => ({ href: `/area/${id}` });

  const zoneStatus = (z) => {
    if (z.hvac) {
      return {
        Zone: { href: `/zone/${z.id}` },
        DualSetPointHVACStatus: {
          CurrentTemperature: { F: z.hvac.temp },
          HeatingSetPoint: { F: z.hvac.heat },
          CoolingSetPoint: { F: z.hvac.cool },
          OperatingMode: z.hvac.mode,
          FanMode: z.hvac.fan,
          OperatingStatuses: [z.hvac.state],
        },
      };
    }
    return { Zone: { href: `/zone/${z.id}` }, Level: z.level };
  };

  const push = (body) => {
    const line = JSON.stringify({ CommuniqueType: 'ReadResponse', Header: { MessageBodyType: 'Status' }, Body: body }) + '\r\n';
    for (const s of sockets) if (s.subscribed) s.write(line);
  };

  function read(url) {
    let m;
    if (url === '/area') {
      return {
        AreaList: state.areas.map((a) => ({
          href: `/area/${a.id}`,
          Name: a.name,
          ...(a.parent ? { Parent: { href: `/area/${a.parent}` } } : {}),
          IsLeaf: !state.areas.some((x) => x.parent === a.id),
        })),
      };
    }
    if (url === '/zone' || url === '/device' || url.startsWith('/buttongroup')) return 405;
    if (url === '/zone/status') return { ZoneStatusList: state.zones.filter((z) => !z.hvac).map(zoneStatus).concat(state.zones.filter((z) => z.hvac).map((z) => ({ Zone: { href: `/zone/${z.id}` } }))) };
    if ((m = url.match(/^\/zone\/(\d+)\/status$/))) {
      const z = zoneById(Number(m[1]));
      return z ? { ZoneStatus: zoneStatus(z) } : 404;
    }
    if ((m = url.match(/^\/zone\/(\d+)$/))) {
      const z = zoneById(Number(m[1]));
      if (!z) return 404;
      const zone = { href: url, Name: z.name, ControlType: z.type, AssociatedArea: areaHref(z.area) };
      if (z.hvac) {
        zone.DualSetPointHVACProperties = {
          OperatingModes: ['Off', 'Heat', 'Cool', 'Auto'],
          FanModes: ['Auto', 'On', 'High', 'Medium', 'Low'],
          HeatingSetPointRange: { F: { Min: 40, Max: 90 } },
          CoolingSetPointRange: { F: { Min: 60, Max: 99 } },
        };
      }
      return { Zone: zone };
    }
    if ((m = url.match(/^\/area\/(\d+)\/associatedcontrolstation$/))) {
      return {
        ControlStationList: state.keypads.filter((k) => k.area === Number(m[1])).map((k) => ({
          href: `/controlstation/${k.stationId}`,
          Name: k.station,
          AssociatedGangedDevices: [{ Device: { href: `/device/${k.deviceId}`, DeviceType: k.type, AddressedState: 'Addressed' }, GangPosition: 0 }],
        })),
      };
    }
    if ((m = url.match(/^\/device\/(\d+)$/))) {
      const k = keypadByDevice(Number(m[1]));
      if (!k) return 404;
      return {
        Device: {
          href: url, Name: 'Device 1', DeviceType: k.type, ModelNumber: k.model,
          AssociatedArea: areaHref(k.area), AssociatedControlStation: { href: `/controlstation/${k.stationId}` },
        },
      };
    }
    if ((m = url.match(/^\/device\/(\d+)\/buttongroup$/))) {
      const k = keypadByDevice(Number(m[1]));
      if (!k) return 404;
      return {
        ButtonGroups: [{
          href: `/buttongroup/${k.buttonGroupId}`,
          Parent: { href: `/device/${k.deviceId}` },
          Buttons: k.buttons.map((b) => ({ href: `/button/${b.id}` })),
          ProgrammingType: 'Freeform',
        }],
      };
    }
    if ((m = url.match(/^\/button\/(\d+)$/))) {
      const b = buttonById(Number(m[1]));
      if (!b) return 404;
      const k = state.keypads.find((x) => x.buttons.includes(b));
      return {
        Button: {
          href: url, ButtonNumber: b.number, Name: `Button ${b.number}`, Parent: { href: `/buttongroup/${k.buttonGroupId}` },
          ...(b.led ? {
            Engraving: { Text: b.engraving },
            AssociatedLED: { href: `/led/${b.led}` },
            ProgrammingModel: { href: `/programmingmodel/${b.id + 1}`, ProgrammingModelType: 'AdvancedToggleProgrammingModel' },
          } : {}),
        },
      };
    }
    if ((m = url.match(/^\/led\/(\d+)\/status$/))) return ledStatus(Number(m[1])) || 404;
    if (url === '/virtualbutton') {
      return { VirtualButtonList: state.scenes.map((s) => ({ href: `/virtualbutton/${s.id}`, Name: s.name, IsProgrammed: s.programmed })) };
    }
    if (url === '/server/1/status/ping') return { PingResponse: { LEAPVersion: 1.2 } };
    return 404;
  }

  function command(url, body) {
    let m;
    const cmd = body?.Command || {};
    if ((m = url.match(/^\/zone\/(\d+)\/commandprocessor$/))) {
      const z = zoneById(Number(m[1]));
      if (!z) return 404;
      if (cmd.CommandType === 'GoToLevel') z.level = cmd.Parameter?.[0]?.Value ?? z.level;
      if (cmd.CommandType === 'GoToSpectrumTuningLevel') z.level = cmd.SpectrumTuningLevelParameters?.Level ?? z.level;
      if (cmd.CommandType === 'GoToDualSetPointParameters') {
        const p = cmd.DualSetPointParameters || {};
        if (p.HeatingSetPoint) z.hvac.heat = p.HeatingSetPoint.F;
        if (p.CoolingSetPoint) z.hvac.cool = p.CoolingSetPoint.F;
        if (p.OperatingMode) z.hvac.mode = p.OperatingMode;
        if (p.FanMode) z.hvac.fan = p.FanMode;
      }
      setImmediate(() => push({ ZoneStatus: zoneStatus(z) }));
      return 201;
    }
    if ((m = url.match(/^\/area\/(\d+)\/commandprocessor$/))) {
      const level = cmd.Parameter?.[0]?.Value ?? 0;
      for (const z of state.zones.filter((x) => x.area === Number(m[1]) && !x.hvac && x.type !== 'Shade')) {
        z.level = level;
        setImmediate(() => push({ ZoneStatus: zoneStatus(z) }));
      }
      return 201;
    }
    if ((m = url.match(/^\/virtualbutton\/(\d+)\/commandprocessor$/))) {
      const scene = state.scenes.find((s) => s.id === Number(m[1]));
      if (!scene) return 404;
      if (scene.name === 'All Off') {
        for (const z of state.zones.filter((x) => !x.hvac && x.type !== 'Shade')) {
          z.level = 0;
          setImmediate(() => push({ ZoneStatus: zoneStatus(z) }));
        }
      }
      return 201;
    }
    // As a QSX takes them: PressAndRelease is a tap and runs a scene button (here: toggles its
    // LED); PressAndHold is a hold, which runs nothing on a scene button, until Release.
    if ((m = url.match(/^\/button\/(\d+)\/commandprocessor$/))) {
      const b = buttonById(Number(m[1]));
      if (!b) return 404;
      const type = cmd.CommandType;
      if (!['PressAndRelease', 'PressAndHold', 'Release'].includes(type)) return 400;
      b.commands = [...(b.commands || []), type];
      const event = (e) => setImmediate(() => push({ ButtonStatus: { Button: { href: `/button/${b.id}` }, ButtonEvent: { EventType: e } } }));
      if (type !== 'Release') event('Press');
      if (type !== 'PressAndHold') event('Release');
      if (type === 'PressAndRelease' && b.led) {
        b.ledState = b.ledState === 'On' ? 'Off' : 'On';
        setImmediate(() => push({ LEDStatus: { LED: { href: `/led/${b.led}` }, State: b.ledState } }));
      }
      return 201;
    }
    return 404;
  }

  // As a QSX answers: no subscription to every button or LED at once, one per button and LED
  function subscribe(url) {
    if (url === '/button/status') return 404;
    if (url === '/button/status/event' || url === '/led/status') return 400; // "This request is not supported"
    let m = url.match(/^\/led\/(\d+)\/status$/);
    if (m) return ledStatus(Number(m[1])) || 404;
    m = url.match(/^\/button\/(\d+)\/status\/event$/);
    if (m) return buttonById(Number(m[1])) ? 204 : 404;
    return 200;
  }

  function respond(socket, msg) {
    const { CommuniqueType: type, Header: { ClientTag: tag, Url: url } = {}, Body: body } = msg;
    received.push({ type, url, body });

    let result;
    if (type === 'ReadRequest') result = read(url);
    else if (type === 'SubscribeRequest') result = subscribe(url);
    else if (type === 'CreateRequest') result = command(url, body);
    else result = 400;

    if (type === 'SubscribeRequest' && (result === 200 || result === 204 || typeof result === 'object')) socket.subscribed = true;

    const code = typeof result === 'number' ? result : 200;
    const text = { 200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 404: 'Not Found', 405: 'Method Not Allowed' }[code];
    const reply = { CommuniqueType: type.replace('Request', 'Response'), Header: { ClientTag: tag, StatusCode: `${code} ${text}`, Url: url } };
    if (typeof result === 'object') reply.Body = result;
    socket.write(JSON.stringify(reply) + '\r\n');
  }

  const server = tls.createServer({ cert, key }, (socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { respond(socket, JSON.parse(line)); } catch { /* ignore junk */ }
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        state,
        received,
        push,
        /** Drop every connection (simulates the processor rebooting). */
        dropConnections() { for (const s of sockets) s.destroy(); },
        close() {
          for (const s of sockets) s.destroy();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

/** Write a paired-processor config for the mock into a test data dir. */
function seedDataDir(dataDir, port) {
  const lutronDir = path.join(dataDir, 'lutron');
  const certDir = path.join(lutronDir, 'certs');
  fs.mkdirSync(certDir, { recursive: true });
  const certs = makeClientCerts();
  fs.writeFileSync(path.join(certDir, 'mock-ca.crt'), certs.ca);
  fs.writeFileSync(path.join(certDir, 'mock-client.crt'), certs.cert);
  fs.writeFileSync(path.join(certDir, 'mock-client.key'), certs.key);
  fs.writeFileSync(path.join(lutronDir, 'settings.json'), JSON.stringify({
    processor: { id: 'mock', host: '127.0.0.1', port, name: 'Mock QSX', pairedAt: new Date().toISOString() },
    componentName: 'Lutron LEAP Bridge',
  }, null, 2));
}

/**
 * The processor's pairing port (8083), as QSX firmware 26.06 behaves: silent after the TLS
 * handshake until put into pairing mode, then a status granting PhysicalAccess; a CSR sent
 * after that is answered with a SigningResult.
 *
 *   const p = await startMockPairing();
 *   p.pairingMode(['Public', 'PhysicalAccess'])   // what pressing the keypad button does
 */
async function startMockPairing({ answer = 'sign' } = {}) {
  const { cert, key } = selfSigned('homeworksqs-mock-server');
  const sockets = new Set();
  const requests = [];
  const server = tls.createServer({ cert, key, requestCert: true, rejectUnauthorized: false }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const request = JSON.parse(line);
        requests.push(request);
        const reply = answer === 'sign'
          ? { Header: { StatusCode: '200 OK', ContentType: 'signing-result;plurality=single', ClientTag: 'get-cert' },
              Body: { SigningResult: { Certificate: 'SIGNED-CERT', RootCertificate: 'ROOT-CA' } } }
          : { Header: { StatusCode: '401 Unauthorized', ContentType: 'exception;plurality=single', ClientTag: 'get-cert' },
              Body: { Message: 'not allowed' } };
        socket.write(JSON.stringify(reply) + '\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    connections: () => sockets.size,
    pairingMode(permissions = ['Public', 'PhysicalAccess']) {
      const status = { Header: { StatusCode: '200 OK', ContentType: 'status;plurality=single' }, Body: { Status: { Permissions: permissions } } };
      for (const socket of sockets) socket.write(JSON.stringify(status) + '\r\n');
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startMockProcessor, startMockPairing, makeClientCerts, seedDataDir };
