/**
 * Feedback for Savant (lutron/feedback.js): the levels and keypad LEDs each Savant host hasn't
 * been sent yet, answered in the fixed slots the LEAP Bridge profile reads. Against a
 * stand-in controller and clock, so every timing rule is checked exactly.
 */
require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ZoneFeedback, SLOTS, LED_SLOTS, BUTTON_SLOTS, BUTTON_IDLE, IDLE_MS, RESYNC_MS } = require('../SplycedBoard/src/integrations/lutron/feedback');

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

test('button events go out first, keyed device_button, and back to None on the next poll', () => {
  const { feedback, set } = setup();
  feedback.poll('10.0.0.5'); // the levels
  set(101, 20);
  feedback.buttonEvent(501, 6, 'Release');
  assert.deepEqual(buttonsIn(feedback.poll('10.0.0.5')), [['501_6', 'Release']], 'ahead of the level that changed');
  assert.deepEqual(buttonsIn(feedback.poll('10.0.0.5')), [['501_6', BUTTON_IDLE]], 'then None, so the next Release is a change');
  assert.deepEqual(levels(feedback.poll('10.0.0.5')), { 101: 20 }, 'then the level');
  assert.deepEqual(feedback.poll('10.0.0.5'), {});
});

test('one event per button per answer, so Savant sees each one; other buttons ride along', () => {
  const { feedback } = setup();
  feedback.poll('10.0.0.5');
  feedback.buttonEvent(501, 6, 'Release');
  feedback.buttonEvent(501, 6, 'MultiTap');
  feedback.buttonEvent(502, 1, 'Press');
  const seen = [];
  for (let answer = feedback.poll('10.0.0.5'); Object.keys(answer).length; answer = feedback.poll('10.0.0.5')) seen.push(buttonsIn(answer));
  assert.deepEqual(seen, [
    [['501_6', 'Release'], ['502_1', 'Press']],
    [['501_6', BUTTON_IDLE], ['502_1', BUTTON_IDLE]],
    [['501_6', 'MultiTap']],
    [['501_6', BUTTON_IDLE]],
  ]);
});

test(`more than ${BUTTON_SLOTS} buttons at once go out ${BUTTON_SLOTS} at a time`, () => {
  const { feedback } = setup();
  feedback.poll('10.0.0.5');
  for (let b = 1; b <= BUTTON_SLOTS + 2; b++) feedback.buttonEvent(501, b, 'Release');
  const first = buttonsIn(feedback.poll('10.0.0.5'));
  assert.equal(first.length, BUTTON_SLOTS);
  const second = buttonsIn(feedback.poll('10.0.0.5'));
  assert.deepEqual(second.filter(([, e]) => e === 'Release').map(([k]) => k), ['501_9', '501_10'], 'the rest go ahead of the resets');
  assert.equal(second.filter(([, e]) => e === BUTTON_IDLE).length, BUTTON_SLOTS - 2, 'resets fill what\'s left');
});

test('button events only go to hosts asking now: a host that starts later gets none from before', () => {
  const { feedback, clock } = setup();
  feedback.poll('10.0.0.5');
  feedback.buttonEvent(501, 6, 'Release');
  assert.ok('z0' in feedback.poll('10.0.0.9'), 'a new host gets the levels, not the old press');
  assert.deepEqual(buttonsIn(feedback.poll('10.0.0.5')), [['501_6', 'Release']]);
  clock.t += IDLE_MS + 1;
  feedback.buttonEvent(501, 6, 'Release');
  assert.deepEqual(buttonsIn(feedback.poll('10.0.0.5')), [['501_6', BUTTON_IDLE]], 'nor one that stopped asking: only the reset it was owed');
});

