/**
 * Rooms through the API, against the mock processor (Home › Main Floor › Kitchen, Living
 * Room; Home › Upstairs › Primary Suite): Savant's zones and the Lutron component's name from
 * the configuration Savant runs (or sclibridge, or typed in), choosing a zone's areas and
 * lights, and the lighting export using all of it.
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

// The configuration Savant runs (userConfig.rpmConfig), as far as zoneConfig.xml goes.
const CONFIG = path.join(h.HOME, 'userConfig.rpmConfig');
function savantRuns(zoneConfigXml) {
  fs.mkdirSync(CONFIG, { recursive: true });
  if (zoneConfigXml === null) fs.rmSync(path.join(CONFIG, 'zoneConfig.xml'), { force: true });
  else fs.writeFileSync(path.join(CONFIG, 'zoneConfig.xml'), zoneConfigXml);
}

before(async () => {
  savantSays('');
  process.env.SPLYCEDBOARD_SCLIBRIDGE = SCLIBRIDGE;
  process.env.SPLYCEDBOARD_SAVANT_CONFIG = CONFIG;
  mock = await startMockProcessor();
  seedDataDir(h.DATA_DIR, mock.port);
  // No name typed on the Setup tab (seedDataDir sets one), so the default and Blueprint's show
  h.patchSettings('lutron', { telnetPort: await h.freePort(), componentName: '' });
  h.setEnabled({ lutron: true, scli: false });
  hub = await h.startHub();
  await h.waitFor(async () => (await hub.get('/api/lutron/status')).json?.ready, { what: 'Lutron ready' });
});

after(async () => {
  await hub?.stop();
  await mock?.close();
});

/** Each Savant zone and what's in it: whole areas by name, single lights as [area, [lights]]. */
const zonesOf = (view) => Object.fromEntries(view.zones.map((z) => [z.name, z.areas.map((a) => {
  const area = view.areas.find((x) => x.areaId === a.areaId);
  return a.whole ? area.name : [area.name, a.lightIds];
})]));

/**
 * The exported plist, as Blueprint reads it: light label → [its Savant zones], label → its
 * Controller Zone, and the controller. Blueprint's own rows name the Savant zone in Controller
 * Zone too: it's the row's first Savant zone, never the Lutron area once the light is placed.
 */
async function exported() {
  const res = await fetch(`${hub.base}/api/lutron/export/lighting`);
  assert.equal(res.status, 200);
  const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: await res.text() }).toString());
  for (const row of json.Lighting) {
    assert.equal(row['Controller Zone'], Object.keys(row['Savant Zone'])[0], `${row.Label}: Controller Zone is its (first) Savant zone`);
  }
  return {
    zones: Object.fromEntries(json.Lighting.map((row) => [row.Label, Object.keys(row['Savant Zone'])])),
    controllerZones: Object.fromEntries(json.Lighting.map((row) => [row.Label, row['Controller Zone']])),
    controllers: [...new Set(json.Lighting.map((row) => row.Controller))],
  };
}

test('lists every Lutron room, with its place in the hierarchy and its lights, if any', async () => {
  const { status, json } = await hub.get('/api/lutron/rooms');
  assert.equal(status, 200);
  assert.deepEqual(json.savant, { zones: [], source: null, at: null });
  assert.deepEqual(json.areas.map((a) => [[...a.path, a.name].join(' › '), a.lights.map((l) => l.name)]), [
    ['Main Floor › Kitchen', ['Kitchen Cans', 'Pendants']],
    ['Main Floor › Living Room', ['Cove Ketra', 'Ceiling Fan']],
    ['Main Floor › Mudroom', []],
    ['Upstairs › Primary Suite', ['Vanity Rania']],
  ]);
  assert.deepEqual(json.controller, { name: 'LutronLeapBridge', source: 'default', found: null });
});

test("reads Savant's zones through sclibridge when there's no configuration file", async () => {
  savantSays('Kitchen\nLiving\nMaster Bedroom\n');
  const { status, json } = await hub.post('/api/lutron/rooms/savant/read');
  assert.equal(status, 200);
  assert.deepEqual([json.savant.zones, json.savant.source], [['Kitchen', 'Living', 'Master Bedroom'], 'savant']);
  assert.deepEqual(zonesOf(json), { Kitchen: ['Kitchen'], Living: ['Living Room'], 'Master Bedroom': [] });
  const suite = json.areas.find((a) => a.name === 'Primary Suite');
  assert.deepEqual([suite.status, suite.suggestion.zone], ['review', 'Master Bedroom'], 'shares Primary/Master: a person decides');
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
    assert.match(res.json.error, /can't be read here/);
  } finally {
    process.env.SPLYCEDBOARD_SCLIBRIDGE = SCLIBRIDGE;
  }
  assert.deepEqual((await hub.get('/api/lutron/rooms')).json.savant.zones, ['Kitchen', 'Living', 'Master Bedroom'], 'the last good list is kept');
});

