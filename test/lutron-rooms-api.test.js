/**
 * Rooms through the API, against the mock processor (Home › Main Floor › Kitchen, Living
 * Room; Home › Upstairs › Primary Suite): reading Savant's rooms through sclibridge, typing
 * them in, moving areas, and the lighting export using the result.
 */
const h = require('./support/harness');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startMockProcessor, seedDataDir } = require('./support/mock-leap');

let mock;
let hub;

// Savant's sclibridge, as far as `userzones` goes: prints whatever the test puts here.
const SCLIBRIDGE = path.join(h.HOME, 'fake-sclibridge');
const savantSays = (output) => fs.writeFileSync(SCLIBRIDGE, `#!/bin/sh\nprintf '%s' '${output}'\n`, { mode: 0o755 });

before(async () => {
  savantSays('');
  process.env.SPLYCEDBOARD_SCLIBRIDGE = SCLIBRIDGE;
  mock = await startMockProcessor();
  seedDataDir(h.DATA_DIR, mock.port);
  h.patchSettings('lutron', { telnetPort: await h.freePort() });
  h.setEnabled({ lutron: true, scli: false });
  hub = await h.startHub();
  await h.waitFor(async () => (await hub.get('/api/lutron/status')).json?.ready, { what: 'Lutron ready' });
});

after(async () => {
  await hub?.stop();
  await mock?.close();
});

const summary = (view) => view.rooms.map((r) => `${[...r.path, r.name].join(' › ')} → ${r.zone} (${r.status})`);

/** The exported plist, as Blueprint reads it: light label → its Savant room. */
async function exported() {
  const res = await fetch(`${hub.base}/api/lutron/export/lighting`);
  assert.equal(res.status, 200);
  const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: await res.text() }).toString());
  return Object.fromEntries(json.Lighting.map((row) => [row.Label, Object.keys(row['Savant Zone'])]));
}

test('lists the Lutron areas that have lights, with their place in the hierarchy', async () => {
  const { status, json } = await hub.get('/api/lutron/rooms');
  assert.equal(status, 200);
  assert.deepEqual(json.savant, { rooms: [], source: null, at: null });
  assert.deepEqual(json.rooms.map((r) => [[...r.path, r.name].join(' › '), r.loads]), [
    ['Main Floor › Kitchen', ['Kitchen Cans', 'Pendants']],
    ['Main Floor › Living Room', ['Cove Ketra', 'Ceiling Fan']],
    ['Upstairs › Primary Suite', ['Vanity Rania']],
  ]);
  assert.equal(json.counts.none, 3);
});

test("reads Savant's rooms through sclibridge and matches them", async () => {
  savantSays('Kitchen\nLiving\nMaster Bedroom\n');
  const { status, json } = await hub.post('/api/lutron/rooms/savant/read');
  assert.equal(status, 200);
  assert.deepEqual([json.savant.rooms, json.savant.source], [['Kitchen', 'Living', 'Master Bedroom'], 'savant']);
  assert.deepEqual(summary(json), [
    'Main Floor › Kitchen → Kitchen (exact)',
    'Main Floor › Living Room → Living (exact)',
    'Upstairs › Primary Suite → null (review)', // shares Primary/Master with Master Bedroom: a person decides
  ]);
  assert.equal(json.rooms[2].suggestion.room, 'Master Bedroom');
});

test("says so when Savant can't be asked", async () => {
  savantSays('Error: could not connect to host\n');
  let res = await hub.post('/api/lutron/rooms/savant/read');
  assert.equal(res.status, 502);
  assert.match(res.json.error, /Savant didn't answer/);

  process.env.SPLYCEDBOARD_SCLIBRIDGE = path.join(h.HOME, 'no-such-sclibridge');
  try {
    res = await hub.post('/api/lutron/rooms/savant/read');
    assert.equal(res.status, 404);
    assert.match(res.json.error, /isn't on this Mac/);
  } finally {
    process.env.SPLYCEDBOARD_SCLIBRIDGE = SCLIBRIDGE;
  }
  assert.deepEqual((await hub.get('/api/lutron/rooms')).json.savant.rooms, ['Kitchen', 'Living', 'Master Bedroom'], 'the last good list is kept');
});

test('typed-in rooms replace the list, cleaned up', async () => {
  const { json } = await hub.put('/api/lutron/rooms/savant', { rooms: [' Kitchen ', 'Living', 'Primary Suite', 'Kitchen', ''] });
  assert.deepEqual([json.savant.rooms, json.savant.source], [['Kitchen', 'Living', 'Primary Suite'], 'typed']);
  assert.equal(json.rooms.find((r) => r.name === 'Primary Suite').status, 'exact');
});

test('an area can be moved to another room, kept under its Lutron name, or put back to automatic', async () => {
  let { json } = await hub.put('/api/lutron/rooms/1', { zone: 'Living' });
  assert.deepEqual([json.rooms.find((r) => r.areaId === 1).zone, json.rooms.find((r) => r.areaId === 1).status], ['Living', 'set']);
  ({ json } = await hub.put('/api/lutron/rooms/1', { automatic: true }));
  assert.deepEqual([json.rooms.find((r) => r.areaId === 1).zone, json.rooms.find((r) => r.areaId === 1).status], ['Kitchen', 'exact']);
  ({ json } = await hub.put('/api/lutron/rooms/2', { zone: null }));
  assert.deepEqual([json.rooms.find((r) => r.areaId === 2).zone, json.rooms.find((r) => r.areaId === 2).status], [null, 'set']);
});

test('the lighting export puts each light in its Savant room', async () => {
  assert.deepEqual(await exported(), {
    'Kitchen Cans': ['Kitchen'],
    Pendants: ['Kitchen'],
    'Cove Ketra': ['Living Room'], // kept under its Lutron name on purpose
    'Ceiling Fan': ['Living Room'],
    'Vanity Rania': ['Primary Suite'],
  });
  await hub.put('/api/lutron/rooms/2', { automatic: true });
  assert.deepEqual((await exported())['Cove Ketra'], ['Living']);
});

test('bad requests are refused', async () => {
  assert.equal((await hub.put('/api/lutron/rooms/999', { zone: 'Kitchen' })).status, 404);
  assert.equal((await hub.put('/api/lutron/rooms/1', { zone: 5 })).status, 400);
  assert.equal((await hub.put('/api/lutron/rooms/savant', { rooms: 'Kitchen' })).status, 400);
});
