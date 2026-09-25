/**
 * SplycedBoard dashboard shell.
 *
 * Owns navigation, the WebSocket, the Overview / Logs / Settings pages, and loads each
 * integration's panel (src/integrations/<id>/ui/panel.{html,css,js}). A panel script
 * registers itself with:
 *
 *   SB.registerPanel('<id>', {
 *     init(ctx),                 ctx = { root, api(method, path, body), esc, toast }
 *     onStateChange(integration) enabled/running/status changed (also called once after init)
 *     onMessage(msg)             WebSocket messages whose source is this integration
 *   });
 */
const SB = (() => {
  const $ = (id) => document.getElementById(id);

  let app = null;          // /api/hub → app info
  let settings = null;     // /api/hub → hub settings
  let integrations = [];
  const panels = {};       // id → { page, root, banner, def }
  const panelDefs = {};    // filled by SB.registerPanel as panel scripts load

  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* plain text */ }
    if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
    return data;
  }

  function toast(message, kind = 'ok') {
    const el = document.createElement('div');
    el.className = `toast${kind === 'error' ? ' error' : ''}`;
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
  }

  function timeAgo(iso) {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  function currentRoute() {
    return location.hash.replace(/^#\/?/, '').split('/')[0] || 'overview';
  }

  function showPage() {
    let route = currentRoute();
    if (!$(`page-${route}`)) route = 'overview';
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${route}`));
    document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
    setMenuOpen(false);
    if (route === 'logs') scrollLogsToEnd();
    window.scrollTo(0, 0);
  }

  function setMenuOpen(open) {
    $('sidebar').classList.toggle('open', open);
    $('menuBtn').setAttribute('aria-expanded', String(open));
  }

  // ── Integrations: nav, overview cards, panel state ───────────────────────

  function renderNav() {
    $('navIntegrations').innerHTML = integrations.map((i) => `
      <a class="nav-item${i.enabled ? '' : ' is-off'}" href="#/${esc(i.id)}" data-route="${esc(i.id)}">
        <span class="nav-icon">${esc(i.icon || '◆')}</span>${esc(i.name)}
        <span class="status-dot ${esc(i.status.level)}" title="${esc(i.status.text)}"></span>
      </a>`).join('');
    const route = currentRoute();
    document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  }

  function renderCards() {
    $('integrationCards').innerHTML = integrations.map((i) => {
      const endpoints = (i.endpoints || []).map((e) => `<span class="info-chip">${esc(e.protocol)} ${esc(e.port)}${e.path ? ` ${esc(e.path)}` : ''}</span>`).join('');
      const cls = !i.enabled ? ' is-off' : i.status.level === 'error' ? ' is-error' : '';
      return `
        <div class="int-card${cls}">
          <div class="int-card-head">
            <div>
              <div class="int-name">${esc(i.icon || '')} ${esc(i.name)}</div>
              <div class="int-status"><span class="status-dot ${esc(i.status.level)}"></span>${esc(i.status.text)}</div>
            </div>
            <label class="toggle" title="${i.enabled ? 'Switch off' : 'Switch on'}" aria-label="${esc(i.name)} on/off">
              <input type="checkbox" ${i.enabled ? 'checked' : ''} onchange="SB.setEnabled('${esc(i.id)}', this.checked, this)">
              <span class="toggle-track"></span>
            </label>
          </div>
          <p class="int-desc">${esc(i.description)}</p>
          ${endpoints ? `<div class="int-endpoints">${endpoints}</div>` : ''}
          <div class="int-actions">
            <a class="btn btn-secondary btn-sm" href="#/${esc(i.id)}">Open</a>
            ${i.profile ? `<a class="btn btn-ghost btn-sm" href="/api/hub/integrations/${esc(i.id)}/profile" download>⬇ Savant profile</a>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  function applyPanelState(i) {
    const p = panels[i.id];
    if (!p) return;
    const off = !i.running;
    p.root.classList.toggle('is-off', off);
    p.banner.hidden = !off;
    if (off) {
      if (!i.enabled) {
        p.banner.innerHTML = `<div><strong>${esc(i.name)} is switched off.</strong> Savant can't use it until it's switched back on.</div>
          <button class="btn btn-primary btn-sm" onclick="SB.setEnabled('${esc(i.id)}', true)">Switch on</button>`;
      } else if (i.status.level === 'error') {
        p.banner.innerHTML = `<div><strong>${esc(i.name)} couldn't start.</strong> ${esc(i.status.text)}</div>
          <button class="btn btn-secondary btn-sm" onclick="SB.restartIntegration('${esc(i.id)}')">Try again</button>`;
      } else {
        p.banner.innerHTML = `<div><strong>${esc(i.name)}</strong> is starting…</div>`;
      }
    }
    try { p.def?.onStateChange?.(i); } catch (err) { console.error(err); }
  }

  function setIntegrations(list) {
    integrations = list;
    renderNav();
    renderCards();
    renderProfiles();
    updateLogSources();
    list.forEach(applyPanelState);
  }

  async function setEnabled(id, enabled, checkbox) {
    const i = integrations.find((x) => x.id === id);
    if (!enabled && !confirm(`Switch off ${i.name}?\n\nSavant loses control of it until it's switched back on.`)) {
      if (checkbox) checkbox.checked = true;
      return;
    }
    if (checkbox) checkbox.disabled = true;
    try {
      const updated = await api('PUT', `/api/hub/integrations/${id}`, { enabled });
      toast(`${i.name} switched ${enabled ? 'on' : 'off'}`);
      if (enabled && updated.status.level === 'error') toast(`${i.name}: ${updated.status.text}`, 'error');
    } catch (err) {
      toast(err.message, 'error');
      if (checkbox) checkbox.checked = !enabled;
    } finally {
      if (checkbox) checkbox.disabled = false;
    }
  }

  async function restartIntegration(id) {
    try {
      const updated = await api('POST', `/api/hub/integrations/${id}/restart`);
      if (updated.status.level === 'error') toast(updated.status.text, 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ── Panels ───────────────────────────────────────────────────────────────

  function registerPanel(id, def) {
    panelDefs[id] = def;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.body.appendChild(s);
    });
  }

  async function loadPanel(i) {
    const page = document.createElement('section');
    page.className = 'page';
    page.id = `page-${i.id}`;
    page.innerHTML = '<div class="disabled-banner" hidden></div><div class="panel-root"></div>';
    $('main').appendChild(page);
    const p = { page, root: page.querySelector('.panel-root'), banner: page.querySelector('.disabled-banner'), def: null };
    panels[i.id] = p;

    if (!i.ui) {
      p.root.innerHTML = `<div class="page-body"><div class="page-head"><h1>${esc(i.name)}</h1><p>${esc(i.description)}</p></div></div>`;
      return;
    }

    try {
      if (i.ui.css) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `/ui/${i.id}/panel.css`;
        document.head.appendChild(link);
      }
      const res = await fetch(`/ui/${i.id}/panel.html`);
      p.root.innerHTML = await res.text();
      if (i.ui.js) await loadScript(`/ui/${i.id}/panel.js`);

      p.def = panelDefs[i.id] || null;
      p.def?.init?.({
        root: p.root,
        api: (method, path, body) => api(method, `/api/${i.id}${path}`, body),
        esc,
        toast,
      });
    } catch (err) {
      console.error(err);
      p.root.innerHTML = `<div class="page-body"><div class="alert alert-error show">The ${esc(i.name)} panel failed to load: ${esc(err.message)}</div></div>`;
    }
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  let wsWasOpen = false;

  function connectWs() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

    ws.onopen = () => {
      $('wsDot').className = 'status-dot ok';
      $('wsText').textContent = 'Live';
      // After a service restart, pick up the new process info and recent logs.
      if (wsWasOpen) refreshHub().then(loadLogs).catch(() => {});
      wsWasOpen = true;
    };

    ws.onmessage = ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.source === 'hub') {
        if (msg.type === 'integrations') setIntegrations(msg.integrations);
        else if (msg.type === 'log') appendLog(msg.entry);
        return;
      }
      try { panels[msg.source]?.def?.onMessage?.(msg); } catch (err) { console.error(err); }
    };

    ws.onclose = () => {
      $('wsDot').className = 'status-dot error';
      $('wsText').textContent = 'Reconnecting…';
      setTimeout(connectWs, 3000);
    };
  }

  // ── Logs ─────────────────────────────────────────────────────────────────

  const LOG_KEEP = 2000;
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  let logEntries = [];
  let logPaused = false;

  const logFilter = () => ({
    source: $('logSource').value,
    level: LEVELS[$('logLevel').value],
    text: $('logSearch').value.trim().toLowerCase(),
  });

  function logMatches(e, f) {
    if (LEVELS[e.level] < f.level) return false;
    if (f.source && e.tag.split(':')[0] !== f.source) return false;
    if (f.text && !`${e.tag} ${e.msg}`.toLowerCase().includes(f.text)) return false;
    return true;
  }

  function logLine(e) {
    const t = new Date(e.t).toLocaleTimeString('en-US', { hour12: false });
    return `<div class="log-line ${e.level}"><span class="log-time">${t}</span><span class="log-level ${e.level}">${e.level}</span>`
      + `<span class="log-tag">[${esc(e.tag)}]</span><span class="log-msg">${esc(e.msg)}</span></div>`;
  }

  function nearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  function scrollLogsToEnd() {
    const view = $('logView');
    view.scrollTop = view.scrollHeight;
  }

  function renderLogs() {
    const f = logFilter();
    const lines = logEntries.filter((e) => logMatches(e, f));
    $('logView').innerHTML = lines.length
      ? lines.map(logLine).join('')
      : '<div class="empty-state"><div class="empty-desc">No log lines match.</div></div>';
    scrollLogsToEnd();
  }

  function appendLog(entry) {
    logEntries.push(entry);
    if (logEntries.length > LOG_KEEP) logEntries.shift();
    if (logPaused || !logMatches(entry, logFilter())) return;

    const view = $('logView');
    const stick = nearBottom(view);
    view.querySelector('.empty-state')?.remove();
    view.insertAdjacentHTML('beforeend', logLine(entry));
    while (view.childElementCount > LOG_KEEP) view.firstElementChild.remove();
    if (stick) scrollLogsToEnd();
  }

  async function loadLogs() {
    const { entries } = await api('GET', '/api/hub/logs?limit=1000');
    logEntries = entries;
    renderLogs();
  }

  function updateLogSources() {
    const select = $('logSource');
    const current = select.value;
    const sources = [...integrations.map((i) => [i.id, i.name]), ['hub', 'Hub'], ['web', 'Web server'], ['app', 'App']];
    select.innerHTML = '<option value="">All sources</option>'
      + sources.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
    select.value = current;
  }

  function initLogs() {
    ['logSource', 'logLevel'].forEach((id) => $(id).addEventListener('change', renderLogs));
    $('logSearch').addEventListener('input', renderLogs);
    $('logPause').addEventListener('click', () => {
      logPaused = !logPaused;
      $('logPause').textContent = logPaused ? 'Resume' : 'Pause';
      if (!logPaused) renderLogs();
    });
    $('logDownload').addEventListener('click', () => {
      const text = logEntries.map((e) => `${e.t} ${e.level.toUpperCase().padEnd(5)} [${e.tag}] ${e.msg}`).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
      a.download = `splycedboard-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }

  // ── Settings page ────────────────────────────────────────────────────────

  function kv(rows) {
    return rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  }

  function renderSettings() {
    $('hostChip').textContent = `${app.hostname} · v${app.version}`;
    $('stepsPort').textContent = app.port;

    $('serviceInfo').innerHTML = kv([
      ['Version', esc(app.version)],
      ['Runtime', esc(app.runtime)],
      ['Running as', app.managed ? 'Background service (starts at login, restarts on crash)' : 'Terminal session (not the background service)'],
      ['Started', `${esc(new Date(app.startedAt).toLocaleString())} · ${timeAgo(app.startedAt)}`],
      ['Process ID', esc(app.pid)],
    ]);
    $('restartBtn').disabled = !app.managed;
    $('restartDesc').textContent = app.managed
      ? 'Stops every integration and starts the service again (about 5 seconds).'
      : 'Only available when SplycedBoard runs as the background service.';

    const urls = (app.addresses.length ? app.addresses : [location.hostname]).map((ip) => `http://${ip}:${app.port}`);
    $('dashboardUrls').innerHTML = urls.map((u) => `<a class="info-chip" href="${esc(u)}">${esc(u)}</a>`).join('');

    $('folderInfo').innerHTML = kv([
      ['Installed in', `<code>${esc(app.dirs.home)}</code>`],
      ['Settings & pairing', `<code>${esc(app.dirs.data)}</code>`],
      ['Log files', app.dirs.logs ? `<code>${esc(app.dirs.logs)}</code>` : 'Terminal output only'],
    ]);

    $('verboseToggle').checked = settings.verbose;
  }

  function renderProfiles() {
    const withProfile = integrations.filter((i) => i.profile);
    $('profileList').innerHTML = withProfile.length ? withProfile.map((i) => `
      <div class="setting-row">
        <div>
          <div class="setting-name">${esc(i.name)}</div>
          <div class="setting-desc mono">${esc(i.profile)}</div>
        </div>
        <a class="btn btn-ghost btn-sm" href="/api/hub/integrations/${esc(i.id)}/profile" download>⬇ Download</a>
      </div>`).join('') : '<div class="setting-desc">No integration ships a Savant profile.</div>';
  }

  function initSettings() {
    $('verboseToggle').addEventListener('change', async (e) => {
      try {
        settings = await api('PUT', '/api/hub/settings', { verbose: e.target.checked });
        toast(`Verbose logging ${settings.verbose ? 'on' : 'off'}`);
      } catch (err) {
        e.target.checked = !e.target.checked;
        toast(err.message, 'error');
      }
    });

    $('restartBtn').addEventListener('click', async () => {
      if (!confirm('Restart SplycedBoard?\n\nEvery integration stops for a few seconds.')) return;
      try {
        await api('POST', '/api/hub/restart');
        toast('Restarting…');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────

  async function refreshHub() {
    const snapshot = await api('GET', '/api/hub');
    app = snapshot.app;
    settings = snapshot.settings;
    renderSettings();
    return snapshot;
  }

  async function boot() {
    $('menuBtn').addEventListener('click', () => setMenuOpen(!$('sidebar').classList.contains('open')));
    initLogs();
    initSettings();

    let snapshot;
    for (;;) {
      try {
        snapshot = await refreshHub();
        break;
      } catch (err) {
        $('integrationCards').innerHTML = `<div class="alert alert-error show">Could not reach SplycedBoard: ${esc(err.message)} — retrying…</div>`;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    for (const i of snapshot.integrations) await loadPanel(i);
    setIntegrations(snapshot.integrations);

    window.addEventListener('hashchange', showPage);
    showPage();
    loadLogs().catch(() => {});
    connectWs();
  }

  document.addEventListener('DOMContentLoaded', boot);

  return { registerPanel, setEnabled, restartIntegration, esc, api, toast };
})();
