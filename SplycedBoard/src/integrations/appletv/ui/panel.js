/**
 * Apple TV dashboard panel: paired Apple TVs, pairing, and a test remote.
 * Inline handlers in panel.html call window.AppleTv.*.
 */
(() => {
  let ctx = null;
  let devices = [];
  let found = []; // last scan results
  let apps = []; // apps on the Apple TV the remote is open for
  let remoteId = null;
  let pairingIp = null;
  let pairingBusy = false; // a pair/start or pair/finish request is in flight
  const $ = (id) => document.getElementById(id);
  const esc = (s) => ctx.esc(s);

  // ── Device cards ─────────────────────────────────────────────────────────

  function statusLine(d) {
    if (d.connection === 'connected') {
      const parts = ['Connected'];
      if (d.power !== 'unknown') parts.push(d.power === 'on' ? 'On' : 'Asleep');
      if (d.playing) parts.push('Playing');
      return { level: 'ok', text: parts.join(' · ') };
    }
    if (d.connection === 'connecting') return { level: 'warn', text: 'Connecting…' };
    return { level: 'error', text: d.error || 'Not connected' };
  }

  function render() {
    const el = $('atvDevices');
    if (!devices.length) {
      el.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">📺</div>
        <div class="empty-title">No Apple TVs yet</div>
        <div class="empty-desc">Add each Apple TV once — after that Savant controls it by its IP address.</div>
        <button class="btn btn-primary" style="margin-top:16px" onclick="AppleTv.openAdd()">＋ Add Apple TV</button>
      </div>`;
      return;
    }
    el.innerHTML = devices.map((d) => {
      const s = statusLine(d);
      return `
        <div class="atv-card">
          <div class="atv-card-head">
            <div style="min-width:0">
              <div class="atv-name">${esc(d.name)}</div>
              <div class="atv-meta">${esc(d.model || 'Apple TV')}</div>
            </div>
            <span class="status-dot ${s.level}" title="${esc(s.text)}"></span>
          </div>
          <div class="atv-status ${s.level}">${esc(s.text)}</div>
          <div class="atv-savant" title="Set this in Blueprint on the Apple TV (SplycedBoard) component">
            <span>AppleTVAddress</span><code>${esc(d.address)}</code>
          </div>
          <div class="atv-actions">
            <button class="btn btn-secondary btn-sm" onclick="AppleTv.openRemote('${esc(d.id)}')">Remote</button>
            <button class="btn btn-ghost btn-sm" onclick="AppleTv.rename('${esc(d.id)}')">Rename</button>
            <button class="btn btn-ghost btn-sm" onclick="AppleTv.changeIp('${esc(d.id)}')">Change IP</button>
            <button class="btn btn-ghost btn-sm" onclick="AppleTv.remove('${esc(d.id)}')">Remove</button>
          </div>
        </div>`;
    }).join('');
    if (remoteId) updateRemoteTitle();
  }

  async function refresh() {
    try {
      devices = (await ctx.api('GET', '/devices')).devices;
      render();
    } catch { /* switched off — the hub shows a banner */ }
  }

  const byId = (id) => devices.find((d) => d.id === id);

  async function rename(id) {
    const d = byId(id);
    const name = prompt('Name for this Apple TV', d.name);
    if (!name || name === d.name) return;
    try {
      await ctx.api('PATCH', `/devices/${id}`, { name });
      refresh();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function changeIp(id) {
    const d = byId(id);
    const address = prompt(`New IP address for ${d.name}.\n\nRemember to change AppleTVAddress in Blueprint to match.`, d.address);
    if (!address || address === d.address) return;
    try {
      await ctx.api('PATCH', `/devices/${id}`, { address: address.trim() });
      refresh();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function remove(id) {
    const d = byId(id);
    if (!confirm(`Remove ${d.name} (${d.address})?\n\nSavant can no longer control it until it's paired again. `
      + 'You can also remove "SplycedBoard" on the Apple TV under Settings → Remotes and Devices.')) return;
    try {
      await ctx.api('DELETE', `/devices/${id}`);
      ctx.toast(`Removed ${d.name}`);
      refresh();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // ── Add / pair ───────────────────────────────────────────────────────────

  function addAlert(kind, message) {
    const el = $('atvAddAlert');
    el.className = kind ? `alert alert-${kind} show` : 'alert';
    el.textContent = message || '';
  }

  function showStep(step) {
    $('atvStepChoose').hidden = step !== 'choose';
    $('atvStepPin').hidden = step !== 'pin';
  }

  function openAdd() {
    pairingIp = null;
    showStep('choose');
    addAlert(null);
    $('atvAddSubtitle').textContent = 'Pick one found on the network, or enter its IP address';
    $('atvAddModal').classList.add('open');
    scan();
  }

  function closeAdd() {
    if (pairingIp) cancelPairing();
    $('atvAddModal').classList.remove('open');
  }

  async function scan() {
    const list = $('atvScanList');
    list.innerHTML = '<div class="loader" style="padding:20px"><div class="spinner"></div> Looking for Apple TVs…</div>';
    try {
      const { appleTvs } = await ctx.api('GET', '/discover?timeout=4000');
      found = appleTvs;
      if (!appleTvs.length) {
        list.innerHTML = '<div class="setting-desc" style="padding:8px 0">None found on this network segment — enter the IP address below.</div>';
        return;
      }
      list.innerHTML = appleTvs.map((tv, i) => `
        <div class="atv-scan-item">
          <div style="min-width:0">
            <div class="atv-name">${esc(tv.name)}</div>
            <div class="atv-meta">${esc(tv.address)} · ${esc(tv.model || '')}</div>
          </div>
          ${tv.paired
            ? '<span class="atv-meta">Paired</span>'
            : `<button class="btn btn-primary btn-sm" onclick="AppleTv.pairFound(${i})">Pair</button>`}
        </div>`).join('');
    } catch (err) {
      list.innerHTML = `<div class="alert alert-error show">${esc(err.message)}</div>`;
    }
  }

  async function pair(ip, port, name) {
    if (pairingBusy) return;
    pairingBusy = true;
    addAlert('info', `Asking ${name || ip} to show a pairing code…`);
    try {
      const session = await ctx.api('POST', '/pair/start', { ip, port: port || undefined, name: name || undefined });
      pairingIp = ip;
      $('atvPinTarget').textContent = session.name;
      $('atvAddSubtitle').textContent = `${session.name} · ${ip}`;
      $('atvPin').value = '';
      addAlert(null);
      showStep('pin');
      $('atvPin').focus();
    } catch (err) {
      addAlert('error', err.message);
    } finally {
      pairingBusy = false;
    }
  }

  function pairFound(index) {
    const tv = found[index];
    if (tv) pair(tv.address, tv.port, tv.name);
  }

  function pairManual() {
    const ip = $('atvManualIp').value.trim();
    if (!ip) return addAlert('error', 'Enter the Apple TV\'s IP address');
    return pair(ip, 0, $('atvManualName').value.trim());
  }

  async function submitPin() {
    if (pairingBusy) return;
    const pin = $('atvPin').value.trim();
    if (!/^\d{4}$/.test(pin)) return addAlert('error', 'Enter the 4 digits shown on the TV');
    const btn = $('atvPinBtn');
    pairingBusy = true;
    btn.disabled = true;
    addAlert('info', 'Pairing…');
    try {
      const device = await ctx.api('POST', '/pair/finish', { ip: pairingIp, pin });
      pairingIp = null;
      $('atvAddModal').classList.remove('open');
      ctx.toast(`Paired with ${device.name} — set AppleTVAddress to ${device.address} in Blueprint`);
      refresh();
    } catch (err) {
      pairingIp = null;
      showStep('choose');
      addAlert('error', err.message);
    } finally {
      pairingBusy = false;
      btn.disabled = false;
    }
  }

  function cancelPairing() {
    if (pairingIp) ctx.api('POST', '/pair/cancel', { ip: pairingIp }).catch(() => {});
    pairingIp = null;
    showStep('choose');
    addAlert(null);
  }

  // ── Remote ───────────────────────────────────────────────────────────────

  function updateRemoteTitle() {
    const d = byId(remoteId);
    if (!d) return;
    $('atvRemoteTitle').textContent = d.name;
    $('atvRemoteSubtitle').textContent = `${d.address} · ${statusLine(d).text}`;
  }

  async function openRemote(id) {
    remoteId = id;
    updateRemoteTitle();
    $('atvRemoteModal').classList.add('open');
    const el = $('atvApps');
    el.innerHTML = '<div class="loader" style="padding:16px"><div class="spinner"></div></div>';
    try {
      apps = await ctx.api('GET', `/devices/${id}/apps`);
      el.innerHTML = apps.length
        ? apps.map((a, i) => `<button class="atv-app" title="${esc(a.bundleId)}" onclick="AppleTv.launch(${i})">${esc(a.name)}</button>`).join('')
        : '<div class="setting-desc">No apps reported.</div>';
    } catch (err) {
      el.innerHTML = `<div class="setting-desc">${esc(err.message)}</div>`;
    }
  }

  function closeRemote() {
    remoteId = null;
    $('atvRemoteModal').classList.remove('open');
  }

  async function key(cmd, action) {
    if (!remoteId) return;
    try {
      await ctx.api('POST', `/devices/${remoteId}/cmd`, { cmd, action });
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function launch(index) {
    const app = apps[index];
    if (!app) return;
    try {
      await ctx.api('POST', `/devices/${remoteId}/app`, { id: app.bundleId });
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  window.AppleTv = {
    openAdd, closeAdd, scan, pairFound, pairManual, submitPin, cancelPairing,
    rename, changeIp, remove, openRemote, closeRemote, key, launch,
  };

  SB.registerPanel('appletv', {
    init(context) {
      ctx = context;
      $('atvPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });
      $('atvManualIp').addEventListener('keydown', (e) => { if (e.key === 'Enter') pairManual(); });
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if ($('atvRemoteModal').classList.contains('open')) closeRemote();
        if ($('atvAddModal').classList.contains('open')) closeAdd();
      });
    },
    onStateChange(integration) {
      if (integration.running) refresh();
    },
    onMessage(msg) {
      if (msg.type === 'devices') {
        devices = msg.devices;
        render();
      }
    },
  });
})();
