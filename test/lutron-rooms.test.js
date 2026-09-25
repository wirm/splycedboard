/**
 * Lutron areas → Savant Blueprint zones (lutron/rooms.js): what goes in a zone by itself,
 * what waits for a person, how the hierarchy tells same-named areas apart, and a person's
 * changes on top: areas and single lights added or taken out, a light in several zones.
 */
require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRooms, overrideFor, words } = require('../SplycedBoard/src/integrations/lutron/rooms');

// A house with the usual trouble: a "Bathroom" in two suites, and a project area at the top.
const AREAS = [
  { id: 1, name: 'Smith Residence', parentId: null },
  { id: 2, name: 'Main Floor', parentId: 1 },
  { id: 3, name: 'Upstairs', parentId: 1 },
  { id: 10, name: 'Living Room', parentId: 2 },
  { id: 11, name: 'Kitchen', parentId: 2 },
  { id: 12, name: 'Kitchen Island', parentId: 2 },
  { id: 13, name: 'Wine Cellar', parentId: 2 },
  { id: 20, name: 'Primary Suite', parentId: 3 },
  { id: 21, name: 'Bathroom', parentId: 20 },
  { id: 30, name: 'Guest Suite', parentId: 3 },
  { id: 31, name: 'Bathroom', parentId: 30 },
];
const lightsIn = (...ids) => ids.map((areaId, i) => ({ id: 100 + i, name: `Light ${i}`, areaId }));
// light 100 in area 10, 101 in 11, 102 in 12, 103 in 13, 104 in 21, 105 and 106 in 31
const LIGHTS = lightsIn(10, 11, 12, 13, 21, 31, 31);
const ZONES = ['Living', 'Kitchen', 'Master Bath', 'Guest Bath'];

function build(savantZones = ZONES, { overrides, kept } = {}, areas = AREAS, lights = LIGHTS) {
  const view = buildRooms({ areas, lights, savantZones, overrides, kept });
  return {
    ...view,
    area: (id) => view.areas.find((a) => a.areaId === id),
    zone: (name) => view.zones.find((z) => z.name === name),
    inZone: (name) => view.zones.find((z) => z.name === name).areas.map((a) => (a.whole ? a.areaId : [a.areaId, a.lightIds])),
  };
}

test('names are compared by their words: abbreviations, plurals and Master/Primary/Owner are the same', () => {
  assert.deepEqual(words('Living Room'), ['living']);
  assert.deepEqual(words('Mstr Bath'), ['primary', 'bathroom']);
  assert.deepEqual(words("Owner's Suite"), ['primary', 'suite']);
  assert.deepEqual(words('2nd Floor Hallway'), ['2', 'floor', 'hall']);
  assert.deepEqual(words('Second floor hall'), ['2', 'floor', 'hall']);
  assert.deepEqual(words('Bedrooms'), ['bedroom']);
  assert.deepEqual(words('Room'), ['room'], 'a name made only of filler words keeps them');
});

test('clear matches go in their zone by themselves: same name, same words, part of the name, near spelling', () => {
  const r = build();
  assert.deepEqual(r.inZone('Living'), [10]);
  assert.deepEqual(r.inZone('Kitchen'), [11, 12]);
  assert.deepEqual([r.area(10).status, r.area(10).how], ['auto', 'words']);
  assert.deepEqual([r.area(11).how, r.area(12).how], ['exact', 'part']);
  assert.ok(r.zone('Kitchen').areas.every((a) => a.auto));

  const typo = build(['Kitchn'], {}, [{ id: 11, name: 'Kitchen', parentId: null }], lightsIn(11));
  assert.deepEqual([typo.inZone('Kitchn'), typo.area(11).how], [[11], 'spelling']);
});

test('same-named areas always wait for a person, with the hierarchy picking each suggestion', () => {
  const r = build();
  for (const [id, zone] of [[21, 'Master Bath'], [31, 'Guest Bath']]) {
    assert.deepEqual([r.area(id).status, r.area(id).placed], ['review', false]);
    assert.deepEqual([r.area(id).suggestion.zone, r.area(id).suggestion.how], [zone, 'path']);
    assert.match(r.area(id).reason, /2 Lutron areas are called "Bathroom"/);
  }
  assert.deepEqual(r.inZone('Master Bath'), [], 'not in a zone until someone says so');
  assert.deepEqual(r.area(21).path, ['Upstairs', 'Primary Suite'], 'the project area at the top is left out');
  assert.equal(r.counts.waiting, 2);
});

test('close calls wait too, and no match at all is said plainly', () => {
  const tie = build(['Guest Bedroom', 'Guest Bath'], {}, [{ id: 1, name: 'Guest', parentId: null }], lightsIn(1));
  assert.equal(tie.area(1).status, 'review');
  assert.match(tie.area(1).reason, /Could be "Guest (Bedroom|Bath)" or "Guest (Bedroom|Bath)"/);

  const r = build();
  assert.deepEqual([r.area(13).status, r.area(13).placed], ['none', false]);
  assert.match(r.area(13).reason, /No Savant zone looks like "Wine Cellar"/);
  assert.equal(r.counts.unmatched, 1);
});

