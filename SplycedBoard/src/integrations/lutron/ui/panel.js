/**
 * Lutron LEAP dashboard panel.
 *
 * Inline handlers in panel.html call window.Lutron.*; everything else is private.
 * Live updates arrive through onMessage() from the hub's WebSocket.
 */
(() => {
  let ctx = null;          // { root, api, esc, toast }
  let inventory = null;
  let zoneLevels = {};     // zoneId → level
  let ledStates = {};      // ledHref → 'On' | 'Off'
  let thermostatStates = {};
  let selectedProcessor = null;
  let typeFilter = 'all';  // 'all' | 'lights' | 'shades'
  let zoneSearch = '';
  let running = false;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => ctx.esc(s);

  const SHADE_TYPES = new Set(['shade']);
  const LIGHT_TYPES = new Set(['dimmer', 'switch', 'fan', 'ketra', 'rania']);

  // ── API ──────────────────────────────────────────────────────────────────

  const api = (method, path, body) => ctx.api(method, path, body);
  const post = (path, body) => api('POST', path, body);

  // ── Status ───────────────────────────────────────────────────────────────

  function updateStatus(connected, ready) {
    $('ltStatusDot').className = 'status-dot' + (ready ? ' ok' : connected ? ' warn' : '');
    $('ltStatusText').textContent = ready ? 'Ready' : connected ? 'Loading…' : 'Not connected';

    const card = $('connectionStatus');
    if (ready) card.innerHTML = '<span style="color:var(--green)">✓ Connected and ready</span>';
    else if (connected) card.innerHTML = '<span style="color:var(--accent)">⟳ Loading inventory…</span>';
    else card.innerHTML = '<span style="color:var(--muted)">Not connected</span>';
  }

  function showAlert(id, kind, message) {
    const el = $(id);
    el.className = `alert alert-${kind} show`;
    el.textContent = message;
  }

  function showPairedInfo(status) {
    if (!status.paired) return;
    $('bridgeInfo').style.display = 'flex';
    $('bridgePortChip').textContent = status.bridgePort;
    $('webPortChip').textContent = status.webPort;
    $('pairedChip').innerHTML = `Processor: <strong>${esc(status.processor.host)}</strong>`;
    // Savant asks for level changes twice a second, from profile 1.13 on (feedback.js)
    const from = status.feedbackFrom || [];
    $('feedbackChip').innerHTML = `Savant feedback: <strong>${from.length ? esc(from.join(', ')) : 'not polling'}</strong>`;
    $('feedbackChip').title = from.length
      ? 'Savant is asking for level changes twice a second'
      : 'Savant asks for level changes with the Lutron LEAP Bridge profile 1.13 or later';
  }

  async function refresh() {
    try {
      const status = await api('GET', '/status');
      showPairedInfo(status);
      updateStatus(status.connected, status.ready);
      if (status.ready) loadInventory();

      showComponentName(await api('GET', '/config'));
    } catch {
      updateStatus(false, false);
    }
  }

  // ── Discovery ────────────────────────────────────────────────────────────

  async function startDiscovery() {
    const btn = $('discoverBtn');
    const list = $('processorList');
    const SCAN_TIMEOUT = 5000;

    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Scanning…';
    list.innerHTML = '<div class="loader"><div class="spinner"></div> <span id="scanStatus">Scanning network…</span></div>';

    let elapsed = 0;
    const countdown = setInterval(() => {
      elapsed += 1;
      const el = $('scanStatus');
      if (el) el.textContent = `Scanning network… ${Math.max(0, SCAN_TIMEOUT / 1000 - elapsed)}s`;
    }, 1000);

    try {
      const { processors, problem, hint } = await api('GET', `/discover?timeout=${SCAN_TIMEOUT}`);
      if (problem) {
        list.innerHTML = `<div class="alert alert-error show">${esc(problem)}</div>`;
      } else if (!processors.length) {
        list.innerHTML = `<div class="alert alert-warn show">${esc(hint || 'No processors found. Try Manual Entry, or check that LEAP is enabled.')}</div>`;
      } else {
        list.innerHTML = `<div class="processor-list">${processors.map((p, i) => `
          <div class="processor-item" data-index="${i}" onclick="Lutron.selectProcessor(this)">
            <div class="processor-info">
              <div class="processor-name">${esc(p.name)}</div>
              <div class="processor-host">${esc(p.host)}:${esc(p.port)}</div>
            </div>
            <span style="font-size:18px">›</span>
          </div>`).join('')}</div>`;
        list._processors = processors;
      }
    } catch (err) {
      list.innerHTML = `<div class="alert alert-error show">${esc(err.message)}</div>`;
    } finally {
      clearInterval(countdown);
      btn.disabled = false;
      btn.innerHTML = '<span>🔍</span> Scan Network';
    }
  }

  function markStep(id) {
    $(id).classList.add('done');
    $(id).textContent = '✓';
  }

  function chooseProcessor(p) {
    selectedProcessor = p;
    $('selectedHost').textContent = `${p.name} (${p.host})`;
    $('pairBtn').disabled = false;
    markStep('step1Num');
  }

  function selectProcessor(el) {
    const p = $('processorList')._processors[Number(el.dataset.index)];
    document.querySelectorAll('#processorList .processor-item').forEach((item) => item.classList.remove('selected'));
    el.classList.add('selected');
    chooseProcessor(p);
  }

  function selectManual() {
    const host = $('manualHost').value.trim();
    const name = $('manualName').value.trim();
    if (host) chooseProcessor({ host, name: name || host });
  }

  // ── Pairing ──────────────────────────────────────────────────────────────

  // How long SplycedBoard waits for pairing mode (PAIRING_TIMEOUT_MS in pairing.js).
  const PAIRING_WINDOW_S = 180;
  const HOW_TO_PAIR = 'On HomeWorks QSX, press a keypad button programmed for pairing in Designer, or use '
    + "Designer's pairing feature. On RA3 and Caséta, press the pairing button on the processor or bridge.";

  async function startPairing() {
    if (!selectedProcessor) return;
    const btn = $('pairBtn');
    btn.innerHTML = '<div class="spinner"></div> Waiting… click to start over';

    let left = PAIRING_WINDOW_S;
    const countdown = () => {
      const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      showAlert('pairAlert', 'info', `Now put the processor into pairing mode (${time} left). ${HOW_TO_PAIR}`);
    };
    countdown();
    clearInterval(startPairing.timer);
    const timer = setInterval(() => { left = Math.max(0, left - 1); countdown(); }, 1000);
    startPairing.timer = timer;

    try {
      await post('/pair', { host: selectedProcessor.host, name: selectedProcessor.name });
      clearInterval(timer);
      showAlert('pairAlert', 'success', '✓ Paired successfully! Connecting to processor…');
      markStep('step2Num');
      markStep('step3Num');
      await reconnect();
      refresh();
    } catch (err) {
      if (startPairing.timer !== timer) return; // replaced by a newer attempt
      clearInterval(timer);
      showAlert('pairAlert', 'error', `Pairing failed: ${err.message}`);
    } finally {
      if (startPairing.timer === timer) btn.innerHTML = '<span>🔐</span> Pair Now';
    }
  }

  async function reconnect() {
    try {
      await post('/connect');
    } catch (err) {
      showAlert('pairAlert', 'error', err.message);
    }
  }

  // The name the export uses: typed here, else the one Blueprint gave the LEAP Bridge
  // component in the configuration Savant runs (cfg.controller, from the server).
  function showComponentName(cfg) {
    const { controller } = cfg;
    $('componentNameInput').value = cfg.componentName || (controller.source === 'blueprint' ? controller.name : '');
    $('componentNameHint').textContent = controller.source === 'blueprint'
      ? '✓ Filled in from the configuration Savant is running on this host.'
      : controller.source === 'typed'
        ? (controller.found && controller.found !== controller.name ? `Blueprint's configuration calls it "${controller.found}". Clear the name to use that.` : '')
        : `Not found in a Savant configuration on this host, so the export uses "${controller.name}".`;
  }

  async function saveComponentName() {
    await post('/config', { componentName: $('componentNameInput').value.trim() });
    showComponentName(await api('GET', '/config'));
    const saved = $('componentNameSaved');
    saved.style.display = 'inline';
    setTimeout(() => { saved.style.display = 'none'; }, 2000);
  }

  // ── Inventory ────────────────────────────────────────────────────────────

  async function loadInventory() {
    try {
      inventory = await api('GET', '/inventory');
    } catch {
      return;
    }
    for (const zone of inventory.zones) {
      if (zone.level !== null) zoneLevels[zone.id] = zone.level;
    }
    for (const t of inventory.thermostats || []) thermostatStates[t.id] = t;

    renderLoads(zoneSearch);
    renderThermostats();
    renderKeypads($('keypadSearch').value);
    renderScenes();
    loadRooms();
  }

  function refreshInventory() {
    inventory = null;
    loadInventory();
  }

  // The lighting table for Blueprint. Areas still waiting for a Savant zone would go out
  // under their Lutron names, so say so first.
  // Export: what goes in, keypad buttons optional (remembered in this browser), and a
  // warning while Lutron areas still wait for a Savant zone.
  const EXPORT_TYPES = new Set(['dimmer', 'switch', 'fan', 'ketra', 'rania']);
  const EXPORT_KEYPADS = 'splycedboard.lutron.exportKeypads';

  async function exportLighting() {
    let counts = null;
    try {
      counts = (await api('GET', '/rooms')).counts;
    } catch { /* the export itself reports what's wrong */ }
    const n = counts?.waiting || 0;
    $('ltExportWaiting').hidden = !n;
    $('ltExportWaitingText').textContent = n
      ? `${n} Lutron area${n === 1 ? ' still needs' : 's still need'} a Savant zone. ${n === 1 ? 'It keeps its Lutron name' : 'They keep their Lutron names'} as the zone unless you review ${n === 1 ? 'it' : 'them'}.`
      : '';
    const lights = inventory ? inventory.zones.filter((z) => EXPORT_TYPES.has(z.type)).length : 0;
    const keypads = inventory ? inventory.buttonGroups.filter((g) => g.deviceId != null) : [];
    const buttons = keypads.reduce((sum, g) => sum + g.buttons.filter((b) => b.number != null).length, 0);
    $('ltExportLights').textContent = `${plural(lights, 'light')}, each in its Savant zones from the Rooms tab.`;
    $('ltExportKeypads').textContent = buttons
      ? `${plural(buttons, 'button')} on ${plural(keypads.length, 'keypad')}, as Keypad Button rows: press, release, and the button's LED as its state.`
      : 'No keypad buttons found.';
    const toggle = $('ltExportKeypadsToggle');
    let remembered = null;
    try { remembered = localStorage.getItem(EXPORT_KEYPADS); } catch { /* not kept */ }
    toggle.checked = !!buttons && remembered === '1';
    toggle.disabled = !buttons;
    $('ltExportModal').classList.add('open');
  }

  function closeExport() {
    $('ltExportModal').classList.remove('open');
  }

  function downloadExport() {
    const keypads = $('ltExportKeypadsToggle').checked;
    try { localStorage.setItem(EXPORT_KEYPADS, keypads ? '1' : '0'); } catch { /* not kept */ }
    closeExport();
    window.location.href = `/api/lutron/export/lighting${keypads ? '?keypads=1' : ''}`;
  }

  async function reviewBeforeExport() {
    closeExport();
    showTab('rooms');
    await loadRooms();
    reviewRooms();
  }

  function showTab(name) {
    ctx.root.querySelector(`.tab-btn[data-tab="${name}"]`)?.click();
  }

  // ── Rooms: Savant Blueprint zones ← Lutron areas (matched on the server, rooms.js) ──

  let rooms = null;   // GET /rooms: { savant, controller, zones, areas, counts }
  let picker = null;  // the tree picker: { zone, selected: Map(areaId → Set(lightId)), open: Set(areaId) }
  let review = null;  // the step-by-step review: { queue: [areaId], index, picks: [zone] }

  const HOW = {
    exact: 'same name',
    words: 'same words',
    path: 'its place in Lutron',
    part: 'part of the name',
    spelling: 'similar spelling',
    shared: 'a word in common',
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const areaById = (id) => rooms.areas.find((a) => a.areaId === id);
  const trail = (a) => [...a.path, a.name].join(' › ');

  async function loadRooms() {
    try {
      rooms = await api('GET', '/rooms');
    } catch {
      rooms = null;
    }
    renderRooms();
  }

  function setRooms(view) {
    rooms = view;
    renderRooms();
  }

  function renderRooms() {
    const waiting = rooms?.counts.waiting || 0;
    $('ltRoomsBadge').hidden = !waiting;
    $('ltRoomsBadge').textContent = waiting;
    $('ltRoomsReviewBtn').hidden = !waiting;
    $('ltRoomsReviewBtn').textContent = `Review ${waiting}`;

    if (!rooms) {
      $('ltRoomsInfo').textContent = '';
      $('ltUnplaced').innerHTML = '';
      $('ltZonesList').innerHTML = `<div class="empty-state"><div class="empty-icon">🏠</div>
        <div class="empty-title">No Rooms</div>
        <div class="empty-desc">Connect to a Lutron processor to map its areas to Savant zones</div></div>`;
      return;
    }

    const { savant, controller, counts } = rooms;
    const from = { blueprint: 'from the configuration Savant is running', savant: 'from Savant', typed: 'typed in' }[savant.source] || '';
    const component = {
      blueprint: `Lutron component in Blueprint: <strong>${esc(controller.name)}</strong>`,
      typed: `Lutron component in Blueprint: <strong>${esc(controller.name)}</strong> (typed on the Setup tab)`,
      default: `Lutron component: <strong>${esc(controller.name)}</strong>, since none was found in a Savant configuration on this host. Set it on the Setup tab.`,
    }[controller.source];
    const tally = [
      savant.zones.length ? `${plural(savant.zones.length, 'Savant zone')} ${from}` : null,
      `${counts.placed} of ${plural(counts.areas, 'Lutron area')} placed`,
      counts.waiting ? `<span class="lt-warn-text">${counts.waiting} waiting for you</span>` : null,
    ].filter(Boolean).join(' · ');
    $('ltRoomsInfo').innerHTML = `<div>${tally}</div><div>${component}</div>`;

    $('ltZonesList').innerHTML = savant.zones.length
      ? rooms.zones.map(zoneCard).join('')
      : `<div class="lt-zones-empty">No Savant zones yet. <strong>Read zones from Savant</strong> (on the Pro Host,
          with its configuration uploaded), or type them in with <strong>Edit zone list</strong>.</div>`;

    renderUnplaced();
  }

  function zoneCard(z, i) {
    const chips = z.areas.map((za) => {
      const a = areaById(za.areaId);
      const count = !a.lights.length ? 'no lights' : za.whole ? plural(a.lights.length, 'light') : `${za.lightIds.length} of ${plural(a.lights.length, 'light')}`;
      const how = za.auto ? `Matched automatically: ${HOW[a.how] || ''}` : 'Chosen by you';
      return `<span class="lt-chip-lutron${za.auto ? ' is-auto' : ''}" title="${esc(how)}">${esc(trail(a))}<small>${count}</small></span>`;
    }).join('');
    return `
      <div class="lt-zone">
        <div class="lt-zone-savant"><span class="lt-zone-name">${esc(z.name)}</span><small>${plural(z.lights, 'light')}</small></div>
        <button class="lt-zone-lutron" onclick="Lutron.openPicker(${i})" aria-label="Choose the Lutron areas in ${esc(z.name)}">
          <span class="lt-zone-chips">${chips || '<span class="lt-zone-none">No Lutron areas yet: click to choose</span>'}</span>
          <span class="lt-zone-edit" aria-hidden="true">✎</span>
        </button>
      </div>`;
  }

  // Areas in no Savant zone: what's waiting for a decision, the likeliest zone one click away.
  function renderUnplaced() {
    const out = rooms.areas.filter((a) => !a.placed);
    if (!out.length) {
      $('ltUnplaced').innerHTML = '';
      return;
    }
    const zoneOptions = rooms.savant.zones.map((z, i) => `<option value="${i}">${esc(z)}</option>`).join('');
    $('ltUnplaced').innerHTML = `
      <div class="lt-unplaced-title">Lutron areas in no Savant zone <small>(exported under their Lutron names)</small></div>
      ${out.map((a) => {
        const waiting = a.status === 'review' && !a.kept;
        const suggestion = a.suggestion && !a.kept ? rooms.savant.zones.indexOf(a.suggestion.zone) : -1;
        return `
        <div class="lt-unplaced${waiting ? ' is-review' : ''}">
          <div class="lt-unplaced-area">
            <div class="lt-room-name">${esc(a.name)}</div>
            <div class="lt-room-path" title="${esc(a.lights.map((l) => l.name).join(', '))}">${a.path.length ? `${esc(a.path.join(' › '))} · ` : ''}${a.lights.length ? plural(a.lights.length, 'light') : 'no lights'}</div>
            <div class="lt-room-note">${waiting ? '⚠ ' : ''}${esc(a.reason || '')}</div>
          </div>
          <div class="lt-unplaced-actions">
            ${suggestion >= 0 ? `<button class="btn btn-secondary btn-sm" onclick="Lutron.addToZone(${a.areaId}, ${suggestion})">Add to ${esc(a.suggestion.zone)}</button>` : ''}
            ${zoneOptions ? `<select aria-label="Savant zone for ${esc(a.name)}" onchange="if (this.value !== '') Lutron.addToZone(${a.areaId}, Number(this.value))">
              <option value="">Add to…</option>${zoneOptions}</select>` : ''}
            ${a.kept
              ? `<button class="btn btn-ghost btn-sm" onclick="Lutron.keepArea(${a.areaId}, false)">Undo</button>`
              : `<button class="btn btn-ghost btn-sm" onclick="Lutron.keepArea(${a.areaId}, true)" title="Export it under its Lutron name, and stop asking">Leave out</button>`}
          </div>
        </div>`;
      }).join('')}`;
  }

  /** Puts a whole area in a Savant zone, keeping what's there. */
  function addToZone(areaId, zoneIndex) {
    const zone = rooms.zones[zoneIndex];
    const areas = zone.areas.filter((a) => a.whole).map((a) => a.areaId);
    const lights = zone.areas.filter((a) => !a.whole && a.areaId !== areaId).flatMap((a) => a.lightIds);
    return saveZone(zone.name, { areas: [...areas, areaId], lights });
  }

  async function saveZone(zone, selection) {
    try {
      setRooms(await api('PUT', '/rooms/zone', { zone, ...selection }));
      return true;
    } catch (err) {
      ctx.toast(err.message, 'error');
      renderRooms();
      return false;
    }
  }

  async function keepArea(areaId, kept) {
    try {
      setRooms(await api('PUT', `/rooms/area/${areaId}`, { kept }));
      return true;
    } catch (err) {
      ctx.toast(err.message, 'error');
      return false;
    }
  }

  // ── The tree picker: one zone's Lutron areas and lights, with everything else in reach ──

  function openPicker(zoneIndex) {
    const zone = rooms.zones[zoneIndex];
    picker = {
      zone: zone.name,
      selected: new Map(zone.areas.map((a) => [a.areaId, new Set(a.lightIds)])),
      open: new Set(zone.areas.filter((a) => !a.whole).map((a) => a.areaId)),
    };
    $('ltPickerTitle').textContent = zone.name;
    $('ltPickerSearch').value = '';
    $('ltPickerModal').classList.add('open');
    renderPicker();
    $('ltPickerSearch').focus();
  }

  function closePicker() {
    picker = null;
    $('ltPickerModal').classList.remove('open');
  }

  function renderPicker() {
    const q = $('ltPickerSearch').value.trim().toLowerCase();
    const hit = (s) => s.toLowerCase().includes(q);
    const rows = [];
    let shown = [];
    for (const a of rooms.areas) {
      const lightHit = q && a.lights.some((l) => hit(l.name));
      if (q && ![a.name, ...a.path].some(hit) && !lightHit) continue;
      // Headings for the parts of the hierarchy not shown yet
      let same = 0;
      while (same < a.path.length && shown[same] === a.path[same]) same++;
      for (let d = same; d < a.path.length; d++) rows.push(`<div class="lt-tree-group" style="--depth:${d}">${esc(a.path[d])}</div>`);
      shown = [...a.path, a.name];
      rows.push(treeArea(a, a.path.length, lightHit));
    }
    $('ltPickerTree').innerHTML = rows.join('') || '<div class="lt-tree-none">Nothing matches.</div>';
    $('ltPickerTree').querySelectorAll('input[data-some="true"]').forEach((box) => { box.indeterminate = true; });

    // An area is chosen while it has a key: for one without lights, the key is all there is
    const lights = [...picker.selected.values()].reduce((n, ids) => n + ids.size, 0);
    $('ltPickerCount').textContent = `${plural(picker.selected.size, 'area')}, ${plural(lights, 'light')}`;
  }

  function treeArea(a, depth, showLights) {
    const chosen = picker.selected.get(a.areaId) || new Set();
    const state = !picker.selected.has(a.areaId) ? 'none' : chosen.size === a.lights.length ? 'all' : 'some';
    const elsewhere = Object.keys(a.zones).filter((z) => z !== picker.zone);
    const suggested = a.suggestion?.zone === picker.zone && state === 'none';
    const open = showLights || picker.open.has(a.areaId);
    const tags = [
      ...elsewhere.map((z) => `<span class="lt-tag lt-tag-other">in ${esc(z)}</span>`),
      suggested ? `<span class="lt-tag lt-tag-suggest">suggested: ${esc(HOW[a.how] || '')}</span>` : '',
    ].join('');
    const lights = open ? a.lights.map((l) => {
      const also = Object.entries(a.zones).filter(([z, ids]) => z !== picker.zone && ids.includes(l.id)).map(([z]) => z);
      return `
        <label class="lt-tree-light${chosen.has(l.id) ? ' is-on' : ''}" style="--depth:${depth + 1}">
          <input type="checkbox" ${chosen.has(l.id) ? 'checked' : ''} onchange="Lutron.pickLight(${a.areaId}, ${l.id}, this.checked)">
          <span class="lt-tree-name">${esc(l.name)}</span>
          ${also.map((z) => `<span class="lt-tag lt-tag-other">in ${esc(z)}</span>`).join('')}
        </label>`;
    }).join('') : '';
    return `
      <div class="lt-tree-area${state !== 'none' ? ' is-on' : ''}" style="--depth:${depth}">
        <label class="lt-tree-check">
          <input type="checkbox" ${state === 'all' ? 'checked' : ''} data-some="${state === 'some'}" onchange="Lutron.pickArea(${a.areaId}, this.checked)">
          <span class="lt-tree-name">${esc(a.name)}</span>
          <span class="lt-tree-count">${a.lights.length ? plural(a.lights.length, 'light') : 'no lights'}</span>
        </label>
        <span class="lt-tree-tags">${tags}</span>
        ${a.lights.length ? `<button class="lt-tree-toggle" onclick="Lutron.toggleLights(${a.areaId})" aria-expanded="${open}">${open ? '▾' : '▸'} lights</button>` : ''}
      </div>${lights}`;
  }

  function pickArea(areaId, checked) {
    if (checked) picker.selected.set(areaId, new Set(areaById(areaId).lights.map((l) => l.id)));
    else picker.selected.delete(areaId);
    renderPicker();
  }

  function pickLight(areaId, lightId, checked) {
    const ids = picker.selected.get(areaId) || new Set();
    if (checked) ids.add(lightId);
    else ids.delete(lightId);
    if (ids.size) picker.selected.set(areaId, ids);
    else picker.selected.delete(areaId);
    renderPicker();
  }

  function toggleLights(areaId) {
    if (picker.open.has(areaId)) picker.open.delete(areaId);
    else picker.open.add(areaId);
    renderPicker();
  }

  async function savePicker() {
    const areas = [];
    const lights = [];
    for (const [areaId, ids] of picker.selected) {
      if (ids.size === areaById(areaId).lights.length) areas.push(areaId);
      else lights.push(...ids);
    }
    if (await saveZone(picker.zone, { areas, lights })) closePicker();
  }

  async function resetPicker() {
    try {
      setRooms(await api('PUT', '/rooms/zone', { zone: picker.zone, automatic: true }));
      closePicker();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // ── Savant's zone list ───────────────────────────────────────────────────

  async function readSavantZones() {
    try {
      setRooms(await api('POST', '/rooms/savant/read'));
      ctx.toast(`Read ${plural(rooms.savant.zones.length, 'Savant zone')}`);
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  function editSavantZones() {
    $('ltSavantZonesText').value = (rooms?.savant.zones || []).join('\n');
    $('ltSavantZonesModal').classList.add('open');
    $('ltSavantZonesText').focus();
  }

  function closeSavantZones() {
    $('ltSavantZonesModal').classList.remove('open');
  }

  async function saveSavantZones() {
    const list = $('ltSavantZonesText').value.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      setRooms(await api('PUT', '/rooms/savant', { zones: list }));
      closeSavantZones();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // ── The review: one waiting area at a time, with where it sits and what's in it, so
  //    same-named areas (a "Bath" in every suite) can be told apart ─────────────────

  function reviewRooms() {
    const queue = (rooms?.areas || []).filter((a) => !a.placed && !a.kept && a.status === 'review').map((a) => a.areaId);
    if (!queue.length) return;
    review = { queue, index: 0, picks: [] };
    $('ltReviewModal').classList.add('open');
    renderReview();
  }

  function closeReview() {
    review = null;
    $('ltReviewModal').classList.remove('open');
  }

  function renderReview() {
    const a = areaById(review.queue[review.index]);
    if (!a || a.placed || a.kept) {
      nextReview();
      return;
    }
    $('ltReviewStep').textContent = `${review.index + 1} of ${review.queue.length}`;
    const picks = [a.suggestion, ...a.alternatives].filter(Boolean);
    review.picks = picks.map((p) => p.zone);
    const lights = a.lights.map((l) => l.name);
    const more = lights.length > 8 ? ` · ${lights.length - 8} more` : '';
    $('ltReviewContent').innerHTML = `
      <div class="lt-review-area">
        <div class="lt-review-name lt-lutron-text">${esc(a.name)}</div>
        <div class="lt-room-path">${esc(trail(a))}</div>
        <div class="lt-review-loads">Lights: ${lights.slice(0, 8).map(esc).join(' · ')}${more}</div>
      </div>
      <div class="alert alert-warn show">${esc(a.reason || '')}</div>
      ${picks.length ? `<div class="lt-review-label">Suggested Savant zones</div>
      <div class="lt-review-picks">${picks.map((p, i) => `
        <button class="btn ${i ? 'btn-secondary' : 'btn-primary'} btn-sm" onclick="Lutron.pickReview(${i})">
          ${esc(p.zone)}<span class="lt-pick-how">${esc(HOW[p.how] || '')}</span>
        </button>`).join('')}</div>` : ''}
      ${rooms.savant.zones.length ? `<div class="lt-review-label">Or another Savant zone</div>
      <div class="lt-review-other">
        <select id="ltReviewOther" aria-label="Another Savant zone">${rooms.savant.zones.map((z, i) => `<option value="${i}">${esc(z)}</option>`).join('')}</select>
        <button class="btn btn-secondary btn-sm" onclick="Lutron.pickReviewOther()">Add to this zone</button>
      </div>` : ''}
      <div class="lt-review-actions">
        <button class="btn btn-ghost btn-sm" onclick="Lutron.pickReviewLeaveOut()">Leave it out</button>
        <button class="btn btn-ghost btn-sm" onclick="Lutron.skipReview()">Skip for now</button>
      </div>`;
  }

  async function reviewDecided(action) {
    if (await action()) nextReview();
  }

  const reviewArea = () => review.queue[review.index];
  const pickReview = (i) => reviewDecided(() => addToZone(reviewArea(), rooms.savant.zones.indexOf(review.picks[i])));
  const pickReviewOther = () => reviewDecided(() => addToZone(reviewArea(), Number($('ltReviewOther').value)));
  const pickReviewLeaveOut = () => reviewDecided(() => keepArea(reviewArea(), true));

  function skipReview() {
    nextReview();
  }

  function nextReview() {
    review.index++;
    if (review.index < review.queue.length) {
      renderReview();
      return;
    }
    const left = rooms?.counts.waiting || 0;
    closeReview();
    ctx.toast(left ? `${plural(left, 'area')} still waiting` : 'Every Lutron area has a Savant zone');
  }

  // ── Loads ────────────────────────────────────────────────────────────────

  function setTypeFilter(val) {
    typeFilter = val;
    ctx.root.querySelectorAll('.type-filter-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === val);
    });
    renderLoads(zoneSearch);
  }

  function renderLoads(filter = '') {
    zoneSearch = filter;
    const container = $('loadsContent');
    if (!inventory) return;

    const lc = filter.toLowerCase();
    const areaMap = new Map();
    for (const zone of inventory.zones) {
      if (zone.type === 'hvac') continue; // on the Thermostats tab
      if (typeFilter === 'lights' && !LIGHT_TYPES.has(zone.type)) continue;
      if (typeFilter === 'shades' && !SHADE_TYPES.has(zone.type)) continue;
      if (filter && !zone.name.toLowerCase().includes(lc) && !zone.areaName.toLowerCase().includes(lc)) continue;

      const key = zone.areaName || 'Unknown Area';
      if (!areaMap.has(key)) areaMap.set(key, []);
      areaMap.get(key).push(zone);
    }

    if (!areaMap.size) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">💡</div><div class="empty-title">No loads found</div></div>';
      return;
    }

    const sorted = Array.from(areaMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    container.innerHTML = sorted.map(([areaName, zones]) => `
      <div class="area-section">
        <div class="area-header">
          <span class="area-name">${esc(areaName)}</span>
          <span class="area-count">${zones.length}</span>
        </div>
        <div class="zone-grid">${zones.map(renderZoneCard).join('')}</div>
      </div>`).join('');
  }

  function zoneHeader(zone, badgeClass, label) {
    return `
      <div class="zone-header">
        <div>
          <div class="zone-name">${esc(zone.name)}</div>
          <div class="zone-id">ID: ${zone.id}</div>
        </div>
        <span class="zone-type-badge ${badgeClass}">${label}</span>
      </div>`;
  }

  function levelSlider(zone, level, extraButtons = '', sliderClass = '') {
    const holdButtons = sliderClass ? '' : `
      <button class="btn btn-ghost btn-icon" onmousedown="Lutron.startAdjust(${zone.id},'raise')" onmouseup="Lutron.stopAdjust(${zone.id})" onmouseleave="Lutron.stopAdjust(${zone.id})" ontouchstart="Lutron.startAdjust(${zone.id},'raise')" ontouchend="Lutron.stopAdjust(${zone.id})" title="Raise">▲</button>
      <button class="btn btn-ghost btn-icon" onmousedown="Lutron.startAdjust(${zone.id},'lower')" onmouseup="Lutron.stopAdjust(${zone.id})" onmouseleave="Lutron.stopAdjust(${zone.id})" ontouchstart="Lutron.startAdjust(${zone.id},'lower')" ontouchend="Lutron.stopAdjust(${zone.id})" title="Lower">▼</button>`;
    return `
      <div class="slider-wrap">
        <div class="level-display">
          <span class="level-pct ${sliderClass ? 'shade' : level > 0 ? 'lit' : ''}" id="pct-${zone.id}">${Math.round(level)}%</span>
          <div class="level-controls">${holdButtons}${extraButtons}</div>
        </div>
        <input type="range" class="${sliderClass}" min="0" max="100" value="${Math.round(level)}" id="slider-${zone.id}"
          aria-label="${esc(zone.name)} level"
          oninput="Lutron.updateSliderDisplay(${zone.id}, this.value)"
          onchange="Lutron.setLevel(${zone.id}, this.value)">
      </div>`;
  }

  function renderZoneCard(zone) {
    const level = zoneLevels[zone.id] ?? zone.level ?? 0;
    const active = level > 0 ? 'active' : '';

    if (zone.type === 'dimmer') {
      return `<div class="zone-card ${active}" id="zone-${zone.id}">
        ${zoneHeader(zone, 'badge-dimmer', 'Dim')}
        ${levelSlider(zone, level)}
      </div>`;
    }

    if (zone.type === 'ketra' || zone.type === 'rania') {
      const label = zone.type === 'ketra' ? 'Ketra' : 'Rania';
      const colorBtn = `<button class="btn btn-ghost btn-icon" onclick="Lutron.openColorModal(${zone.id})" title="${label} controls" style="font-size:14px">✦</button>`;
      return `<div class="zone-card ${active}" id="zone-${zone.id}">
        ${zoneHeader(zone, `badge-${zone.type}`, label)}
        ${levelSlider(zone, level, colorBtn)}
      </div>`;
    }

    if (zone.type === 'shade') {
      return `<div class="zone-card ${active}" id="zone-${zone.id}">
        ${zoneHeader(zone, 'badge-shade', 'Shade')}
        ${levelSlider(zone, level, '', 'shade-slider')}
        <div class="shade-labels">
          <button class="shade-label-btn" onclick="Lutron.setLevel(${zone.id}, 0)">Close</button>
          <button class="shade-label-btn" onclick="Lutron.setLevel(${zone.id}, 100)">Open</button>
        </div>
      </div>`;
    }

    if (zone.type === 'fan') {
      const speeds = ['Off', 'Low', 'Med', 'High'];
      const speedIdx = fanSpeedIndex(level);
      return `<div class="zone-card ${active}" id="zone-${zone.id}">
        ${zoneHeader(zone, 'badge-fan', 'Fan')}
        <div style="display:flex; gap:6px; flex-wrap:wrap">
          ${speeds.map((s, i) => `
            <button class="btn ${i === speedIdx ? 'btn-primary' : 'btn-ghost'} btn-sm" id="fan-${zone.id}-${i}"
              onclick="Lutron.setLevel(${zone.id}, ${FAN_LEVELS[i]})">${s}</button>`).join('')}
        </div>
      </div>`;
    }

    // Switch / anything else
    return `<div class="zone-card ${active}" id="zone-${zone.id}">
      ${zoneHeader(zone, 'badge-switch', 'Switch')}
      <div class="switch-wrap">
        <span class="switch-label" id="swlabel-${zone.id}">${level > 0 ? 'On' : 'Off'}</span>
        <label class="toggle" aria-label="${esc(zone.name)}">
          <input type="checkbox" id="sw-${zone.id}" ${level > 0 ? 'checked' : ''}
            onchange="Lutron.setLevel(${zone.id}, this.checked ? 100 : 0)">
          <span class="toggle-track"></span>
        </label>
      </div>
    </div>`;
  }

  const FAN_LEVELS = [0, 25, 50, 100];
  const fanSpeedIndex = (level) => (level === 0 ? 0 : level <= 25 ? 1 : level <= 50 ? 2 : 3);

  function onZoneSearch(val) {
    $('zoneSearchClear').style.display = val ? 'block' : 'none';
    renderLoads(val);
  }

  function clearZoneSearch() {
    $('zoneSearch').value = '';
    $('zoneSearchClear').style.display = 'none';
    renderLoads('');
  }

  function handleZoneUpdate(zone) {
    zoneLevels[zone.id] = zone.level ?? 0;
    updateZoneCard(zone.id, zone.level ?? 0);
  }

  function updateZoneCard(id, level) {
    const pct = $(`pct-${id}`);
    const slider = $(`slider-${id}`);
    const sw = $(`sw-${id}`);
    const swLabel = $(`swlabel-${id}`);
    const card = $(`zone-${id}`);

    if (pct) {
      pct.textContent = `${Math.round(level)}%`;
      if (!pct.classList.contains('shade')) pct.classList.toggle('lit', level > 0);
    }
    if (slider) slider.value = Math.round(level);
    if (sw) sw.checked = level > 0;
    if (swLabel) swLabel.textContent = level > 0 ? 'On' : 'Off';
    if (card) card.classList.toggle('active', level > 0);

    const cur = fanSpeedIndex(level);
    FAN_LEVELS.forEach((_, i) => {
      const btn = $(`fan-${id}-${i}`);
      if (btn) btn.className = `btn ${i === cur ? 'btn-primary' : 'btn-ghost'} btn-sm`;
    });
  }

  function updateSliderDisplay(id, val) {
    const pct = $(`pct-${id}`);
    if (!pct) return;
    pct.textContent = `${Math.round(val)}%`;
    if (!pct.classList.contains('shade')) pct.classList.toggle('lit', val > 0);
  }

  // ── Zone control ─────────────────────────────────────────────────────────

  const adjustTimers = {};

  function setLevel(id, level) {
    const rounded = Math.round(parseFloat(level));
    zoneLevels[id] = rounded;
    post(`/zone/${id}/level`, { level: rounded }).catch((err) => ctx.toast(err.message, 'error'));
  }

  function startAdjust(id, dir) {
    const step = () => {
      const cur = zoneLevels[id] ?? 0;
      const next = dir === 'raise' ? Math.min(100, cur + 5) : Math.max(0, cur - 5);
      zoneLevels[id] = next;
      updateZoneCard(id, next);
      post(`/zone/${id}/level`, { level: next }).catch(() => {});
    };
    stopAdjust(id);
    step();
    adjustTimers[id] = setInterval(step, 400);
  }

  function stopAdjust(id) {
    clearInterval(adjustTimers[id]);
    delete adjustTimers[id];
  }

  // ── Keypads ──────────────────────────────────────────────────────────────

  // Each keypad drawn with its family's structure (lutron/keypads.js): the buttons where they
  // sit on the faceplate, empty positions, raise/lower pairs, and live LEDs.
  function renderKeypads(filter = '') {
    const container = $('keypadsContent');
    if (!inventory) return;

    const lc = filter.toLowerCase();
    const areaMap = new Map();
    for (const bg of inventory.buttonGroups) {
      const haystack = [bg.deviceName, bg.areaName, bg.family?.name, bg.model, ...bg.buttons.map((b) => b.name)].join(' ').toLowerCase();
      if (filter && !haystack.includes(lc)) continue;
      const key = bg.areaName || 'Unknown Area';
      if (!areaMap.has(key)) areaMap.set(key, []);
      areaMap.get(key).push(bg);
    }

    if (!areaMap.size) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">⌨️</div><div class="empty-title">No keypads found</div></div>';
      return;
    }

    const sorted = Array.from(areaMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    container.innerHTML = sorted.map(([areaName, groups]) => `
      <div class="area-section">
        <div class="area-header">
          <span class="area-name">${esc(areaName)}</span>
          <span class="area-count">${groups.length}</span>
        </div>
        <div class="kp-grid">${groups.map(keypadCard).join('')}</div>
      </div>`).join('');
  }

  function keypadCard(bg) {
    const byId = new Map(bg.buttons.map((b) => [b.id, b]));
    const family = bg.family || { id: 'generic', name: 'Keypad' };
    const key = (b, cls = '') => {
      if (!b) return '<span class="kp-key kp-blank" aria-hidden="true"></span>';
      const label = b.role === 'raise' ? '▲' : b.role === 'lower' ? '▼' : (b.engraving || b.name || `Button ${b.number}`);
      const trigger = bg.deviceId != null && b.number != null ? ` · Savant trigger: ButtonEvent_${bg.deviceId}_${b.number}` : '';
      const title = `Button ${b.number ?? b.id}${b.role !== 'button' ? ` (${b.role})` : ''}${trigger}`;
      return `<button class="kp-key ${cls}${b.ledState === 'On' ? ' is-on' : ''}" type="button" title="${esc(title)}"
          data-button="${esc(b.href)}" ${b.ledHref ? `data-led="${esc(b.ledHref)}"` : ''}
          onpointerdown="Lutron.pressButton('${esc(b.href)}')" onpointerup="Lutron.releaseButton('${esc(b.href)}')"
          onpointerleave="Lutron.releaseButton('${esc(b.href)}')" onpointercancel="Lutron.releaseButton('${esc(b.href)}')">
          ${b.ledHref ? '<span class="kp-led" aria-hidden="true"></span>' : ''}<span class="kp-label">${esc(label)}</span>
        </button>`;
    };
    const rows = (bg.rows || bg.buttons.map((b) => ({ type: 'button', id: b.id }))).map((row) => {
      if (row.type === 'gap') return '<div class="kp-gap" aria-hidden="true"></div>';
      if (row.type === 'pair') {
        const lower = byId.get(row.lower);
        const raise = byId.get(row.raise);
        if (family.id === 'pico') return `<div class="kp-row">${key(raise || lower, 'kp-arrow')}</div>`;
        return `<div class="kp-row kp-pair">${key(lower, 'kp-arrow')}${key(raise, 'kp-arrow')}</div>`;
      }
      return `<div class="kp-row">${key(byId.get(row.id))}</div>`;
    }).join('');
    const addresses = bg.buttons.filter((b) => b.number != null).map((b) => `
      <tr><td>${esc(b.role === 'button' ? (b.engraving || b.name) : b.role === 'raise' ? 'Raise' : 'Lower')}</td>
        <td>${esc(String(bg.deviceId ?? '—'))}</td><td>${esc(String(b.number))}</td><td>${esc(String(b.ledId ?? '—'))}</td>
        <td><code>ButtonEvent_${esc(String(bg.deviceId ?? '—'))}_${esc(String(b.number))}</code></td></tr>`).join('');
    return `
      <div class="kp-card">
        <div class="kp-head">
          <div class="kp-name">${esc(bg.deviceName)}</div>
          <div class="kp-meta">${esc([family.name, bg.model].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="kp-plate kp-${esc(family.id)}"><div class="kp-keys">${rows}</div></div>
        <details class="kp-addresses">
          <summary>Savant addresses</summary>
          <table>
            <thead><tr><th>Button</th><th>Address1</th><th>Address2</th><th>Address3</th><th>Trigger state</th></tr></thead>
            <tbody>${addresses}</tbody>
          </table>
          <div class="kp-addresses-note">Keypad Button rows: device, button number, LED. Trigger state (profile 1.16+): Press,
            Release, Hold or MultiTap when the button is used, then None, for Savant triggers.</div>
        </details>
      </div>`;
  }

  // The processor reports a press, from here, Savant or a finger on the keypad: the key lights
  // while it's held (at least long enough to see).
  const pressedAt = new Map();
  function handleButtonEvent(buttonHref, event) {
    const keys = document.querySelectorAll(`.kp-key[data-button="${CSS.escape(buttonHref || '')}"]`);
    if (event === 'Press') {
      pressedAt.set(buttonHref, Date.now());
      keys.forEach((el) => el.classList.add('is-pressed'));
    } else if (event === 'Release') {
      const wait = Math.max(0, 250 - (Date.now() - (pressedAt.get(buttonHref) || 0)));
      setTimeout(() => keys.forEach((el) => el.classList.remove('is-pressed')), wait);
    }
  }

  function handleLedUpdate(ledHref, state) {
    ledStates[ledHref] = state;
    for (const bg of inventory?.buttonGroups || []) {
      for (const b of bg.buttons) if (b.ledHref === ledHref) b.ledState = state;
    }
    for (const el of document.querySelectorAll(`.kp-key[data-led="${CSS.escape(ledHref)}"]`)) el.classList.toggle('is-on', state === 'On');
  }

  // A mouse press+leave fires release twice; only send it once per press.
  const pressed = new Set();

  function pressButton(href) {
    pressed.add(href);
    post('/button/press', { href }).catch(() => {});
  }

  function releaseButton(href) {
    if (!pressed.delete(href)) return;
    post('/button/release', { href }).catch(() => {});
  }

  // ── Scenes ───────────────────────────────────────────────────────────────

  function renderScenes() {
    const container = $('scenesContent');
    if (!inventory) return;

    const scenes = inventory.virtualButtons.filter((vb) => vb.isProgrammed);
    if (!scenes.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">🎬</div><div class="empty-title">No scenes programmed</div></div>';
      return;
    }

    container.innerHTML = `<div class="scene-grid">${scenes.map((vb) => `
      <button class="scene-btn" onclick="Lutron.recallScene(${vb.id})">
        <span class="scene-icon">🎬</span>
        <span>${esc(vb.name)}</span>
        <span style="font-size:10px; color:var(--muted)">ID: ${vb.id}</span>
      </button>`).join('')}</div>`;
  }

  function recallScene(id) {
    post(`/scene/${id}/recall`).catch((err) => ctx.toast(err.message, 'error'));
  }

  // ── Color / tuning modal ─────────────────────────────────────────────────

  let colorModalZone = null;
  let colorModalWarmDim = false; // false = color (Ketra), true = warm dim / white tuning
  const zoneColorState = {};     // zoneId → { level, colorTemp, hue, saturation, vibrancy, warmDim }

  function openColorModal(zoneId) {
    const zone = inventory?.zones.find((z) => z.id === zoneId);
    if (!zone) return;
    colorModalZone = zone;
    colorModalWarmDim = zone.type !== 'ketra' || (zoneColorState[zone.id]?.warmDim ?? false);
    $('colorModalName').textContent = zone.name;
    $('colorModalArea').textContent = zone.areaName;
    renderColorModal();
    $('colorModal').classList.add('open');
  }

  function renderColorModal() {
    const zone = colorModalZone;
    if (!zone) return;
    const isKetra = zone.type === 'ketra';
    const cs = zoneColorState[zone.id] || {};
    const level = cs.level ?? zoneLevels[zone.id] ?? 50;
    const colorTemp = cs.colorTemp ?? 2700;
    const hue = cs.hue ?? 0;
    const vibrancy = cs.vibrancy ?? 0;
    const cctMin = 1400;
    const cctMax = isKetra ? 10000 : 6500;

    let html = '';

    if (isKetra) {
      const modeBtn = (warm, label) => `
        <button onclick="Lutron.setColorMode(${warm})"
          style="padding:7px 16px;font-size:12px;font-weight:600;border:none;cursor:pointer;transition:all 0.15s;
            ${colorModalWarmDim === warm ? 'background:var(--accent);color:#111' : 'background:none;color:var(--muted)'}">${label}</button>`;
      html += `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
          <div style="display:flex;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
            ${modeBtn(false, '✦ Color')}${modeBtn(true, '◐ Warm Dim')}
          </div>
          <div id="cm-color-preview" style="width:28px;height:28px;border-radius:50%;border:2px solid var(--border);
            background:${!colorModalWarmDim ? `hsl(${hue},${vibrancy}%,50%)` : 'white'};flex-shrink:0"></div>
        </div>`;
    }

    html += `
      <div class="modal-section">
        <div class="modal-label"><span>Brightness</span><span class="modal-label-val" id="cm-bri-val">${Math.round(level)}%</span></div>
        <input type="range" min="0" max="100" value="${Math.round(level)}" id="cm-bri" aria-label="Brightness"
          oninput="document.getElementById('cm-bri-val').textContent = Math.round(this.value) + '%'"
          onchange="Lutron.sendSpectrum()">
      </div>`;

    if (!colorModalWarmDim && isKetra) {
      const saturation = cs.saturation ?? 100;
      html += `
        <div class="modal-section">
          <div class="modal-label"><span>Hue</span><span class="modal-label-val" id="cm-hue-val">${hue}°</span></div>
          <input type="range" class="hue-slider" min="0" max="360" value="${hue}" step="1" id="cm-hue" aria-label="Hue"
            oninput="Lutron.cmUpdatePreview()" onchange="Lutron.sendSpectrum()">
        </div>
        <div class="modal-section">
          <div class="modal-label"><span>Saturation</span><span class="modal-label-val" id="cm-sat-val">${saturation}%</span></div>
          <input type="range" min="0" max="100" value="${saturation}" step="1" id="cm-sat" aria-label="Saturation"
            style="background:linear-gradient(to right,#888,hsl(${hue},100%,50%))"
            oninput="Lutron.cmUpdatePreview()" onchange="Lutron.sendSpectrum()">
        </div>
        <div class="modal-section">
          <div class="modal-label">
            <span>Vibrancy <span style="font-size:10px;color:var(--muted)">(0 = white)</span></span>
            <span class="modal-label-val" id="cm-vib-val">${vibrancy}%</span>
          </div>
          <input type="range" min="0" max="100" value="${vibrancy}" step="1" id="cm-vib" aria-label="Vibrancy"
            style="background:linear-gradient(to right,#fff,hsl(${hue},100%,50%))"
            oninput="Lutron.cmUpdatePreview()" onchange="Lutron.sendSpectrum()">
        </div>`;
    } else {
      html += `
        <div class="modal-section">
          <div class="modal-label"><span>Color Temperature</span><span class="modal-label-val" id="cm-cct-val">${colorTemp}K</span></div>
          <div style="height:4px;border-radius:2px;margin-bottom:6px;background:linear-gradient(to right,#ff9a3c,#fff5e0,#c9e8ff)"></div>
          <input type="range" class="cct-slider" min="${cctMin}" max="${cctMax}" value="${colorTemp}" step="100" id="cm-cct" aria-label="Color temperature"
            oninput="document.getElementById('cm-cct-val').textContent = this.value + 'K'"
            onchange="Lutron.sendSpectrum()">
          <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:10px;color:var(--muted)">
            <span>Warm ${cctMin}K</span><span>Cool ${cctMax}K</span>
          </div>
        </div>`;
    }

    $('colorModalContent').innerHTML = html;
  }

  function setColorMode(warmDim) {
    colorModalWarmDim = warmDim;
    if (colorModalZone) {
      const cs = (zoneColorState[colorModalZone.id] ||= {});
      cs.warmDim = warmDim;
      // Drop the other mode's values so they don't bleed into commands.
      if (warmDim) {
        delete cs.hue;
        delete cs.saturation;
        delete cs.vibrancy;
      } else {
        delete cs.colorTemp;
      }
    }
    renderColorModal();
    sendSpectrum();
  }

  function cmUpdatePreview() {
    const hue = $('cm-hue')?.value ?? 0;
    const sat = $('cm-sat')?.value ?? 100;
    const vib = $('cm-vib')?.value ?? 0;
    if ($('cm-hue-val')) $('cm-hue-val').textContent = hue + '°';
    if ($('cm-sat-val')) $('cm-sat-val').textContent = sat + '%';
    if ($('cm-vib-val')) $('cm-vib-val').textContent = vib + '%';
    const lightness = 50 - (sat / 100) * 20; // rough preview only
    if ($('cm-color-preview')) $('cm-color-preview').style.background = `hsl(${hue},${vib}%,${lightness + (100 - vib) * 0.3}%)`;
    if ($('cm-sat')) $('cm-sat').style.background = `linear-gradient(to right,#888,hsl(${hue},100%,50%))`;
    if ($('cm-vib')) $('cm-vib').style.background = `linear-gradient(to right,#fff,hsl(${hue},100%,50%))`;
  }

  function sendSpectrum() {
    const zone = colorModalZone;
    if (!zone) return;

    const level = parseInt($('cm-bri')?.value ?? 50, 10);
    const params = { level, warmDim: colorModalWarmDim };
    if (!colorModalWarmDim && zone.type === 'ketra') {
      params.hue = parseInt($('cm-hue')?.value ?? 0, 10);
      params.saturation = parseInt($('cm-sat')?.value ?? 100, 10);
      params.vibrancy = parseInt($('cm-vib')?.value ?? 0, 10);
    } else {
      params.colorTemp = parseInt($('cm-cct')?.value ?? 2700, 10);
    }

    Object.assign((zoneColorState[zone.id] ||= {}), params);
    zoneLevels[zone.id] = level;
    updateZoneCard(zone.id, level);
    post(`/zone/${zone.id}/spectrum`, params).catch((err) => ctx.toast(err.message, 'error'));
  }

  function closeColorModal() {
    $('colorModal').classList.remove('open');
    colorModalZone = null;
  }

  // ── Thermostats ──────────────────────────────────────────────────────────

  const HVAC_MODES = ['Off', 'Heat', 'Cool', 'Auto'];
  const DEFAULT_FAN_MODES = ['Auto', 'On', 'High', 'Medium', 'Low'];
  const modeClass = (m, current) => (m === current ? ` active-${m.toLowerCase()}` : '');

  function renderThermostats() {
    const container = $('thermostatsContent');
    if (!inventory) return;
    const tstats = inventory.thermostats || [];
    if (!tstats.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">🌡️</div><div class="empty-title">No thermostats found</div><div class="empty-desc">Palladiom thermostat zones appear here when connected</div></div>';
      return;
    }
    container.innerHTML = `<div class="hvac-grid">${tstats.map((t) => renderHvacCard(thermostatStates[t.id] || t)).join('')}</div>`;
  }

  function renderHvacCard(t) {
    const show = (v) => (v != null ? v : '--');
    const mode = t.mode || 'Off';
    const fan = t.fanMode || 'Auto';
    const fanModes = t.supportedFanModes || DEFAULT_FAN_MODES;
    const setpoint = (which, label, value) => `
      <div class="hvac-setpoint">
        <div class="hvac-setpoint-label ${which}">${label}</div>
        <div class="hvac-setpoint-row">
          <button class="hvac-adj-btn" onclick="Lutron.hvacAdjSetpoint(${t.id},'${which}',-1)" aria-label="Lower ${label}">−</button>
          <span class="hvac-setpoint-val" id="hvac-${which}-${t.id}">${show(value)}</span>
          <button class="hvac-adj-btn" onclick="Lutron.hvacAdjSetpoint(${t.id},'${which}',1)" aria-label="Raise ${label}">+</button>
        </div>
      </div>`;

    return `
      <div class="hvac-card" id="hvac-${t.id}">
        <div class="zone-header" style="margin-bottom:0">
          <div>
            <div class="zone-name">${esc(t.name)}</div>
            <div class="zone-id">ID: ${t.id} · ${esc(t.areaName)}</div>
          </div>
          <span class="zone-type-badge badge-hvac">HVAC</span>
        </div>

        <div class="hvac-temp">
          <span class="hvac-temp-val" id="hvac-temp-${t.id}">${show(t.temperature)}</span>
          <span class="hvac-temp-unit">°F</span>
          <span class="hvac-state" id="hvac-state-${t.id}">${esc(t.operatingState || '')}</span>
        </div>

        <div>
          <div class="hvac-section-label">Mode</div>
          <div class="hvac-modes">
            ${HVAC_MODES.map((m) => `<button class="hvac-mode-btn${modeClass(m, mode)}" id="hvac-mode-${t.id}-${m}" onclick="Lutron.hvacSetMode(${t.id},'${m}')">${m}</button>`).join('')}
          </div>
        </div>

        <div class="hvac-setpoints">
          ${setpoint('heat', 'Heat Setpoint', t.heatSetpoint)}
          ${setpoint('cool', 'Cool Setpoint', t.coolSetpoint)}
        </div>

        <div>
          <div class="hvac-section-label">Fan</div>
          <div class="hvac-fan-modes">
            ${fanModes.map((f) => `<button class="hvac-fan-btn${f === fan ? ' active' : ''}" id="hvac-fan-${t.id}-${esc(f)}" onclick="Lutron.hvacSetFan(${t.id},'${esc(f)}')">${esc(f)}</button>`).join('')}
          </div>
        </div>
      </div>`;
  }

  function handleThermostatUpdate(t) {
    thermostatStates[t.id] = { ...thermostatStates[t.id], ...t };
    updateThermostatCard(thermostatStates[t.id]);
  }

  function updateThermostatCard(t) {
    const set = (id, v) => { if ($(id) && v != null) $(id).textContent = v; };
    set(`hvac-temp-${t.id}`, t.temperature);
    set(`hvac-state-${t.id}`, t.operatingState);
    set(`hvac-heat-${t.id}`, t.heatSetpoint);
    set(`hvac-cool-${t.id}`, t.coolSetpoint);

    HVAC_MODES.forEach((m) => {
      const btn = $(`hvac-mode-${t.id}-${m}`);
      if (btn) btn.className = `hvac-mode-btn${modeClass(m, t.mode)}`;
    });
    (t.supportedFanModes || DEFAULT_FAN_MODES).forEach((f) => {
      const btn = $(`hvac-fan-${t.id}-${f}`);
      if (btn) btn.className = `hvac-fan-btn${f === t.fanMode ? ' active' : ''}`;
    });
  }

  function hvacSetMode(id, mode) {
    handleThermostatUpdate({ id, mode });
    api('GET', `/hvac/mode?id=${id}&mode=${encodeURIComponent(mode)}`).catch((err) => ctx.toast(err.message, 'error'));
  }

  function hvacSetFan(id, mode) {
    handleThermostatUpdate({ id, fanMode: mode });
    api('GET', `/hvac/fan?id=${id}&mode=${encodeURIComponent(mode)}`).catch((err) => ctx.toast(err.message, 'error'));
  }

  function hvacAdjSetpoint(id, which, delta) {
    const t = thermostatStates[id] || {};
    const key = which === 'heat' ? 'heatSetpoint' : 'coolSetpoint';
    const current = typeof t[key] === 'number' ? t[key] : which === 'heat' ? 68 : 76;
    const next = current + delta;
    handleThermostatUpdate({ id, [key]: next });
    api('GET', `/hvac/${which}?id=${id}&setpoint=${next}`).catch((err) => ctx.toast(err.message, 'error'));
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  function initTabs(root) {
    root.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        root.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.tab));
      });
    });
  }

  window.Lutron = {
    startDiscovery, selectProcessor, selectManual, startPairing, reconnect, saveComponentName,
    refreshInventory, exportLighting, closeExport, downloadExport, reviewBeforeExport, setTypeFilter, clearZoneSearch,
    openPicker, closePicker, pickArea, pickLight, toggleLights, savePicker, resetPicker,
    addToZone, keepArea, readSavantZones, editSavantZones, closeSavantZones, saveSavantZones,
    reviewRooms, closeReview, pickReview, pickReviewOther, pickReviewLeaveOut, skipReview,
    updateSliderDisplay, setLevel, startAdjust, stopAdjust,
    pressButton, releaseButton, recallScene,
    openColorModal, closeColorModal, setColorMode, cmUpdatePreview, sendSpectrum,
    hvacSetMode, hvacSetFan, hvacAdjSetpoint,
  };

  SB.registerPanel('lutron', {
    init(context) {
      ctx = context;
      initTabs(ctx.root);
      $('zoneSearch').addEventListener('input', (e) => onZoneSearch(e.target.value));
      $('keypadSearch').addEventListener('input', (e) => renderKeypads(e.target.value));
      ctx.root.querySelector('.tab-btn[data-tab="rooms"]').addEventListener('click', loadRooms);
      $('ltPickerSearch').addEventListener('input', () => { if (picker) renderPicker(); });
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        closeColorModal();
        closePicker();
        closeReview();
        closeSavantZones();
        closeExport();
      });
    },

    onStateChange(integration) {
      const wasRunning = running;
      running = integration.running;
      if (running && !wasRunning) refresh();
      if (!running) updateStatus(false, false);
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'status':
          updateStatus(msg.connected, msg.ready);
          if (msg.ready) refresh();
          break;
        case 'zoneUpdate': handleZoneUpdate(msg.zone); break;
        case 'thermostatUpdate': handleThermostatUpdate(msg.thermostat); break;
        case 'ledUpdate': handleLedUpdate(msg.ledHref, msg.state); break;
        case 'buttonEvent': handleButtonEvent(msg.buttonHref, msg.event); break;
        default: break;
      }
    },
  });
})();
