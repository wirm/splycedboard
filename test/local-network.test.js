/**
 * Reaching the local network from the Pro Host (core/local-network.js): telling a network
 * with nothing on it apart from macOS keeping SplycedBoard off it, and the advice a scan
 * shows when it comes back empty.
 */
const h = require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RUNTIME, tryConnect, localNetworkBlocked, adviceForEmptyScan } = require('../SplycedBoard/src/core/local-network');

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

test('an empty scan points at the Local Network setting, naming the runtime SplycedBoard runs on', async () => {
  assert.equal(RUNTIME, process.versions.bun ? 'bun' : 'node');
  const empty = await adviceForEmptyScan({
    what: 'Lutron processors',
    fallback: 'Or add the processor by IP with Manual Entry.',
    isBlocked: async () => false,
    gateway: async () => '192.168.5.1',
  });
  assert.equal(empty.problem, null);
  assert.match(empty.hint, /^No Lutron processors found\. /);
  assert.ok(empty.hint.includes(`System Settings → Privacy & Security → Local Network and switch on "${RUNTIME}".`));
  assert.match(empty.hint, /Or add the processor by IP with Manual Entry\.$/);

  const blocked = await adviceForEmptyScan({ what: 'Apple TVs', fallback: '', isBlocked: async () => true, gateway: async () => null });
  assert.equal(blocked.hint, null);
  assert.match(blocked.problem, /^macOS isn't letting SplycedBoard reach devices on the local network\./);
});

test("the hosts asked are the dashboard's device and the router", async () => {
  let asked = null;
  await adviceForEmptyScan({
    what: 'Apple TVs',
    fallback: '',
    client: '192.168.5.178',
    isBlocked: async (hosts) => { asked = hosts; return false; },
    gateway: async () => '192.168.5.1',
  });
  assert.deepEqual(asked, ['192.168.5.178', '192.168.5.1']);
});
