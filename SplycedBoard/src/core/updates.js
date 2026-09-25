/**
 * Updates from GitHub releases: the same download as the one-line install in the README.
 *
 *   check()     asks GitHub for the newest release of the repository named in package.json
 *   install()   downloads that release's SplycedBoard.tar.gz, checks it against the SHA-256
 *               digest GitHub publishes for it, unpacks it into data/update/, and runs its
 *               installer (./install --yes --headless). That updates this copy the way a
 *               manual update does: settings, pairing and integration choices are kept, and
 *               the service restarts on the new version. Installer output: logs/update.log.
 *
 * The installer stops this service part-way through, so it can't be a child of it: it runs
 * as its own short-lived launchd job, com.splycedboard.update. Only the background service
 * installs updates (SPLYCEDBOARD_MANAGED=1); a copy running in a terminal can only check.
 *
 * data/update/pending.json remembers an update in progress, so the new version can say how
 * it went once it's running.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execFile, spawnSync } = require('child_process');
const { promisify } = require('util');
const { compareVersions } = require('./profiles');
const { toPlist } = require('./plist');

const execFileAsync = promisify(execFile);

const ASSET = 'SplycedBoard.tar.gz';
const UPDATE_LABEL = 'com.splycedboard.update';
const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const API_TIMEOUT_MS = 20 * 1000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const WATCH_EVERY_MS = 2000;
const WATCH_LIMIT_MS = 15 * 60 * 1000;

/** "owner/repo" from package.json's repository field. */
function githubRepo(pkg) {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const m = String(url || '').match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Release versions: 2.0.10 > 2.0.9, and 2.1.0 > 2.1.0-beta.1. */
function compareReleases(a, b) {
  const [coreA, preA] = String(a).split('-', 2);
  const [coreB, preB] = String(b).split('-', 2);
  return compareVersions(coreA, coreB) || (preA && !preB ? -1 : !preA && preB ? 1 : 0);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Runs the installer as its own launchd job, so it survives stopping the service that
 * started it. It writes its exit code to resultFile when it's done.
 */
function launchdLauncher({ installer, cwd, env, logFile, resultFile, label = UPDATE_LABEL }) {
  const domain = `gui/${process.getuid()}`;
  const plistFile = path.join(path.dirname(resultFile), `${label}.plist`);
  fs.writeFileSync(plistFile, toPlist({
    Label: label,
    ProgramArguments: ['/bin/bash', '-c', '/bin/bash "$0" --yes --headless; echo $? > "$1"', installer, resultFile],
    WorkingDirectory: cwd,
    EnvironmentVariables: env,
    RunAtLoad: true,
    StandardOutPath: logFile,
    StandardErrorPath: logFile,
  }));
  spawnSync('launchctl', ['bootout', `${domain}/${label}`]); // a finished earlier update, if any
  const r = spawnSync('launchctl', ['bootstrap', domain, plistFile], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`launchd wouldn't start the installer: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
}

class Updater extends EventEmitter {
  /**
   * @param version   the running version
   * @param repo      "owner/repo" on GitHub (see githubRepo)
   * @param managed   running as the launchd service: only then can it install
   * @param launch    how to run the installer (tests replace launchdLauncher)
   */
  constructor({ version, repo, dataDir, logDir = null, managed = false, log = null, apiBase, launch = launchdLauncher, watchEveryMs = WATCH_EVERY_MS }) {
    super();
    this.repo = repo;
    this.log = log;
    this.apiBase = apiBase || process.env.SPLYCEDBOARD_UPDATE_API || 'https://api.github.com';
    this.userAgent = `SplycedBoard/${version}`;
    this.launch = launch;
    this.watchEveryMs = watchEveryMs;
    this.workDir = path.join(dataDir, 'update');
    this.pendingFile = path.join(this.workDir, 'pending.json');
    this.resultFile = path.join(this.workDir, 'result');
    this.logFile = path.join(logDir || this.workDir, 'update.log');
    this.timers = [];
    this.checking = null;
    this.state = {
      current: version,
      repo,
      canInstall: Boolean(managed),
      checking: false,
      checkedAt: null,
      latest: null,     // { version, tag, name, url, publishedAt, asset: { url, size, digest } }
      available: false,
      error: null,
      installing: null, // { version, startedAt }
      result: null,     // { ok, version, message, at }: how the last update went
    };
    this._readPending();
  }

  status() {
    return { ...this.state };
  }

  /** Check a minute after starting, then twice a day. */
  startAutoCheck() {
    const run = () => this.check().catch(() => { /* kept in state.error */ });
    this.timers.push(setTimeout(run, FIRST_CHECK_MS), setInterval(run, CHECK_EVERY_MS));
    for (const timer of this.timers) timer.unref?.();
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** Ask GitHub for the newest release. Concurrent calls share one request. */
  check() {
    this.checking ??= this._check().finally(() => { this.checking = null; });
    return this.checking;
  }

  async _check() {
    if (!this.repo) throw httpError(500, "package.json doesn't name a GitHub repository to update from");
    this._set({ checking: true });
    try {
      const res = await fetch(`${this.apiBase}/repos/${this.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': this.userAgent, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (res.status === 404) throw new Error(`${this.repo} has no published releases`);
      if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests from this network; try again later');
      if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
      const release = await res.json();
      const asset = (release.assets || []).find((a) => a.name === ASSET);
      const version = String(release.tag_name || '').replace(/^v/, '');
      const latest = {
        version,
        tag: release.tag_name,
        name: release.name || release.tag_name,
        url: release.html_url,
        publishedAt: release.published_at,
        asset: asset ? { url: asset.browser_download_url, size: asset.size, digest: asset.digest || null } : null,
      };
      const available = Boolean(asset) && compareReleases(version, this.state.current) > 0;
      if (available && this.state.latest?.version !== version) {
        this.log?.info(`SplycedBoard v${version} is available (this is v${this.state.current})`);
      }
      this._set({ checking: false, checkedAt: new Date().toISOString(), latest, available, error: null });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? "GitHub didn't answer in time" : err.message;
      this._set({ checking: false, checkedAt: new Date().toISOString(), error: `Couldn't check for updates: ${reason}` });
      this.log?.warn(this.state.error);
      throw httpError(err.status || 502, this.state.error);
    }
    return this.status();
  }

  /** Download, verify and unpack the newest release, then start its installer. */
  async install() {
    if (!this.state.canInstall) {
      throw httpError(409, 'Updates can only be installed by the background service, not a copy running in a terminal.');
    }
    if (this.state.installing) throw httpError(409, `Already updating to v${this.state.installing.version}.`);
    await this.check(); // install what GitHub says is newest right now
    // Checked again: a second request may have started while this one waited for GitHub.
    if (this.state.installing) throw httpError(409, `Already updating to v${this.state.installing.version}.`);
    const { latest } = this.state;
    if (!this.state.available) throw httpError(409, `v${this.state.current} is already the newest version.`);

    this._set({ installing: { version: latest.version, startedAt: new Date().toISOString() }, result: null });
    try {
      const archive = await this._download(latest.asset);
      const dir = await this._unpack(archive, latest.version);
      fs.writeFileSync(this.pendingFile, JSON.stringify({ from: this.state.current, to: latest.version }));
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.writeFileSync(this.logFile, '');
      this.launch({
        installer: path.join(dir, 'install'),
        cwd: dir,
        env: installerEnv(),
        logFile: this.logFile,
        resultFile: this.resultFile,
      });
    } catch (err) {
      this._finish(false, latest.version, err.message);
      throw httpError(502, err.message);
    }
    this.log?.info(`Updating to v${latest.version}. SplycedBoard restarts when the installer is done (log: ${this.logFile})`);
    this._watch(latest.version);
    return this.status();
  }

  /** The installer's output so far. */
  logTail(lines = 200) {
    try {
      return fs.readFileSync(this.logFile, 'utf8').split('\n').slice(-lines).join('\n');
    } catch {
      return '';
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  async _download(asset) {
    if (asset.size > MAX_DOWNLOAD_BYTES) throw new Error('The download is unexpectedly large');
    const res = await fetch(asset.url, { headers: { 'User-Agent': this.userAgent }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`The download failed: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    const [algorithm, expected] = String(asset.digest || '').split(':');
    if (algorithm === 'sha256' && expected) {
      const actual = crypto.createHash('sha256').update(data).digest('hex');
      if (actual !== expected) throw new Error("The download doesn't match the checksum GitHub published for it");
    } else {
      this.log?.warn('GitHub published no SHA-256 checksum for this download, so it was installed unchecked');
    }
    return data;
  }

  async _unpack(data, version) {
    fs.rmSync(this.workDir, { recursive: true, force: true });
    fs.mkdirSync(this.workDir, { recursive: true });
    const archive = path.join(this.workDir, ASSET);
    fs.writeFileSync(archive, data);
    await execFileAsync('tar', ['-xzf', archive, '-C', this.workDir]);
    const dir = path.join(this.workDir, 'SplycedBoard');
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* checked next */ }
    if (pkg?.name !== 'splycedboard' || pkg.version !== version) throw new Error(`The download isn't SplycedBoard v${version}`);
    if (!fs.existsSync(path.join(dir, 'install'))) throw new Error('The download has no installer');
    return dir;
  }

  // A successful install stops this process before the installer finishes, so the new
  // version reports it (_readPending). Still being here when it finishes means it failed.
  _watch(version) {
    const started = Date.now();
    const timer = setInterval(() => {
      let code = null;
      try { code = parseInt(fs.readFileSync(this.resultFile, 'utf8'), 10); } catch { /* still running */ }
      if (code === null && Date.now() - started < WATCH_LIMIT_MS) return;
      clearInterval(timer);
      if (code === 0) this._finish(true, version, `Installed v${version}. Restart SplycedBoard to run it.`);
      else if (code === null) this._finish(false, version, `The installer hasn't finished after 15 minutes. See ${this.logFile}.`);
      else this._finish(false, version, `The installer stopped with an error (exit code ${code}); still running v${this.state.current}. See ${this.logFile}.`);
    }, this.watchEveryMs);
    timer.unref?.();
    this.timers.push(timer);
  }

  _readPending() {
    let pending;
    try { pending = JSON.parse(fs.readFileSync(this.pendingFile, 'utf8')); } catch { return; }
    fs.rmSync(this.pendingFile, { force: true });
    const ok = pending.to === this.state.current;
    this.state.result = {
      ok,
      version: pending.to,
      at: new Date().toISOString(),
      message: ok
        ? `Updated from v${pending.from} to v${pending.to}.`
        : `The update to v${pending.to} didn't finish; still running v${this.state.current}. See ${this.logFile}.`,
    };
    if (ok) this.log?.info(this.state.result.message);
    else this.log?.warn(this.state.result.message);
  }

  _finish(ok, version, message) {
    fs.rmSync(this.pendingFile, { force: true });
    this._set({ installing: null, result: { ok, version, message, at: new Date().toISOString() } });
    if (ok) this.log?.info(message);
    else this.log?.error(`Update to v${version} failed: ${message}`);
  }

  _set(patch) {
    Object.assign(this.state, patch);
    this.emit('change', this.status());
  }
}

// What the installer needs from the service's own launchd environment: where this copy
// lives and which port it serves, so the update lands in the same place.
function installerEnv() {
  const keep = ['PATH', 'HOME', 'SPLYCEDBOARD_HOME', 'SPLYCEDBOARD_LOG_DIR', 'SPLYCEDBOARD_WEB_PORT'];
  return Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
}

module.exports = { Updater, githubRepo, compareReleases, launchdLauncher, UPDATE_LABEL };
