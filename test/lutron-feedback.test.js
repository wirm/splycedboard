/**
 * Feedback for Savant (lutron/feedback.js): the levels and keypad LEDs each Savant host hasn't
 * been sent yet, answered in the fixed slots the LEAP Bridge profile reads. Against a
 * stand-in controller and clock, so every timing rule is checked exactly.
 */
require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ZoneFeedback, SLOTS, LED_SLOTS, BUTTON_SLOTS, PRESS_MS, IDLE_MS, RESYNC_MS } = require('../SplycedBoard/src/integrations/lutron/feedback');

function setup(levels = { 101: 75, 102: 0, 201: 40 }, leds = []) {
  const controller = {
    ready: true,
    zones: new Map(Object.entries(levels).map(([id, level]) => [Number(id), { id: Number(id), type: 'dimmer', level }])),
    leds,
    keypadLeds() { return this.leds; },
  };
  const clock = { t: 1_000_000 };
  const feedback = new ZoneFeedback({ getController: () => controller, now: () => clock.t });
  const set = (id, level) => {
    controller.zones.get(id).level = level;
    feedback.zoneChanged(id);
  };
  return { controller, clock, feedback, set };
}

/** The distinct zone → level pairs in an answer, and a check that every slot is filled. */
function levels(answer) {
  if (!Object.keys(answer).length) return {};
  const out = {};
  for (let i = 0; i < SLOTS; i++) {
    assert.ok(`z${i}` in answer && `l${i}` in answer, `slot ${i} is filled`);
    assert.equal(typeof answer[`z${i}`], 'string', 'zones go out as strings, for the state names');
    out[answer[`z${i}`]] = answer[`l${i}`];
  }
  return out;
}

test('a Savant host asking for the first time gets every level, then nothing until something changes', () => {
  const { feedback } = setup();
  const first = feedback.poll('10.0.0.5');
  assert.deepEqual(levels(first), { 101: 75, 102: 0, 201: 40 });
  assert.equal(first[`z${SLOTS - 1}`], first.z0, 'spare slots repeat the first zone');
  assert.deepEqual(feedback.poll('10.0.0.5'), {});
});

test('a change goes out on the next poll, to every host', () => {
  const { feedback, set } = setup();
  feedback.poll('10.0.0.5');
  feedback.poll('10.0.0.6');
  set(101, 20);
  set(101, 30); // twice before the next poll: sent once, at its latest level
  assert.deepEqual(levels(feedback.poll('10.0.0.5')), { 101: 30 });
  assert.deepEqual(levels(feedback.poll('10.0.0.6')), { 101: 30 });
  assert.deepEqual(feedback.poll('10.0.0.5'), {});
});

test(`more than ${SLOTS} levels go out ${SLOTS} at a time, what just changed ahead of a resync`, () => {
  const many = Object.fromEntries(Array.from({ length: SLOTS + 8 }, (_, i) => [1000 + i, i]));
  const { feedback, set } = setup(many);
  const first = levels(feedback.poll('10.0.0.5'));
  assert.equal(Object.keys(first).length, SLOTS);
  set(1039, 99); // not sent yet
  const answer = feedback.poll('10.0.0.5');
  assert.deepEqual([answer.z0, answer.l0], ['1039', 99], 'the change comes first');
  assert.equal(Object.keys(levels(answer)).length, 8, 'then the rest of the resync');
  assert.deepEqual(feedback.poll('10.0.0.5'), {});
});

test('a host that stopped asking (Savant restarted), or every ten minutes, gets everything again', () => {
  const { feedback, clock } = setup();
  feedback.poll('10.0.0.5');
  clock.t += IDLE_MS - 1000;
  assert.deepEqual(feedback.poll('10.0.0.5'), {}, 'still asking');
  clock.t += IDLE_MS + 1;
  assert.deepEqual(levels(feedback.poll('10.0.0.5')), { 101: 75, 102: 0, 201: 40 }, 'after a gap');

  // Asking all along: everything again once the ten minutes are up, and only then
  const resent = [];
  for (let waited = 5000; waited <= RESYNC_MS + 5000; waited += 5000) {
    clock.t += 5000;
    if (Object.keys(feedback.poll('10.0.0.5')).length) resent.push(waited);
  }
  assert.deepEqual(resent, [RESYNC_MS + 5000]);
});

