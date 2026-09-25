/**
 * Lutron processor discovery: the direct LEAP-port check used when mDNS finds nothing, and
 * telling "nothing found" apart from "macOS won't let SplycedBoard onto the network".
 */
const h = require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { sweep, tryConnect, localNetworkBlocked } = require('../SplycedBoard/src/integrations/lutron/discovery');

function listen() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy()).listen(0, '127.0.0.1', () => resolve(server));
  });
}
const close = (server) => new Promise((resolve) => server.close(resolve));

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

test('a connection attempt reports why it failed', async () => {
  const result = await tryConnect('127.0.0.1', await h.freePort());
  assert.deepEqual([result.ok, result.code], [false, 'ECONNREFUSED']);
});

test('the network counts as blocked only when hosts known to exist all fail with "no route"', async () => {
  const connect = (codes) => async (host) => ({ ok: false, code: codes[host], ms: 1 });
  const router = '192.168.5.1';
  const dashboard = '192.168.5.178';
  assert.equal(await localNetworkBlocked([router, dashboard], { connect: connect({ [router]: 'EHOSTUNREACH', [dashboard]: 'EHOSTUNREACH' }) }), true);
  assert.equal(await localNetworkBlocked([router, dashboard], { connect: connect({ [router]: 'EHOSTUNREACH', [dashboard]: 'ECONNREFUSED' }) }), false);
  assert.equal(await localNetworkBlocked([router], { connect: connect({ [router]: 'TIMEOUT' }) }), false, "timeouts don't tell");
  assert.equal(await localNetworkBlocked(['127.0.0.1', null]), false, 'nothing to ask');
});
