/**
 * Pairing with a Lutron processor (lutron/pairing.js), against a mock of its pairing port
 * that behaves like QSX firmware 26.06: silent until pairing mode, then PhysicalAccess;
 * a CSR sent after that is answered with a SigningResult.
 */
const h = require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startMockPairing } = require('./support/mock-leap');
const { pairWithProcessor } = require('../SplycedBoard/src/integrations/lutron/pairing');

function recorder() {
  const lines = [];
  return { log: { info: (m) => lines.push(m), warn: (m) => lines.push(m), debug() {} }, lines };
}
const connected = (p) => h.waitFor(() => p.connections() === 1, { what: 'the pairing connection' });

test('pairing completes once the processor goes into pairing mode, however long after connecting', async () => {
  const p = await startMockPairing();
  const { log, lines } = recorder();
  try {
    const pairing = pairWithProcessor('127.0.0.1', 'Test', { log, port: p.port, timeoutMs: 10000 });
    await connected(p);
    await new Promise((resolve) => setTimeout(resolve, 300)); // the processor says nothing meanwhile
    assert.equal(p.requests.length, 0, 'nothing is sent before pairing mode');

    p.pairingMode(); // the keypad button
    const result = await pairing;
    assert.deepEqual([result.cert, result.ca], ['SIGNED-CERT', 'ROOT-CA']);
    assert.match(result.key, /BEGIN PRIVATE KEY/);
    assert.equal(p.requests[0].Body.CommandType, 'CSR');
    assert.ok(lines.includes('Processor status: permissions ["Public","PhysicalAccess"]'), 'what the processor said is logged');
  } finally {
    await p.close();
  }
});

test("a processor that never goes into pairing mode times out, saying what to do", async () => {
  const p = await startMockPairing();
  try {
    await assert.rejects(
      pairWithProcessor('127.0.0.1', 'Test', { log: recorder().log, port: p.port, timeoutMs: 400 }),
      /didn't go into pairing mode within 0\.4 s\. Click Pair Now, then: On HomeWorks QSX, press a keypad button programmed for pairing/,
    );
  } finally {
    await p.close();
  }
});

test("a processor that answers without allowing pairing is told apart from one that's silent", async () => {
  const p = await startMockPairing();
  try {
    const pairing = pairWithProcessor('127.0.0.1', 'Test', { log: recorder().log, port: p.port, timeoutMs: 600 });
    await connected(p);
    p.pairingMode(['Public']);
    await assert.rejects(pairing, /answered but didn't allow pairing \(permissions: Public\)/);
  } finally {
    await p.close();
  }
});

test('a newer attempt cancels one still waiting, and its connection closes', async () => {
  const p = await startMockPairing();
  try {
    const controller = new AbortController();
    const pairing = pairWithProcessor('127.0.0.1', 'Test', { log: recorder().log, port: p.port, timeoutMs: 10000, signal: controller.signal });
    await connected(p);
    controller.abort();
    await assert.rejects(pairing, /cancelled/);
    await h.waitFor(() => p.connections() === 0, { what: 'the connection to close' });
  } finally {
    await p.close();
  }
});

test('a refusal from the processor is reported', async () => {
  const p = await startMockPairing({ answer: 'refuse' });
  try {
    const pairing = pairWithProcessor('127.0.0.1', 'Test', { log: recorder().log, port: p.port, timeoutMs: 10000 });
    await connected(p);
    p.pairingMode();
    await assert.rejects(pairing, /Processor rejected pairing \(401 Unauthorized\)\. Click Pair Now, then:/);
  } finally {
    await p.close();
  }
});