test('areas and single lights can be added, automatic ones taken out, and a light can be in several zones', () => {
  const r = build(ZONES, {
    overrides: {
      Kitchen: { addAreas: [10], removeAreas: [12] }, // the living room's lights also in the kitchen; the island out
      'Guest Bath': { addLights: [105] },             // one of the guest bathroom's two lights
    },
  });
  assert.deepEqual(r.inZone('Kitchen'), [11, 10], 'in hierarchy order: Main Floor › Kitchen, then Living Room');
  assert.deepEqual(r.zone('Kitchen').areas.map((a) => a.auto), [true, false]);
  assert.deepEqual(r.inZone('Guest Bath'), [[31, [105]]]);

  assert.deepEqual(r.area(10).zones, { Living: [100], Kitchen: [100] });
  assert.deepEqual([r.zonesOf(100), r.zonesOf(105), r.zonesOf(106)], [['Living', 'Kitchen'], ['Guest Bath'], []]);

  assert.deepEqual([r.area(12).placed, r.area(12).reason], [false, 'Taken out of "Kitchen".']);
  assert.deepEqual([r.area(31).placed, r.area(31).reason], [true, null]);
  assert.equal(r.counts.waiting, 1, 'only the primary suite\'s bathroom is left');
});

test('an area left out on purpose stops waiting', () => {
  const r = build(ZONES, { kept: [21, 13] });
  assert.deepEqual([r.area(21).kept, r.area(21).reason], [true, 'Left out on purpose: exported under its Lutron name.']);
  assert.deepEqual([r.counts.kept, r.counts.waiting, r.counts.unmatched], [2, 1, 0]);
});

test("a person's selection is stored as the difference from the automatic matches", () => {
  const now = build();
  assert.deepEqual(overrideFor('Kitchen', { areas: [11, 10], lights: [104, 101] }, now), {
    addAreas: [10],
    removeAreas: [12],
    addLights: [104], // 101 is in area 11, which is there whole
  });
  assert.deepEqual(overrideFor('Kitchen', { areas: [11, 12], lights: [] }, now), { addAreas: [], removeAreas: [], addLights: [] });
});

test('several top-level areas are floors, not a project: they stay in the path and count for matching', () => {
  const areas = [
    { id: 1, name: 'First Floor', parentId: null },
    { id: 2, name: 'Second Floor', parentId: null },
    { id: 10, name: 'Hall', parentId: 1 },
    { id: 20, name: 'Hall', parentId: 2 },
  ];
  const r = build(['1st Floor Hall', '2nd Floor Hall'], {}, areas, lightsIn(10, 20));
  assert.deepEqual(r.area(10).path, ['First Floor']);
  assert.deepEqual([r.area(10).suggestion.zone, r.area(20).suggestion.zone], ['1st Floor Hall', '2nd Floor Hall']);
});

test('rooms are listed in hierarchy order, each with its lights', () => {
  const r = build(['Kitchen']);
  assert.deepEqual(r.areas.map((a) => [...a.path, a.name].join(' › ')), [
    'Main Floor › Kitchen', 'Main Floor › Kitchen Island', 'Main Floor › Living Room', 'Main Floor › Wine Cellar',
    'Upstairs › Guest Suite › Bathroom', 'Upstairs › Primary Suite › Bathroom',
  ]);
  assert.deepEqual(r.area(31).lights, [{ id: 105, name: 'Light 5' }, { id: 106, name: 'Light 6' }]);
});

test('a numbered room is never matched to another number by spelling', () => {
  const r = build(['Bedroom 2'], {}, [{ id: 1, name: 'Bedroom 1', parentId: null }], lightsIn(1));
  assert.notEqual(r.area(1).status, 'auto');
  assert.equal(r.area(1).placed, false);
});

test('no Savant zones yet: nothing is placed, and it says why', () => {
  const r = build([]);
  assert.equal(r.counts.placed, 0);
  assert.match(r.area(10).reason, /No Savant zones yet/);
});

test('every room is listed, lights or not; a floor or the project only when lights sit on it', () => {
  const areas = [
    { id: 1, name: 'Smith Residence', parentId: null },
    { id: 2, name: 'Main Floor', parentId: 1 },
    { id: 11, name: 'Kitchen', parentId: 2 },
    { id: 14, name: 'Mudroom', parentId: 2 }, // keypads only
    { id: 3, name: 'Upstairs', parentId: 1 }, // a hall light sits on the floor itself
    { id: 31, name: 'Bedroom', parentId: 3, isLeaf: true },
    { id: 32, name: 'Attic', parentId: 3, isLeaf: false }, // Lutron says it holds areas; none came with it
  ];
  const r = build(['Kitchen', 'Mudroom', 'Upstairs Hall'], {}, areas, lightsIn(11, 3));
  assert.deepEqual(r.areas.map((a) => [[...a.path, a.name].join(' › '), a.lights.length]), [
    ['Main Floor › Kitchen', 1], ['Main Floor › Mudroom', 0], ['Upstairs', 1], ['Upstairs › Bedroom', 0],
  ]);
  // A room without lights still goes in its zone: its keypads follow it into the export
  assert.deepEqual(r.inZone('Mudroom'), [14]);
  assert.deepEqual([r.zone('Mudroom').lights, r.area(14).placed, r.area(14).zones], [0, true, { Mudroom: [] }]);
  assert.deepEqual(overrideFor('Kitchen', { areas: [11, 14], lights: [] }, r), { addAreas: [14], removeAreas: [], addLights: [] });
});
