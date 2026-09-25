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
  }

  async function refresh() {
    try {
      const status = await api('GET', '/status');
      showPairedInfo(status);
      updateStatus(status.connected, status.ready);
      if (status.ready) loadInventory();

      const cfg = await api('GET', '/config');
      if (cfg.componentName) $('componentNameInput').value = cfg.componentName;
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

  async function saveComponentName() {
    await post('/config', { componentName: $('componentNameInput').value.trim() });
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
  }

  function refreshInventory() {
    inventory = null;
    loadInventory();
  }

  function exportLighting() {
    window.location.href = '/api/lutron/export/lighting';
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

  const ledId = (href) => (href ? `led-${href.replace(/\//g, '-').replace(/^-/, '')}` : '');

  function renderKeypads(filter = '') {
    const container = $('keypadsContent');
    if (!inventory) return;

    const lc = filter.toLowerCase();
    const areaMap = new Map();
    for (const bg of inventory.buttonGroups) {
      if (filter && !bg.deviceName.toLowerCase().includes(lc) && !bg.areaName.toLowerCase().includes(lc)) continue;
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
        <div class="keypad-grid">
          ${groups.map((bg) => `
            <div class="keypad-card${bg.buttons.length > 5 ? ' wide' : ''}">
              <div class="keypad-title">${esc(bg.deviceName)}</div>
              <div class="zone-id" style="margin-bottom:10px">Device ID: ${bg.deviceId}</div>
              <div class="button-grid${bg.buttons.length > 5 ? ' multi-col' : ''}">
                ${bg.buttons.map((btn) => `
                  <button class="keypad-btn"
                    onmousedown="Lutron.pressButton('${esc(btn.href)}')"
                    onmouseup="Lutron.releaseButton('${esc(btn.href)}')"
                    onmouseleave="Lutron.releaseButton('${esc(btn.href)}')"
                    ontouchstart="Lutron.pressButton('${esc(btn.href)}')"
                    ontouchend="Lutron.releaseButton('${esc(btn.href)}')">
                    <span class="keypad-btn-label">
                      <span class="keypad-btn-name">${esc(btn.name || 'Button ' + btn.number)}</span>
                      <span class="keypad-btn-num">Button ${btn.number ?? btn.id}</span>
                    </span>
                    <span class="keypad-btn-led ${ledStates[btn.ledHref] === 'On' ? 'on' : ''}" id="${ledId(btn.ledHref)}"></span>
                  </button>`).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>`).join('');
  }

  function handleLedUpdate(ledHref, state) {
    ledStates[ledHref] = state;
    const el = $(ledId(ledHref));
    if (el) el.classList.toggle('on', state === 'On');
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
    refreshInventory, exportLighting, setTypeFilter, clearZoneSearch,
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
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeColorModal(); });
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
        default: break;
      }
    },
  });
})();
