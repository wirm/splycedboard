/**
 * Savant profiles: Blueprint finds a profile by its file name, which must be
 * "<manufacturer>_<model>.xml" in lowercase, the way Savant names its own library. Under any
 * other name Blueprint still lists the component, but adding it fails with "Component not found".
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { manifests } = require('../SplycedBoard/src/integrations');
const { compareVersions } = require('../SplycedBoard/src/core/profiles');
const { SLOTS, LED_SLOTS } = require('../SplycedBoard/src/integrations/lutron/feedback');

const ROOT = path.join(__dirname, '..');
const PROFILES = path.join(ROOT, 'SplycedBoard', 'profiles');
const files = fs.readdirSync(PROFILES).filter((f) => f.endsWith('.xml'));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function rootAttributes(xml) {
  const tag = xml.match(/<component\b([^>]*)>/);
  assert.ok(tag, 'no <component> root element');
  const attrs = {};
  for (const [, name, value] of tag[1].matchAll(/([\w:]+)="([^"]*)"/g)) {
    attrs[name] = value.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e]);
  }
  return attrs;
}

test('there are profiles to check', () => {
  assert.ok(files.length > 0);
});

for (const file of files) {
  test(`${file} is named <manufacturer>_<model>.xml, which is how Blueprint finds it`, () => {
    const attrs = rootAttributes(fs.readFileSync(path.join(PROFILES, file), 'utf8'));
    assert.ok(attrs.manufacturer && attrs.model, 'manufacturer and model are required');
    assert.ok(attrs.rpm_xml_version, 'rpm_xml_version (the profile version) is required');
    assert.equal(file, `${attrs.manufacturer}_${attrs.model}`.toLowerCase() + '.xml');
  });
}

test('each integration names a profile that exists', () => {
  for (const { id, profile } of manifests()) {
    if (profile) assert.ok(fs.existsSync(path.join(PROFILES, profile)), `${id}: profiles/${profile} is missing`);
  }
});

// ReportProfileVersion tells SplycedBoard which profile version Savant runs (core/profiles.js).
// Savant has no way to read rpm_xml_version itself, so the version is written into the
// action: it has to be kept equal by hand, and this makes sure it is.
test('profiles report their own integration and version, equal to rpm_xml_version', () => {
  const reporting = [];
  for (const { id, profile } of manifests()) {
    if (!profile) continue;
    const xml = fs.readFileSync(path.join(PROFILES, profile), 'utf8');
    const action = xml.match(/<action name="ReportProfileVersion">([\s\S]*?)<\/action>/);
    if (!action) continue;
    reporting.push(id);
    assert.match(action[1], />api\/hub\/profile-report</, `${profile}: ReportProfileVersion calls the wrong path`);
    const query = action[1].match(/<!\[CDATA\[\?integration=([^&\]]+)&version=([^&\]]+)/);
    assert.ok(query, `${profile}: ReportProfileVersion has no ?integration=…&version=…`);
    assert.equal(query[1], id, `${profile}: reports integration "${query[1]}"`);
    const { rpm_xml_version: version } = rootAttributes(xml);
    assert.equal(query[2], version, `${profile}: reports version ${query[2]}, but rpm_xml_version is ${version}`);
  }
  for (const id of ['appletv', 'lutron']) assert.ok(reporting.includes(id), `the ${id} profile doesn't report its version`);
});

// Every change to a profile must bump rpm_xml_version (and add a Change Log line). Checked
// against the latest release tag, matching profiles by manufacturer and model since file
// names can change. Skipped where git has no tag to compare with (a shallow CI checkout).
test('a profile that changed since the last release has a higher version', (t) => {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let tag;
  try {
    tag = git('describe', '--tags', '--abbrev=0').trim();
  } catch {
    return t.skip('no release tag to compare with');
  }
  const released = new Map();
  for (const file of git('ls-tree', '-z', '--name-only', `${tag}:SplycedBoard/profiles`).split('\0')) {
    if (!file.endsWith('.xml')) continue;
    const xml = git('show', `${tag}:SplycedBoard/profiles/${file}`);
    const attrs = rootAttributes(xml);
    released.set(`${attrs.manufacturer}\n${attrs.model}`, { xml, version: attrs.rpm_xml_version });
  }
  for (const file of files) {
    const xml = fs.readFileSync(path.join(PROFILES, file), 'utf8');
    const attrs = rootAttributes(xml);
    const before = released.get(`${attrs.manufacturer}\n${attrs.model}`);
    if (!before || before.xml === xml) continue;
    assert.equal(compareVersions(attrs.rpm_xml_version, before.version), 1,
      `${file} changed since ${tag} but its rpm_xml_version is still ${attrs.rpm_xml_version} (was ${before.version}): bump it and add a Change Log line`);
  }
});

// Savant runs an entity's query_status_with_action only where its schema puts it, after the
// representations, and passes the action only the addresses named in with_arg. The Lutron
// profile up to 1.12 had its polling first, with no address: Savant never asked for a level.
test('entities ask for their state after their representations, passing the address', () => {
  for (const file of files) {
    const xml = fs.readFileSync(path.join(PROFILES, file), 'utf8');
    for (const [, name, body] of xml.matchAll(/<entity name="([^"]+)"[^>]*>([\s\S]*?)<\/entity>/g)) {
      const representations = [...body.matchAll(/<\/\w+_representation>/g)].map((m) => m.index);
      for (const query of body.matchAll(/<query_status_with_action\b[^>]*>([\s\S]*?)<\/query_status_with_action>/g)) {
        assert.ok(query.index > Math.max(...representations), `${file}: "${name}" asks before its representations`);
        assert.match(query[1], /<with_arg name="\w+" address_component="\d+"/, `${file}: "${name}" asks without passing its address`);
      }
    }
  }
});

// Savant looks for an entity's query action among the custom component actions only. The
// Lutron profile's QueryDimmerLevel sat with the lighting resource actions in 1.13, and Savant's
// engine logged "Action ({ name_ = QueryDimmerLevel; resourceType_ = \"\"; }) not found".
test("entities' state queries are custom component actions", () => {
  for (const file of files) {
    const xml = fs.readFileSync(path.join(PROFILES, file), 'utf8');
    const custom = [...xml.matchAll(/<custom_component_actions>([\s\S]*?)<\/custom_component_actions>/g)].map((m) => m[1]).join('');
    for (const [, name] of xml.matchAll(/<query_status_with_action name="([^"]+)"/g)) {
      assert.ok(custom.includes(`<action name="${name}">`), `${file}: ${name} is queried by an entity, but isn't a custom component action`);
    }
  }
});

// update_state_variable reads and writes only variables the profile declares, a Name_* target
// needing Name declared as a dynamic_state_variable. With 1.13's undeclared ones, Savant logged
// "state variable not defined: (DimmerLevel_0)" for every feedback slot.
test('update_state_variable only reads and writes declared variables', () => {
  for (const file of files) {
    const xml = fs.readFileSync(path.join(PROFILES, file), 'utf8');
    const declared = new Set([...xml.matchAll(/<(?:state|volume_state|date_state)_variable name="([^"]+)"/g)].map((m) => m[1]));
    const dynamic = new Set([...xml.matchAll(/<dynamic_state_variable name="([^"]+)"/g)].map((m) => m[1]));
    const known = (name) => (name.endsWith('_*') ? dynamic.has(name.slice(0, -2)) : declared.has(name) || dynamic.has(name));
    for (const [tag, attrs, source] of xml.matchAll(/<update_state_variable\b([^>]*)>([^<]*)</g)) {
      const attr = (a) => attrs.match(new RegExp(`\\b${a}="([^"]*)"`))?.[1];
      assert.ok(known(attr('name')), `${file}: writes ${attr('name')}, which isn't declared: ${tag}`);
      if (attr('wildcard_source') === 'state_variable') {
        assert.ok(declared.has(attr('wildcard_source_name')), `${file}: ${attr('wildcard_source_name')} isn't declared: ${tag}`);
      }
      if (attr('update_source') === 'state_variable') assert.ok(known(source), `${file}: reads ${source}, which isn't declared: ${tag}`);
    }
  }
});

// SplycedBoard answers the Lutron profile's PollFeedback in SLOTS slots (lutron/feedback.js),
// and the profile's ZoneFeedback status message writes each into two states: a slot one side
// has and the other doesn't would lose levels, or write old ones.
test('the Lutron profile reads every feedback slot SplycedBoard sends, levels and LEDs', () => {
  const xml = fs.readFileSync(path.join(PROFILES, 'lutron_leap bridge.xml'), 'utf8');
  const message = xml.match(/<status_message name="ZoneFeedback">([\s\S]*?)<\/status_message>/)?.[1];
  assert.ok(message, 'no ZoneFeedback status message');
  const all = Array.from({ length: SLOTS }, (_, i) => i);
  const slots = (re) => [...message.matchAll(re)].map((m) => Number(m[1]));
  assert.deepEqual(slots(/<values path="\/none\/z(\d+)"/g), all, 'zone slots');
  assert.deepEqual(slots(/<values path="\/none\/l(\d+)"/g), all, 'level slots');
  for (const state of ['DimmerLevel', 'ColorLevel']) {
    const writes = [...message.matchAll(new RegExp(`<update_state_variable name="${state}_\\*"[^>]*wildcard_source_name="FeedbackZone(\\d+)">FeedbackLevel(\\d+)<`, 'g'))];
    assert.deepEqual(writes.map((m) => Number(m[1])), all, state);
    assert.ok(writes.every((m) => m[1] === m[2]), `${state}: each slot's zone gets its own level`);
  }
  assert.match(xml, /<action name="PollFeedback">[\s\S]*?>api\/lutron\/feedback</, 'PollFeedback asks the wrong path');

  // Keypad LEDs: "<device>_<LED>" into IsCurrentLEDOn_*
  const leds = xml.match(/<status_message name="LEDFeedback">([\s\S]*?)<\/status_message>/)?.[1];
  assert.ok(leds, 'no LEDFeedback status message');
  const allLeds = Array.from({ length: LED_SLOTS }, (_, i) => i);
  assert.deepEqual([...leds.matchAll(/<values path="\/none\/k(\d+)"/g)].map((m) => Number(m[1])), allLeds, 'LED key slots');
  assert.deepEqual([...leds.matchAll(/<values path="\/none\/o(\d+)"/g)].map((m) => Number(m[1])), allLeds, 'LED state slots');
  const lights = [...leds.matchAll(/<update_state_variable name="IsCurrentLEDOn_\*"[^>]*wildcard_source_name="FeedbackLEDKey(\d+)">FeedbackLEDOn(\d+)</g)];
  assert.deepEqual(lights.map((m) => Number(m[1])), allLeds);
  assert.ok(lights.every((m) => m[1] === m[2]), "each LED slot's key gets its own state");
  assert.match(xml, /<action name="FeedbackStart">[\s\S]*?feedback<\/command_string>[\s\S]*?\?start=1[\s\S]*?period_ms="0"/, 'FeedbackStart asks for everything when Savant starts');
});

// Blueprint's own schema, where Blueprint is installed (not on CI). Savant passes over what it
// doesn't expect without a word, which is how the misplaced polling above went unnoticed.
function blueprintSchema() {
  const base = path.join(os.homedir(), 'Library', 'Application Support', 'Savant');
  let dirs;
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return null;
  }
  return dirs
    .filter((d) => d.startsWith('.SavantOS'))
    .map((d) => path.join(base, d, 'RPMInstallLink/Library/Application Support/RacePointMedia/systemConfig.rpmConfig/componentProfiles/racepoint_component_profile.xsd'))
    .filter((f) => fs.existsSync(f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

// What the schema asks for that Savant's own profiles leave out as well, and one untested
// addition of ours: the Lutron thermostat state variables name their ThermostatID (1.11).
const TOLERATED = [
  /The attribute 'state_center_type' is required but missing/,
  /Element 'state_variable', attribute 'unique_identifier': The attribute 'unique_identifier' is not allowed/,
];

test("profiles validate against Blueprint's schema", (t) => {
  const xsd = blueprintSchema();
  if (!xsd) return t.skip('Blueprint is not installed here');
  for (const file of files) {
    let out = '';
    try {
      execFileSync('xmllint', ['--noout', '--schema', xsd, path.join(PROFILES, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      out = String(err.stderr);
    }
    const errors = out.split('\n').filter((line) => /validity error/.test(line) && !TOLERATED.some((re) => re.test(line)));
    assert.deepEqual(errors, [], file);
  }
});
