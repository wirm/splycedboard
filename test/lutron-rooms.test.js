/**
 * Lutron areas → Savant rooms (lutron/rooms.js): what gets matched by itself, what waits
 * for a person, and how the hierarchy tells same-named areas apart.
 */
require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapRooms, words } = require('../SplycedBoard/src/integrations/lutron/rooms');

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
const ZONES = lightsIn(10, 11, 12, 13, 21, 31, 31);

const map = (savantRooms, decisions = {}, areas = AREAS, zones = ZONES) => {
  const { rooms, counts } = mapRooms({ areas, zones, savantRooms, decisions });
  const byId = Object.fromEntries(rooms.map((r) => [r.areaId, r]));
  return { rooms, counts, byId };
};

test('names are compared by their words: abbreviations, plurals and Master/Primary/Owner are the same', () => {
  assert.deepEqual(words('Living Room'), ['living']);
  assert.deepEqual(words('Mstr Bath'), ['primary', 'bathroom']);
  assert.deepEqual(words("Owner's Suite"), ['primary', 'suite']);
  assert.deepEqual(words('2nd Floor Hallway'), ['2', 'floor', 'hall']);
  assert.deepEqual(words('Second floor hall'), ['2', 'floor', 'hall']);
  assert.deepEqual(words('Bedrooms'), ['bedroom']);
  assert.deepEqual(words('Room'), ['room'], 'a name made only of filler words keeps them');
});

test('clear matches apply by themselves: same name, same words, part of the name, near spelling', () => {
  const { byId } = map(['Living', 'Kitchen', 'Master Bath', 'Guest Bath']);
  assert.deepEqual([byId[10].zone, byId[10].status, byId[10].how], ['Living', 'exact', 'words']);
  assert.deepEqual([byId[11].zone, byId[11].status, byId[11].how], ['Kitchen', 'exact', 'exact']);
  assert.deepEqual([byId[12].zone, byId[12].status, byId[12].how], ['Kitchen', 'close', 'part']);

  const typo = map(['Kitchn'], {}, [{ id: 11, name: 'Kitchen', parentId: null }], lightsIn(11)).byId[11];
  assert.deepEqual([typo.zone, typo.status, typo.how], ['Kitchn', 'close', 'spelling']);
});

test('same-named areas always wait for a person, with the hierarchy picking each suggestion', () => {
  const { byId, counts } = map(['Living', 'Kitchen', 'Master Bath', 'Guest Bath']);
  for (const [id, room] of [[21, 'Master Bath'], [31, 'Guest Bath']]) {
    assert.equal(byId[id].status, 'review');
    assert.equal(byId[id].zone, null, 'not applied until confirmed: the export keeps the Lutron name');
    assert.deepEqual([byId[id].suggestion.room, byId[id].suggestion.how], [room, 'path']);
    assert.match(byId[id].reason, /2 Lutron areas are called "Bathroom"/);
  }
  assert.deepEqual(byId[21].path, ['Upstairs', 'Primary Suite'], 'the project area at the top is left out');
  assert.equal(counts.review, 2);
});

test('close calls and weak matches wait too; no match at all is said plainly', () => {
  const close = map(['Family', 'Family Media'], {}, [{ id: 1, name: 'Family Media Room', parentId: null }], lightsIn(1)).byId[1];
  assert.equal(close.status, 'exact', 'the same words win outright');

  const tie = map(['Guest Bedroom', 'Guest Bath'], {}, [{ id: 1, name: 'Guest', parentId: null }], lightsIn(1)).byId[1];
  assert.equal(tie.status, 'review');
  assert.match(tie.reason, /Could be "Guest (Bedroom|Bath)" or "Guest (Bedroom|Bath)"/);

  const { byId } = map(['Living', 'Kitchen']);
  assert.deepEqual([byId[13].status, byId[13].zone], ['none', null]);
  assert.match(byId[13].reason, /No Savant room looks like "Wine Cellar"/);
});

test("what the user picks wins, a stale pick asks again, and no Savant rooms means nothing's matched", () => {
  const picks = { 21: { zone: 'Master Bath' }, 13: { zone: null }, 31: { zone: 'Gone Room' } };
  const { byId } = map(['Living', 'Kitchen', 'Master Bath', 'Guest Bath'], picks);
  assert.deepEqual([byId[21].status, byId[21].zone], ['set', 'Master Bath']);
  assert.deepEqual([byId[13].status, byId[13].zone], ['set', null], 'null: keep the Lutron name, on purpose');
  assert.equal(byId[31].status, 'review');
  assert.match(byId[31].reason, /"Gone Room" isn't one of Savant's rooms any more/);

  const empty = map([]);
  assert.equal(empty.counts.none, empty.counts.total);
  assert.match(empty.byId[10].reason, /No Savant rooms yet/);
});

test('several top-level areas are floors, not a project: they stay in the path and count for matching', () => {
  const areas = [
    { id: 1, name: 'First Floor', parentId: null },
    { id: 2, name: 'Second Floor', parentId: null },
    { id: 10, name: 'Hall', parentId: 1 },
    { id: 20, name: 'Hall', parentId: 2 },
  ];
  const { byId } = map(['1st Floor Hall', '2nd Floor Hall'], {}, areas, lightsIn(10, 20));
  assert.deepEqual(byId[10].path, ['First Floor']);
  assert.deepEqual([byId[10].suggestion.room, byId[20].suggestion.room], ['1st Floor Hall', '2nd Floor Hall']);
});

test('only areas with lights are listed, in hierarchy order, each with its lights', () => {
  const { rooms } = map(['Kitchen']);
  assert.deepEqual(rooms.map((r) => [...r.path, r.name].join(' › ')), [
    'Main Floor › Kitchen', 'Main Floor › Kitchen Island', 'Main Floor › Living Room', 'Main Floor › Wine Cellar',
    'Upstairs › Guest Suite › Bathroom', 'Upstairs › Primary Suite › Bathroom',
  ]);
  assert.deepEqual(rooms.find((r) => r.areaId === 31).loads, ['Light 5', 'Light 6']);
});

test('a numbered room is never matched to another number by spelling', () => {
  const { byId } = map(['Bedroom 2'], {}, [{ id: 1, name: 'Bedroom 1', parentId: null }], lightsIn(1));
  assert.notEqual(byId[1].status, 'exact');
  assert.notEqual(byId[1].status, 'close');
  assert.equal(byId[1].zone, null);
});
