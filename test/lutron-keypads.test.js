/**
 * Lutron keypads (lutron/keypads.js): which family a keypad is, from its LEAP DeviceType or
 * ModelNumber, which buttons raise and lower, and where each sits on the faceplate.
 */
require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { keypadFamily, keypadLayout, buttonRole } = require('../SplycedBoard/src/integrations/lutron/keypads');

const buttons = (...numbers) => numbers.map((number) => ({ id: 100 + number, number }));

test('the family comes from the device type, or else the model number', () => {
  assert.equal(keypadFamily('SeeTouchKeypad', 'HQWD-W4S').id, 'seetouch');
  assert.equal(keypadFamily('PalladiomKeypad', 'HQWT-U-PRW').id, 'palladiom');
  assert.equal(keypadFamily('SunnataKeypad').id, 'sunnata');
  assert.equal(keypadFamily('SunnataHybridKeypad').id, 'sunnata');
  assert.equal(keypadFamily('AlisseKeypad').id, 'alisse');
  assert.equal(keypadFamily('Pico3ButtonRaiseLower').id, 'pico');
  assert.equal(keypadFamily(null, 'RRST-W3RL-WH').id, 'sunnata', 'by model number alone');
  assert.equal(keypadFamily(null, 'HQWT-U-P2W').id, 'palladiom');
  assert.deepEqual(keypadFamily('SomethingNew', 'XYZ-1'), { id: 'generic', name: 'Keypad' });
});

test('raise and lower: from the programming model or engraving, else 16/18 lower and 17/19 raise', () => {
  assert.equal(buttonRole({ number: 18 }), 'lower');
  assert.equal(buttonRole({ number: 19 }), 'raise');
  assert.equal(buttonRole({ number: 16 }), 'lower');
  assert.equal(buttonRole({ number: 17 }), 'raise');
  assert.equal(buttonRole({ number: 3 }), 'button');
  assert.equal(buttonRole({ number: 3, programmingModel: 'SingleSceneRaiseProgrammingModel' }), 'raise');
  assert.equal(buttonRole({ number: 4, engraving: 'Lower' }), 'lower');
  assert.equal(buttonRole({ number: 5 }, 'pico'), 'raise', 'Pico: 5 raises');
  assert.equal(buttonRole({ number: 6 }, 'pico'), 'lower', 'Pico: 6 lowers');
  assert.equal(buttonRole({ number: 6 }), 'button', 'on a keypad 6 is a button (seeTouch Off)');
});

test('buttons run top to bottom by number, raise/lower pairs at the bottom', () => {
  const { family, rows } = keypadLayout({ deviceType: 'PalladiomKeypad', buttons: buttons(3, 1, 17, 2, 16) });
  assert.equal(family.name, 'Palladiom');
  assert.deepEqual(rows, [
    { type: 'button', id: 101 }, { type: 'button', id: 102 }, { type: 'button', id: 103 },
    { type: 'pair', lower: 116, raise: 117 },
  ]);
});

test('a seeTouch keeps its positions: a missing number is an empty slot', () => {
  const { rows } = keypadLayout({ deviceType: 'SeeTouchKeypad', buttons: buttons(1, 2, 3, 4, 6, 18, 19) });
  assert.deepEqual(rows.map((r) => r.type), ['button', 'button', 'button', 'button', 'gap', 'button', 'pair']);
  // Two raise/lower pairs (a two-group seeTouch): both, in order
  const two = keypadLayout({ deviceType: 'SeeTouchKeypad', buttons: buttons(1, 2, 16, 17, 18, 19) });
  assert.deepEqual(two.rows.slice(-2), [{ type: 'pair', lower: 116, raise: 117 }, { type: 'pair', lower: 118, raise: 119 }]);
});

test('a Pico reads on, raise, favorite, lower, off', () => {
  const { rows } = keypadLayout({ deviceType: 'Pico3ButtonRaiseLower', buttons: buttons(2, 3, 4, 5, 6) });
  assert.deepEqual(rows, [
    { type: 'button', id: 102 }, { type: 'pair', lower: null, raise: 105 }, { type: 'button', id: 103 },
    { type: 'pair', lower: 106, raise: null }, { type: 'button', id: 104 },
  ]);
});

test('a raise or lower without its partner still shows', () => {
  const { rows } = keypadLayout({ deviceType: 'SunnataKeypad', buttons: buttons(1, 19) });
  assert.deepEqual(rows, [{ type: 'button', id: 101 }, { type: 'pair', lower: null, raise: 119 }]);
});
