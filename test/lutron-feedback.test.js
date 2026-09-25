/**
 * Feedback for Savant (lutron/feedback.js): the levels each Savant host hasn't been sent yet,
 * answered in the fixed slots the LEAP Bridge profile reads. Against a stand-in controller
 * and clock, so every timing rule is checked exactly.
 */
require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ZoneFeedback, SLOTS, IDLE_MS, RESYNC_MS } = require('../SplycedBoard/src/integrations/lutron/feedback');

function setup(levels = { 101: 75, 102: 0, 201: 40 }) {
  const controller = {
    ready: true,
    zones: new Map(Object.entries(levels).map(([id, level]) => [Number(id), { id: Number(id), type: 'dimmer', level }])),
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