test("reads the zones and the Lutron component's name from the configuration Savant runs", async () => {
  savantRuns(`<?xml version="1.0" encoding="UTF-8"?>
<zone_config>
<zone_master manufacturer="Savant" model="Pro Host" zone_master_name="Smith"/>
<zone name="Kitchen" guid="1" type="user"></zone>
<zone name="Living" guid="2" type="user"></zone>
<zone name="Primary Suite &amp; Bath" guid="3" type="user"></zone>
<zone name="Equipment" guid="4" type="resource"></zone>
<component_list>
<component manufacturer="HAI" model="OmniPro II" user_defined_name="HAI Panel" device_class="Lighting_controller"></component>
<component manufacturer="Lutron" model="LEAP Bridge" user_defined_name="Lighting Controller" device_class="Lighting_controller"></component>
</component_list>
</zone_config>`);
  const { json } = await hub.post('/api/lutron/rooms/savant/read');
  assert.deepEqual([json.savant.zones, json.savant.source], [['Kitchen', 'Living', 'Primary Suite & Bath'], 'blueprint']);
  assert.deepEqual(json.controller, { name: 'Lighting Controller', source: 'blueprint', found: 'Lighting Controller' });
  assert.deepEqual((await hub.get('/api/lutron/config')).json.controller.name, 'Lighting Controller');
  assert.deepEqual((await exported()).controllers, ['Lighting Controller']);

  // A name typed on the Setup tab wins, and clearing it goes back to Blueprint's
  await hub.post('/api/lutron/config', { componentName: 'My Lutron' });
  assert.deepEqual((await hub.get('/api/lutron/config')).json.controller, { name: 'My Lutron', source: 'typed', found: 'Lighting Controller' });
  assert.deepEqual((await exported()).controllers, ['My Lutron']);
  await hub.post('/api/lutron/config', { componentName: '' });
  assert.deepEqual((await exported()).controllers, ['Lighting Controller']);
  savantRuns(null);
});

// SavantOS 11 keeps zoneConfig.xml to Savant (_savant, mode 600), but componentStateVariables.plist
// is readable: the LEAP Bridge component is the one with this profile's SystemType and FadeTime.
test("on SavantOS 11 the component's name comes from its state variables", async () => {
  const { toPlist } = require('../SplycedBoard/src/core/plist');
  savantRuns(null);
  fs.writeFileSync(path.join(CONFIG, 'componentStateVariables.plist'), toPlist({
    'Beta Host': { InitialValues: {}, MaxValues: {}, MinValues: {} },
    'Lighting Controller': { InitialValues: { FadeTime: '1', SystemType: 'QSX', FanSet_0: '0' }, MaxValues: {}, MinValues: {} },
    'Network Device': { InitialValues: {}, MaxValues: {}, MinValues: {} },
  }));
  savantRuns('<zone_config/>');
  fs.chmodSync(path.join(CONFIG, 'zoneConfig.xml'), 0o000); // as Savant leaves it: not ours to read
  try {
    assert.deepEqual((await hub.get('/api/lutron/config')).json.controller, { name: 'Lighting Controller', source: 'blueprint', found: 'Lighting Controller' });
    assert.deepEqual((await exported()).controllers, ['Lighting Controller']);
  } finally {
    fs.chmodSync(path.join(CONFIG, 'zoneConfig.xml'), 0o644);
    fs.rmSync(path.join(CONFIG, 'componentStateVariables.plist'));
    savantRuns(null);
  }
});

test('typed-in zones replace the list, cleaned up', async () => {
  const { json } = await hub.put('/api/lutron/rooms/savant', { zones: [' Kitchen ', 'Living', 'Primary Suite', 'Kitchen', ''] });
  assert.deepEqual([json.savant.zones, json.savant.source], [['Kitchen', 'Living', 'Primary Suite'], 'typed']);
  assert.deepEqual(zonesOf(json), { Kitchen: ['Kitchen'], Living: ['Living Room'], 'Primary Suite': ['Primary Suite'] });
});

