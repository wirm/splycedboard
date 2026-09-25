/**
 * Lutron processor discovery: mDNS first, then the direct LEAP-port check, then advice when
 * nothing turns up. Browsing and sweeping are replaced here, since the real ones depend on
 * the network the tests run on.
 */
const h = require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { sweep, discoverProcessors } = require('../SplycedBoard/src/integrations/lutron/discovery');
const { RUNTIME } = require('../SplycedBoard/src/core/local-network');

function listen() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy()).listen(0, '127.0.0.1', () => resolve(server));
  });
}
const close = (server) => new Promise((resolve) => server.close(resolve));

function recorder() {
  const warnings = [];
  return { log: { info() {}, warn: (m) => warnings.push(m) }, warnings };
}

const processor = { id: '192.168.5.138', name: 'Lutron Status', host: '192.168.5.138', port: 8081 };

test('an address with both LEAP ports open is a processor; one open port is not', async () => {
  const pairing = await listen();
  const leap = await listen();
  try {
    const found = await sweep(['127.0.0.1'], { ports: [pairing.address().port, leap.address().port] });
    assert.deepEqual(found.map((p) => [p.host, p.port]), [['127.0.0.1', 8081]]);
    assert.deepEqual(await sweep(['127.0.0.1'], { ports: [pairing.address().port, await h.freePort()] }), []);
  } finally {
    await close(pairing);
    await close(leap);
  }
});

test('processors found by mDNS come straight back', async () => {
  const { log } = recorder();
  const steps = {
    browse: async () => ({ processors: [processor], problems: [] }),
    sweep: async () => assert.fail('no direct check needed'),
    advise: async () => assert.fail('no advice needed'),
  };
  assert.deepEqual(await discoverProcessors(10, { log, steps }), { processors: [processor], problem: null, hint: null });
});

test('when mDNS finds nothing, the direct check can', async () => {
  const { log } = recorder();
  const steps = {
    browse: async () => ({ processors: [], problems: [] }),
    sweep: async () => [processor],
    advise: async () => assert.fail('no advice needed'),
  };
  assert.deepEqual(await discoverProcessors(10, { log, steps }), { processors: [processor], problem: null, hint: null });
});

test('when nothing is found, the scan says so, logs why, and says what to check', async () => {
  const { log, warnings } = recorder();
  const steps = {
    browse: async () => ({ processors: [], problems: ['EHOSTUNREACH', 'EHOSTUNREACH'] }),
    sweep: async () => [],
    advise: async () => ({ problem: null, hint: 'No Lutron processors found. (advice)' }),
  };
  assert.deepEqual(await discoverProcessors(10, { log, steps }), { processors: [], problem: null, hint: 'No Lutron processors found. (advice)' });
  assert.deepEqual(warnings, ['mDNS problems while scanning: EHOSTUNREACH', 'No Lutron processors found. (advice)']);
});

test('the advice given by default names the Local Network setting and Manual Entry', async () => {
  const { log } = recorder();
  const steps = { browse: async () => ({ processors: [], problems: [] }), sweep: async () => [] };
  const { processors, problem, hint } = await discoverProcessors(10, { log, steps, client: '127.0.0.1' });
  assert.deepEqual(processors, []);
  // Whether this machine's network looks blocked decides which of the two; both name the setting.
  assert.ok((hint || problem).includes(`Local Network and switch on "${RUNTIME}"`));
  if (hint) assert.match(hint, /^No Lutron processors found\. .*Manual Entry\.$/);
});
