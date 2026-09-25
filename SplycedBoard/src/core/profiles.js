/**
 * Which version of each Savant profile Savant is actually running.
 *
 * From Lutron LEAP Bridge 1.12 and Apple TV 1.2 on, each profile has a ReportProfileVersion
 * action that Savant runs when it starts and every minute after:
 *
 *   GET /api/hub/profile-report?integration=<id>&version=<rpm_xml_version>[&device=<address>]
 *
 * Comparing that with the profile this copy of SplycedBoard ships (rpm_xml_version in
 * profiles/<file>) shows when Blueprint has an older, or newer, profile than it should.
 *
 * Older profiles can't report. When Savant keeps calling an integration's API for two
 * minutes and nothing reports, that's an older profile too. A single request (someone
 * testing with curl) isn't enough.
 *
 * A "source" is one component in Savant's configuration: the device address it reports
 * (each Apple TV), or else the address the requests come from (the Pro Host, for Lutron).
 */
const fs = require('fs');
const { EventEmitter } = require('events');

const ACTIVE_MS = 5 * 60 * 1000; // not heard from in 5 minutes: no longer in Savant's configuration
const GRACE_MS = 2 * 60 * 1000;  // time Savant gets to report before a source counts as unreported
const TICK_MS = 30 * 1000;

/**
 * What a shipped profile says about itself: its version (rpm_xml_version on the root
 * <component>) and whether it has a ReportProfileVersion action.
 */
function readProfile(file) {
  let xml;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    return { version: null, reports: false };
  }
  const root = xml.match(/<component\b([^>]*)>/);
  return {
    version: root?.[1].match(/\srpm_xml_version="([^"]+)"/)?.[1] ?? null,
    reports: xml.includes('<action name="ReportProfileVersion">'),
  };
}

/** Dotted versions, compared part by part as whole numbers: 1.9 < 1.10 < 1.11. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const WARN_STATES = new Set(['older', 'newer', 'unreported']);

class ProfileTracker extends EventEmitter {
  constructor({ log = null, now = Date.now } = {}) {
    super();
    this.log = log;
    this.now = now;
    this.profiles = new Map(); // id → { name, file, version, sources: Map(key → source) }
    this.timer = null;
  }

  /** The profile an integration ships: { name, file, version, reports }. */
  register(id, profile) {
    this.profiles.set(id, { ...profile, sources: new Map() });
  }

  has(id) {
    return this.profiles.has(id);
  }

  /** ReportProfileVersion from Savant. Returns that source's state. */
  report(id, key, version) {
    const profile = this.profiles.get(id);
    const source = this._source(profile, key);
    source.version = version;
    source.reportAt = this.now();
    this._evaluate(id);
    return this._state(profile, source);
  }

  /**
   * Any other successful request from Savant to the integration's API. Only telling for a
   * profile that reports: from one that can't, silence is expected.
   */
  traffic(id, key) {
    const profile = this.profiles.get(id);
    if (!profile?.reports) return;
    const source = this._source(profile, key);
    const now = this.now();
    if (!source.trafficAt || now - source.trafficAt > ACTIVE_MS) source.firstTrafficAt = now;
    source.trafficAt = now;
    this._evaluate(id);
  }

  /** For the dashboard: the profile shipped, what Savant runs, and a warning when they differ. */
  summary(id) {
    const profile = this.profiles.get(id);
    if (!profile) return null;
    const sources = [];
    for (const [key, source] of profile.sources) {
      const state = this._state(profile, source);
      if (state === 'inactive') continue;
      const lastSeen = Math.max(source.reportAt || 0, source.trafficAt || 0);
      sources.push({ device: key, version: source.version, state, lastSeen: new Date(lastSeen).toISOString() });
    }
    const bad = sources.filter((s) => WARN_STATES.has(s.state));
    let warning = bad.length ? this._message(profile, bad[0]) : null;
    if (bad.length > 1) warning += ` (${bad.length - 1} more component${bad.length > 2 ? 's' : ''} too.)`;
    return { file: profile.file, version: profile.version, reports: profile.reports, sources, warning };
  }

  /** Re-check every source: they go quiet, or run out of grace, without any request to notice it. */
  refresh() {
    for (const id of this.profiles.keys()) this._evaluate(id);
  }

  start() {
    this.timer = setInterval(() => this.refresh(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _source(profile, key) {
    let source = profile.sources.get(key);
    if (!source) {
      source = { version: null, reportAt: 0, trafficAt: 0, firstTrafficAt: 0, state: 'inactive', seen: 'inactive null' };
      profile.sources.set(key, source);
    }
    return source;
  }

  _state(profile, source) {
    const now = this.now();
    if (source.reportAt && now - source.reportAt <= ACTIVE_MS) {
      const cmp = compareVersions(source.version, profile.version);
      return cmp === 0 ? 'current' : cmp < 0 ? 'older' : 'newer';
    }
    if (source.trafficAt && now - source.trafficAt <= ACTIVE_MS) {
      // Calls spread over at least GRACE_MS, with every report due in that time missing.
      return source.trafficAt - source.firstTrafficAt >= GRACE_MS ? 'unreported' : 'pending';
    }
    return 'inactive';
  }

  _message(profile, { device, version, state }) {
    const where = device ? ` (${device})` : '';
    if (state === 'older') {
      return `Savant is running version ${version} of this profile${where}, but this SplycedBoard ships ${profile.version}. `
        + 'Add the new profile in Blueprint and update the configuration.';
    }
    if (state === 'newer') {
      return `Savant is running version ${version} of this profile${where}, newer than the ${profile.version} `
        + 'this SplycedBoard ships. Update SplycedBoard.';
    }
    return `Savant is running a version of this profile older than ${profile.version}${where}, from before `
      + `profiles reported their version. Add version ${profile.version} in Blueprint and update the configuration.`;
  }

  // Logs each source's state changes once, and tells the dashboard.
  _evaluate(id) {
    const profile = this.profiles.get(id);
    let changed = false;
    for (const [key, source] of profile.sources) {
      const state = this._state(profile, source);
      const seen = `${state} ${source.version}`;
      if (seen === source.seen) continue;
      const previous = source.state;
      source.seen = seen;
      source.state = state;
      changed = true;
      if (state === 'current') {
        this.log?.info(`${profile.name}: Savant runs profile ${source.version} (${key})`);
      } else if (WARN_STATES.has(state)) {
        this.log?.warn(`${profile.name}: ${this._message(profile, { device: key, version: source.version, state })}`);
      } else if (state === 'inactive' && previous !== 'pending') {
        this.log?.info(`${profile.name}: no longer hearing from Savant's component (${key})`);
      }
      if (state === 'inactive') profile.sources.delete(key);
    }
    if (changed) this.emit('change', id);
  }
}

module.exports = { ProfileTracker, readProfile, compareVersions, ACTIVE_MS, GRACE_MS };