test("a zone's areas and single lights are chosen freely, and a light can be in two zones", async () => {
  // The living room's lights also in the kitchen, and just the pendants also in the living room
  let { json } = await hub.put('/api/lutron/rooms/zone', { zone: 'Kitchen', areas: [1, 2], lights: [] });
  ({ json } = await hub.put('/api/lutron/rooms/zone', { zone: 'Living', areas: [2], lights: [102] }));
  assert.deepEqual(zonesOf(json), {
    Kitchen: ['Kitchen', 'Living Room'],
    Living: [['Kitchen', [102]], 'Living Room'],
    'Primary Suite': ['Primary Suite'],
  });
  assert.deepEqual(json.areas.find((a) => a.name === 'Living Room').zones, { Kitchen: [202, 203], Living: [202, 203] });

  const { zones, controllerZones } = await exported();
  assert.deepEqual(zones, {
    'Kitchen Cans': ['Kitchen'],
    Pendants: ['Kitchen', 'Living'],
    'Cove Ketra': ['Kitchen', 'Living'],
    'Ceiling Fan': ['Kitchen', 'Living'],
    'Vanity Rania': ['Primary Suite'],
  });
  // Controller Zone names the Savant zone, not the Lutron area: the first, for a light in several
  assert.deepEqual([controllerZones['Cove Ketra'], controllerZones['Kitchen Cans']], ['Kitchen', 'Kitchen'], 'Cove Ketra is in the Living Room area');

  ({ json } = await hub.put('/api/lutron/rooms/zone', { zone: 'Kitchen', automatic: true }));
  assert.deepEqual(zonesOf(json).Kitchen, ['Kitchen'], 'back to the automatic match');
});

test('a room without lights can be put in a zone', async () => {
  let { json } = await hub.put('/api/lutron/rooms/zone', { zone: 'Kitchen', areas: [1, 4], lights: [] });
  assert.deepEqual(zonesOf(json).Kitchen, ['Kitchen', 'Mudroom']);
  assert.deepEqual(json.areas.find((a) => a.name === 'Mudroom').zones, { Kitchen: [] });
  ({ json } = await hub.put('/api/lutron/rooms/zone', { zone: 'Kitchen', automatic: true }));
  assert.deepEqual(zonesOf(json).Kitchen, ['Kitchen']);
});

test('an area taken out of its zone can be left out on purpose, and putting it back undoes that', async () => {
  let { json } = await hub.put('/api/lutron/rooms/zone', { zone: 'Primary Suite', areas: [], lights: [] });
  let suite = json.areas.find((a) => a.name === 'Primary Suite');
  assert.deepEqual([suite.placed, suite.reason], [false, 'Taken out of "Primary Suite".']);

  ({ json } = await hub.put('/api/lutron/rooms/area/3', { kept: true }));
  suite = json.areas.find((a) => a.name === 'Primary Suite');
  assert.deepEqual([suite.kept, json.counts.kept], [true, 1]);

  ({ json } = await hub.put('/api/lutron/rooms/zone', { zone: 'Living', areas: [2, 3], lights: [102] }));
  suite = json.areas.find((a) => a.name === 'Primary Suite');
  assert.deepEqual([suite.placed, suite.kept, json.counts.kept], [true, false, 0]);
});

test('choices saved by 2.2.0 (one room per area) carry over', async () => {
  h.patchSettings('lutron', { rooms: { savant: ['Kitchen', 'Living', 'Guest Bath'], decisions: { 1: { zone: 'Guest Bath' }, 2: { zone: null } } } });
  const { json } = await hub.get('/api/lutron/rooms');
  assert.deepEqual(zonesOf(json), { Kitchen: [], Living: [], 'Guest Bath': ['Kitchen'] });
  assert.equal(json.areas.find((a) => a.name === 'Living Room').kept, true);
  assert.equal(h.readJson(path.join(h.DATA_DIR, 'lutron', 'settings.json')).rooms.decisions, undefined, 'converted once');
});

test('bad requests are refused', async () => {
  assert.equal((await hub.put('/api/lutron/rooms/zone', { zone: 'Nowhere', areas: [], lights: [] })).status, 404);
  assert.equal((await hub.put('/api/lutron/rooms/zone', { zone: 'Kitchen', areas: [1] })).status, 400);
  assert.equal((await hub.put('/api/lutron/rooms/area/999', { kept: true })).status, 404);
  assert.equal((await hub.put('/api/lutron/rooms/area/1', { kept: 'yes' })).status, 400);
  assert.equal((await hub.put('/api/lutron/rooms/savant', { zones: 'Kitchen' })).status, 400);
});
