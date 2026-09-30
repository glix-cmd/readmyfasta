// READMYFASTA — interfaz. El análisis pesado vive en src/js/worker.js (Pyodide) y src/py/core.py.
// Regla de seguridad: todo lo que procede de un archivo del usuario se inserta con textContent o escapeHtml().
'use strict';

(() => {
  const APP_VERSION = '2.4.1';
  const $ = (id) => document.getElementById(id);
  const I18N = window.I18N;

  // ------------------------------------------------------------------ utilidades
  // Icono del sprite SVG de index.html (hereda color del texto, sin emojis)
  function icon(name, cls = 'icon') {
    return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* modo privado */ } },
  };
  function fmtBytes(b) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${fmtN(b, i ? 1 : 0)} ${u[i]}`;
  }
  function fmtBases(n) {
    if (n >= 1e9) return `${fmtN(n / 1e9, 2)} Gb`;
    if (n >= 1e6) return `${fmtN(n / 1e6, 2)} Mb`;
    if (n >= 1e4) return `${fmtN(n / 1e3, 1)} kb`;
    return fmtN(n);
  }
  function baseName(name) { return String(name || 'datos').replace(/(\.gz|\.bgz)$/i, '').replace(/\.[^.]+$/, '') || 'datos'; }
  function downloadBlob(blob, filename) {
    setTimeout(() => toast(t('toastExport', filename)), 50);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const loadedScripts = {};
  function loadScript(src) {
    if (!loadedScripts[src]) {
      loadedScripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
        document.head.appendChild(s);
      });
    }
    return loadedScripts[src];
  }

  // ------------------------------------------------------------------ avisos flotantes (toasts)
  function toast(message, opts = {}) {
    const box = $('toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    if (opts.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opts.action;
      b.addEventListener('click', () => { if (opts.onAction) opts.onAction(); close(); });
      el.appendChild(b);
    }
    box.appendChild(el);
    let timer = null;
    function close() {
      clearTimeout(timer);
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 220);
    }
    if (!opts.sticky) timer = setTimeout(close, opts.timeout || 3200);
    return close;
  }

  // ------------------------------------------------------------------ i18n
  let LANG = storage.get('rmf-lang') || ((navigator.language || 'es').toLowerCase().startsWith('en') ? 'en' : 'es');
  window.APP_LANG = LANG;
  function t(key, ...args) {
    const entry = (I18N[LANG] && I18N[LANG][key] !== undefined) ? I18N[LANG][key] : I18N.es[key];
    if (entry === undefined) return key;
    return typeof entry === 'function' ? entry(...args) : entry;
  }
  function applyStaticI18n(root = document) {
    document.documentElement.lang = LANG;
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  }

  // ------------------------------------------------------------------ estado
  const state = {
    kind: null, result: null, fileName: '', isFastq: false, alphabet: 'dna',
    page: 0, total: 0, threshold: 20, bam: null, busy: false,
  };
  const PAGE_SIZE = 25;
  const charts = {};
  let viewer3d = null;

  // ------------------------------------------------------------------ motor (Web Worker)
  const engine = { worker: null, ready: false, seq: 0, pending: new Map(), readyPromise: null, onProgress: null };

  function startEngine() {
    const pip = $('enginePip');
    pip.className = 'pip busy';
    $('engineText').textContent = t('engineLoading');
    engine.ready = false;
    let resolveReady, rejectReady;
    engine.readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    engine.readyPromise.catch(() => {});
    try {
      engine.worker = new Worker('src/js/worker.js');
    } catch (err) {
      $('engineText').textContent = t('engineError', err.message);
      rejectReady(err);
      return;
    }
    engine.worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        engine.ready = true;
        pip.className = 'pip ok';
        $('engineText').textContent = t('engineReady');
        resolveReady();
      } else if (data.type === 'fatal') {
        pip.className = 'pip';
        $('engineText').textContent = t('engineError', data.message);
        rejectReady(new Error(data.message));
      } else if (data.type === 'progress') {
        if (engine.onProgress) engine.onProgress(data.fraction);
      } else {
        const p = engine.pending.get(data.id);
        if (!p) return;
        engine.pending.delete(data.id);
        if (data.type === 'error') p.reject(new Error(data.message));
        else p.resolve(data);
      }
    };
    engine.worker.onerror = (e) => {
      if (!engine.ready) {
        $('engineText').textContent = t('engineError', e.message || 'worker');
        rejectReady(new Error(e.message));
        return;
      }
      // Caída en pleno análisis (típicamente falta de memoria en WebAssembly): se rechazan
      // los trabajos pendientes con un error comprensible y se arranca un motor limpio.
      e.preventDefault();
      restartAfterCrash();
    };
  }

  class UserError extends Error {
    constructor(code, info) { super(code); this.code = code; this.info = info || {}; }
  }

  async function call(cmd, args) {
    await engine.readyPromise;
    const msg = await new Promise((resolve, reject) => {
      const id = ++engine.seq;
      engine.pending.set(id, { resolve, reject });
      engine.worker.postMessage({ id, cmd, args });
    });
    const parsed = JSON.parse(msg.json);
    if (parsed && parsed.error) throw new UserError(parsed.error, parsed.info);
    return { data: parsed, bytes: msg.bytes };
  }

  function restartAfterCrash() {
    engine.pending.forEach((p) => p.reject(new UserError('worker_crash')));
    engine.pending.clear();
    try { engine.worker.terminate(); } catch (_) { /* ya estaba detenido */ }
    startEngine();
  }
  function cancelEngine() {
    engine.worker.terminate();
    engine.pending.forEach((p) => p.reject(new UserError('cancelled')));
    engine.pending.clear();
    startEngine();
  }

  // ------------------------------------------------------------------ errores y avisos
  function showError(msg) {
    const box = $('dropError');
    box.textContent = msg;
    box.hidden = false;
  }
  function clearError() { $('dropError').hidden = true; $('dropError').textContent = ''; }
  function userErrorMessage(err, fileName) {
    if (err instanceof UserError) {
      if (err.code === 'zip' && /\.docx$/i.test(fileName || '')) return t('err_docx');
      if (err.code === 'zip' && /\.xlsx$/i.test(fileName || '')) return t('err_xlsx');
      const key = `err_${err.code}`;
      if (I18N.es[key] !== undefined) return t(key, err.info);
      return t('err_generic', err.code);
    }
    return t('err_generic', err && err.message ? err.message : String(err));
  }
  function renderWarnings(list) {
    const box = $('warnings');
    box.innerHTML = '';
    (list || []).forEach((w) => {
      const key = `warn_${w.code}`;
      if (I18N.es[key] === undefined) return;
      const p = document.createElement('p');
      p.className = 'warn';
      p.setAttribute('role', 'status');
      p.innerHTML = icon('alert');
      const span = document.createElement('span');
      span.textContent = t(key, w);
      p.appendChild(span);
      box.appendChild(p);
    });
  }

  // ------------------------------------------------------------------ carga de archivos
  const INDEX_RE = /\.(bai|csi|crai|tbi|fai|gzi)$/i;
  const ALIGN_RE = /\.(bam|sam)$/i;

  async function sniff(file) {
    const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    const b = (i) => head[i];
    const ascii = (n) => String.fromCharCode(...head.slice(0, n));
    const out = { type: 'text', text: '' };
    if (head.length === 0) return { type: 'empty' };
    if (b(0) === 0x1f && b(1) === 0x8b) {
      out.type = 'gzip';
      if ('DecompressionStream' in window) {
        try {
          const ds = new Blob([head]).stream().pipeThrough(new DecompressionStream('gzip'));
          const reader = ds.getReader();
          const chunks = [];
          let size = 0;
          while (size < 8192) {
            const { value, done } = await reader.read();
            if (done) break;
            chunks.push(value); size += value.length;
          }
          reader.cancel().catch(() => {});
          const inner = new Uint8Array(size);
          let off = 0;
          chunks.forEach((c) => { inner.set(c, off); off += c.length; });
          if (inner[0] === 0x42 && inner[1] === 0x41 && inner[2] === 0x4d && inner[3] === 1) return { type: 'bam' };
          out.text = new TextDecoder('utf-8', { fatal: false }).decode(inner);
        } catch (_) {
          // Solo es una vista previa: un gzip multi-miembro o recortado se analiza igualmente en Python.
        }
      }
      return out;
    }
    const magic4 = ascii(4);
    if (magic4 === 'PK\u0003\u0004') return { type: 'zip' };
    if (magic4 === '%PDF') return { type: 'pdf' };
    if (magic4 === 'ABIF') return { type: 'ab1' };
    if (magic4 === 'CRAM') return { type: 'cram' };
    if (magic4 === 'BAI\u0001') return { type: 'bai' };
    out.text = new TextDecoder('utf-8', { fatal: false }).decode(head.slice(0, 8192));
    return out;
  }

  function showPreview(file, info) {
    const fmt = info.type === 'gzip' ? t('fmtGzip') : info.type === 'bam' ? t('fmtBam') : t('fmtText');
    $('previewMeta').textContent = t('detected', fmt, fmtBytes(file.size)) + (file.size > 2 * 1024 ** 3 ? ` · ${t('bigFileWarn')}` : '');
    const lines = (info.text || '').replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, 8)
      .map((l) => (l.length > 160 ? `${l.slice(0, 160)}…` : l));
    $('previewText').textContent = lines.join('\n');
    $('previewText').hidden = !info.text;
    document.querySelector('.preview-title').hidden = !info.text;
    $('previewBox').hidden = false;
  }

  async function routeFiles(fileList) {
    if (state.busy) return;
    const files = [...fileList];
    if (!files.length) return;
    clearError();
    const main = files.find((f) => ALIGN_RE.test(f.name)) || files.find((f) => !INDEX_RE.test(f.name)) || files[0];
    const index = files.find((f) => f !== main && INDEX_RE.test(f.name));
    const info = await sniff(main);
    const blockers = { zip: 'zip', pdf: 'pdf', ab1: 'ab1', cram: 'cram', bai: 'is_bai', empty: 'empty' };
    if (blockers[info.type] || (INDEX_RE.test(main.name) && !ALIGN_RE.test(main.name))) {
      $('previewBox').hidden = true;
      return showError(userErrorMessage(new UserError(blockers[info.type] || 'is_bai'), main.name));
    }
    showPreview(main, info);
    state.fileName = main.name;
    if (info.type === 'bam' || ALIGN_RE.test(main.name)) return handleBam(main, index);
    return handleText(main);
  }

  function setBusy(on, name) {
    state.busy = on;
    $('progressBox').hidden = !on;
    document.querySelectorAll('[data-example], #pasteBtn').forEach((b) => { b.disabled = on; });
    if (on) {
      $('progressLabel').textContent = engine.ready ? t('processing', name) : `${t('processing', name)} ${t('engineQueued')}`;
      $('progressBar').removeAttribute('aria-valuenow');
      $('progressFill').style.width = '0%';
      $('progressBox').classList.add('indeterminate');
    }
  }

  async function handleText(file) {
    setBusy(true, file.name);
    const started = performance.now();
    engine.onProgress = (fraction) => {
      const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      $('progressBox').classList.remove('indeterminate');
      $('progressFill').style.width = `${pct}%`;
      $('progressBar').setAttribute('aria-valuenow', String(pct));
      $('progressLabel').textContent = t('progressPct', file.name, pct);
    };
    try {
      const { data } = await call('load', { file });
      renderResult(data);
      afterLoad(file, (performance.now() - started) / 1000);
    } catch (err) {
      if (err instanceof UserError && (err.code === 'is_bam' || err.code === 'is_sam')) {
        setBusy(false);
        await handleBam(file, null);
        return;
      }
      if (err instanceof UserError && err.code === 'cancelled') showError(t('cancelled'));
      else { showError(userErrorMessage(err, file.name)); if (!(err instanceof UserError)) console.error(err); }
    } finally {
      engine.onProgress = null;
      setBusy(false);
    }
  }

  const KIND_ICON = { sequence: 'dna', tabular: 'table', structure: 'box', bam: 'reads' };
  function afterLoad(file, seconds) {
    const name = file.name;
    state.fileInfo = { name, size: file.size, seconds };
    $('results').classList.remove('hidden');
    $('emptyNote').classList.add('hidden');
    $('dropzone').classList.add('ready');
    $('dzTitle').textContent = t('loaded', name);
    $('previewBox').hidden = true;
    document.body.classList.add('has-results');
    renderFileBar();
    setLoaderOpen(false);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('main').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }
  function renderFileBar() {
    const info = state.fileInfo;
    if (!info) return;
    const s = state.result && state.result.summary;
    const label = state.kind === 'bam' ? 'BAM' : (s && s.kind_label) || '';
    const count = s ? (s.count ?? s.n_rows ?? s.atoms) : null;
    const kindIcon = state.kind === 'sequence' && state.isFastq ? 'flask'
      : state.kind === 'sequence' && state.alphabet === 'protein' ? 'atom' : (KIND_ICON[state.kind] || 'file');
    $('fbIcon').innerHTML = icon(kindIcon);
    $('fbName').textContent = info.name;
    const meta = [];
    if (label) meta.push(`<span class="badge">${escapeHtml(label)}${s && s.compressed ? ' · gz' : ''}</span>`);
    meta.push(escapeHtml(fmtBytes(info.size)));
    if (count !== null && count !== undefined && state.kind !== 'structure') meta.push(escapeHtml(t('fbRecords', fmtN(count))));
    if (info.seconds !== undefined) meta.push(escapeHtml(t('fbAnalysedIn', fmtN(info.seconds, 1))));
    $('fbMeta').innerHTML = meta.join('<span aria-hidden="true">·</span>');
    $('fileBar').hidden = false;
  }
  function setLoaderOpen(open) {
    const hasFile = !!state.fileInfo;
    $('loaderBody').hidden = hasFile && !open;
    $('loaderExtras').hidden = hasFile && !open;
    const btn = $('loadAnotherBtn');
    btn.setAttribute('aria-expanded', String(!!open));
    btn.querySelector('[data-i18n]').dataset.i18n = open ? 'hideLoader' : 'loadAnother';
    btn.querySelector('[data-i18n]').textContent = t(open ? 'hideLoader' : 'loadAnother');
  }

  // ------------------------------------------------------------------ pestañas accesibles
  const tabButtons = () => [...document.querySelectorAll('.tab-btn')];
  function activateTab(name, focus) {
    tabButtons().forEach((btn) => {
      const on = btn.dataset.tab === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      if (on && focus) btn.focus();
    });
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    if (name === 'graficos') requestAnimationFrame(() => Object.values(charts).forEach((c) => c && c.resize()));
  }
  function setAvailableTabs(tabs) {
    const all = [...tabs, 'formatos'];
    tabButtons().forEach((btn) => { btn.hidden = !all.includes(btn.dataset.tab); });
    const active = document.querySelector('.tab-btn.active');
    if (!active || !all.includes(active.dataset.tab)) activateTab(all[0]);
  }
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) activateTab(btn.dataset.tab);
  });
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    const visible = tabButtons().filter((b) => !b.hidden);
    const i = visible.indexOf(document.activeElement);
    if (i < 0) return;
    let next = null;
    if (e.key === 'ArrowRight') next = visible[(i + 1) % visible.length];
    else if (e.key === 'ArrowLeft') next = visible[(i - 1 + visible.length) % visible.length];
    else if (e.key === 'Home') next = visible[0];
    else if (e.key === 'End') next = visible[visible.length - 1];
    if (next) { e.preventDefault(); activateTab(next.dataset.tab, true); }
  });

  // ------------------------------------------------------------------ render por tipo
  function renderResult(result) {
    state.result = result;
    state.kind = result.kind;
    renderWarnings(result.warnings);
    destroyCharts();
    $('volcanoBox').classList.add('hidden');
    $('chartsSequence').hidden = result.kind !== 'sequence';
    $('chartsError').innerHTML = '';
    $('listSequence').hidden = result.kind !== 'sequence';
    $('listAlt').innerHTML = '';
    $('qualityThresholdBar').classList.add('hidden');
    if (result.kind === 'sequence') return renderSequence(result);
    if (result.kind === 'tabular') return renderTabular(result);
    if (result.kind === 'structure') return renderStructure(result);
    return null;
  }

  function renderSequence(result) {
    const s = result.summary;
    state.isFastq = !!s.is_fastq;
    state.alphabet = s.alphabet;
    state.total = s.listed;
    state.page = 0;
    $('qualityThresholdBar').classList.toggle('hidden', !state.isFastq);
    const protein = s.alphabet === 'protein';
    $('colLenHeader').dataset.i18n = protein ? 'colLenAa' : 'colLenBp';
    $('colLenHeader').textContent = t($('colLenHeader').dataset.i18n);
    $('colGcHeader').hidden = protein;
    $('qualHeader').classList.toggle('hidden', !state.isFastq);
    document.querySelectorAll('.fastq-only').forEach((el) => { el.hidden = !state.isFastq; });
    document.querySelectorAll('.nuc-only').forEach((el) => { el.hidden = protein; });
    $('motifBothWrap').hidden = protein;
    $('motifPresets').hidden = protein;
    $('motifHelp').dataset.i18n = protein ? 'motifHelpProtein' : 'motifHelp';
    $('motifHelp').innerHTML = t($('motifHelp').dataset.i18n);
    $('exMinLen').value = 0; $('exMaxLen').value = 0; $('exMinQual').value = 0; $('exMaxEE').value = 0;
    $('motifResults').innerHTML = ''; $('searchBody').innerHTML = ''; $('searchInfo').textContent = '';
    renderSummary();
    drawPage();
    renderSequenceCharts();
    updateExportCmd();
    renderRun();
    const tabs = ['lista', 'buscar', 'motivo', 'graficos', 'exportar'];
    if (state.isFastq && (result.run || result.duplication)) tabs.splice(3, 0, 'run');
    setAvailableTabs(tabs);
  }

  // --- tarjetas de resumen
  function qualityVerdict(avg, threshold) {
    if (avg >= threshold + 10) return { cls: 'v-good', icon: icon('check-circle'), label: t('verdictExcellent') };
    if (avg >= threshold) return { cls: 'v-good', icon: icon('check-circle'), label: t('verdictGood') };
    if (avg >= threshold - 5) return { cls: 'v-fair', icon: icon('alert'), label: t('verdictFair') };
    return { cls: 'v-low', icon: icon('x-circle'), label: t('verdictLow') };
  }
  function card(label, value, opts = {}) {
    const tip = opts.tip
      ? `<details class="tip"><summary aria-label="${escapeHtml(t('tipAria', label))}">${icon('info')}</summary><p>${escapeHtml(t(opts.tip))}</p></details>` : '';
    const sub = opts.sub ? `<div class="sub-value">${opts.sub}</div>` : '';
    return `<div class="stat-card ${opts.cls || ''}"><div class="label-row"><span class="label">${escapeHtml(label)}</span>${tip}</div><div class="value">${value}</div>${sub}</div>`;
  }
  function renderSummary() {
    const s = state.result.summary;
    const protein = s.alphabet === 'protein';
    const unit = protein ? t('unitAa') : t('unitBp');
    const volume = [
      card(state.isFastq ? t('statReads') : t('statSeqs'), fmtN(s.count)),
      card(protein ? t('statTotalAa') : t('statTotalBp'), escapeHtml(fmtBases(s.total_bp))),
      card(t('statAvgLen'), `${fmtN(s.avg_len)} ${unit}`, { sub: `${t('statMedian')}: ${fmtN(s.median)} · ${t('statMinMax')}: ${fmtN(s.min_len)}–${fmtN(s.max_len)}` }),
    ];
    const composition = [];
    const quality = [];
    const library = [];
    const groups = [[t('groupVolume'), volume], [t('groupComposition'), composition], [t('groupQuality'), quality], [t('groupLibrary'), library]];
    if (!state.isFastq) volume.push(card(t('statN50'), `${fmtN(s.n50)} ${unit}`, { tip: 'tipN50', sub: `L50: ${fmtN(s.l50)}` }));
    if (!protein) {
      composition.push(card(t('statGC'), `${fmtN(s.avg_gc, 2)} %`, { tip: 'tipGC' }));
      composition.push(card(t('statPctN'), `${fmtN(s.pct_n, 3)} %`, { tip: 'tipPctN' }));
      if (s.pct_softmasked) composition.push(card(t('statSoftmasked'), `${fmtN(s.pct_softmasked, 2)} %`, { tip: 'tipSoftmasked' }));
    }
    if (s.n_dup_ids) {
      composition.push(card(t('statDupIds'), fmtN(s.n_dup_ids), { tip: 'tipDupIds', cls: 'v-fair',
        sub: escapeHtml((s.dup_ids || []).slice(0, 3).map((d) => `${d.id} ×${d.count}`).join(' · ')) }));
    }
    if (state.isFastq) {
      const v = qualityVerdict(s.avg_quality, state.threshold);
      quality.push(card(t('statQual'), `${v.icon} ${fmtN(s.avg_quality, 2)}`,
        { tip: 'tipQual', cls: v.cls, sub: `${escapeHtml(v.label)} · ${t('threshold')} ${state.threshold}` }));
      quality.push(card(t('statQ30'), `${fmtN(s.pct_q30, 2)} %`, { tip: 'tipQ30' }));
      const ad = Object.entries(s.adapters || {}).sort((a, b) => b[1] - a[1]);
      const top = ad.length && ad[0][1] > 0 ? `${fmtN(ad[0][1], 2)} %` : escapeHtml(t('noneDetected'));
      library.push(card(t('statAdapters'), top, { tip: 'tipAdapters', sub: ad.length && ad[0][1] > 0 ? escapeHtml(ad[0][0]) : '' }));
      if (s.ee_mean !== undefined) {
        quality.push(card(t('statEE'), fmtN(s.ee_mean, 2), { tip: 'tipEE', sub: escapeHtml(t('eeSub', fmtN(s.ee_pct_le1, 1))) }));
      }
      if (s.pct_duplicated !== undefined) {
        library.push(card(t('statDupPct'), `${fmtN(s.pct_duplicated, 1)} %`, { tip: 'tipDup' }));
      }
      if (s.polyg_pct) library.push(card(t('statPolyG'), `${fmtN(s.polyg_pct, 2)} %`, { tip: 'tipPolyG' }));
      if (s.genome_size) {
        volume.push(card(t('statGenome'), escapeHtml(fmtBases(s.genome_size)), { tip: 'tipGenome', sub: s.kmer_coverage ? `${fmtN(s.kmer_coverage, 1)}×` : '' }));
      }
    }
    $('statsGrid').innerHTML = groups.filter(([, list]) => list.length)
      .map(([title, list]) => statGroup(title, list)).join('');
  }
  function statGroup(title, list) {
    return `<section class="stat-group">${title ? `<h3 class="stat-group-title">${escapeHtml(title)}</h3>` : ''}<div class="stats-grid">${list.join('')}</div></section>`;
  }

  // --- listado
  async function drawPage() {
    if (state.kind !== 'sequence') return;
    const { data } = await call('page', { start: state.page * PAGE_SIZE, size: PAGE_SIZE });
    const protein = state.alphabet === 'protein';
    $('listBody').innerHTML = data.rows.map((r) => {
      let q = '';
      if (state.isFastq && r.qual !== null) {
        const v = qualityVerdict(r.qual, state.threshold);
        q = `<span class="${v.cls}">${v.icon} ${fmtN(r.qual, 1)}<span class="sr-only"> (${escapeHtml(v.label)})</span></span>`;
      }
      return `<tr data-idx="${r.idx}">
        <td class="muted">${r.idx + 1}</td>
        <td><button type="button" class="linklike" data-idx="${r.idx}">${escapeHtml(r.id)}</button></td>
        <td class="num">${fmtN(r.len)}</td>
        ${protein ? '' : `<td class="num">${fmtN(r.gc, 2)} %</td>`}
        ${state.isFastq ? `<td class="num">${q}</td>` : ''}
      </tr>`;
    }).join('');
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    $('pageInfo').textContent = t('pageInfo', state.page + 1, fmtN(pages), fmtN(state.total));
    $('prevPage').disabled = state.page === 0;
    $('nextPage').disabled = state.page >= pages - 1;
  }
  $('prevPage').addEventListener('click', () => { if (state.page > 0) { state.page--; drawPage(); } });
  $('nextPage').addEventListener('click', () => {
    if ((state.page + 1) * PAGE_SIZE < state.total) { state.page++; drawPage(); }
  });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button.linklike[data-idx]');
    if (btn) return openDetail(Number(btn.dataset.idx), btn);
    const row = e.target.closest('#listBody tr[data-idx], #searchBody tr[data-idx], #motifResults tr[data-idx]');
    if (row && !e.target.closest('button, a')) {
      const b = row.querySelector('button.linklike');
      openDetail(Number(row.dataset.idx), b);
    }
    return null;
  });

  // --- umbral de calidad
  const TECH = { illumina: 20, nanopore: 10, hifi: 20 };
  let thresholdTimer = null;
  function applyThreshold(val) {
    if (Number.isNaN(val) || val < 0 || val > 93) return;
    state.threshold = val;
    if (state.kind !== 'sequence') return;
    renderSummary();
    drawPage();
    if (charts.tile && state.result.run) {
      const th = val;
      renderRun();
    }
    if (charts.qual) {
      const ds = charts.qual.data.datasets.find((d) => d.id === 'threshold');
      if (ds) { ds.data = ds.data.map(() => val); charts.qual.update('none'); }
    }
  }
  $('techSelect').addEventListener('change', (e) => {
    const v = TECH[e.target.value];
    if (v !== undefined) { $('qualityThresholdInput').value = v; applyThreshold(v); }
  });
  $('qualityThresholdInput').addEventListener('input', (e) => {
    clearTimeout(thresholdTimer);
    thresholdTimer = setTimeout(() => {
      const val = parseInt(e.target.value, 10);
      const match = Object.entries(TECH).find(([k, v]) => v === val && k === $('techSelect').value);
      if (!match) $('techSelect').value = 'custom';
      applyThreshold(val);
    }, 250);
  });

  // ------------------------------------------------------------------ detalle (diálogo accesible)
  let lastFocus = null;
  function formatSeqBlocks(seq, colored) {
    const lines = [];
    for (let i = 0; i < seq.length; i += 60) {
      const line = seq.slice(i, i + 60);
      const blocks = [];
      for (let j = 0; j < line.length; j += 10) {
        const chunk = line.slice(j, j + 10);
        blocks.push(colored ? [...chunk].map((c) => {
          const u = c.toUpperCase();
          const cls = 'ACGT'.includes(u) ? `b-${u}` : (u === 'U' ? 'b-T' : 'b-N');
          return `<span class="${cls}">${escapeHtml(c)}</span>`;
        }).join('') : escapeHtml(chunk));
      }
      lines.push(`<span class="pos">${String(i + 1).padStart(6, ' ')}</span> ${blocks.join(' ')}`);
    }
    return lines.join('\n');
  }
  async function openDetail(idx, trigger) {
    lastFocus = trigger || document.activeElement;
    const { data: r } = await call('detail', { idx });
    const protein = r.alphabet === 'protein';
    const unit = protein ? t('unitAa') : t('unitBp');
    let html = `<h2 id="detailTitle">${escapeHtml(r.id)}</h2>
      <dl class="kv">
        <dt>${t('detailDesc')}</dt><dd>${escapeHtml(r.desc)}</dd>
        <dt>${t('detailLen')}</dt><dd>${fmtN(r.len)} ${unit}</dd>
        ${protein ? '' : `<dt>%GC</dt><dd>${fmtN(r.gc, 2)} %</dd>`}
        ${r.qual_mean !== undefined ? `<dt>${t('detailQualMean')}</dt><dd>${fmtN(r.qual_mean, 1)}</dd>` : ''}
      </dl>`;
    if (!r.has_seq) {
      html += `<p class="warn">${t('detailNotStored')}</p>`;
    } else {
      html += `<div class="detail-section"><div class="section-head"><h3>${t('detailSeq')}</h3>
          <button type="button" class="ghost small" data-copy="seq">${t('detailCopySeq')}</button></div>
        ${r.truncated ? `<p class="help">${t('detailTruncated', fmtN(r.seq.length))}</p>` : ''}
        ${protein ? '' : `<div class="legend" aria-hidden="true"><span><i class="b-A-bg"></i>A</span><span><i class="b-T-bg"></i>T/U</span><span><i class="b-C-bg"></i>C</span><span><i class="b-G-bg"></i>G</span><span><i class="b-N-bg"></i>N/otras</span></div>`}
        <pre class="seqmono">${formatSeqBlocks(r.seq, !protein)}</pre></div>`;
      if (r.qual) {
        html += `<div class="detail-section"><h3>${t('detailQual')}</h3><pre class="seqmono">${formatSeqBlocks(r.qual, false)}</pre></div>`;
      }
      if (r.revcomp) {
        html += `<details class="detail-section"><summary>${t('detailRevcomp')}</summary>
          ${r.len > r.revcomp.length ? `<p class="help">${t('detailRevcompTruncated', fmtN(r.revcomp.length))}</p>` : ''}
          <pre class="seqmono">${formatSeqBlocks(r.revcomp, true)}</pre></details>
          <details class="detail-section"><summary>${t('detailFrames')}</summary>
          <pre class="seqmono frames">${Object.entries(r.frames).map(([k, v]) => `<b>${k}</b> ${escapeHtml(v)}`).join('\n\n')}</pre></details>`;
      }
    }
    $('detailContent').innerHTML = html;
    $('detailContent').dataset.seq = r.seq || '';
    const panel = $('detailPanel');
    panel.hidden = false;
    $('detailBackdrop').hidden = false;
    requestAnimationFrame(() => panel.classList.add('open'));
    $('detailClose').focus();
  }
  function closeDetail() {
    const panel = $('detailPanel');
    panel.classList.remove('open');
    $('detailBackdrop').hidden = true;
    setTimeout(() => { panel.hidden = true; }, 200);
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || !$('detailPanel').hidden) return;
    const tab = $('tabbtn-buscar');
    if (!tab || tab.hidden || state.kind !== 'sequence') return;
    e.preventDefault();
    activateTab('buscar');
    $('searchInput').focus();
  });
  $('detailClose').addEventListener('click', closeDetail);
  $('detailBackdrop').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    const panel = $('detailPanel');
    if (panel.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
    if (e.key === 'Tab') {
      const f = [...panel.querySelectorAll('button, summary, [href], input, [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  $('detailContent').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    try {
      await navigator.clipboard.writeText($('detailContent').dataset.seq || '');
      toast(t('copied'));
    } catch (_) { /* portapapeles no disponible */ }
  });

  // ------------------------------------------------------------------ búsqueda
  $('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('searchInput').value;
    if (!q.trim()) { $('searchBody').innerHTML = ''; $('searchInfo').textContent = ''; return; }
    const { data } = await call('search', { query: q });
    $('searchBody').innerHTML = data.rows.map((r) => `
      <tr data-idx="${r.idx}"><td>${r.idx + 1}</td>
      <td><button type="button" class="linklike" data-idx="${r.idx}">${escapeHtml(r.id)}</button></td>
      <td>${escapeHtml(r.desc)}</td><td class="num">${fmtN(r.len)}</td></tr>`).join('')
      || `<tr><td colspan="4" class="help">${t('searchNoResults')}</td></tr>`;
    $('searchInfo').textContent = data.capped ? t('searchCapped') : t('searchCount', fmtN(data.rows.length));
  });

  // ------------------------------------------------------------------ motivos
  $('motifForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('motifResults');
    try {
      const { data } = await call('motif', { motif: $('motifInput').value, bothStrands: $('motifBoth').checked });
      const parts = [];
      if (data.palindrome) parts.push(`<p class="help">${t('motifPalindrome')}</p>`);
      if (data.searched < data.count) parts.push(`<p class="warn">${t('motifPartial', fmtN(data.searched), fmtN(data.count))}</p>`);
      if (data.total === 0) {
        box.innerHTML = `${parts.join('')}<p class="warn">${escapeHtml(t('motifNoMatch', data.motif))}</p>`;
        return;
      }
      parts.push(`<p class="help">${t('motifResults', fmtN(data.total), fmtN(data.sequences))}</p>`);
      const showMinus = state.alphabet !== 'protein';
      parts.push(`<div class="table-scroll"><table><thead><tr><th scope="col">${t('colId')}</th><th scope="col">${showMinus ? t('motifColPlus') : '#'}</th>${showMinus ? `<th scope="col">${t('motifColMinus')}</th>` : ''}<th scope="col">${t('motifColPos')}</th></tr></thead><tbody>`
        + data.matches.map((m) => {
          const pos = [m.pos_plus.length ? `${showMinus ? '+ ' : ''}${m.pos_plus.map((x) => fmtN(x)).join(', ')}${m.plus > m.pos_plus.length ? '…' : ''}` : '',
            m.pos_minus.length ? `− ${m.pos_minus.map((x) => fmtN(x)).join(', ')}${m.minus > m.pos_minus.length ? '…' : ''}` : ''].filter(Boolean).join(' · ');
          return `<tr data-idx="${m.idx}"><td><button type="button" class="linklike" data-idx="${m.idx}">${escapeHtml(m.id)}</button></td><td>${fmtN(m.plus)}</td>${showMinus ? `<td>${fmtN(m.minus)}</td>` : ''}<td>${pos}</td></tr>`;
        }).join('') + '</tbody></table></div>');
      if (data.sequences > data.matches.length) parts.push(`<p class="help">${t('motifCapped')}</p>`);
      box.innerHTML = parts.join('');
    } catch (err) {
      box.innerHTML = `<p class="warn">${escapeHtml(userErrorMessage(err))}</p>`;
    }
  });
  $('motifPresets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-motif]');
    if (!b) return;
    $('motifInput').value = b.dataset.motif;
    $('motifForm').requestSubmit();
  });

  // ------------------------------------------------------------------ gráficos
  // Paleta de datos apta para daltonismo (Okabe-Ito), con variantes más luminosas para el
  // tema oscuro. Se recalcula al cambiar de tema y los gráficos se vuelven a dibujar.
  const PALETTES = {
    light: { blue: '#0072B2', orange: '#D55E00', sky: '#56B4E9', amber: '#E69F00' },
    dark: { blue: '#5AB4EE', orange: '#F28C5C', sky: '#8CD0F5', amber: '#F2B84B' },
  };
  const COLORS = {};
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function effectiveTheme() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
  function refreshPalette() {
    Object.assign(COLORS, PALETTES[effectiveTheme()], {
      teal: cssVar('--accent'), ink: cssVar('--ink'), grey: cssVar('--ink-faint'),
      text: cssVar('--ink-soft'), grid: cssVar('--line-soft'), surface: cssVar('--surface'),
    });
    if (window.Chart) {
      Chart.defaults.color = COLORS.text;
      Chart.defaults.borderColor = COLORS.grid;
      Chart.defaults.plugins.tooltip.backgroundColor = cssVar('--code-bg');
      Chart.defaults.plugins.tooltip.titleColor = cssVar('--code-ink');
      Chart.defaults.plugins.tooltip.bodyColor = cssVar('--code-ink');
      Chart.defaults.plugins.tooltip.borderColor = cssVar('--code-line');
      Chart.defaults.plugins.tooltip.borderWidth = 1;
    }
  }
  function alpha(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  refreshPalette();
  function destroyCharts() {
    Object.keys(charts).forEach((k) => { if (charts[k]) charts[k].destroy(); charts[k] = null; });
  }
  async function ensureChartJs() {
    if (window.Chart) return true;
    try {
      await loadScript('vendor/chartjs/chart.umd.js');
      Chart.defaults.animation = false;
      Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
      Chart.defaults.font.size = 11.5;
      Chart.defaults.elements.bar.borderRadius = 3;
      Chart.defaults.elements.line.tension = 0.25;
      Chart.defaults.plugins.legend.labels.usePointStyle = true;
      Chart.defaults.datasets.line.pointStyle = 'line';
      Chart.defaults.datasets.bar.pointStyle = 'rectRounded';
      Chart.defaults.plugins.legend.labels.pointStyleWidth = 10;
      Chart.defaults.plugins.legend.labels.padding = 14;
      Object.assign(Chart.defaults.plugins.tooltip, {
        padding: 10, cornerRadius: 8, boxPadding: 4, titleFont: { weight: '600' }, displayColors: true,
      });
      Chart.defaults.scale.grid.drawTicks = false;
      Chart.defaults.scale.border.display = false;
      Chart.defaults.scale.ticks.padding = 6;
      refreshPalette();
      return true;
    } catch (_) {
      $('chartsError').innerHTML = `<p class="warn">${t('chartJsError')}</p>`;
      return false;
    }
  }
  const baseOptions = (xTitle, yTitle, extra = {}) => ({
    responsive: true, maintainAspectRatio: false, normalized: true, animation: false,
    plugins: { legend: { display: false } },
    scales: { x: { title: { display: true, text: xTitle } }, y: { title: { display: true, text: yTitle }, beginAtZero: true } },
    ...extra,
  });
  function ariaChart(canvas, title, detail) { canvas.setAttribute('aria-label', t('chartAria', title, detail)); }

  async function renderSequenceCharts() {
    if (!(await ensureChartJs())) return;
    destroyCharts();
    const c = state.result.charts;
    const s = state.result.summary;
    const unit = s.alphabet === 'protein' ? t('unitAa') : t('unitBp');
    charts.len = new Chart($('chartLen'), {
      type: 'bar',
      data: { labels: c.length.labels, datasets: [{ label: t('chartLegendSeqs'), data: c.length.counts, backgroundColor: COLORS.teal }] },
      options: baseOptions(`${t('chartAxisLen')} (${unit})`, t('chartAxisCount')),
    });
    ariaChart($('chartLen'), t('chartLenTitle'), `${t('statMedian')}: ${fmtN(s.median)} ${unit}.`);
    // longitud única (típico de Illumina sin recortar): una barra gigante no informa de nada
    const single = c.length.labels.length <= 1;
    $('chartLenWrap').hidden = single;
    $('lenNote').hidden = !single;
    if (single) $('lenNote').textContent = t('lenAllSame', fmtN(s.min_len), unit);

    $('gcChartBox').hidden = !c.gc;
    if (c.gc) {
      const labels = c.gc.counts.map((_, i) => i);
      const total = c.gc.counts.reduce((a, b) => a + b, 0);
      const sd = Math.max(c.gc.sd || 0, 0.5);
      const normal = labels.map((x) => total * Math.exp(-0.5 * ((x - c.gc.mean) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI)));
      charts.gc = new Chart($('chartGC'), {
        data: {
          labels,
          datasets: [
            { type: 'bar', label: t('chartLegendSeqs'), data: c.gc.counts, backgroundColor: COLORS.amber, order: 2 },
            { type: 'line', label: t('chartLegendNormal'), data: normal, borderColor: COLORS.ink, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, order: 1 },
          ],
        },
        options: baseOptions(t('chartAxisGC'), t('chartAxisCount'), { plugins: { legend: { display: true, labels: { boxWidth: 14 } } } }),
      });
      ariaChart($('chartGC'), t('chartGCTitle'), `${t('statGC')}: ${fmtN(c.gc.mean, 1)} %.`);
    }

    const qp = c.quality_profile;
    $('qualChartBox').classList.toggle('hidden', !qp);
    if (qp) {
      $('qualChartHelp').textContent = t('chartQualHelp', fmtN(qp.sample_size), qp.bin_width);
      const band = (data, fill, color, label) => ({ label, data, borderWidth: 0, pointRadius: 0, fill, backgroundColor: color, pointStyle: 'rectRounded' });
      charts.qual = new Chart($('chartQual'), {
        type: 'line',
        data: {
          labels: qp.labels,
          datasets: [
            { ...band(qp.p10, false, 'transparent', 'p10'), id: 'p10' },
            { ...band(qp.p90, '-1', alpha(COLORS.blue, 0.16), t('chartLegendP1090')) },
            { ...band(qp.p25, false, 'transparent', 'p25'), id: 'p25' },
            { ...band(qp.p75, '-1', alpha(COLORS.blue, 0.34), t('chartLegendP2575')) },
            { label: t('chartLegendMedian'), data: qp.p50, borderColor: COLORS.blue, borderWidth: 2, pointRadius: 0, fill: false },
            { label: t('chartLegendMean'), data: qp.mean, borderColor: COLORS.ink, borderDash: [3, 3], borderWidth: 1.2, pointRadius: 0, fill: false },
            { id: 'threshold', label: t('chartLegendThreshold'), data: qp.labels.map(() => state.threshold), borderColor: COLORS.orange, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false },
          ],
        },
        options: baseOptions(t('chartAxisPos'), t('chartAxisPhred'), {
          plugins: { legend: { display: true, labels: { boxWidth: 14, filter: (item) => !['p10', 'p25'].includes(item.text) } } },
        }),
      });
      const lastMed = qp.p50[qp.p50.length - 1];
      ariaChart($('chartQual'), t('chartQualTitle'), `${t('chartLegendMedian')}: ${qp.p50[0]} → ${lastMed}.`);
    }
    const comp = c.composition;
    $('compBox').classList.toggle('hidden', !comp);
    if (comp) {
      const series = [['A', COLORS.teal], ['C', COLORS.blue], ['G', COLORS.ink], ['T', COLORS.orange], ['N', COLORS.grey]];
      charts.comp = new Chart($('chartComp'), {
        type: 'line',
        data: {
          labels: comp.labels,
          datasets: series.map(([k, col]) => ({ label: k, data: comp[k], borderColor: col, borderWidth: 1.6, pointRadius: 0, fill: false })),
        },
        options: baseOptions(t('chartAxisPos'), t('axisPctBases'), { plugins: { legend: { display: true, labels: { boxWidth: 14 } } } }),
      });
      ariaChart($('chartComp'), t('chartCompTitle'), `${t('chartAxisPos')} 1–${comp.labels.length}.`);
    }
    const ee = c.ee;
    $('eeBox').classList.toggle('hidden', !ee);
    if (ee) {
      charts.ee = new Chart($('chartEE'), {
        type: 'bar',
        data: { labels: ee.labels, datasets: [{ label: t('chartAxisReads'), data: ee.counts, backgroundColor: COLORS.sky }] },
        options: baseOptions(t('axisEE'), t('chartAxisReads')),
      });
      ariaChart($('chartEE'), t('chartEETitle'), t('eeSub', fmtN(ee.pct_le1, 1)));
      if (ee.sampled) $('eeBox').querySelector('.help').textContent = `${t('chartEEHelp')} ${t('eeSampled', fmtN(ee.sample_size))}`;
    }
    const km = c.kmers;
    $('kmerBox').classList.toggle('hidden', !km || !km.spectrum);
    if (km && km.spectrum) {
      $('kmerHelp').textContent = t('chartKmerHelp', km.k, fmtN(km.reads_sampled));
      charts.kmer = new Chart($('chartKmer'), {
        type: 'line',
        data: { labels: km.spectrum.labels, datasets: [{ label: t('axisKmers'), data: km.spectrum.counts, borderColor: COLORS.teal, borderWidth: 1.8, pointRadius: 0, fill: false }] },
        options: baseOptions(t('axisMultiplicity'), t('axisKmers'), { scales: { x: { title: { display: true, text: t('axisMultiplicity') } }, y: { type: 'logarithmic', title: { display: true, text: t('axisKmers') }, ticks: { callback: (v) => (Math.log10(v) % 1 === 0 ? fmtN(v) : '') } } } }),
      });
      const bits = [`${t('kmerDistinct')}: ${fmtN(km.distinct)}`];
      if (km.genome_size) {
        bits.push(`${t('kmerPeak')}: ${fmtN(km.peak)}×`, `${t('statGenome')}: ${fmtBases(km.genome_size)}`);
        if (km.error_kmer_pct !== null && km.error_kmer_pct !== undefined) bits.push(`${t('kmerError')}: ${fmtN(km.error_kmer_pct, 1)} %`);
        $('kmerSummary').textContent = bits.join(' · ');
      } else {
        $('kmerSummary').textContent = `${bits[0]} · ${t(km.reason === 'few_reads' ? 'kmerFewReads' : 'kmerNone')}`;
      }
      ariaChart($('chartKmer'), t('chartKmerTitle'), km.genome_size ? `${t('statGenome')}: ${fmtBases(km.genome_size)}.` : t('kmerNone'));
    }
    const qh = c.quality_hist;
    $('qualHistBox').classList.toggle('hidden', !qh);
    if (qh) {
      charts.qualHist = new Chart($('chartQualHist'), {
        type: 'bar',
        data: { labels: qh.labels, datasets: [{ label: t('chartAxisReads'), data: qh.counts, backgroundColor: COLORS.sky }] },
        options: baseOptions(t('chartAxisPhred'), t('chartAxisReads')),
      });
      ariaChart($('chartQualHist'), t('chartQualHistTitle'), `${t('statQual')}: ${fmtN(s.avg_quality, 1)}.`);
    }
  }

  // ------------------------------------------------------------------ panel «Run y duplicados»
  function kvTable(rows) {
    return `<div class="table-scroll"><table><tbody>${rows.map(([k, v]) => `<tr class="static"><th scope="row">${escapeHtml(k)}</th><td>${v}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderRun() {
    const box = $('runContent');
    const r = state.result.run;
    const d = state.result.duplication;
    const s = state.result.summary;
    if (!state.isFastq || (!r && !d)) { box.innerHTML = ''; return; }
    const parts = [];
    parts.push('<div class="panel-card">');
    parts.push(`<h2>${t('runTitle')}</h2><p class="help">${t('runHelp')}</p>`);
    if (!r) {
      parts.push(`<p class="warn">${t('runNoHeader')}</p>`);
    } else {
      parts.push(kvTable([
        [t('runInstrument'), escapeHtml(r.instruments.join(', ') || '—')],
        [t('runRun'), escapeHtml(r.runs.join(', ') || '—')],
        [t('runFlowcell'), escapeHtml(r.flowcells.join(', ') || '—')],
        [t('runLanes'), fmtN(r.lanes.length)],
        [t('runTiles'), fmtN(r.n_tiles)],
        [t('runReadPair'), `R1: ${fmtN(r.reads_r1)} · R2: ${fmtN(r.reads_r2)}`],
        [t('runFiltered'), `${fmtN(r.filtered_out)} (${fmtN(r.pct_filtered_out, 2)} %)`],
        [t('runIndexes'), fmtN(r.n_indexes)],
      ]));
      if (r.lanes.length) {
        parts.push(`<h3>${t('runLanes')}</h3><div class="table-scroll"><table><thead><tr><th scope="col">${t('colLane')}</th><th scope="col" class="num">${t('colReads')}</th><th scope="col" class="num">${t('colPctReads')}</th><th scope="col" class="num">${t('colQuality')}</th></tr></thead><tbody>${
          r.lanes.map((l) => `<tr class="static"><td>${escapeHtml(l.lane)}</td><td class="num">${fmtN(l.reads)}</td><td class="num">${fmtN(l.pct, 2)} %</td><td class="num">${qualCell(l.quality, r.tile_mean_quality)}</td></tr>`).join('')}</tbody></table></div>`);
      }
      if (r.tiles.length) {
        parts.push(`<h3>${t('tilesTitle')}</h3><p class="help">${t('tilesHelp')}</p><div class="chart-wrap" id="chartTileWrap"><canvas id="chartTile" role="img"></canvas></div>`);
        parts.push(`<h3>${t('worstTiles')}</h3><div class="table-scroll"><table><thead><tr><th scope="col">${t('colLane')}</th><th scope="col">${t('colTile')}</th><th scope="col" class="num">${t('colReads')}</th><th scope="col" class="num">${t('colQuality')}</th></tr></thead><tbody>${
          r.worst_tiles.map((x) => `<tr class="static"><td>${escapeHtml(x.lane)}</td><td>${escapeHtml(x.tile)}</td><td class="num">${fmtN(x.reads)}</td><td class="num">${qualCell(x.quality, r.tile_mean_quality)}</td></tr>`).join('')}</tbody></table></div>`);
      }
      if (r.indexes.length) {
        parts.push(`<h3>${t('indexesTitle')}</h3><p class="help">${t('indexesHelp')}</p><div class="table-scroll"><table><thead><tr><th scope="col">${t('colIndex')}</th><th scope="col" class="num">${t('colReads')}</th><th scope="col" class="num">${t('colPctReads')}</th></tr></thead><tbody>${
          r.indexes.map((x) => `<tr class="static"><td class="mono-cell">${escapeHtml(x.index)}</td><td class="num">${fmtN(x.reads)}</td><td class="num">${fmtN(x.pct, 2)} %</td></tr>`).join('')}</tbody></table></div>`);
      }
    }
    parts.push('</div>');

    if (d) {
      parts.push('<div class="panel-card spaced">');
      parts.push(`<h2>${t('dupTitle')}</h2><p class="help">${t('dupHelp', fmtN(d.reads_checked), d.prefix)}</p>`);
      parts.push(kvTable([
        [t('dupUnique'), `${fmtN(d.distinct)} (${fmtN(d.pct_unique, 1)} %)`],
        [t('dupDuplicated'), `${fmtN(d.pct_duplicated, 1)} %`],
        [t('polyG'), `${fmtN(s.polyg_pct, 2)} %`],
        [t('polyA'), `${fmtN(s.polya_pct, 2)} %`],
      ]));
      parts.push(`<h3>${t('chartDupTitle')}</h3><div class="chart-wrap" id="chartDupWrap"><canvas id="chartDup" role="img"></canvas></div>`);
      parts.push(`<h3>${t('overrepTitle')}</h3>`);
      if (d.top.length) {
        parts.push(`<div class="table-scroll"><table><thead><tr><th scope="col">${t('colSeq')}</th><th scope="col">${t('colTimes')}</th><th scope="col">${t('colPct')}</th><th scope="col">${t('colSource')}</th></tr></thead><tbody>${
          d.top.map((x) => `<tr class="static"><td class="mono-cell">${escapeHtml(x.seq)}</td><td>${fmtN(x.count)}</td><td>${fmtN(x.pct, 3)} %</td><td>${x.source ? escapeHtml(x.source) : `<span class="muted">${t('sourceUnknown')}</span>`}</td></tr>`).join('')}</tbody></table></div>`);
      } else {
        parts.push(`<p class="help">${t('overrepNone')}</p>`);
      }
      parts.push('</div>');
    }
    box.innerHTML = parts.join('');
    drawRunCharts();
  }
  function qualCell(q, ref) {
    if (q === null || q === undefined) return '—';
    // Una tile o un lane se juzgan contra la media del propio run: lo que importa es
    // si se desvían del resto, no su valor absoluto frente al umbral general.
    let v;
    if (ref !== null && ref !== undefined) {
      const d = q - ref;
      v = d >= -2 ? { cls: 'v-good', icon: icon('check-circle'), label: t('verdictGood') }
        : d >= -5 ? { cls: 'v-fair', icon: icon('alert'), label: t('verdictFair') }
        : { cls: 'v-low', icon: icon('x-circle'), label: t('verdictLow') };
    } else {
      v = qualityVerdict(q, state.threshold);
    }
    return `<span class="${v.cls}">${v.icon} ${fmtN(q, 1)}<span class="sr-only"> (${escapeHtml(v.label)})</span></span>`;
  }
  async function drawRunCharts() {
    if (!(await ensureChartJs())) return;
    const r = state.result.run;
    const d = state.result.duplication;
    if (r && r.tiles.length && $('chartTile')) {
      if (charts.tile) charts.tile.destroy();
      const th = r.tile_mean_quality !== null && r.tile_mean_quality !== undefined ? r.tile_mean_quality - 2 : state.threshold;
      charts.tile = new Chart($('chartTile'), {
        type: 'bar',
        data: {
          labels: r.tiles.map((x) => `${x.lane}:${x.tile}`),
          datasets: [{
            label: t('colQuality'), data: r.tiles.map((x) => x.quality),
            backgroundColor: r.tiles.map((x) => (x.quality >= th ? COLORS.blue : x.quality >= th - 5 ? COLORS.amber : COLORS.orange)),
          }],
        },
        options: baseOptions(`${t('colLane')}:${t('colTile')}`, t('chartAxisPhred'), {
          plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: (c) => `${fmtN(r.tiles[c.dataIndex].reads)} ${t('colReads').toLowerCase()}` } } },
        }),
      });
      ariaChart($('chartTile'), t('tilesTitle'), `${fmtN(r.n_tiles)} tiles.`);
    }
    if (d && $('chartDup')) {
      if (charts.dup) charts.dup.destroy();
      charts.dup = new Chart($('chartDup'), {
        type: 'bar',
        data: { labels: d.levels.labels, datasets: [{ label: t('chartLegendSeqs'), data: d.levels.counts, backgroundColor: COLORS.teal }] },
        options: baseOptions(t('dupLevels'), t('chartAxisCount')),
      });
      ariaChart($('chartDup'), t('chartDupTitle'), `${fmtN(d.pct_duplicated, 1)} %.`);
    }
  }

  // ------------------------------------------------------------------ tablas y volcano plot
  function renderTabular(result) {
    const s = result.summary;
    const rows = result.records || [];
    const header = rows[0] || [];
    const body = rows.slice(1, 51);
    const delim = s.delimiter === '\t' ? t('delimTab') : `«${s.delimiter}»`;
    $('statsGrid').innerHTML = statGroup('', [
      card(t('rows'), fmtN(s.n_rows)),
      card(t('cols'), fmtN(s.n_cols)),
      card(t('delimiter'), escapeHtml(delim)),
    ]);
    const colStats = (s.columns || []).map((c) => `${escapeHtml(c.name)} (${fmtN(c.numeric_pct)} % ${t('numericPct')})`).join(' · ');
    $('listAlt').innerHTML = `
      <div class="panel-card">
        <h2>${escapeHtml(t('tabularPreviewTitle', s.kind_label))}</h2>
        <p class="help">${colStats || t('tabularNoCols')}</p>
        <div class="table-scroll tall">
          <table>
            <thead><tr>${header.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join('')}</tr></thead>
            <tbody>${body.map((r) => `<tr class="static">${r.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
        <p class="help">${t('tabularShowing', 50, fmtN(s.n_rows))}</p>
      </div>`;
    const tabs = ['lista'];
    if (result.de) { tabs.push('graficos'); renderVolcano(result.de); }
    setAvailableTabs(tabs);
  }

  async function renderVolcano(de) {
    if (!(await ensureChartJs())) return;
    const yCut = -Math.log10(0.05);
    const up = []; const down = []; const ns = [];
    de.points.forEach(([x, y, name]) => {
      const p = { x, y, name };
      if (y >= yCut && x >= 1) up.push(p); else if (y >= yCut && x <= -1) down.push(p); else ns.push(p);
    });
    $('volcanoBox').classList.remove('hidden');
    $('volcanoTitle').textContent = t('volcanoTitle', de.tool);
    $('volcanoSummary').textContent = t('volcanoSummary', fmtN(up.length), fmtN(down.length));
    state.volcano = { up, down, de };
    charts.volcano = new Chart($('chartVolcano'), {
      type: 'scatter',
      data: {
        datasets: [
          { label: t('volcanoNs'), data: ns, backgroundColor: alpha(COLORS.grey, 0.45), pointRadius: 2 },
          { label: t('volcanoDown'), data: down, backgroundColor: COLORS.blue, pointRadius: 2.6, pointStyle: 'triangle' },
          { label: t('volcanoUp'), data: up, backgroundColor: COLORS.orange, pointRadius: 2.6, pointStyle: 'rect' },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: { xAxisKey: 'x', yAxisKey: 'y' },
        plugins: {
          legend: { display: true, labels: { usePointStyle: true } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.raw.name}: log2FC ${fmtN(ctx.raw.x, 2)}, -log10 p ${fmtN(ctx.raw.y, 2)}` } },
        },
        scales: { x: { title: { display: true, text: de.fc_name } }, y: { title: { display: true, text: `-log10(${de.p_name})` }, beginAtZero: true } },
      },
    });
    ariaChart($('chartVolcano'), t('volcanoTitle', de.tool), t('volcanoSummary', fmtN(up.length), fmtN(down.length)));
  }
  $('volcanoDownload').addEventListener('click', () => {
    if (!state.volcano) return;
    const { up, down, de } = state.volcano;
    const dec = (n) => (LANG === 'es' ? String(n).replace('.', ',') : String(n));
    const lines = [['gen', de.fc_name, `-log10(${de.p_name})`, 'direccion'].join(';')];
    up.forEach((p) => lines.push([p.name, dec(p.x), dec(p.y), 'up'].join(';')));
    down.forEach((p) => lines.push([p.name, dec(p.x), dec(p.y), 'down'].join(';')));
    downloadBlob(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv' }), `${baseName(state.fileName)}_significativos.csv`);
  });

  // ------------------------------------------------------------------ estructuras 3D
  const PLDDT = [[90, '#0053D6', 'plddtVeryHigh'], [70, '#65CBF3', 'plddtHigh'], [50, '#FFDB13', 'plddtLow'], [-1, '#FF7D45', 'plddtVeryLow']];
  function releaseViewer() {
    if (!viewer3d) return;
    try {
      viewer3d.clear();
      const canvas = document.querySelector('#viewer3d canvas');
      const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
      const ext = gl && gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    } catch (_) { /* nada que liberar */ }
    viewer3d = null;
  }
  async function renderStructure(result) {
    const s = result.summary;
    releaseViewer();
    $('statsGrid').innerHTML = statGroup('', [
      card(t('statAtoms'), fmtN(s.atoms)), card(t('statHetatms'), fmtN(s.hetatms)), card(t('statChains'), fmtN(s.n_chains)),
      card(t('statResidues'), fmtN(s.n_residues)), card(t('statModels'), fmtN(s.n_models)),
      ...(s.method ? [card(t('statMethod'), escapeHtml(s.method))] : []),
      ...(s.resolution ? [card(t('statResolution'), `${fmtN(s.resolution, 2)} Å`)] : []),
    ]);
    $('listAlt').innerHTML = `
      <div class="panel-card">
        <h2 data-i18n="structureTitle3D">${t('structureTitle3D')}</h2>
        <p class="help" data-i18n="structureHelp3D">${t('structureHelp3D')}</p>
        ${s.alphafold ? `<p class="help" data-i18n="plddtNote">${t('plddtNote')}</p>` : ''}
        <div class="viewer3d-controls" role="group">
          ${s.alphafold ? `<button type="button" class="ghost style-btn active" data-style="plddt" aria-pressed="true" data-i18n="stylePlddt">${t('stylePlddt')}</button>` : ''}
          <button type="button" class="ghost style-btn ${s.alphafold ? '' : 'active'}" data-style="cartoon" aria-pressed="${!s.alphafold}" data-i18n="styleCartoon">${t('styleCartoon')}</button>
          <button type="button" class="ghost style-btn" data-style="stick" aria-pressed="false" data-i18n="styleStick">${t('styleStick')}</button>
          <button type="button" class="ghost style-btn" data-style="sphere" aria-pressed="false" data-i18n="styleSphere">${t('styleSphere')}</button>
        </div>
        <div id="viewer3d"></div>
        ${s.alphafold ? `<div class="legend plddt-legend"><strong data-i18n="plddtLegendTitle">${t('plddtLegendTitle')}</strong>${PLDDT.map(([, col, key]) => `<span><i style="background:${col}"></i><span data-i18n="${key}">${t(key)}</span></span>`).join('')}</div>` : ''}
      </div>
      <div class="panel-card spaced" id="chainsCard"></div>
      <div class="panel-card spaced">
        <h2 data-i18n="structureTitle">${t('structureTitle')}</h2>
        <p class="help" data-i18n="structureHelp">${t('structureHelp')}</p>
        <p><b data-i18n="chainsLabel">${t('chainsLabel')}</b> ${escapeHtml((s.chains || []).join(', ') || '—')}</p>
        <p><b data-i18n="hetLabel">${t('hetLabel')}</b> ${escapeHtml((s.het_groups || []).join(', ') || '—')}</p>
      </div>`;
    renderChains(s);
    setAvailableTabs(['lista']);
    const el = $('viewer3d');
    try {
      await loadScript('vendor/3dmol/3Dmol-min.js');
    } catch (_) {
      el.innerHTML = `<p class="help">${t('viewerUnavailable')}</p>`;
      return;
    }
    viewer3d = window.$3Dmol.createViewer(el, { backgroundColor: COLORS.surface || 'white' });
    viewer3d.addModel(result.structure_text, result.structure_format === 'cif' ? 'cif' : 'pdb');
    applyViewerStyle(s.alphafold ? 'plddt' : 'cartoon');
    viewer3d.zoomTo();
    viewer3d.render();
  }
  function chainTypeLabel(k) {
    return t(k === 'protein' ? 'typeProtein' : k === 'nucleic' ? 'typeNucleic' : 'typeOther');
  }
  function chainsFasta(chains) {
    const base = baseName(state.fileName);
    return chains.map((c) => `>${base}_cadena_${c.chain} residuos=${c.first}-${c.last} n=${c.n_residues}\n`
      + (c.seq.match(/.{1,60}/g) || []).join('\n')).join('\n') + '\n';
  }
  function renderChains(s) {
    const box = $('chainsCard');
    const chains = s.chain_detail || [];
    if (!box) return;
    if (!chains.length) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    const plddt = !!s.alphafold;
    const rows = chains.map((c) => `<tr class="static">
      <td>${escapeHtml(c.chain)}</td>
      <td>${escapeHtml(chainTypeLabel(c.type))}</td>
      <td>${fmtN(c.n_residues)}</td>
      <td>${c.first === null ? '—' : `${fmtN(c.first)}–${fmtN(c.last)}`}</td>
      <td>${c.n_gaps ? `<span class="v-fair">${fmtN(c.n_gaps)}</span>` : '0'}</td>
      <td>${c.missing_residues ? `<span class="v-fair">${fmtN(c.missing_residues)}</span>` : '0'}</td>
      <td>${c.bfactor ? fmtN(c.bfactor.mean, 1) : '—'}</td></tr>`).join('');
    const gapBlocks = chains.filter((c) => c.gaps.length).map((c) => `<p class="help"><b>${escapeHtml(c.chain)}:</b> `
      + c.gaps.map((g) => escapeHtml(g.missing === null ? t('gapNonMonotonic', g.after, g.before) : t('gapRange', g.after, g.before, g.missing))).join(' · ') + '</p>').join('');
    const seqs = chains.map((c) => `<details class="detail-section"><summary>${escapeHtml(t('seqOfChain', c.chain))} (${fmtN(c.seq.length)})</summary>
      <pre class="seqmono">${escapeHtml((c.seq.match(/.{1,60}/g) || []).join('\n'))}</pre></details>`).join('');
    const hasB = chains.some((c) => c.bfactor);
    box.innerHTML = `<h2>${t('chainsTitle')}</h2><p class="help">${t('chainsHelp')}</p>
      <div class="table-scroll"><table><thead><tr>
        <th scope="col">${t('colChain')}</th><th scope="col">${t('colChainType')}</th><th scope="col">${t('colResidues')}</th>
        <th scope="col">${t('colRange')}</th><th scope="col">${t('colGaps')}</th><th scope="col">${t('colMissing')}</th>
        <th scope="col">${plddt ? t('colPlddtMean') : t('colBmean')}</th></tr></thead><tbody>${rows}</tbody></table></div>
      <h3>${t('gapsDetail')}</h3>${gapBlocks || `<p class="help">${t('noGaps')}</p>`}
      ${hasB ? `<h3>${plddt ? t('chartPlddtTitle') : t('chartBfactorTitle')}</h3>
        <p class="help">${plddt ? t('chartPlddtHelp') : t('chartBfactorHelp')}</p>
        <div class="chart-wrap" id="chartBfWrap"><canvas id="chartBf" role="img"></canvas></div>` : ''}
      ${seqs}
      <p class="button-row"><button type="button" class="ghost" id="downloadChainsBtn">${icon('download')}<span>${t('downloadChainsFasta')}</span></button></p>`;
    if (hasB) drawBfactorChart(chains, plddt);
  }
  async function drawBfactorChart(chains, plddt) {
    if (!(await ensureChartJs()) || !$('chartBf')) return;
    if (charts.bf) charts.bf.destroy();
    const palette = [COLORS.blue, COLORS.orange, COLORS.teal, COLORS.amber, COLORS.sky, COLORS.ink];
    const withB = chains.filter((c) => c.bfactor);
    // cada punto lleva su número de residuo: así las cadenas con numeraciones distintas
    // no se dibujan una encima de otra y los huecos quedan a la vista
    charts.bf = new Chart($('chartBf'), {
      type: 'line',
      data: {
        datasets: withB.map((c, i) => ({
          label: `${t('colChain')} ${c.chain}`,
          data: c.bfactor.values.map((v, k) => ({ x: Number(c.bfactor.labels[k]), y: v })),
          borderColor: palette[i % palette.length], borderWidth: 1.6, pointRadius: 0, fill: false,
          spanGaps: false,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
        parsing: { xAxisKey: 'x', yAxisKey: 'y' },
        plugins: { legend: { display: withB.length > 1, labels: { boxWidth: 14 } } },
        scales: {
          x: { type: 'linear', title: { display: true, text: t('axisResidue') }, ticks: { precision: 0 } },
          y: { title: { display: true, text: plddt ? t('axisPlddt') : t('axisBfactor') }, beginAtZero: true },
        },
      },
    });
    ariaChart($('chartBf'), plddt ? t('chartPlddtTitle') : t('chartBfactorTitle'),
      withB.map((c) => `${c.chain}: ${fmtN(c.bfactor.mean, 1)}`).join(', '));
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#downloadChainsBtn')) return;
    const chains = (state.result && state.result.summary && state.result.summary.chain_detail) || [];
    if (!chains.length) return;
    downloadBlob(new Blob([chainsFasta(chains)], { type: 'text/plain' }), `${baseName(state.fileName)}_cadenas.fasta`);
  });

  function plddtColor(atom) {
    const b = atom.b;
    return PLDDT.find(([cut]) => b > cut)[1];
  }
  function applyViewerStyle(style) {
    if (!viewer3d) return;
    const styles = {
      plddt: { cartoon: { colorfunc: plddtColor } },
      cartoon: { cartoon: { color: 'spectrum' } },
      stick: { stick: { radius: 0.15 }, sphere: { scale: 0.25 } },
      sphere: { sphere: {} },
    };
    viewer3d.setStyle({}, styles[style] || styles.cartoon);
    viewer3d.setStyle({ hetflag: true }, { stick: { radius: 0.2 }, sphere: { scale: 0.3 } });
    viewer3d.render();
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.style-btn');
    if (!btn) return;
    document.querySelectorAll('.style-btn').forEach((b) => { b.classList.toggle('active', b === btn); b.setAttribute('aria-pressed', String(b === btn)); });
    applyViewerStyle(btn.dataset.style);
  });

  // ------------------------------------------------------------------ BAM / SAM con samtools (Aioli)
  const SAMTOOLS = 'samtools/1.10';
  const AIOLI_URL = 'https://biowasm.com/cdn/v3/aioli.js';
  let aioliCLI = null;
  async function handleBam(file, index) {
    setBusy(true, file.name);
    const started = performance.now();
    try {
      // Aioli se carga de biowasm.com, igual que samtools: el BAM necesita conexión igualmente,
      // y así el zip no incluye su worker en base64 (patrón que algunos antivirus marcan por error).
      await loadScript(AIOLI_URL);
      if (!aioliCLI) aioliCLI = await new window.Aioli([SAMTOOLS]);
      const CLI = aioliCLI;
      const paths = await CLI.mount(index ? [file, index] : [file]);
      const path = paths[0];
      const out = (r) => (typeof r === 'string' ? r : (r && r.stdout) || '');
      const header = out(await CLI.exec(`samtools view -H ${path}`));
      const flagstat = parseFlagstat(out(await CLI.exec(`samtools flagstat ${path}`)));
      let idx = null;
      let preview = '';
      if (index) {
        idx = out(await CLI.exec(`samtools idxstats ${path}`)).trim().split('\n').filter(Boolean)
          .map((l) => l.split('\t')).filter((f) => f.length >= 4)
          .map(([ref, len, mapped, unmapped]) => ({ ref, len: +len, mapped: +mapped, unmapped: +unmapped }));
        const firstRef = idx.find((r) => r.mapped > 0);
        if (firstRef) preview = out(await CLI.exec(`samtools view ${path} ${firstRef.ref}`)).split('\n').slice(0, 20).join('\n');
      } else if (file.size < 30 * 1024 * 1024) {
        preview = out(await CLI.exec(`samtools view ${path}`)).split('\n').slice(0, 20).join('\n');
      }
      state.bam = { header, flagstat, idx, preview, hasIndex: !!index };
      state.kind = 'bam';
      state.result = { kind: 'bam' };
      renderWarnings([]);
      destroyCharts();
      $('listSequence').hidden = true;
      $('qualityThresholdBar').classList.add('hidden');
      renderBam();
      afterLoad(file, (performance.now() - started) / 1000);
    } catch (err) {
      console.error(err);
      showError(t('errBam', err && err.message ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }
  function parseFlagstat(text) {
    const lines = String(text).split('\n');
    const get = (re) => { const l = lines.find((x) => re.test(x)); return l ? parseInt(l, 10) : null; };
    return {
      total: get(/in total/), mapped: get(/ mapped \(/), duplicates: get(/ duplicates/),
      paired: get(/paired in sequencing/), proper: get(/properly paired/),
    };
  }
  function renderBam() {
    const b = state.bam;
    const f = b.flagstat;
    const pct = (n) => (f.total ? ` (${fmtN((n / f.total) * 100, 1)} %)` : '');
    $('statsGrid').innerHTML = statGroup('', [
      card(t('statAligns'), fmtN(f.total)),
      card(t('statMapped'), `${fmtN(f.mapped)}<small>${pct(f.mapped)}</small>`),
      card(t('statDup'), `${fmtN(f.duplicates)}<small>${pct(f.duplicates)}</small>`),
      card(t('statPaired'), fmtN(f.paired)),
      ...(f.paired ? [card(t('statProperPair'), `${fmtN(f.proper)}<small>${pct(f.proper)}</small>`)] : []),
    ]);
    const idxHtml = b.idx
      ? `<div class="table-scroll"><table><thead><tr><th scope="col">${t('colRef')}</th><th scope="col">${t('colRefLen')}</th><th scope="col">${t('colMapped')}</th><th scope="col">${t('colUnmapped')}</th></tr></thead><tbody>${
        b.idx.map((r) => `<tr class="static"><td>${escapeHtml(r.ref)}</td><td>${fmtN(r.len)}</td><td>${fmtN(r.mapped)}</td><td>${fmtN(r.unmapped)}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="help">${t('bamIdxNoIndex')}</p>`;
    $('listAlt').innerHTML = `
      <div class="panel-card">
        <h2>${t('bamTitle')}</h2>
        <p class="help">${t('bamHelp')}</p>
        <h3>${t('bamIdxTitle')}</h3>${idxHtml}
        <h3>${t('bamHeaderLabel')}</h3>
        <pre class="code-block">${escapeHtml(String(b.header).slice(0, 4000))}</pre>
        <h3>${t('bamAlignLabel')}</h3>
        ${b.preview ? `<pre class="code-block">${escapeHtml(b.preview.slice(0, 6000))}</pre>` : `<p class="help">${t('bamPreviewNeedsIndex')}</p>`}
      </div>`;
    setAvailableTabs(['lista']);
  }

  // ------------------------------------------------------------------ exportación
  function exportOptions() {
    return {
      min_len: parseInt($('exMinLen').value, 10) || 0,
      max_len: parseInt($('exMaxLen').value, 10) || 0,
      keyword: $('exKeyword').value,
      min_qual: state.isFastq ? (parseFloat($('exMinQual').value) || 0) : 0,
      max_ee: state.isFastq ? (parseFloat($('exMaxEE').value) || 0) : 0,
      format: state.isFastq ? ($('exFormat').value === 'fasta' ? 'fasta' : 'same') : 'same',
      revcomp: state.alphabet !== 'protein' && $('exRevcomp').checked,
      gzip: $('exGzip').checked,
    };
  }
  function shellQuote(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }
  function updateExportCmd() {
    if (state.kind !== 'sequence') return;
    const o = exportOptions();
    const input = shellQuote(state.fileName || 'entrada.fastq.gz');
    const ext = (state.isFastq && o.format !== 'fasta') ? 'fastq' : 'fasta';
    const outName = shellQuote(`${baseName(state.fileName)}_seleccion.${ext}${o.gzip ? '.gz' : ''}`);
    const steps = [];
    if (o.keyword.trim()) steps.push(`seqkit grep -n -r -i -p ${shellQuote(o.keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}`);
    const seqFlags = [];
    if (o.min_len) seqFlags.push(`-m ${o.min_len}`);
    if (o.max_len) seqFlags.push(`-M ${o.max_len}`);
    if (o.min_qual) seqFlags.push(`-Q ${o.min_qual}`);
    if (o.revcomp) seqFlags.push('-r -p');
    if (seqFlags.length) steps.push(`seqkit seq ${seqFlags.join(' ')}`);
    if (state.isFastq && o.format === 'fasta') steps.push('seqkit fq2fa');
    if (!steps.length) steps.push('seqkit seq');
    const cmd = steps.map((s, i) => (i === 0 ? `${s} ${input}` : s)).join(' \\\n  | ');
    let text = `${cmd} \\\n  -o ${outName}`;
    if (o.max_ee) {
      text += `\n\n# ${t('exMaxEeLabel')}\nvsearch --fastq_filter ${input} --fastq_maxee ${o.max_ee} --fastqout ${outName}`;
    }
    $('exportCmd').textContent = text;
  }
  $('exportForm').addEventListener('input', updateExportCmd);
  $('exportForm').addEventListener('change', updateExportCmd);
  $('exportForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('exportBtn');
    btn.disabled = true;
    $('exportInfo').textContent = t('exportRunning');
    try {
      const { data, bytes } = await call('exportSelection', { options: exportOptions() });
      if (!data.count) { $('exportInfo').textContent = t('exportNone'); return; }
      downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), `${baseName(state.fileName)}_seleccion.${data.ext}`);
      $('exportInfo').textContent = t('exportInfo', fmtN(data.count));
    } catch (err) {
      $('exportInfo').textContent = userErrorMessage(err);
    } finally {
      btn.disabled = false;
    }
  });
  $('copyCmdBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('exportCmd').textContent);
      toast(t('copied'));
    } catch (_) { /* portapapeles no disponible */ }
  });
  $('exportStatsBtn').addEventListener('click', () => {
    const rows = statsRows();
    const cell = (v) => {
      const s = typeof v === 'number' && LANG === 'es' ? String(v).replace('.', ',') : String(v ?? '');
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [[t('csvKey'), t('csvValue')], ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
    downloadBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv' }), `${baseName(state.fileName)}_estadisticas.csv`);
  });
  function statsRows() {
    const s = state.result && state.result.summary;
    if (!s) return [];
    const rows = [[t('reportFile').replace(':', ''), state.fileName], [t('reportType').replace(':', ''), s.kind_label],
      [state.isFastq ? t('statReads') : t('statSeqs'), s.count], [t('statTotalBp'), s.total_bp],
      [t('statAvgLen'), s.avg_len], [t('statMedian'), s.median], ['Min', s.min_len], ['Max', s.max_len]];
    if (!state.isFastq) rows.push(['N50', s.n50], ['L50', s.l50], ['N90', s.n90]);
    if (s.alphabet !== 'protein') rows.push([t('statGC'), s.avg_gc], [t('statPctN'), s.pct_n]);
    if (s.pct_softmasked !== undefined && s.pct_softmasked !== null) rows.push([t('statSoftmasked'), s.pct_softmasked]);
    if (s.n_dup_ids !== undefined) rows.push([t('statDupIds'), s.n_dup_ids], ['Secuencias duplicadas', s.dup_seq_extra ?? 0]);
    if (state.isFastq) {
      rows.push([t('statQual'), s.avg_quality], [t('statQ30'), s.pct_q30], ['% ≥ Q20', s.pct_q20 ?? ''], ['Phred offset', s.phred_offset]);
      if (s.ee_mean !== undefined) rows.push([t('statEE'), s.ee_mean], ['% EE ≤ 1', s.ee_pct_le1]);
      if (s.pct_duplicated !== undefined) rows.push([`${t('statDupPct')} (%)`, s.pct_duplicated]);
      rows.push([`${t('polyG')} (%)`, s.polyg_pct ?? ''], [`${t('polyA')} (%)`, s.polya_pct ?? '']);
      if (s.genome_size) rows.push([t('statGenome'), s.genome_size], ['Cobertura (k-mer)', s.kmer_coverage]);
      if (s.n_lanes) rows.push([t('runLanes'), s.n_lanes], [t('runTiles'), s.n_tiles]);
      Object.entries(s.adapters || {}).forEach(([k, v]) => rows.push([`${t('statAdapters')} · ${k} (%)`, v]));
      rows.push([t('reportQualThreshold'), state.threshold]);
    }
    return rows;
  }

  // ------------------------------------------------------------------ informe imprimible
  // Los canvas son transparentes: al imprimir en modo oscuro el texto claro desaparecería
  // sobre el papel blanco. Se copia cada gráfico sobre el fondo del tema actual.
  function opaqueImage(canvas) {
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = COLORS.surface || '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    return out.toDataURL('image/png');
  }
  function buildPrintReport() {
    const el = $('printReport');
    const now = new Date().toLocaleString(LANG === 'en' ? 'en-US' : 'es-ES');
    const kindLabel = state.kind === 'bam' ? 'BAM' : (state.result && state.result.summary ? state.result.summary.kind_label : '');
    const head = `<div class="report-header"><h2>${t('reportTitle')}</h2><div class="report-meta">${t('reportFile')} <b>${escapeHtml(state.fileName || '—')}</b> · ${t('reportType')} <b>${escapeHtml(kindLabel)}</b> · ${t('reportGenerated')} ${escapeHtml(now)}</div></div>`;
    const table = (rows) => `<table class="report-table"><tbody>${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(typeof v === 'number' ? fmtN(v, 3) : v)}</td></tr>`).join('')}</tbody></table>`;
    const img = (id, label) => {
      const c = $(id);
      if (!c || c.closest('.hidden') || c.closest('[hidden]') || !charts || !Object.values(charts).some((ch) => ch && ch.canvas === c)) return '';
      try { return `<p><b>${escapeHtml(label)}</b></p><img class="report-chart-img" alt="${escapeHtml(label)}" src="${opaqueImage(c)}">`; } catch (_) { return ''; }
    };
    let html = head;
    if (state.kind === 'sequence') {
      html += table(statsRows()) + img('chartLen', t('chartLenTitle')) + img('chartGC', t('chartGCTitle')) + img('chartQual', t('chartQualTitle'))
        + img('chartQualHist', t('chartQualHistTitle')) + img('chartComp', t('chartCompTitle')) + img('chartEE', t('chartEETitle'))
        + img('chartKmer', t('chartKmerTitle')) + img('chartTile', t('tilesTitle')) + img('chartDup', t('chartDupTitle'));
    } else if (state.kind === 'tabular') {
      const s = state.result.summary;
      html += table([[t('rows'), s.n_rows], [t('cols'), s.n_cols]]) + `<p><b>${t('reportColumns')}</b> ${(s.columns || []).map((c) => escapeHtml(c.name)).join(', ')}</p>`;
      if (state.result.de) html += `<p>${escapeHtml($('volcanoSummary').textContent)}</p>` + img('chartVolcano', t('volcanoTitle', state.result.de.tool));
    } else if (state.kind === 'structure') {
      const s = state.result.summary;
      html += table([[t('statAtoms'), s.atoms], [t('statHetatms'), s.hetatms], [t('statChains'), `${s.n_chains} (${(s.chains || []).join(', ')})`], [t('statResidues'), s.n_residues], [t('statModels'), s.n_models]]);
      if ((s.chain_detail || []).length) {
        html += `<p><b>${t('chainsTitle')}</b></p>` + table(s.chain_detail.map((c) => [
          `${t('colChain')} ${c.chain}`,
          `${c.n_residues} ${t('colResidues').toLowerCase()} · ${c.first}–${c.last} · ${c.n_gaps} ${t('colGaps').toLowerCase()} (${c.missing_residues})`,
        ])) + img('chartBf', s.alphafold ? t('chartPlddtTitle') : t('chartBfactorTitle'));
      }
      const v3d = document.querySelector('#viewer3d canvas');
      if (v3d) { try { html += `<p><b>${t('reportViewer3D')}</b></p><img class="report-chart-img" alt="" src="${v3d.toDataURL('image/png')}">`; } catch (_) { /* sin captura */ } }
    } else if (state.kind === 'bam') {
      const f = state.bam.flagstat;
      html += table([[t('statAligns'), f.total], [t('statMapped'), f.mapped], [t('statDup'), f.duplicates], [t('statPaired'), f.paired]]);
      if (state.bam.idx) html += `<p><b>${t('reportIdx')}</b></p>` + table(state.bam.idx.map((r) => [r.ref, r.mapped]));
      html += `<pre style="white-space:pre-wrap;font-size:11px;">${escapeHtml(String(state.bam.header).slice(0, 2000))}</pre>`;
    }
    el.innerHTML = html;
  }
  $('printReportBtn').addEventListener('click', () => { buildPrintReport(); setTimeout(() => window.print(), 60); });

  // ------------------------------------------------------------------ guía de formatos
  function renderFormatsInfo() {
    $('formatsInfoContainer').innerHTML = `<p class="help intro">${t('formatsIntro')}</p>` + window.FORMATS_INFO.map((f) => {
      const d = f[LANG] || f.es;
      const list = (arr) => `<ul>${arr.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
      return `<div class="panel-card format-card">
        <h2><span class="fmt-icon" aria-hidden="true">${icon(f.icon)}</span>${f.name} <span class="format-ext">${f.ext}</span></h2>
        <p class="help subtitle">${escapeHtml(d.subtitle)}</p>
        <div class="format-grid">
          <div><h3>${t('formatsProps')}</h3>${list(d.properties)}</div>
          <div><h3>${t('formatsUses')}</h3>${list(d.uses)}</div>
          <div><h3>${t('formatsTool')}</h3>${list(d.tool)}</div>
        </div></div>`;
    }).join('');
  }
  $('navFormatsBtn').addEventListener('click', () => $('showFormatsInfoBtn').click());
  $('showFormatsInfoBtn').addEventListener('click', () => {
    $('results').classList.remove('hidden');
    $('emptyNote').classList.add('hidden');
    if (!state.result) {
      $('statsGrid').innerHTML = '';
      tabButtons().forEach((b) => { b.hidden = b.dataset.tab !== 'formatos'; });
    }
    activateTab('formatos', true);
  });

  // ------------------------------------------------------------------ tema claro / oscuro / automático
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function themeMode() { return document.documentElement.getAttribute('data-theme-mode') || 'auto'; }
  function applyTheme(mode, persist) {
    const dark = mode === 'dark' || (mode === 'auto' && darkQuery && darkQuery.matches);
    const root = document.documentElement;
    const changed = root.getAttribute('data-theme') !== (dark ? 'dark' : 'light');
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-theme-mode', mode);
    root.style.colorScheme = dark ? 'dark' : 'light';
    if (persist) storage.set('rmf-theme', mode);
    document.querySelectorAll('[data-theme-choice]').forEach((b) => {
      const on = b.dataset.themeChoice === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    refreshPalette();
    if (changed) redrawForTheme();
  }
  function redrawForTheme() {
    if (!state.result) return;
    if (state.kind === 'sequence') { renderSequenceCharts(); renderRun(); }
    else if (state.kind === 'tabular' && state.result.de) { if (charts.volcano) charts.volcano.destroy(); renderVolcano(state.result.de); }
    else if (state.kind === 'structure') {
      renderChains(state.result.summary);
      if (viewer3d) { viewer3d.setBackgroundColor(COLORS.surface); viewer3d.render(); }
    }
  }
  document.getElementById('themeGroup').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-choice]');
    if (b) applyTheme(b.dataset.themeChoice, true);
  });
  if (darkQuery) {
    const onSystem = () => { if (themeMode() === 'auto') applyTheme('auto', false); };
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSystem); else darkQuery.addListener(onSystem);
  }

  // ------------------------------------------------------------------ idioma
  function setLanguage(lang) {
    LANG = lang;
    window.APP_LANG = lang;
    storage.set('rmf-lang', lang);
    document.querySelectorAll('.lang-btn').forEach((b) => {
      const on = b.dataset.lang === lang;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    applyStaticI18n();
    renderFormatsInfo();
    $('engineText').textContent = engine.ready ? t('engineReady') : t('engineLoading');
    if (state.result) {
      if (state.kind === 'bam') renderBam();
      else if (state.kind === 'structure') {
        const s = state.result.summary;
        $('statsGrid').innerHTML = statGroup('', [card(t('statAtoms'), fmtN(s.atoms)), card(t('statHetatms'), fmtN(s.hetatms)), card(t('statChains'), fmtN(s.n_chains)), card(t('statResidues'), fmtN(s.n_residues)), card(t('statModels'), fmtN(s.n_models))]);
        renderChains(s);
      } else if (state.kind === 'tabular') {
        destroyCharts();
        renderTabular(state.result);
      } else if (state.kind === 'sequence') {
        renderWarnings(state.result.warnings);
        renderSummary();
        drawPage();
        renderSequenceCharts();
        renderRun();
        updateExportCmd();
        $('colLenHeader').textContent = t($('colLenHeader').dataset.i18n);
        $('motifHelp').innerHTML = t($('motifHelp').dataset.i18n);
      }
      if (state.kind !== 'sequence') renderWarnings(state.result.warnings);
      $('dzTitle').textContent = t('loaded', state.fileName);
      renderFileBar();
      setLoaderOpen(!$('loaderBody').hidden);
    }
    $('motifResults').innerHTML = '';
  }
  $('langEs').addEventListener('click', () => setLanguage('es'));
  $('langEn').addEventListener('click', () => setLanguage('en'));

  // ------------------------------------------------------------------ entradas: selector, arrastrar, pegar, ejemplos
  const fileInput = $('fileInput');
  fileInput.addEventListener('change', (e) => { routeFiles(e.target.files); e.target.value = ''; });
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    $('dropzone').classList.add('drag');
    $('dropOverlay').hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dropzone').classList.remove('drag'); $('dropOverlay').hidden = true; }
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('drag');
    $('dropOverlay').hidden = true;
    routeFiles(e.dataTransfer.files);
  });
  $('loadAnotherBtn').addEventListener('click', () => {
    const open = $('loaderBody').hidden;
    setLoaderOpen(open);
    if (open) $('dropzone').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('cancelBtn').addEventListener('click', () => cancelEngine());

  $('pasteBtn').addEventListener('click', () => {
    let text = $('pasteInput').value.trim();
    if (!text) { showError(t('pasteEmpty')); return; }
    let name = 'secuencia_pegada.fasta';
    if (text.startsWith('@')) name = 'secuencia_pegada.fastq';
    else if (!text.startsWith('>')) text = `>secuencia_pegada\n${text}`;
    routeFiles([new File([`${text}\n`], name, { type: 'text/plain' })]);
  });

  const EXAMPLES = {
    fasta: ['data/ejemplo.fasta'], protein: ['data/ejemplo_proteinas.fasta'], fastq: ['data/ejemplo.fastq.gz'],
    csv: ['data/ejemplo_resultados.csv'], tsv: ['data/ejemplo_metadatos.tsv'], pdb: ['data/ejemplo_estructura.pdb'],
    bam: ['data/ejemplo_alineamientos.bam', 'data/ejemplo_alineamientos.bam.bai'],
  };
  document.querySelector('.example-grid').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-example]');
    if (!b) return;
    clearError();
    try {
      const files = await Promise.all(EXAMPLES[b.dataset.example].map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        return new File([await res.blob()], url.split('/').pop());
      }));
      await routeFiles(files);
    } catch (err) {
      showError(t('exampleError'));
    }
  });

  // ------------------------------------------------------------------ arranque
  (function tape() {
    const s = Array.from({ length: 120 }, () => 'ATCG'[Math.floor(Math.random() * 4)]);
    const html = s.map((c) => `<span class="${c}">${c}</span>`).join('');
    $('tape').innerHTML = html + html;
  })();
  if (window.self !== window.top) {
    $('dzFallback').textContent = t('iframeFallback');
    $('dzFallback').hidden = false;
  }
  setLanguage(LANG);
  applyTheme(themeMode(), false);
  $('appVersion').textContent = `READMYFASTA v${APP_VERSION}`;
  startEngine();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    const hadController = !!navigator.serviceWorker.controller;
    let notified = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // solo si ya había una versión controlando la página: es una actualización, no la primera visita
      if (!hadController || notified) return;
      notified = true;
      toast(t('toastNewVersion'), { action: t('toastReload'), onAction: () => location.reload(), sticky: true });
    });
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  // Punto de acceso para las pruebas automáticas.
  window.__rmf = { state, charts, call };
})();