test('nothing goes out before the processor is ready; everything does once it is', () => {
  const { feedback, controller } = setup();
  controller.ready = false;
  assert.deepEqual(feedback.poll('10.0.0.5'), {});
  controller.ready = true;
  feedback.resyncAll();
  assert.deepEqual(levels(feedback.poll('10.0.0.5')), { 101: 75, 102: 0, 201: 40 });
});

test('zones without a level, and thermostats, are left out', () => {
  const { feedback, controller } = setup({ 101: 75, 102: null });
  controller.zones.set(302, { id: 302, type: 'hvac', level: 70 });
  assert.deepEqual(levels(feedback.poll('10.0.0.5')), { 101: 75 });
});

test('the dashboard sees which hosts are asking; ones gone for an hour are forgotten', () => {
  const { feedback, clock } = setup();
  feedback.poll('10.0.0.5');
  assert.deepEqual(feedback.activeHosts(), ['10.0.0.5']);
  clock.t += IDLE_MS + 1;
  assert.deepEqual(feedback.activeHosts(), []);
  clock.t += 60 * 60 * 1000;
  feedback.poll('10.0.0.6');
  assert.deepEqual([...feedback.hosts.keys()], ['10.0.0.6']);
});

/** The distinct "<device>_<LED>" → 1/0 pairs in an LED answer, checking every slot is filled. */
function ledsIn(answer) {
  const out = {};
  for (let i = 0; i < LED_SLOTS; i++) {
    assert.ok(`k${i}` in answer && `o${i}` in answer, `LED slot ${i} is filled`);
    out[answer[`k${i}`]] = answer[`o${i}`];
  }
  return out;
}

test('keypad LEDs go out once no level is waiting, keyed device_LED, and again when one changes', () => {
  const led = (id, state) => ({ ledHref: `/led/${id}`, ledId: id, deviceId: 501, state });
  const { feedback, controller } = setup({ 101: 75 }, [led(801, 'On'), led(802, 'Off'), led(803, null)]);
  assert.deepEqual(levels(feedback.poll('10.0.0.5')), { 101: 75 }, 'levels first');
  assert.deepEqual(ledsIn(feedback.poll('10.0.0.5')), { '501_801': 1, '501_802': 0 }, 'then LEDs; one not heard from yet is left out');
  assert.deepEqual(feedback.poll('10.0.0.5'), {});

  controller.leds[1].state = 'On';
  feedback.ledChanged('/led/802');
  assert.deepEqual(ledsIn(feedback.poll('10.0.0.5')), { '501_802': 1 });
});

test('Savant saying it just started gets everything again at once', () => {
  const { feedback } = setup();
  feedback.poll('10.0.0.5');
  assert.deepEqual(feedback.poll('10.0.0.5'), {});
  assert.deepEqual(levels(feedback.poll('10.0.0.5', { start: true })), { 101: 75, 102: 0, 201: 40 });
});

/** The button → event pairs in an answer, in slot order, and a check that every slot is filled. */
function buttonsIn(answer) {
  const out = [];
  for (let i = 0; i < BUTTON_SLOTS; i++) {
    assert.ok(`b${i}` in answer && `e${i}` in answer, `button slot ${i} is filled`);
    out.push([answer[`b${i}`], answer[`e${i}`]]);
  }
  return [...new Map(out).entries()];
}

/** Savant asking every half second until there's nothing left: the answers with buttons, in order. */
function buttonAnswers(feedback, clock, address = '10.0.0.5') {
  const seen = [];
  for (let answer = feedback.poll(address); Object.keys(answer).length; answer = feedback.poll(address)) {
    if ('b0' in answer) seen.push(buttonsIn(answer));
    clock.t += 500;
  }
  return seen;
}

