/**
 * The TV tools' dashboard pages (Tools → Samsung TV, LG TV, Sony TV): scanning, the list of
 * TVs with each one's key, the TVs in Blueprint's configuration, and a remote.
 *
 * A tool's ui/panel.html holds its own words (heading, how-to) and these placeholders:
 *   <div data-tv="toolbar"></div> <div data-tv="scan"></div> <div data-tv="list"></div>
 * and its ui/panel.js calls:
 *   SBTv.mount('<id>', { brand, keyLabel, keyHint, pairLabel, … })
 *
 * The remote takes the keyboard: arrows move, Space or Enter is OK, Backspace is Back,
 * + and − are volume, M is Menu, H is Home, Esc closes it.
 */
const SBTv = (() => {
  const COMMAND_LABELS = {
    power_on: 'On', power_off: 'Off', power_toggle: 'Power',
    input: 'Input', home: 'Home', menu: 'Menu', options: 'Options',
    up: '▲', down: '▼', left: '◀', right: '▶', ok: 'OK',
    back: '‹ Back', exit: 'Exit', info: 'Info', guide: 'Guide',
    vol_up: 'Vol +', vol_down: 'Vol −', mute_toggle: 'Mute', mute_on: 'Mute on', mute_off: 'Mute off',
    ch_up: 'Ch +', ch_down: 'Ch −', dash: '–',
    rewind: '◀◀', play: '▶', pause: '❚❚', stop: '■', ff: '▶▶',
    red: '', green: '', yellow: '', blue: '', cc: 'CC',
    hdmi1: 'HDMI 1', hdmi2: 'HDMI 2', hdmi3: 'HDMI 3', hdmi4: 'HDMI 4', tv: 'TV',
    num1: '1', num2: '2', num3: '3', num4: '4', num5: '5', num6: '6', num7: '7', num8: '8', num9: '9', num0: '0',
  };
  const KEYBOARD = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    ' ': 'ok', Enter: 'ok', Backspace: 'back',
    '+': 'vol_up', '=': 'vol_up', '-': 'vol_down', _: 'vol_down',
    m: 'menu', M: 'menu', h: 'home', H: 'home',
  };
  const POWER_TEXT = { on: 'On', standby: 'Standby', unreachable: 'Not answering', unknown: 'Unknown' };
  const POWER_DOT = { on: 'ok', standby: 'idle', unreachable: 'error', unknown: 'idle' };

  /** Copies text, also where the dashboard isn't a secure context (plain http on the LAN). */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall back below */ }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }

  function mount(id, options) {
    const opts = {
      brand: id,
      keyLabel: 'Key',
      keyHint: '',
      keyPlaceholder: '',
      pairLabel: null, // e.g. 'Request token': the TV hands out its key
      ...options,
    };
    const s = {
      ctx: null,
      root: null,
      tvs: [],
      blueprint: { found: false, withoutAddress: [] },
      scan: null,
      drafts: {},
      remote: { tv: null, state: null, timer: null, queue: Promise.resolve(), last: 0 },
      loaded: false,
    };
    const esc = (v) => s.ctx.esc(v);
    const pairLabel = (tv) => (typeof opts.pairLabel === 'function' ? opts.pairLabel(tv) : opts.pairLabel);
    const q = (sel) => s.root.querySelector(sel);
    const byId = (tvId) => s.tvs.find((t) => t.id === tvId);

    // ── Rendering ────────────────────────────────────────────────────────────

    function renderToolbar() {
      const bp = s.blueprint;
      const inBlueprint = s.tvs.filter((t) => t.blueprint).length;
      let chip;
      if (!bp.found) chip = '<span class="info-chip" title="Savant\'s running configuration wasn\'t found on this host">No Blueprint configuration here</span>';
      else chip = `<span class="info-chip">Blueprint: <strong>${inBlueprint}</strong>&nbsp;${esc(opts.brand)} TV${inBlueprint === 1 ? '' : 's'}</span>`;
      const scanning = s.scan?.state === 'running';
      q('[data-tv="toolbar"]').innerHTML = `
        <div class="tv-toolbar">
          <button class="btn btn-primary btn-sm" data-act="scan" ${scanning ? 'disabled' : ''}>${scanning ? 'Scanning…' : 'Scan the network'}</button>
          <button class="btn btn-secondary btn-sm" data-act="add">Add by IP</button>
          <button class="btn btn-ghost btn-sm" data-act="refresh-all" title="Ask every TV in the list whether it's on and whether its key works, and read Blueprint's configuration again">Check all</button>
          <span class="tv-toolbar-chip">${chip}</span>
        </div>
        ${bp.withoutAddress?.length ? `<div class="note tv-note">In Blueprint without an IP address, so Savant controls them by IR or RS-232: ${bp.withoutAddress.map((c) => `<strong>${esc(c.component)}</strong>${c.zone ? ` (${esc(c.zone)})` : ''}`).join(', ')}.</div>` : ''}`;
    }

    function foundRow(f) {
      const facts = [f.model, f.year, f.address, f.mac].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('');
      return `
        <div class="tv-found">
          <div>
            <div class="tv-found-name">${esc(f.name || f.model || `${opts.brand} TV`)}</div>
            <div class="tv-facts">${facts}</div>
          </div>
          ${f.known
            ? '<span class="info-chip">In the list</span>'
            : `<button class="btn btn-primary btn-sm" data-act="add-found" data-address="${esc(f.address)}" data-name="${esc(f.name || '')}">Add</button>`}
        </div>`;
    }

    function renderScan() {
      const el = q('[data-tv="scan"]');
      const job = s.scan;
      if (!job) {
        el.innerHTML = '';
        return;
      }
      const running = job.state === 'running';
      el.innerHTML = `
        <div class="card tv-scan">
          <div class="tv-scan-head">
            <div class="card-title">Found on the network</div>
            ${running ? '' : '<button class="btn btn-ghost btn-sm" data-act="scan-close">Close</button>'}
          </div>
          <div class="tv-scan-status">${running ? '<div class="spinner"></div>' : ''}<span>${esc(job.message)}</span></div>
          ${job.problem ? `<div class="alert alert-error show">${esc(job.problem)}</div>` : ''}
          ${job.hint ? `<div class="alert alert-info show">${esc(job.hint)}</div>` : ''}
          ${(job.found || []).map(foundRow).join('')}
        </div>`;
    }

    function keyRow(tv) {
      const draft = s.drafts[tv.id];
      const value = draft ?? tv.key ?? '';
      const changed = draft !== undefined && draft !== (tv.key ?? '');
      const pairing = tv.pairing;
      let status = '';
      if (pairing) status = `<div class="tv-pairing"><div class="spinner"></div><span>${esc(pairing.message)}</span></div>`;
      else if (tv.keyCheck?.ok === true && !changed) status = `<span class="tv-key-ok" title="Checked ${esc(new Date(tv.keyCheck.at).toLocaleString())}">✓ The TV takes it</span>`;
      else if (tv.keyCheck?.ok === null && tv.keyCheck.message && !changed) status = `<span class="tv-key-unknown">${esc(tv.keyCheck.message)}</span>`;
      const smartView = tv.extra?.smartViewToken
        ? `<div class="tv-key tv-key-secondary">
            <label>Smart View token <span class="tv-muted">(SplycedBoard's remote, not for Savant)</span></label>
            <div class="tv-key-row">
              <input type="text" readonly value="${esc(tv.extra.smartViewToken)}" class="mono">
              <button class="btn btn-ghost btn-sm" data-act="copy" data-text="${esc(tv.extra.smartViewToken)}">Copy</button>
            </div>
          </div>` : '';
      return `
        <div class="tv-key">
          <label for="${esc(id)}Key-${esc(tv.id)}">${esc(opts.keyLabel)}${opts.keyHint ? ` <span class="tv-muted">${esc(opts.keyHint)}</span>` : ''}</label>
          <div class="tv-key-row">
            <input type="text" id="${esc(id)}Key-${esc(tv.id)}" class="mono" data-key-input="${esc(tv.id)}" value="${esc(value)}"
              placeholder="${esc(opts.keyPlaceholder || `No ${opts.keyLabel} yet`)}" autocomplete="off" spellcheck="false">
            <button class="btn btn-ghost btn-sm" data-act="copy-key" data-id="${esc(tv.id)}" ${value ? '' : 'disabled'}>Copy</button>
            <button class="btn ${changed ? 'btn-primary' : 'btn-secondary'} btn-sm" data-act="save-key" data-id="${esc(tv.id)}" ${changed ? '' : 'disabled'}>Save &amp; test</button>
            ${pairLabel(tv) ? `<button class="btn btn-primary btn-sm" data-act="pair" data-id="${esc(tv.id)}" ${pairing ? 'disabled' : ''}>${esc(pairLabel(tv))}</button>` : ''}
          </div>
          ${status}
        </div>
        ${smartView}`;
    }

    function tvCard(tv) {
      const power = tv.power || null;
      const dot = POWER_DOT[power] || 'off';
      const facts = [
        tv.model ? `<span>${esc(tv.model)}</span>` : '',
        tv.year ? `<span>${esc(tv.year)}</span>` : '',
        opts.describe ? `<span>${esc(opts.describe(tv))}</span>` : '',
      ].filter(Boolean).join('');
      const bp = tv.blueprint;
      const copyable = (label, value) => (value
        ? `<span class="tv-copy">${label} <code>${esc(value)}</code><button class="tv-copy-btn" data-act="copy" data-text="${esc(value)}" title="Copy" aria-label="Copy ${label}">⧉</button></span>`
        : `<span class="tv-copy tv-muted">${label} unknown</span>`);
      const canRemote = (tv.commands || []).length > 0;
      return `
        <div class="card tv-card${tv.warnings.length ? ' has-warning' : ''}" data-tv-id="${esc(tv.id)}">
          <div class="tv-card-head">
            <div>
              <div class="tv-name"><span class="status-dot ${dot}" title="${esc(POWER_TEXT[power] || 'Not checked yet')}"></span>${esc(tv.name)}</div>
              ${facts ? `<div class="tv-facts">${facts}</div>` : ''}
            </div>
            ${bp ? `<span class="tv-blueprint" title="In the configuration Savant runs">Blueprint · ${esc(bp.component)}${bp.zone ? ` · ${esc(bp.zone)}` : ''}</span>` : ''}
          </div>
          <div class="tv-addresses">${copyable('IP', tv.address)}${copyable('MAC', tv.mac)}</div>
          ${keyRow(tv)}
          ${tv.warnings.map((w) => `<div class="alert alert-warn show tv-warning">⚠ ${esc(w)}</div>`).join('')}
          <div class="btn-row tv-actions">
            <button class="btn btn-primary btn-sm" data-act="remote" data-id="${esc(tv.id)}" ${canRemote ? '' : `disabled title="${esc(pairLabel(tv) ? `${pairLabel(tv)} first` : 'Nothing to control yet')}"`}>Remote</button>
            <button class="btn btn-ghost btn-sm" data-act="refresh" data-id="${esc(tv.id)}">Check</button>
            ${tv.mac ? `<button class="btn btn-ghost btn-sm" data-act="wake" data-id="${esc(tv.id)}" title="Wake-on-LAN to ${esc(tv.mac)}">Wake</button>` : ''}
            <button class="btn btn-ghost btn-sm" data-act="rename" data-id="${esc(tv.id)}">Rename</button>
            <button class="btn btn-ghost btn-sm" data-act="mac" data-id="${esc(tv.id)}">${tv.mac ? 'Change MAC' : 'Set MAC'}</button>
            ${bp ? '' : `<button class="btn btn-danger btn-sm" data-act="remove" data-id="${esc(tv.id)}">Remove</button>`}
          </div>
        </div>`;
    }

    function renderList() {
      const el = q('[data-tv="list"]');
      // Keep whatever is being typed in a key field.
      const active = document.activeElement;
      const focusId = s.root.contains(active) ? active.dataset.keyInput : null;
      const selection = focusId ? [active.selectionStart, active.selectionEnd] : null;
      el.innerHTML = s.tvs.length
        ? s.tvs.map(tvCard).join('')
        : `<div class="card"><div class="empty-state">
            <div class="empty-icon">📺</div>
            <div class="empty-title">No ${esc(opts.brand)} TVs yet</div>
            <div class="empty-desc">Scan the network, or add one by its IP address. TVs in Blueprint's configuration on this host show up here by themselves.</div>
          </div></div>`;
      if (focusId) {
        const input = el.querySelector(`[data-key-input="${CSS.escape(focusId)}"]`);
        if (input) {
          input.focus();
          try { input.setSelectionRange(...selection); } catch { /* not a text field */ }
        }
      }
    }

    function render() {
      renderToolbar();
      renderScan();
      renderList();
      if (s.remote.tv) renderRemoteTitle();
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    function apply(snapshot) {
      s.tvs = snapshot.tvs || [];
      s.blueprint = snapshot.blueprint || s.blueprint;
      for (const tvId of Object.keys(s.drafts)) {
        const tv = byId(tvId);
        if (!tv || s.drafts[tvId] === (tv.key ?? '')) delete s.drafts[tvId];
      }
      if (s.remote.tv) s.remote.tv = byId(s.remote.tv.id) || s.remote.tv;
      render();
    }

    async function load() {
      try {
        apply(await s.ctx.api('GET', '/tvs'));
        if (!s.loaded) {
          s.loaded = true;
          // Once per page load: is each TV on, and does its key work?
          s.ctx.api('POST', '/refresh').then(apply).catch(() => {});
        }
      } catch (err) {
        q('[data-tv="list"]').innerHTML = `<div class="alert alert-error show">${esc(err.message)}</div>`;
      }
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    async function run(fn, done) {
      try {
        const result = await fn();
        if (done) s.ctx.toast(typeof done === 'function' ? done(result) : done);
        return result;
      } catch (err) {
        s.ctx.toast(err.message, 'error');
        return null;
      }
    }

    async function startScan() {
      const job = await run(() => s.ctx.api('POST', '/scan'));
      if (!job) return;
      s.scan = job;
      render();
      // The WebSocket brings progress; this catches the end if it's missed.
      const poll = async () => {
        if (!s.scan || s.scan.id !== job.id || s.scan.state !== 'running') return;
        try {
          s.scan = await s.ctx.api('GET', `/jobs/${job.id}`);
          render();
        } catch { /* try again */ }
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 1500);
    }

    async function addTv(address, name) {
      const tv = await run(() => s.ctx.api('POST', '/tvs', { address, name }), (t) => `Added ${t.name}`);
      if (tv) {
        if (s.scan?.found) for (const f of s.scan.found) if (f.address === address) f.known = tv.id;
        await load();
      }
      return tv;
    }

    function openAdd() {
      const modal = q('[data-tv="add-modal"]');
      modal.classList.add('open');
      modal.querySelector('[name="address"]').value = '';
      modal.querySelector('[name="name"]').value = '';
      modal.querySelector('.alert').className = 'alert';
      setTimeout(() => modal.querySelector('[name="address"]').focus(), 50);
    }

    async function submitAdd() {
      const modal = q('[data-tv="add-modal"]');
      const address = modal.querySelector('[name="address"]').value.trim();
      const name = modal.querySelector('[name="name"]').value.trim();
      const alert = modal.querySelector('.alert');
      const button = modal.querySelector('[data-act="add-submit"]');
      button.disabled = true;
      button.textContent = 'Checking the TV…';
      try {
        const tv = await s.ctx.api('POST', '/tvs', { address, name });
        modal.classList.remove('open');
        s.ctx.toast(`Added ${tv.name}`);
        await load();
      } catch (err) {
        alert.className = 'alert alert-error show';
        alert.textContent = err.message;
      } finally {
        button.disabled = false;
        button.textContent = 'Add';
      }
    }

    async function saveKey(tvId) {
      const tv = byId(tvId);
      const key = s.drafts[tvId] ?? tv?.key ?? '';
      const updated = await run(() => s.ctx.api('PUT', `/tvs/${tvId}`, { key }));
      if (!updated) return;
      delete s.drafts[tvId];
      const i = s.tvs.findIndex((t) => t.id === tvId);
      if (i >= 0) s.tvs[i] = updated;
      render();
      if (updated.keyCheck?.ok === true) s.ctx.toast(`${updated.name} takes the ${opts.keyLabel}`);
      else if (updated.keyCheck?.ok === false) s.ctx.toast(updated.keyCheck.message, 'error');
      else s.ctx.toast(`${opts.keyLabel} saved`);
    }

    async function pair(tvId) {
      const job = await run(() => s.ctx.api('POST', `/tvs/${tvId}/pair`));
      if (!job) return;
      const tv = byId(tvId);
      if (tv) tv.pairing = job;
      render();
      const poll = async () => {
        let current;
        try { current = await s.ctx.api('GET', `/jobs/${job.id}`); } catch { return; }
        if (current.state === 'running') {
          setTimeout(poll, 1500);
          return;
        }
        finishPairing(current);
      };
      setTimeout(poll, 1500);
    }

    const finished = new Set();
    function finishPairing(job) {
      if (finished.has(job.id)) return;
      finished.add(job.id);
      if (job.state === 'done') s.ctx.toast(job.message);
      else s.ctx.toast(job.message, 'error');
      load();
    }

    async function rename(tvId) {
      const tv = byId(tvId);
      const name = prompt('Name for this TV', tv?.name || '');
      if (name === null || !name.trim()) return;
      await run(() => s.ctx.api('PUT', `/tvs/${tvId}`, { name }), 'Renamed');
      load();
    }

    async function setMac(tvId) {
      const tv = byId(tvId);
      const mac = prompt('The TV\'s MAC address (for switching it on over the network)', tv?.mac || '');
      if (mac === null) return;
      await run(() => s.ctx.api('PUT', `/tvs/${tvId}`, { mac }), 'MAC address saved');
      load();
    }

    async function remove(tvId) {
      const tv = byId(tvId);
      if (!confirm(`Remove ${tv?.name || 'this TV'} from the list?`)) return;
      await run(() => s.ctx.api('DELETE', `/tvs/${tvId}`), 'Removed');
      if (s.remote.tv?.id === tvId) closeRemote();
      load();
    }

    // ── Remote ───────────────────────────────────────────────────────────────

    function renderRemoteTitle() {
      const r = s.remote;
      const modal = q('[data-tv="remote-modal"]');
      modal.querySelector('.modal-title').textContent = r.tv.name;
      const st = r.state || {};
      const bits = [r.tv.address, POWER_TEXT[st.power] || 'Checking…'];
      if (st.volume != null) bits.push(`Volume ${st.volume}`);
      if (st.mute) bits.push('Muted');
      if (st.source) bits.push(st.source);
      modal.querySelector('.modal-subtitle').textContent = bits.join(' · ');
      const slider = modal.querySelector('[data-volume]');
      if (slider && st.volume != null && document.activeElement !== slider) slider.value = st.volume;
    }

    function remoteButton(cmd, cls = 'btn btn-ghost btn-sm', label = COMMAND_LABELS[cmd]) {
      if (!s.remote.tv.commands.includes(cmd)) return '';
      return `<button class="${cls}" data-cmd="${esc(cmd)}" aria-label="${esc(cmd.replace(/_/g, ' '))}">${esc(label)}</button>`;
    }

    function renderRemote() {
      const has = (cmd) => s.remote.tv.commands.includes(cmd);
      const b = remoteButton;
      // A row of command ids ('home') and ready-made buttons (b(…) HTML)
      const row = (...items) => {
        const html = items.map((c) => (/^[a-z0-9_]+$/.test(c) ? b(c) : c)).join('');
        return html ? `<div class="tv-remote-row">${html}</div>` : '';
      };
      const numbers = ['num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9', 'dash', 'num0', 'guide'];
      const colors = ['red', 'green', 'yellow', 'blue'].map((c) => b(c, `tv-color tv-color-${c}`, '')).join('');
      const onlyPower = s.remote.tv.commands.every((c) => c === 'power_on');
      const label = pairLabel(s.remote.tv);
      q('[data-tv="remote-body"]').innerHTML = `
        ${onlyPower ? `<div class="note tv-note">Only switching on works until SplycedBoard is paired with this TV${label ? `: close this and pick <strong>${esc(label)}</strong>` : ''}.</div>` : ''}
        ${row(b('power_on', 'btn btn-primary btn-sm', '⏻ On'), b('power_off', 'btn btn-secondary btn-sm', '⏻ Off'), b('power_toggle', 'btn btn-ghost btn-sm', '⏻ Toggle'))}
        ${row('input', 'home', 'menu', 'options')}
        ${['up', 'down', 'left', 'right', 'ok'].some(has) ? `<div class="tv-dpad">
          ${b('up', 'tv-key tv-up')}${b('left', 'tv-key tv-left')}${b('ok', 'tv-key tv-ok')}${b('right', 'tv-key tv-right')}${b('down', 'tv-key tv-down')}
        </div>` : ''}
        ${row(b('back', 'btn btn-secondary btn-sm'), 'exit', 'info', has('guide') && !has('num1') ? 'guide' : '')}
        ${['vol_up', 'vol_down', 'mute_toggle', 'ch_up', 'ch_down'].some(has) ? `<div class="tv-remote-row tv-remote-rockers">
          <div class="tv-rocker">${b('vol_up')}${b('mute_toggle')}${b('vol_down')}</div>
          <div class="tv-rocker">${b('ch_up')}${b('ch_down')}</div>
        </div>` : ''}
        ${has('set_volume') ? `<label class="tv-volume">Volume <input type="range" min="0" max="100" step="1" data-volume></label>` : ''}
        ${row('rewind', 'play', 'pause', 'stop', 'ff')}
        ${numbers.some(has) ? `<details class="tv-numbers"><summary>Numbers</summary><div class="tv-numpad">${numbers.map((c) => b(c, 'tv-key tv-num')).join('')}</div></details>` : ''}
        ${colors || has('cc') ? `<div class="tv-remote-row">${colors}${b('cc')}</div>` : ''}
        ${row('hdmi1', 'hdmi2', 'hdmi3', 'hdmi4', 'tv')}
        <div class="tv-keyboard-hint">Keyboard: arrows move · Space or Enter is OK · Backspace is Back · + − volume · M menu · H home · Esc closes</div>`;
    }

    async function refreshRemoteState() {
      const r = s.remote;
      if (!r.tv) return;
      const tvId = r.tv.id;
      try {
        const st = await s.ctx.api('GET', `/tvs/${tvId}/state`);
        if (r.tv?.id !== tvId) return;
        r.state = st;
        renderRemoteTitle();
      } catch { /* shown on the next try */ }
    }

    function openRemote(tvId) {
      const tv = byId(tvId);
      if (!tv) return;
      s.remote.tv = tv;
      s.remote.state = null;
      renderRemote();
      renderRemoteTitle();
      q('[data-tv="remote-modal"]').classList.add('open');
      refreshRemoteState();
      clearInterval(s.remote.timer);
      s.remote.timer = setInterval(refreshRemoteState, 5000);
    }

    function closeRemote() {
      clearInterval(s.remote.timer);
      s.remote.timer = null;
      s.remote.tv = null;
      q('[data-tv="remote-modal"]').classList.remove('open');
    }

    /** One command at a time, in order: a remote shouldn't reorder presses. */
    function send(cmd, value) {
      const r = s.remote;
      if (!r.tv) return;
      const tvId = r.tv.id;
      const button = q(`[data-tv="remote-body"] [data-cmd="${CSS.escape(cmd)}"]`);
      if (button) {
        button.classList.add('is-pressed');
        setTimeout(() => button.classList.remove('is-pressed'), 160);
      }
      r.queue = r.queue.then(async () => {
        try {
          await s.ctx.api('POST', `/tvs/${tvId}/command`, { command: cmd, value });
          if (/^(power|vol|mute|set_volume)/.test(cmd)) setTimeout(refreshRemoteState, 600);
        } catch (err) {
          s.ctx.toast(err.message, 'error');
        }
      });
    }

    function onKey(e) {
      if (!s.remote.tv || !q('[data-tv="remote-modal"]').classList.contains('open')) return;
      // Only while this tool's page is the one showing.
      if (!s.root.closest('.page')?.classList.contains('active')) return;
      if (e.key === 'Escape') {
        closeRemote();
        return;
      }
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const cmd = KEYBOARD[e.key];
      if (!cmd || !s.remote.tv.commands.includes(cmd)) return;
      e.preventDefault();
      // Held keys repeat; a TV can't take 30 presses a second.
      const now = Date.now();
      if (e.repeat && now - s.remote.last < 180) return;
      s.remote.last = now;
      send(cmd);
    }

    // ── Wiring ───────────────────────────────────────────────────────────────

    function onClick(e) {
      const el = e.target.closest('[data-act], [data-cmd]');
      if (!el || !s.root.contains(el)) return;
      if (el.dataset.cmd) {
        send(el.dataset.cmd);
        el.blur(); // so Space and Enter work the remote, not this button
        return;
      }
      const tvId = el.dataset.id;
      switch (el.dataset.act) {
        case 'scan': startScan(); break;
        case 'scan-close': s.scan = null; render(); break;
        case 'add': openAdd(); break;
        case 'add-submit': submitAdd(); break;
        case 'add-close': q('[data-tv="add-modal"]').classList.remove('open'); break;
        case 'add-found': el.disabled = true; addTv(el.dataset.address, el.dataset.name).then(() => { el.disabled = false; }); break;
        case 'refresh-all':
          el.disabled = true;
          run(() => s.ctx.api('POST', '/refresh'), 'Checked every TV').then((snap) => { if (snap) apply(snap); el.disabled = false; });
          break;
        case 'refresh':
          el.disabled = true;
          run(() => s.ctx.api('POST', `/tvs/${tvId}/refresh`)).then(() => load());
          break;
        case 'wake': run(() => s.ctx.api('POST', `/tvs/${tvId}/wake`), 'Wake-on-LAN sent'); break;
        case 'copy': copyText(el.dataset.text).then((ok) => s.ctx.toast(ok ? 'Copied' : 'Couldn\'t copy: select it and copy by hand', ok ? 'ok' : 'error')); break;
        case 'copy-key': {
          const tv = byId(tvId);
          const text = s.drafts[tvId] ?? tv?.key ?? '';
          copyText(text).then((ok) => s.ctx.toast(ok ? `${opts.keyLabel} copied` : 'Couldn\'t copy: select it and copy by hand', ok ? 'ok' : 'error'));
          break;
        }
        case 'save-key': saveKey(tvId); break;
        case 'pair': pair(tvId); break;
        case 'rename': rename(tvId); break;
        case 'mac': setMac(tvId); break;
        case 'remove': remove(tvId); break;
        case 'remote': openRemote(tvId); break;
        case 'remote-close': closeRemote(); break;
        default: break;
      }
    }

    function onInput(e) {
      const tvId = e.target.dataset?.keyInput;
      if (tvId) {
        s.drafts[tvId] = e.target.value.trim();
        const tv = byId(tvId);
        const changed = s.drafts[tvId] !== (tv?.key ?? '');
        const card = e.target.closest('.tv-key');
        const save = card?.querySelector('[data-act="save-key"]');
        if (save) {
          save.disabled = !changed;
          save.className = `btn ${changed ? 'btn-primary' : 'btn-secondary'} btn-sm`;
        }
        const copy = card?.querySelector('[data-act="copy-key"]');
        if (copy) copy.disabled = !s.drafts[tvId];
      }
    }

    function scaffold() {
      const extra = document.createElement('div');
      extra.innerHTML = `
        <div class="modal-overlay" data-tv="add-modal">
          <div class="modal" role="dialog" aria-modal="true">
            <div class="modal-header">
              <div class="modal-titles"><div class="modal-title">Add a ${esc(opts.brand)} TV</div>
                <div class="modal-subtitle">By its IP address. It can be off; SplycedBoard checks it when it answers.</div></div>
              <button class="modal-close" data-act="add-close" aria-label="Close">✕</button>
            </div>
            <div class="form-group"><label>IP address</label><input type="text" name="address" placeholder="192.168.1.50" autocomplete="off"></div>
            <div class="form-group"><label>Name <span class="tv-muted">(optional)</span></label><input type="text" name="name" placeholder="Living Room TV" autocomplete="off"></div>
            <div class="alert"></div>
            <div class="btn-row"><button class="btn btn-primary" data-act="add-submit">Add</button><button class="btn btn-ghost" data-act="add-close">Cancel</button></div>
          </div>
        </div>
        <div class="modal-overlay" data-tv="remote-modal">
          <div class="modal tv-remote-modal" role="dialog" aria-modal="true">
            <div class="modal-header">
              <div class="modal-titles"><div class="modal-title">Remote</div><div class="modal-subtitle"></div></div>
              <button class="modal-close" data-act="remote-close" aria-label="Close">✕</button>
            </div>
            <div class="tv-remote" data-tv="remote-body"></div>
          </div>
        </div>`;
      s.root.append(...extra.children);
      for (const sel of ['[data-tv="add-modal"]', '[data-tv="remote-modal"]']) {
        const overlay = q(sel);
        overlay.addEventListener('click', (e) => {
          if (e.target !== overlay) return;
          if (sel.includes('remote')) closeRemote();
          else overlay.classList.remove('open');
        });
      }
      q('[data-tv="add-modal"]').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAdd(); });
      s.root.addEventListener('click', onClick);
      s.root.addEventListener('input', onInput);
      s.root.addEventListener('change', (e) => {
        if (e.target.matches('[data-volume]')) send('set_volume', Number(e.target.value));
      });
      s.root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.dataset?.keyInput) {
          e.preventDefault();
          saveKey(e.target.dataset.keyInput);
        }
      });
      document.addEventListener('keydown', onKey);
      document.addEventListener('keyup', (e) => {
        // A focused button would also "click" on Space's keyup.
        if (s.remote.tv && e.key === ' ' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) e.preventDefault();
      });
    }

    SB.registerPanel(id, {
      init(context) {
        s.ctx = context;
        s.root = context.root;
        scaffold();
        render();
      },
      onStateChange(integration) {
        if (integration.running) load();
      },
      onMessage(msg) {
        if (msg.type === 'tvs') apply(msg);
        else if (msg.type === 'job') {
          const job = msg.job;
          if (job.kind === 'scan' && s.scan?.id === job.id) {
            s.scan = job;
            renderToolbar();
            renderScan();
          } else if (job.kind === 'pair') {
            const tv = byId(job.tvId);
            if (tv) {
              tv.pairing = job.state === 'running' ? job : null;
              renderList();
            }
            if (job.state !== 'running') finishPairing(job);
          }
        }
      },
    });
  }

  return { mount, copyText };
})();
