/* =========================================================
   Solar Tracker dashboard: rendering, recording, comparison.
   Sensor communication lives in sources.js; storage in storage.js.
   ========================================================= */
(function () {
  'use strict';

  const { DemoSource, SerialSource } = window.SolarSources;
  const Store = window.SessionStore;

  /* ---------------- Constants ---------------- */
  const MAX_LIVE = 300;        // live window (samples)
  const STALE_MS = 5000;       // no valid sample for this long => stale
  const RECENT_ROWS = 20;

  const CONFIGS = {
    A: { name: 'Fixed panel',    sub: 'No reflectors',   short: 'Fixed',                 full: 'Fixed panel, no reflectors',    color: '#80868B', tracking: false, reflectors: false },
    B: { name: 'Fixed panel',    sub: 'With reflectors', short: 'Fixed + reflectors',    full: 'Fixed panel, with reflectors',  color: '#E37400', tracking: false, reflectors: true },
    C: { name: 'Tracking panel', sub: 'No reflectors',   short: 'Tracking',              full: 'Tracking panel, no reflectors', color: '#00857A', tracking: true,  reflectors: false },
    D: { name: 'Tracking panel', sub: 'With reflectors', short: 'Tracking + reflectors', full: 'Tracking panel, with reflectors', color: '#1A73E8', tracking: true, reflectors: true }
  };

  const LIVE_METRICS = {
    p: { name: 'Power',   unit: 'W',  dp: 3, color: '#00857A', fill: 'rgba(0,133,122,0.08)' },
    v: { name: 'Voltage', unit: 'V',  dp: 2, color: '#C25E00', fill: 'rgba(227,116,0,0.08)' },
    i: { name: 'Current', unit: 'mA', dp: 1, color: '#1A73E8', fill: 'rgba(26,115,232,0.08)' }
  };

  const COMPARE_METRICS = {
    avgP: { name: 'Average power',   unit: 'W',  dp: 3 },
    avgV: { name: 'Average voltage', unit: 'V',  dp: 2 },
    avgI: { name: 'Average current', unit: 'mA', dp: 1 }
  };

  const END_REASONS = {
    'source-switch': 'the data source was changed',
    'lost': 'the device disconnected',
    'disconnected': 'the data source was disconnected'
  };

  /* ---------------- State ---------------- */
  const state = {
    kind: 'demo',              // 'demo' | 'serial'
    source: null,
    sourceId: 0,
    conn: 'disconnected',      // 'connecting' | 'connected' | 'disconnected'
    connMsg: '',
    connLevel: 'info',
    live: [],
    lastAt: null,
    lastReading: null,
    ignored: 0,
    lastIgnored: null,
    trendMetric: 'p',
    paused: false,
    pausedAt: null,
    config: 'A',
    rec: null,
    sessions: [],
    selected: new Set(),
    compareMetric: 'avgP',
    baselineId: '',
    testId: '',
    lastSessionId: null,
    storageOk: true
  };

  let trendChart = null;
  let compareChart = null;
  let sourceSeq = 0;
  let switching = false;

  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);
  const dom = {};

  function cacheDom() {
    [
      'status', 'status-text', 'serial-controls', 'baud', 'connect-btn', 'help-btn', 'conn-message', 'conn-message-text',
      'meta-time', 'meta-source', 'meta-fresh', 'readings', 'val-p', 'val-v', 'val-i', 'flag-note', 'ignored-note', 'shade-toggle',
      'trend-tabs', 'trend-title', 'trend-chart', 'trend-empty', 'pause-btn', 'pause-state',
      'configs', 'config-lock-note', 'session-name', 'session-notes', 'rec-indicator', 'rec-label', 'rec-duration', 'rec-count',
      'rec-config', 'rec-start', 'rec-stop', 'rec-download', 'rec-hint',
      'export-all', 'clear-all', 'storage-note', 'storage-warn', 'sessions-body', 'sessions-empty',
      'compare-tabs', 'compare-sim-note', 'compare-box', 'compare-chart', 'compare-empty', 'compare-empty-title', 'compare-empty-body', 'coverage',
      'baseline-select', 'test-select', 'improve-result', 'improve-detail',
      'recent-details', 'recent-body', 'recent-empty',
      'help-dialog', 'confirm-dialog', 'confirm-h', 'confirm-body', 'confirm-ok', 'compat-serial', 'compat-secure', 'toasts'
    ].forEach((id) => {
      dom[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $(id);
    });
    dom.stateTags = Array.from(document.querySelectorAll('.reading [data-role="state"]'));
    dom.sessionsTableWrap = dom.sessionsBody.closest('.table-wrap');
    dom.recentTableWrap = dom.recentBody.closest('.table-wrap');
  }

  /* ---------------- Helpers ---------------- */
  function fmt(n, dp) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    let s = n.toFixed(dp);
    if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
    return s.replace('-', '−');
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtTime(t) {
    const d = new Date(t);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function fmtDateTime(t) {
    return new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s);
  }
  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function uid() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* insecure context */ }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }
  function el(tag, attrs) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (attrs[k] === null || attrs[k] === undefined || attrs[k] === false) continue;
        node.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c === null || c === undefined) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  const findSession = (id) => state.sessions.find((s) => s.id === id) || null;
  const sourceWord = (src) => (src === 'demo' ? 'demo' : 'hardware');

  /* ---------------- Toasts ---------------- */
  function toast(message, kind) {
    kind = kind || 'info';
    const prefix = { success: 'Done', info: 'Info', warn: 'Note', error: 'Problem' }[kind] || 'Info';
    const t = el('div', { class: 'toast toast-' + kind }, el('strong', null, prefix + ':'), message);
    dom.toasts.append(t);
    while (dom.toasts.children.length > 3) dom.toasts.firstElementChild.remove();
    setTimeout(() => t.remove(), kind === 'error' || kind === 'warn' ? 9000 : 4500);
  }

  /* ---------------- Dialogs ---------------- */
  function confirmDialog(title, body, okLabel) {
    const d = dom.confirmDialog;
    if (!d || typeof d.showModal !== 'function') return Promise.resolve(window.confirm(title + '\n\n' + body));
    dom.confirmH.textContent = title;
    dom.confirmBody.textContent = body;
    dom.confirmOk.textContent = okLabel || 'Confirm';
    d.returnValue = '';
    return new Promise((resolve) => {
      d.addEventListener('close', () => resolve(d.returnValue === 'confirm'), { once: true });
      d.showModal();
    });
  }

  /* =========================================================
     DATA SOURCES
     ========================================================= */
  function handlersFor(id) {
    return {
      onReading: (r) => { if (id === state.sourceId) onReading(r); },
      onStatus: (c, m, l) => { if (id === state.sourceId) onStatus(c, m, l); },
      onRejected: (line, reason) => { if (id === state.sourceId) onRejected(line, reason); }
    };
  }

  function serialProblem() {
    if (!SerialSource.secureContext) return 'USB Serial needs a secure page. Open this site via http://localhost or HTTPS (see README). Demo mode still works.';
    if (!SerialSource.supported) return 'This browser does not support Web Serial, so USB Serial is unavailable. Use desktop Chrome or Edge, or select Demo.';
    return null;
  }

  function resetLive() {
    state.live = [];
    state.lastAt = null;
    state.lastReading = null;
    state.ignored = 0;
    state.lastIgnored = null;
    if (trendChart) { trendChart.data.datasets[0].data = []; trendChart.update('none'); }
  }

  async function setSource(kind) {
    if (switching || kind === state.kind && state.source) return;
    if (state.rec) {
      const ok = await confirmDialog(
        'Stop recording and switch source?',
        'Switching the data source stops the current recording. Samples captured so far are kept and saved as a session.',
        'Stop and switch'
      );
      if (!ok) { syncSourceRadios(); return; }
    }
    switching = true;
    setSourceRadiosDisabled(true);
    try {
      if (state.rec) stopRecording('source-switch');
      const old = state.source;
      state.source = null;
      state.sourceId = ++sourceSeq;              // late events from the old source are ignored
      if (old) { try { await old.stop(); } catch (e) { /* ignore */ } }

      state.kind = kind;
      document.body.dataset.source = kind;
      resetLive();
      state.conn = 'disconnected';
      state.connLevel = 'info';
      state.connMsg = '';

      if (kind === 'demo') {
        const src = new DemoSource(handlersFor(state.sourceId));
        src.setShading(dom.shadeToggle.checked);
        state.source = src;
        await src.start();
      } else {
        const problem = serialProblem();
        state.connMsg = problem || 'Not connected. Close the Arduino Serial Monitor, then press Connect and choose the board’s port.';
        state.connLevel = problem ? 'error' : 'info';
      }
    } finally {
      switching = false;
      setSourceRadiosDisabled(false);
      syncSourceRadios();
      refreshAll();
    }
  }

  function syncSourceRadios() {
    document.querySelectorAll('input[name="source"]').forEach((r) => { r.checked = r.value === state.kind; });
  }
  function setSourceRadiosDisabled(dis) {
    document.querySelectorAll('input[name="source"]').forEach((r) => { r.disabled = dis; });
  }

  async function onConnectClick() {
    if (state.kind !== 'serial') return;
    if (state.conn === 'connected') {
      const src = state.source;
      if (src) await src.stop('Disconnected. Existing records were kept.');
      return;
    }
    if (state.conn === 'connecting') return;
    const problem = serialProblem();
    if (problem) { onStatus('disconnected', problem, 'error'); return; }
    state.sourceId = ++sourceSeq;
    const src = new SerialSource(handlersFor(state.sourceId), { baudRate: Number(dom.baud.value) || 115200 });
    state.source = src;
    state.ignored = 0;
    state.lastIgnored = null;
    await src.start();
  }

  function onStatus(conn, msg, level) {
    const wasConnected = state.conn === 'connected';
    state.conn = conn;
    state.connMsg = msg || '';
    state.connLevel = level || 'info';

    if (conn !== 'connected' && state.rec) {
      stopRecording(wasConnected && level === 'error' ? 'lost' : 'disconnected');
    }
    if (conn === 'disconnected' && state.kind === 'serial') state.source = null;

    if (level === 'error') toast(msg, 'error');
    else if (state.kind === 'serial' && conn === 'connected') toast(msg, 'info');
    else if (state.kind === 'serial' && conn === 'disconnected' && wasConnected) toast(msg, 'info');

    refreshAll();
  }

  function onReading(r) {
    const entry = { t: r.t, v: r.v, i: r.i, p: r.p, flags: r.flags, cfg: state.rec ? state.rec.config : null };
    state.live.push(entry);
    if (state.live.length > MAX_LIVE) state.live.shift();
    state.lastAt = r.t;
    state.lastReading = entry;
    if (state.rec) state.rec.samples.push({ t: r.t, v: r.v, i: r.i, p: r.p, flags: r.flags });

    renderReadings();
    pushTrendPoint(entry);
    renderRecent();
    renderStatus();
    renderRecLive();
  }

  function onRejected(line, reason) {
    state.ignored += 1;
    state.lastIgnored = { line: String(line || ''), reason };
    renderIgnored();
  }

  /* =========================================================
     LIVE READINGS + STATUS
     ========================================================= */
  function freshness() {
    if (state.conn === 'connecting') return 'connecting';
    if (state.conn !== 'connected') return 'disconnected';
    if (state.lastAt === null) return 'waiting';
    return Date.now() - state.lastAt > STALE_MS ? 'stale' : 'fresh';
  }

  function renderReadings() {
    const r = state.lastReading;
    setText(dom.valP, r ? fmt(r.p, 3) : '—');
    setText(dom.valV, r ? fmt(r.v, 2) : '—');
    setText(dom.valI, r ? fmt(r.i, 1) : '—');
    document.querySelectorAll('[data-live]').forEach((n) => {
      const k = n.getAttribute('data-live');
      setText(n, r ? fmt(r[k], k === 'p' ? 3 : k === 'v' ? 2 : 1) : '—');
    });

    const flags = r ? r.flags : [];
    const notes = [];
    if (flags.includes('negative-voltage')) notes.push('Negative voltage received (' + fmt(r.v, 2) + ' V).');
    if (flags.includes('negative-current')) notes.push('Negative current received (' + fmt(r.i, 1) + ' mA).');
    if (notes.length) notes.push('Values are shown exactly as received. Check sensor wiring and orientation.');
    if (flags.includes('power-mismatch')) notes.push('The Arduino’s power_W differs from voltage × current ÷ 1000. The dashboard uses its own calculation.');
    dom.flagNote.hidden = notes.length === 0;
    setText(dom.flagNote, notes.join(' '));
  }

  function renderStatus() {
    const f = freshness();
    const age = state.lastAt !== null ? Math.round((Date.now() - state.lastAt) / 1000) : null;
    const demo = state.kind === 'demo';

    let text;
    switch (f) {
      case 'fresh': text = demo ? 'Demo running · Fresh' : 'Connected · Fresh'; break;
      case 'stale': text = (demo ? 'Demo' : 'Connected') + ' · Stale'; break;
      case 'waiting': text = demo ? 'Demo · Waiting for data' : 'Connected · Waiting for data'; break;
      case 'connecting': text = 'Connecting'; break;
      default: text = demo ? 'Demo stopped' : 'Disconnected';
    }
    setText(dom.statusText, text);
    dom.status.dataset.state = f;

    setText(dom.metaTime, state.lastAt !== null ? fmtTime(state.lastAt) + (age >= 2 ? ' (' + age + ' s ago)' : '') : '—');
    setText(dom.metaSource, demo ? 'Demo (simulated)' : state.conn === 'connected' ? 'USB Serial · ' + dom.baud.value + ' baud' : 'USB Serial');

    const freshLabel = { fresh: 'Fresh', stale: 'Stale', waiting: 'Waiting', connecting: 'Connecting', disconnected: 'Disconnected' }[f];
    setText(dom.metaFresh, freshLabel);
    dom.metaFresh.dataset.state = f === 'connecting' ? 'waiting' : f;
    dom.readings.dataset.fresh = f;

    // Per-card tag: stale / disconnected-with-last-value / negative flag
    const r = state.lastReading;
    const tags = ['p', 'v', 'i'].map((k) => {
      if (!r) return ['', ''];
      if (f === 'stale') return ['Stale · ' + age + ' s old', ''];
      if (f === 'disconnected') return ['Last value · disconnected', ''];
      if ((k === 'v' && r.flags.includes('negative-voltage')) || (k === 'i' && r.flags.includes('negative-current')) ||
          (k === 'p' && (r.flags.includes('negative-voltage') || r.flags.includes('negative-current')))) return ['Negative · check', 'neg'];
      return ['', ''];
    });
    dom.stateTags.forEach((node, idx) => {
      setText(node, tags[idx][0]);
      if (tags[idx][1]) node.dataset.kind = tags[idx][1]; else delete node.dataset.kind;
    });

    // Connection controls
    const serial = state.kind === 'serial';
    dom.serialControls.hidden = !serial;
    const problem = serial ? serialProblem() : null;
    setText(dom.connectBtn, state.conn === 'connected' ? 'Disconnect' : state.conn === 'connecting' ? 'Connecting…' : 'Connect');
    dom.connectBtn.disabled = !!problem || state.conn === 'connecting';
    dom.connectBtn.classList.toggle('pill-dark', state.conn !== 'connected');
    dom.connectBtn.classList.toggle('pill-outline', state.conn === 'connected');
    dom.baud.disabled = state.conn !== 'disconnected';

    const showMsg = serial && state.connMsg && (state.conn !== 'connected' || state.connLevel === 'error');
    dom.connMessage.hidden = !showMsg;
    if (showMsg) {
      setText(dom.connMessageText, state.connMsg);
      dom.connMessage.dataset.level = state.connLevel;
    }
    renderIgnored();
  }

  function renderIgnored() {
    const show = state.kind === 'serial' && state.ignored > 0;
    dom.ignoredNote.hidden = !show;
    if (show) {
      const li = state.lastIgnored;
      const sample = li && li.line ? ' Last: “' + truncate(li.line, 60) + '” (' + li.reason + ').' : li ? ' Last: ' + li.reason + '.' : '';
      setText(dom.ignoredNote, 'Ignored ' + state.ignored + ' non-data line' + (state.ignored === 1 ? '' : 's') + ' from the serial port.' + sample);
    }
  }

  /* =========================================================
     LIVE TREND CHART
     ========================================================= */
  function initTrendChart() {
    if (!window.Chart) {
      dom.trendEmpty.innerHTML = '<p><strong>The chart library did not load.</strong> You may be offline. Readings, recording and CSV export still work. See README to bundle Chart.js locally.</p>';
      dom.pauseBtn.disabled = true;
      return;
    }
    const bodyFont = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.family = bodyFont;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = '#5F6368';

    trendChart = new Chart(dom.trendChart, {
      type: 'line',
      data: { datasets: [{ data: [], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 8, tension: 0.25, fill: 'origin' }] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        onResize: (chart, size) => { chart.options.scales.x.ticks.maxTicksLimit = size.width < 520 ? 4 : 7; },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: 'Time (local, HH:MM:SS)', font: { weight: '700' } },
            ticks: { callback: (v) => fmtTime(v), maxRotation: 0, autoSkip: true, maxTicksLimit: window.innerWidth < 520 ? 4 : 7 },
            grid: { color: 'rgba(17,17,17,0.06)' },
            border: { color: 'rgba(17,17,17,0.2)' }
          },
          y: {
            title: { display: true, text: '', font: { weight: '700' } },
            grace: '8%',
            grid: { color: 'rgba(17,17,17,0.06)' },
            border: { display: false }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#111111',
            titleColor: '#FFFFFF',
            bodyColor: '#FFFFFF',
            padding: 10,
            displayColors: false,
            callbacks: {
              title: (items) => (items.length ? 'Time ' + fmtTime(items[0].parsed.x) : ''),
              label: (item) => {
                const m = LIVE_METRICS[state.trendMetric];
                return m.name + ': ' + fmt(item.parsed.y, m.dp) + ' ' + m.unit;
              }
            }
          }
        }
      }
    });
    applyTrendMetric();
  }

  function applyTrendMetric() {
    const m = LIVE_METRICS[state.trendMetric];
    setText(dom.trendTitle, m.name + ' (' + m.unit + ') over time');
    if (!trendChart) return;
    const ds = trendChart.data.datasets[0];
    ds.borderColor = m.color;
    ds.backgroundColor = m.fill;
    ds.label = m.name;
    trendChart.options.scales.y.title.text = m.name + ' (' + m.unit + ')';
    rebuildTrend();
  }

  // Whole-second tick steps so the time axis never repeats the same label
  const TICK_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);
  function updateTimeTicks() {
    const d = trendChart.data.datasets[0].data;
    const ticks = trendChart.options.scales.x.ticks;
    const x = trendChart.options.scales.x;
    if (d.length < 2) {
      // With 0–1 points Chart.js would auto-range ±5 % of the epoch value; give it a sane 10 s window instead
      ticks.stepSize = 2000;
      x.min = d.length ? d[0].x - 5000 : undefined;
      x.max = d.length ? d[0].x + 5000 : undefined;
      return;
    }
    x.min = undefined;
    x.max = undefined;
    const span = d[d.length - 1].x - d[0].x;
    const target = span / Math.max(1, (ticks.maxTicksLimit || 7) - 1);
    ticks.stepSize = TICK_STEPS_MS.find((s) => s >= target) || 3600000;
  }

  function rebuildTrend() {
    if (!trendChart) return;
    const k = state.trendMetric;
    trendChart.data.datasets[0].data = state.live.map((e) => ({ x: e.t, y: e[k] }));
    updateTimeTicks();
    trendChart.update('none');
    dom.trendEmpty.hidden = state.live.length > 0;
  }

  function pushTrendPoint(e) {
    if (!trendChart) return;
    dom.trendEmpty.hidden = state.live.length > 0;
    if (state.paused) return;
    const data = trendChart.data.datasets[0].data;
    data.push({ x: e.t, y: e[state.trendMetric] });
    while (data.length > MAX_LIVE) data.shift();
    updateTimeTicks();
    trendChart.update('none');
  }

  function togglePause() {
    state.paused = !state.paused;
    state.pausedAt = state.paused ? Date.now() : null;
    setText(dom.pauseBtn, state.paused ? 'Resume chart' : 'Pause chart');
    dom.pauseState.hidden = !state.paused;
    setText(dom.pauseState, state.paused ? 'Chart paused at ' + fmtTime(state.pausedAt) : '');
    if (!state.paused) rebuildTrend();   // jump to the latest live window
  }

  /* =========================================================
     TABS (keyboard: arrows, Home, End)
     ========================================================= */
  function setupTabs(list, onSelect) {
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
      });
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.setAttribute('aria-labelledby', tab.id);
      if (focus) tab.focus();
      onSelect(tab.dataset.metric);
    }
    list.addEventListener('click', (e) => {
      const t = e.target.closest('[role="tab"]');
      if (t) select(t, false);
    });
    list.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      let n = null;
      if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = tabs.length - 1;
      if (n !== null) { e.preventDefault(); select(tabs[n], true); }
    });
  }

  /* =========================================================
     CONFIGURATION CARDS
     ========================================================= */
  function configSvg(c) {
    const tilt = c.tracking ? -22 : -8;
    const arc = c.tracking
      ? '<path d="M44 40 A40 40 0 0 1 116 40" fill="none" stroke="#fff" stroke-width="1.4" stroke-dasharray="3 5" opacity=".6"/><path d="M116 40 l-8 -2 l3.6 7 z" fill="#fff" opacity=".6"/>'
      : '';
    const refl = c.reflectors
      ? '<line x1="52" y1="72" x2="42" y2="50" stroke="#E8EAF7" stroke-width="4" stroke-linecap="round"/><line x1="108" y1="72" x2="118" y2="50" stroke="#E8EAF7" stroke-width="4" stroke-linecap="round"/>'
      : '';
    return '<svg viewBox="0 0 160 110" aria-hidden="true" focusable="false">' +
      '<circle cx="132" cy="22" r="16" fill="#F6A93B" opacity=".18"/><circle cx="132" cy="22" r="9" fill="#FFD08A"/>' + arc +
      '<line x1="6" y1="100" x2="154" y2="100" stroke="#fff" stroke-width="1.2" opacity=".35"/>' +
      '<line x1="80" y1="100" x2="80" y2="74" stroke="#C9CCE8" stroke-width="4" stroke-linecap="round"/>' +
      '<g transform="rotate(' + tilt + ' 80 72)">' + refl +
      '<rect x="50" y="67.5" width="60" height="9" rx="2" fill="#4B6FD0"/>' +
      '<line x1="65" y1="68" x2="65" y2="76" stroke="#fff" stroke-width="1" opacity=".55"/><line x1="80" y1="68" x2="80" y2="76" stroke="#fff" stroke-width="1" opacity=".55"/><line x1="95" y1="68" x2="95" y2="76" stroke="#fff" stroke-width="1" opacity=".55"/></g>' +
      '<circle cx="80" cy="72" r="2.6" fill="#fff"/>' +
      '</svg>';
  }

  function buildConfigCards() {
    Object.keys(CONFIGS).forEach((key) => {
      const c = CONFIGS[key];
      const label = document.createElement('label');
      label.className = 'work';
      label.dataset.config = key;
      label.style.setProperty('--cfg', c.color);
      label.setAttribute('data-cursor', 'Select');
      label.innerHTML =
        '<input type="radio" name="config" value="' + key + '"' + (key === state.config ? ' checked' : '') + '>' +
        '<span class="work-tile"><span class="work-letter">' + key + '</span>' + configSvg(c) + '<span class="work-check">Selected</span></span>' +
        '<span class="work-title">' + c.full + '</span>' +
        '<span class="work-meta">Configuration ' + key + ' · <span data-count="' + key + '">Not recorded</span></span>';
      dom.configs.append(label);
    });
    dom.configs.addEventListener('change', (e) => {
      if (e.target.name === 'config' && !state.rec) {
        state.config = e.target.value;
        renderConfigCards();
      }
    });
  }

  function renderConfigCards() {
    const src = state.kind === 'demo' ? 'demo' : 'hardware';
    dom.configs.querySelectorAll('.work').forEach((card) => {
      const key = card.dataset.config;
      const input = card.querySelector('input');
      input.checked = key === state.config;
      input.disabled = !!state.rec;
      card.classList.toggle('is-selected', key === state.config);
      card.classList.toggle('is-locked', !!state.rec);
      const n = state.sessions.filter((s) => s.config === key && s.source === src).length;
      setText(card.querySelector('[data-count]'), n ? n + ' ' + src + ' session' + (n === 1 ? '' : 's') : 'Not recorded (' + src + ')');
    });
    dom.configLockNote.hidden = !state.rec;
  }

  /* =========================================================
     RECORDING
     ========================================================= */
  function startRecording() {
    if (state.rec || state.conn !== 'connected') return;
    const now = Date.now();
    const config = state.config;
    const name = dom.sessionName.value.trim() || 'Config ' + config + ' run, ' + fmtTime(now);
    state.rec = {
      id: uid(),
      name,
      config,
      source: state.kind === 'demo' ? 'demo' : 'hardware',
      startedAt: now,
      samples: []
    };
    toast('Recording configuration ' + config + (state.kind === 'demo' ? ' (simulated data).' : '.'), 'info');
    renderConfigCards();
    renderRecUI();
  }

  function computeStats(samples, startedAt, endedAt) {
    let sv = 0, si = 0, sp = 0, peak = -Infinity;
    for (const s of samples) {
      sv += s.v; si += s.i; sp += s.p;           // mean power from individual samples
      if (s.p > peak) peak = s.p;
    }
    const n = samples.length;
    return {
      count: n,
      avgV: n ? sv / n : null,
      avgI: n ? si / n : null,
      avgP: n ? sp / n : null,
      peakP: n ? peak : null,
      durationS: Math.max(0, (endedAt - startedAt) / 1000)
    };
  }

  function stopRecording(reason) {
    const rec = state.rec;
    if (!rec) return;
    state.rec = null;
    const endedAt = Date.now();
    const auto = reason && reason !== 'manual';
    const why = auto ? END_REASONS[reason] || 'recording was interrupted' : null;

    if (!rec.samples.length) {
      toast((auto ? 'Recording stopped because ' + why + '. ' : 'Recording stopped. ') + 'No samples were captured, so nothing was saved.', 'warn');
      renderConfigCards();
      renderRecUI();
      return;
    }

    const session = {
      id: rec.id,
      name: rec.name,
      config: rec.config,
      source: rec.source,
      notes: dom.sessionNotes.value.trim(),
      startedAt: rec.startedAt,
      endedAt,
      endReason: auto ? 'Stopped automatically because ' + why + '.' : null,
      samples: rec.samples,
      stats: computeStats(rec.samples, rec.startedAt, endedAt)
    };
    dom.sessionName.value = '';
    addSession(session);
    if (auto) toast('Recording stopped because ' + why + '. The ' + session.stats.count + ' captured samples were kept and saved.', 'warn');
    else toast('“' + session.name + '” saved with ' + session.stats.count + ' samples.', 'success');
  }

  function lastSession() {
    return findSession(state.lastSessionId) || state.sessions[0] || null;
  }

  function renderRecLive() {
    const rec = state.rec;
    setText(dom.recDuration, rec ? fmtDuration((Date.now() - rec.startedAt) / 1000) : '—');
    setText(dom.recCount, rec ? String(rec.samples.length) : '—');
  }

  function renderRecUI() {
    const rec = state.rec;
    dom.recIndicator.dataset.state = rec ? 'recording' : 'idle';
    setText(dom.recLabel, rec ? 'REC · Recording configuration ' + rec.config + (rec.source === 'demo' ? ' (simulated)' : '') : 'Not recording');
    setText(dom.recConfig, rec ? rec.config : '—');
    renderRecLive();

    dom.recStart.disabled = !!rec || state.conn !== 'connected';
    dom.recStop.disabled = !rec;
    const last = lastSession();
    dom.recDownload.disabled = !last;
    setText(dom.recDownload, last ? 'Download CSV (last session)' : 'Download CSV');
    dom.sessionName.disabled = !!rec;

    let hint;
    if (rec) hint = 'Capturing every sample from ' + (rec.source === 'demo' ? 'the demo generator (simulated)' : 'the Arduino') + '. Pausing the chart does not stop recording.';
    else if (state.conn !== 'connected') hint = state.kind === 'serial' ? 'Start recording is unavailable until the Arduino is connected.' : 'Start recording is unavailable until the data source is running.';
    else if (!last) hint = 'Download CSV becomes available once a session has been recorded and stopped.';
    else hint = 'Last saved session: “' + last.name + '”.';
    setText(dom.recHint, hint);
  }

  /* =========================================================
     SESSIONS + STORAGE
     ========================================================= */
  async function loadSessions() {
    try {
      const all = await Store.getAll();
      state.sessions = (all || [])
        .filter((s) => s && s.id && Array.isArray(s.samples) && s.samples.length && CONFIGS[s.config])
        .map((s) => (s.stats ? s : Object.assign(s, { stats: computeStats(s.samples, s.startedAt, s.endedAt) })))
        .sort((a, b) => b.startedAt - a.startedAt);
    } catch (e) {
      state.storageOk = false;
      dom.storageWarn.hidden = false;
      dom.storageNote.hidden = true;
    }
  }

  async function addSession(session) {
    state.sessions.unshift(session);
    state.lastSessionId = session.id;
    if (!state.storageOk) session.unsaved = true;
    renderSessionsAll();
    if (!state.storageOk) return;
    try {
      const copy = Object.assign({}, session);
      delete copy.unsaved;
      await Store.put(copy);
    } catch (e) {
      session.unsaved = true;
      toast('Could not save to browser storage (' + (e && e.message ? e.message : e) + '). The session is kept for this page only. Export it as CSV now.', 'error');
      renderSessions();
    }
  }

  async function deleteSession(id) {
    const s = findSession(id);
    if (!s) return;
    const ok = await confirmDialog(
      'Delete “' + s.name + '”?',
      'Its ' + s.stats.count + ' samples will be permanently removed from this browser. Download the CSV first if you need it.',
      'Delete session'
    );
    if (!ok) return;
    try {
      if (state.storageOk && !s.unsaved) await Store.remove(id);
    } catch (e) {
      toast('Could not delete from browser storage: ' + (e && e.message ? e.message : e), 'error');
      return;
    }
    state.sessions = state.sessions.filter((x) => x.id !== id);
    state.selected.delete(id);
    if (state.baselineId === id) state.baselineId = '';
    if (state.testId === id) state.testId = '';
    if (state.lastSessionId === id) state.lastSessionId = null;
    renderSessionsAll();
    toast('Session deleted.', 'success');
  }

  async function clearAll() {
    const n = state.sessions.length;
    if (!n) return;
    const ok = await confirmDialog(
      'Clear all ' + n + ' session' + (n === 1 ? '' : 's') + '?',
      'Every recorded session will be permanently removed from this browser. Use “Export all sessions” first if you need the data.',
      'Clear all'
    );
    if (!ok) return;
    try {
      if (state.storageOk) await Store.clear();
    } catch (e) {
      toast('Could not clear browser storage: ' + (e && e.message ? e.message : e), 'error');
      return;
    }
    state.sessions = [];
    state.selected.clear();
    state.baselineId = '';
    state.testId = '';
    state.lastSessionId = null;
    renderSessionsAll();
    toast('All sessions cleared.', 'success');
  }

  function renderSessions() {
    const list = state.sessions;
    const body = dom.sessionsBody;
    body.textContent = '';
    dom.sessionsEmpty.hidden = list.length > 0;
    dom.sessionsTableWrap.hidden = list.length === 0;
    dom.exportAll.disabled = !list.length;
    dom.clearAll.disabled = !list.length;

    list.forEach((s) => {
      const c = CONFIGS[s.config];
      const st = s.stats;
      const cb = el('input', { type: 'checkbox', 'data-id': s.id, 'aria-label': 'Include “' + s.name + '” in comparison' });
      cb.checked = state.selected.has(s.id);

      const nameTd = el('td', null,
        el('span', { class: 's-name' }, s.name),
        el('span', { class: 's-sub' }, fmtDateTime(s.startedAt)));
      if (s.notes) nameTd.append(el('span', { class: 's-notes' }, s.notes));
      if (s.endReason) nameTd.append(el('span', { class: 's-end' }, s.endReason));
      if (s.unsaved) nameTd.append(el('span', { class: 's-end' }, 'Not stored in this browser. Export it.'));

      const cfgCell = el('div', { class: 'cfg-cell', style: '--cfg:' + c.color },
        el('span', { class: 'swatch', 'aria-hidden': 'true' }),
        el('div', null, el('strong', null, s.config), el('span', null, c.full)));

      const badge = s.source === 'demo'
        ? el('span', { class: 'badge badge-demo' }, 'Demo · simulated')
        : el('span', { class: 'badge badge-hw' }, 'Hardware');

      const actions = el('div', { class: 'row-actions' },
        el('button', { type: 'button', class: 'btn btn-text btn-sm', 'data-action': 'csv', 'data-id': s.id, 'aria-label': 'Download CSV for “' + s.name + '”' }, 'CSV'),
        el('button', { type: 'button', class: 'btn btn-danger-text btn-sm', 'data-action': 'delete', 'data-id': s.id, 'aria-label': 'Delete “' + s.name + '”' }, 'Delete'));

      body.append(el('tr', null,
        el('td', null, cb),
        nameTd,
        el('td', null, cfgCell),
        el('td', null, badge),
        el('td', { class: 'num' }, fmtDuration(st.durationS)),
        el('td', { class: 'num' }, String(st.count)),
        el('td', { class: 'num' }, fmt(st.avgV, 2)),
        el('td', { class: 'num' }, fmt(st.avgI, 1)),
        el('td', { class: 'num' }, fmt(st.avgP, 3)),
        el('td', { class: 'num' }, fmt(st.peakP, 3)),
        el('td', null, actions)));
    });
  }

  function renderSessionsAll() {
    renderSessions();
    renderCompare();
    renderImprovementSelects();
    renderConfigCards();
    renderRecUI();
  }

  /* =========================================================
     COMPARISON
     ========================================================= */
  const patternCache = {};
  function hatchPattern(color) {
    if (patternCache[color]) return patternCache[color];
    const c = document.createElement('canvas');
    c.width = c.height = 12;
    const g = c.getContext('2d');
    g.fillStyle = hexToRgba(color, 0.22);
    g.fillRect(0, 0, 12, 12);
    g.strokeStyle = color;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(-3, 3); g.lineTo(3, -3);
    g.moveTo(0, 12); g.lineTo(12, 0);
    g.moveTo(9, 15); g.lineTo(15, 9);
    g.stroke();
    patternCache[color] = g.createPattern(c, 'repeat');
    return patternCache[color];
  }

  function selectedSessions() {
    return state.sessions
      .filter((s) => state.selected.has(s.id))
      .sort((a, b) => a.config.localeCompare(b.config) || a.startedAt - b.startedAt);
  }

  function renderCompare() {
    const sel = selectedSessions();
    const sources = new Set(sel.map((s) => s.source));
    let problem = null;
    if (!state.sessions.length) {
      problem = ['Nothing to compare yet.', 'Record at least two sessions from the same data source, for example configuration A and configuration D, then tick them in the table.'];
    } else if (sel.length < 2) {
      problem = ['Select at least two sessions to compare.', sel.length === 1
        ? 'One session selected. Tick one more Compare box in the table.'
        : 'Use the Compare checkboxes in the table. Sessions must all be demo or all be hardware.'];
    } else if (sources.size > 1) {
      problem = ['Demo and hardware sessions can’t be compared together.', 'Simulated values would distort a hardware comparison. Untick the sessions from one of the two sources.'];
    } else if (!window.Chart) {
      problem = ['The chart library did not load.', 'You may be offline. The session table above still shows every average. See README to bundle Chart.js locally.'];
    }

    dom.compareEmpty.hidden = !problem;
    dom.compareBox.hidden = !!problem;
    dom.compareSimNote.hidden = !!problem || !sources.has('demo');
    if (problem) {
      setText(dom.compareEmptyTitle, problem[0]);
      setText(dom.compareEmptyBody, problem[1]);
    } else {
      drawCompare(sel);
    }
    renderCoverage(sel, sources);
  }

  function drawCompare(sel) {
    const key = state.compareMetric;
    const m = COMPARE_METRICS[key];
    const isDemo = sel[0].source === 'demo';
    const labels = sel.map((s) => [s.config + ': ' + CONFIGS[s.config].short, truncate(s.name, 26)]);
    const data = sel.map((s) => s.stats[key]);
    const bg = sel.map((s) => (isDemo ? hatchPattern(CONFIGS[s.config].color) : CONFIGS[s.config].color));
    const border = sel.map((s) => CONFIGS[s.config].color);
    const small = window.innerWidth < 600;

    if (!compareChart) {
      compareChart = new Chart(dom.compareChart, {
        type: 'bar',
        data: { labels: [], datasets: [{ data: [], borderWidth: 2, borderRadius: 6, maxBarThickness: 76 }] },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, font: { size: small ? 10 : 12 } } },
            y: { beginAtZero: true, grace: '10%', title: { display: true, text: '', font: { weight: '700' } }, grid: { color: 'rgba(17,17,17,0.07)' }, border: { display: false } }
          },
          plugins: {
            legend: { display: false },
            title: { display: false, text: '', color: '#7A4D00', font: { weight: '800', size: 12 }, align: 'start', padding: { bottom: 10 } },
            tooltip: {
              backgroundColor: '#111111', titleColor: '#FFFFFF', bodyColor: '#FFFFFF', padding: 10, displayColors: false,
              callbacks: {
                title: (items) => { const s = compareChart.$sessions[items[0].dataIndex]; return s ? s.name : ''; },
                label: (item) => { const mm = COMPARE_METRICS[state.compareMetric]; return mm.name + ': ' + fmt(item.parsed.y, mm.dp) + ' ' + mm.unit; },
                afterLabel: (item) => {
                  const s = compareChart.$sessions[item.dataIndex];
                  if (!s) return '';
                  return ['Config ' + s.config + ': ' + CONFIGS[s.config].full, s.stats.count + ' samples · ' + (s.source === 'demo' ? 'SIMULATED (demo)' : 'hardware')];
                }
              }
            }
          }
        }
      });
    }
    compareChart.$sessions = sel;
    compareChart.data.labels = labels;
    const ds = compareChart.data.datasets[0];
    ds.data = data;
    ds.backgroundColor = bg;
    ds.borderColor = border;
    ds.label = isDemo ? 'Simulated (demo) sessions' : 'Hardware sessions';
    compareChart.options.scales.y.title.text = m.name + ' (' + m.unit + ')';
    compareChart.options.plugins.title.display = isDemo;
    compareChart.options.plugins.title.text = 'SIMULATED DATA · hatched bars are from demo sessions';
    compareChart.options.scales.x.ticks.font.size = small ? 10 : 12;
    compareChart.update('none');
  }

  function renderCoverage(sel, sources) {
    dom.coverage.textContent = '';
    if (!sel.length) { dom.coverage.hidden = true; return; }
    dom.coverage.hidden = false;
    const src = sources.size === 1 ? Array.from(sources)[0] : null;
    Object.keys(CONFIGS).forEach((key) => {
      const c = CONFIGS[key];
      const nSel = sel.filter((s) => s.config === key).length;
      const existsAny = state.sessions.some((s) => s.config === key && (!src || s.source === src));
      const status = nSel
        ? el('span', null, nSel + ' session' + (nSel === 1 ? '' : 's') + ' in chart')
        : el('span', { class: 'nr' }, existsAny ? 'Recorded, not selected' : 'Not recorded' + (src ? ' (' + sourceWord(src) + ')' : ''));
      dom.coverage.append(el('li', { style: '--cfg:' + c.color }, el('strong', null, key + ': ' + c.short), status));
    });
  }

  /* ---------------- Improvement ---------------- */
  function optionLabel(s) {
    return s.config + ' · ' + truncate(s.name, 30) + ' (' + sourceWord(s.source) + ', ' + fmt(s.stats.avgP, 3) + ' W)';
  }

  function renderImprovementSelects() {
    if (state.baselineId && !findSession(state.baselineId)) state.baselineId = '';
    const base = findSession(state.baselineId);
    if (state.testId) {
      const t = findSession(state.testId);
      if (!t || (base && (t.source !== base.source || t.id === base.id))) state.testId = '';
    }

    const fill = (select, current, isTest) => {
      select.textContent = '';
      select.append(el('option', { value: '' }, state.sessions.length ? 'Choose a session' : 'No sessions recorded'));
      state.sessions.forEach((s) => {
        let disabled = false, suffix = '';
        if (isTest && base) {
          if (s.id === base.id) { disabled = true; suffix = ', is the baseline'; }
          else if (s.source !== base.source) { disabled = true; suffix = ', different source'; }
        }
        const opt = el('option', { value: s.id }, optionLabel(s) + suffix);
        opt.disabled = disabled;
        select.append(opt);
      });
      select.value = current || '';
      select.disabled = !state.sessions.length;
    };
    fill(dom.baselineSelect, state.baselineId, false);
    fill(dom.testSelect, state.testId, true);
    renderImprovement();
  }

  function renderImprovement() {
    const base = findSession(state.baselineId);
    const test = findSession(state.testId);
    let result = '—';
    let detail;
    if (!state.sessions.length) {
      detail = 'Record sessions first, then choose a baseline (for example A) and a test session (for example D) from the same data source.';
    } else if (!base || !test) {
      detail = 'Choose a baseline and a test session from the same data source.';
    } else if (base.source !== test.source) {
      result = 'N/A';
      detail = 'Demo and hardware sessions cannot be compared.';
    } else if (!(base.stats.avgP > 0)) {
      result = 'N/A';
      detail = 'Baseline mean power is ' + fmt(base.stats.avgP, 3) + ' W. A percentage change is undefined when the baseline is zero or negative.';
    } else {
      const pct = ((test.stats.avgP - base.stats.avgP) / base.stats.avgP) * 100;
      const mag = Math.abs(pct);
      result = mag < 0.05 ? '0.0%' : (pct > 0 ? '+' : '−') + mag.toFixed(1) + '%';
      const dir = mag < 0.05 ? 'about the same mean power as' : pct > 0 ? 'higher mean power than' : 'lower mean power than';
      detail = 'Mean power ' + fmt(base.stats.avgP, 3) + ' W (baseline, config ' + base.config + ') → ' + fmt(test.stats.avgP, 3) +
        ' W (test, config ' + test.config + '). The test session had ' + dir + ' the baseline.' +
        (base.source === 'demo' ? ' Derived from SIMULATED demo data.' : '');
    }
    setText(dom.improveResult, result);
    setText(dom.improveDetail, detail);
    renderBigStats();
  }

  /* =========================================================
     RECENT READINGS
     ========================================================= */
  function renderRecent() {
    if (!dom.recentDetails.open) return;
    const rows = state.live.slice(-RECENT_ROWS).reverse();
    dom.recentEmpty.hidden = rows.length > 0;
    dom.recentTableWrap.hidden = rows.length === 0;
    const frag = document.createDocumentFragment();
    rows.forEach((e) => {
      frag.append(el('tr', null,
        el('td', { class: 'tabular' }, fmtTime(e.t)),
        el('td', null, e.cfg ? e.cfg + ': ' + CONFIGS[e.cfg].short : 'Not recording'),
        el('td', { class: 'num' }, fmt(e.v, 2)),
        el('td', { class: 'num' }, fmt(e.i, 1)),
        el('td', { class: 'num' }, fmt(e.p, 3))));
    });
    dom.recentBody.textContent = '';
    dom.recentBody.append(frag);
  }

  /* =========================================================
     CSV EXPORT
     ========================================================= */
  const CSV_HEADER = ['timestamp_iso', 'elapsed_s', 'session_name', 'configuration', 'data_source', 'voltage_V', 'current_mA', 'power_W', 'notes'];

  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function numOut(n, d) { return Number.isFinite(n) ? String(Number(n.toFixed(d))) : ''; }

  function toCsv(sessions) {
    const lines = [CSV_HEADER.join(',')];
    sessions.forEach((s) => {
      const cfg = s.config + ': ' + CONFIGS[s.config].full;
      const src = s.source === 'demo' ? 'demo (simulated)' : 'hardware';
      s.samples.forEach((x) => {
        lines.push([
          new Date(x.t).toISOString(),
          ((x.t - s.startedAt) / 1000).toFixed(3),
          s.name, cfg, src,
          numOut(x.v, 4), numOut(x.i, 3), numOut(x.p, 6),
          s.notes || ''
        ].map(csvCell).join(','));
      });
    });
    return lines.join('\r\n') + '\r\n';
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
  }
  function stamp(t) {
    const d = new Date(t);
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  function download(filename, text) {
    try {
      const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Downloaded ' + filename, 'success');
    } catch (e) {
      toast('Download failed: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  function exportSession(s) {
    if (!s || !s.samples.length) return;
    const name = 'solar-tracker_SY-K-05_config-' + s.config + '_' + slug(s.name) + '_' + stamp(s.startedAt) + (s.source === 'demo' ? '_SIMULATED' : '_hardware') + '.csv';
    download(name, toCsv([s]));
  }

  function exportAll() {
    if (!state.sessions.length) return;
    const ordered = state.sessions.slice().sort((a, b) => a.startedAt - b.startedAt);
    download('solar-tracker_SY-K-05_all-sessions_' + stamp(Date.now()) + '.csv', toCsv(ordered));
  }

  /* =========================================================
     BIG NUMBERS (dark band) — derived only from recorded sessions
     ========================================================= */
  function renderBigStats() {
    const sessions = state.sessions.length;
    const samples = state.sessions.reduce((n, s) => n + s.stats.count, 0);
    setText(document.getElementById('stat-sessions'), sessions.toLocaleString());
    setText(document.getElementById('stat-samples'), samples.toLocaleString());
    const base = findSession(state.baselineId), test = findSession(state.testId);
    const cap = document.getElementById('stat-change-cap');
    setText(document.getElementById('stat-change'), dom.improveResult.textContent);
    setText(cap, base && test
      ? 'mean power change, config ' + test.config + ' vs. config ' + base.config + (base.source === 'demo' ? ' (simulated)' : '')
      : 'mean power change, once you choose a baseline and test session below');
  }

  /* =========================================================
     WIRING
     ========================================================= */
  function refreshAll() {
    renderReadings();
    renderStatus();
    renderRecUI();
    renderConfigCards();
    if (!state.paused) rebuildTrend();
    renderRecent();
    if (!trendChart) dom.trendEmpty.hidden = false;
  }

  function bindEvents() {
    document.querySelectorAll('input[name="source"]').forEach((r) => {
      r.addEventListener('change', () => { if (r.checked) setSource(r.value); });
    });
    dom.connectBtn.addEventListener('click', onConnectClick);
    dom.shadeToggle.addEventListener('change', () => {
      if (state.source instanceof DemoSource) state.source.setShading(dom.shadeToggle.checked);
    });

    dom.helpBtn.addEventListener('click', () => {
      const d = dom.helpDialog;
      if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    });
    dom.helpDialog.querySelector('[data-close]').addEventListener('click', () => {
      if (typeof dom.helpDialog.close === 'function') dom.helpDialog.close(); else dom.helpDialog.removeAttribute('open');
    });

    setupTabs(dom.trendTabs, (metric) => { state.trendMetric = metric; applyTrendMetric(); });
    dom.pauseBtn.addEventListener('click', togglePause);

    dom.recStart.addEventListener('click', startRecording);
    dom.recStop.addEventListener('click', () => stopRecording('manual'));
    dom.recDownload.addEventListener('click', () => exportSession(lastSession()));

    dom.exportAll.addEventListener('click', exportAll);
    dom.clearAll.addEventListener('click', clearAll);

    dom.sessionsBody.addEventListener('change', (e) => {
      const cb = e.target;
      if (cb.type !== 'checkbox' || !cb.dataset.id) return;
      if (cb.checked) state.selected.add(cb.dataset.id); else state.selected.delete(cb.dataset.id);
      renderCompare();
    });
    dom.sessionsBody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'csv') exportSession(findSession(btn.dataset.id));
      else if (btn.dataset.action === 'delete') deleteSession(btn.dataset.id);
    });

    setupTabs(dom.compareTabs, (metric) => { state.compareMetric = metric; renderCompare(); });

    dom.baselineSelect.addEventListener('change', () => { state.baselineId = dom.baselineSelect.value; renderImprovementSelects(); });
    dom.testSelect.addEventListener('change', () => { state.testId = dom.testSelect.value; renderImprovement(); });

    dom.recentDetails.addEventListener('toggle', renderRecent);

    window.addEventListener('beforeunload', (e) => {
      if (state.rec) { e.preventDefault(); e.returnValue = ''; }
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (compareChart && !dom.compareBox.hidden) renderCompare(); }, 200);
    });
  }

  function renderCompat() {
    const sup = SerialSource.supported, sec = SerialSource.secureContext;
    dom.compatSerial.textContent = sup ? 'Supported' : 'Not supported';
    dom.compatSerial.dataset.ok = String(sup);
    dom.compatSecure.textContent = sec ? 'Yes' : 'No (open via localhost)';
    dom.compatSecure.dataset.ok = String(sec);
  }

  async function init() {
    cacheDom();
    buildConfigCards();
    renderCompat();
    initTrendChart();
    bindEvents();
    await loadSessions();
    renderSessionsAll();
    await setSource('demo');
    setInterval(() => { renderStatus(); renderRecLive(); }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