test('button events go out first, keyed device_button: a tap reported as a Release is Press, then Release, and stays', () => {
  const { feedback, set, clock } = setup();
  feedback.poll('10.0.0.5'); // the levels
  set(101, 20);
  feedback.buttonEvent(501, 6, 'Release'); // how a HomeWorks QSX reports a tap
  assert.deepEqual(buttonsIn(feedback.poll('10.0.0.5')), [['501_6', 'Press']], 'ahead of the level that changed');
  assert.deepEqual(levels(feedback.poll('10.0.0.5')), { 101: 20 }, 'the level goes while the Release waits');
  clock.t += PRESS_MS - 1;
  assert.deepEqual(feedback.poll('10.0.0.5'), {}, `the Release waits ${PRESS_MS} ms`);
  clock.t += 1;
  assert.deepEqual(buttonsIn(feedback.poll('10.0.0.5')), [['501_6', 'Release']]);
  clock.t += 500;
  assert.deepEqual(feedback.poll('10.0.0.5'), {}, 'and that is the last word: it stays Release');
});

test('a hold is Hold until the Release, with the Press first when the processor reports one', () => {
  const { feedback, clock } = setup();
  feedback.poll('10.0.0.5');
  feedback.buttonEvent(501, 1, 'Press');
  feedback.buttonEvent(501, 1, 'Hold');
  feedback.buttonEvent(501, 1, 'LongHold'); // still held
  feedback.buttonEvent(501, 2, 'Hold'); // held, with no Press reported
  assert.deepEqual(buttonAnswers(feedback, clock), [[['501_1', 'Press'], ['501_2', 'Hold']], [['501_1', 'Hold']]]);
  feedback.buttonEvent(501, 1, 'Release');
  feedback.buttonEvent(501, 2, 'Release');
  assert.deepEqual(buttonAnswers(feedback, clock), [[['501_1', 'Release'], ['501_2', 'Release']]], 'let go: Release, with no Press before it');
});

test('a value never follows itself, so every tap is a change: Press between two Releases, and between two MultiTaps', () => {
  const { feedback, clock } = setup();
  feedback.poll('10.0.0.5');
  feedback.buttonEvent(501, 6, 'Release'); // a tap
  feedback.buttonEvent(501, 6, 'Release'); // another
  feedback.buttonEvent(501, 6, 'MultiTap'); // a double tap: QSX reports its second tap so
  feedback.buttonEvent(501, 6, 'MultiTap'); // and another
  feedback.buttonEvent(502, 1, 'Release'); // other buttons ride along
  assert.deepEqual(buttonAnswers(feedback, clock), [
    [['501_6', 'Press'], ['502_1', 'Press']],
    [['501_6', 'Release'], ['502_1', 'Release']],
    [['501_6', 'Press']],
    [['501_6', 'Release']],
    [['501_6', 'MultiTap']],
    [['501_6', 'Press']],
    [['501_6', 'MultiTap']],
  ]);
  assert.ok(!JSON.stringify(buttonAnswers(feedback, clock)).includes('None'));
});

test(`more than ${BUTTON_SLOTS} buttons at once go out ${BUTTON_SLOTS} at a time, in order`, () => {
  const { feedback } = setup();
  feedback.poll('10.0.0.5');
  for (let b = 1; b <= BUTTON_SLOTS + 2; b++) feedback.buttonEvent(501, b, 'Press');
  assert.deepEqual(buttonsIn(feedback.poll('10.0.0.5')).map(([key]) => key), Array.from({ length: BUTTON_SLOTS }, (_, i) => `501_${i + 1}`));
  assert.deepEqual(buttonsIn(feedback.poll('10.0.0.5')), [['501_9', 'Press'], ['501_10', 'Press']]);
  assert.deepEqual(feedback.poll('10.0.0.5'), {});
});

test('button events only go to hosts asking now: a host that starts later gets none from before', () => {
  const { feedback, clock } = setup();
  feedback.poll('10.0.0.5');
  feedback.buttonEvent(501, 6, 'Press');
  assert.ok('z0' in feedback.poll('10.0.0.9'), 'a new host gets the levels, not the old press');
  assert.deepEqual(buttonsIn(feedback.poll('10.0.0.5')), [['501_6', 'Press']]);
  clock.t += IDLE_MS + 1;
  feedback.buttonEvent(501, 6, 'Release');
  assert.ok(!('b0' in feedback.poll('10.0.0.5')), 'nor one that stopped asking');
});

