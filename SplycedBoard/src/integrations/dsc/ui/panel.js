/**
 * DSC PowerSeries Pro dashboard panel: partitions (arm/disarm), zones, the ITv2 session and its
 * settings, and a live message log. Inline handlers in panel.html call window.Dsc.*.
 */
(() => {
  let ctx = null;
  let running = false;
  let state = { status: {}, settings: {}, panel: { info: {}, partitions: [], zones: [] } };
  let log = [];
  const MAX_LOG = 1000;
  const codes = {}; // partition → the user code typed in, kept while the page is open
  const $ = (id) => document.getElementById(id);
  const esc = (s) => ctx.esc(s);

  // ── Status ───────────────────────────────────────────────────────────────

  function renderStatus() {
    const s = state.status || {};
    const level = !running ? 'off' : s.level || 'idle';
    $('dscStatusDot').className = `status-dot ${level}`;
    $('dscStatusText').textContent = running ? s.text || '…' : 'Switched off';

    const info = state.panel.info || {};
    const rows = [
      ['State', s.text || '—'],
      ['Panel address', s.peer || '—'],
      ['Panel integration ID', s.panelId || '—'],
      ['Connected since', s.since ? new Date(s.since).toLocaleString() : '—'],
      ['Last message', s.lastMessageAt ? new Date(s.lastMessageAt).toLocaleTimeString() : '—'],
      ['Encryption', s.encryption || '—'],
      ['Panel software', info.softwareVersion || '—'],
      ['Capacity', info.maxZones ? `${info.maxZones} zones · ${info.maxPartitions} partitions · ${info.maxUsers} users` : '—'],
    ];
    if (s.error) rows.push(['Last error', s.error]);
    $('dscSession').innerHTML = rows.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join('');
  }

  // ── Partitions ───────────────────────────────────────────────────────────

  const ARM_CLASS = { disarmed: 'ok', stay: 'warn', away: 'error', night: 'warn', armed: 'error', unknown: 'idle' };

  function partitionFacts(p) {
    const facts = [];
    if (p.exitDelaySeconds != null) facts.push(`Exit delay: ${p.exitDelaySeconds}s`);
    if (p.entryDelay) facts.push(`Entry delay (${p.entryDelay})`);
    if (p.bell) facts.push('🔔 Siren');
    if (p.alarmMemory) facts.push('Alarm in memory');
    if (p.trouble) facts.push('Trouble');
    if (p.lastChange) {
      const who = p.lastChange.user != null ? `user ${p.lastChange.user}` : p.lastChange.by;
      facts.push(`Last change: ${who}, ${new Date(p.lastChange.at).toLocaleTimeString()}`);
    }
    return facts;
  }

  function renderPartitions() {
    const el = $('dscPartitions');
    const parts = state.panel.partitions || [];
    if (!parts.length) {
      el.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">🛡️</div>
        <div class="empty-title">${state.status.connected ? 'Waiting for the panel…' : 'No panel connected'}</div>
        <div class="empty-desc">${state.status.connected
          ? 'Connected; partitions appear once the panel reports them.'
          : 'Set the connection up on the Connection tab.'}</div>
      </div>`;
      return;
    }
    // Keep focus and what's typed in a code box while the cards redraw.
    const focused = document.activeElement?.dataset?.dscCode;
    el.innerHTML = parts.map((p) => {
      const ready = p.ready === true ? 'ok' : p.ready === false ? 'warn' : 'idle';
      return `
        <div class="dsc-partition">
          <div class="dsc-partition-head">
            <div style="min-width:0">
              <div class="dsc-partition-name">${esc(p.label || `Partition ${p.number}`)}</div>
              <div class="dsc-meta">Partition ${p.number}</div>
            </div>
            <span class="dsc-badge ${ARM_CLASS[p.arming] || 'idle'}">${esc(p.armingText)}</span>
          </div>
          <div class="dsc-ready ${ready}">${esc(p.readyText)}</div>
          <div class="dsc-facts">${partitionFacts(p).map((f) => `<span>${esc(f)}</span>`).join('')}</div>
          <div class="dsc-arm">
            <input type="password" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="User code"
              data-dsc-code="${p.number}" value="${esc(codes[p.number] || '')}"
              oninput="Dsc.code(${p.number}, this.value)" onkeydown="if (event.key === 'Enter') Dsc.disarm(${p.number})">
            <div class="dsc-arm-buttons">
              <button class="btn btn-secondary btn-sm" onclick="Dsc.arm(${p.number}, 'away')">Away</button>
              <button class="btn btn-secondary btn-sm" onclick="Dsc.arm(${p.number}, 'stay')">Stay</button>
              <button class="btn btn-secondary btn-sm" onclick="Dsc.arm(${p.number}, 'night')">Night</button>
              <button class="btn btn-primary btn-sm" onclick="Dsc.disarm(${p.number})">Disarm</button>
            </div>
          </div>
        </div>`;
    }).join('');
    if (focused) el.querySelector(`[data-dsc-code="${focused}"]`)?.focus();
  }

  // ── Zones ────────────────────────────────────────────────────────────────

  function renderZones() {
    const el = $('dscZones');
    const onlyActive = $('dscOpenOnly').checked;
    const zones = (state.panel.zones || []).filter((z) => !onlyActive || z.open || z.alarm);
    if (!zones.length) {
      el.innerHTML = `<div class="dsc-empty">${onlyActive ? 'No zone is open or in alarm.' : 'No zones reported yet.'}</div>`;
      return;
    }
    el.innerHTML = `<table class="dsc-table">
      <thead><tr><th>Zone</th><th>Name</th><th>Status</th><th>Alarm</th><th>Changed</th></tr></thead>
      <tbody>${zones.map((z) => {
        const status = z.open == null ? '<span class="dsc-muted">Unknown</span>'
          : z.open ? '<span class="dsc-open">Open</span>' : '<span class="dsc-closed">Closed</span>';
        return `<tr>
          <td>${z.number}</td>
          <td>${esc(z.label || '')}</td>
          <td>${status}</td>
          <td>${z.alarm ? `<span class="dsc-alarm">${esc(z.alarmType || 'Alarm')}</span>` : ''}</td>
          <td class="dsc-muted">${z.changedAt ? new Date(z.changedAt).toLocaleTimeString() : ''}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  function renderSettings() {
    const s = state.settings || {};
    $('dscPort').value = s.port || '';
    $('dscPort').placeholder = String(s.defaultPort || '');
    $('dscIntegrationId').value = s.integrationId || '';
    $('dscAccessCode').value = '';
    $('dscAccessCode').placeholder = s.accessCodeSet ? 'Saved (type to replace)' : '';
    $('dscAccessCodeHint').textContent = s.accessCodeHint || '';
  }

  async function saveSettings() {
    const alert = $('dscSettingsAlert');
    const body = {
      port: $('dscPort').value ? Number($('dscPort').value) : null,
      integrationId: $('dscIntegrationId').value.trim(),
    };
    if ($('dscAccessCode').value) body.accessCode = $('dscAccessCode').value.trim();
    try {
      const res = await ctx.api('PUT', '/settings', body);
      state.settings = res.settings;
      renderSettings();
      showAlert(alert, 'success', 'Saved. Waiting for the panel to connect…');
    } catch (err) {
      showAlert(alert, 'error', err.message);
    }
  }

  function showAlert(el, kind, text) {
    el.className = `alert alert-${kind} show`;
    el.textContent = text;
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  async function arm(partition, mode) {
    await command('/arm', { partition, mode, code: codes[partition] || '' }, `Arm ${mode}`);
  }

  async function disarm(partition) {
    await command('/disarm', { partition, code: codes[partition] || '' }, 'Disarm');
  }

  async function command(path, body, what) {
    try {
      const res = await ctx.api('POST', path, body);
      ctx.toast(`${what}: ${res.result || 'sent'}`, 'success');
    } catch (err) {
      ctx.toast(`${what}: ${err.message}`, 'error');
    }
  }

  async function refresh() {
    try {
      await ctx.api('POST', '/refresh');
      ctx.toast('Asked the panel for its status', 'success');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // ── Message log ──────────────────────────────────────────────────────────

  function logLine(m) {
    const time = new Date(m.t).toLocaleTimeString([], { hour12: false }) + '.' + String(m.t % 1000).padStart(3, '0');
    const arrow = { in: '◀', out: '▶', info: '•', error: '✕' }[m.dir] || '•';
    const hex = $('dscShowHex').checked && m.hex ? `<div class="dsc-hex">${esc(m.hex)}</div>` : '';
    return `<div class="dsc-line ${m.dir}"><span class="dsc-time">${time}</span><span class="dsc-arrow">${arrow}</span>`
      + `<span class="dsc-text">${esc(m.text)}</span>${hex}</div>`;
  }

  function visible(m) {
    return $('dscShowPolls').checked || !m.routine;
  }

  function renderLog() {
    const el = $('dscLog');
    const lines = log.filter(visible);
    el.innerHTML = lines.length ? lines.map(logLine).join('') : '<div class="dsc-empty">No messages yet.</div>';
    el.scrollTop = el.scrollHeight;
  }

  function addLog(m) {
    log.push(m);
    if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
    if (!visible(m)) return;
    const el = $('dscLog');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.querySelector('.dsc-empty')?.remove();
    el.insertAdjacentHTML('beforeend', logLine(m));
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  async function copyLog() {
    const text = log.filter(visible).map((m) => `${new Date(m.t).toISOString()} ${m.dir} ${m.text}${m.hex ? `\n    ${m.hex}` : ''}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast('Copied', 'success');
    } catch {
      ctx.toast('Copy failed: select the text instead', 'error');
    }
  }

  async function clearLog() {
    await ctx.api('DELETE', '/messages').catch(() => {});
    log = [];
    renderLog();
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  function renderAll() {
    renderStatus();
    renderPartitions();
    renderZones();
  }

  async function load() {
    try {
      state = await ctx.api('GET', '/state');
      renderAll();
      renderSettings();
      log = (await ctx.api('GET', '/messages')).messages || [];
      renderLog();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // Exit delays count down on screen between updates.
  setInterval(() => {
    if (!running || !(state.panel.partitions || []).some((p) => p.exitDelaySeconds)) return;
    for (const p of state.panel.partitions) if (p.exitDelaySeconds) p.exitDelaySeconds -= 1;
    renderPartitions();
  }, 1000);

  function initTabs(root) {
    root.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        root.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.tab));
      });
    });
  }

  window.Dsc = {
    arm, disarm, refresh, saveSettings, copyLog, clearLog,
    code: (partition, value) => { codes[partition] = value.replace(/\D/g, ''); },
  };

  SB.registerPanel('dsc', {
    init(context) {
      ctx = context;
      initTabs(ctx.root);
      $('dscOpenOnly').addEventListener('change', renderZones);
      $('dscShowPolls').addEventListener('change', renderLog);
      $('dscShowHex').addEventListener('change', renderLog);
    },

    onStateChange(integration) {
      const wasRunning = running;
      running = integration.running;
      if (running && !wasRunning) load();
      renderStatus();
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'status':
          state.status = msg.status;
          renderStatus();
          if (!msg.status.connected) renderPartitions();
          break;
        case 'panel':
          state.panel = msg.panel;
          renderAll();
          break;
        case 'message':
          addLog(msg.message);
          break;
        default:
          break;
      }
    },
  });
})();
