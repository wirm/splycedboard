/**
 * Savant profiles: Blueprint finds a profile by its file name, which must be
 * "<manufacturer>_<model>.xml" in lowercase, the way Savant names its own library. Under any
 * other name Blueprint still lists the component, but adding it fails with "Component not found".
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { manifests } = require('../SplycedBoard/src/integrations');
const { compareVersions } = require('../SplycedBoard/src/core/profiles');

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
