import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

const $ = (sel) => document.querySelector(sel);

const els = {
  toolbar: $('#toolbar'),
  title: $('#title'),
  openBtn: $('#open-btn'),
  fileInput: $('#file-input'),
  dropzone: $('#dropzone'),
  welcome: $('#welcome'),
  status: $('#status'),
  reader: $('#reader'),
  pages: $('#pages'),
  progressBar: $('#progress-bar'),
  pageIndicator: $('#page-indicator'),
  zoomIn: $('#zoom-in'),
  zoomOut: $('#zoom-out'),
  themeBtn: $('#theme-btn'),
  settingsBtn: $('#settings-btn'),
  sheet: $('#sheet'),
  backdrop: $('#sheet-backdrop'),
  sizeRange: $('#size-range'),
  sizeValue: $('#size-value'),
  spacingRange: $('#spacing-range'),
  spacingValue: $('#spacing-value'),
};

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const FONT_MIN = 12, FONT_MAX = 44;
const ZOOM_MIN = 1, ZOOM_MAX = 4;

const defaults = {
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  mode: 'text',
  font: 'serif',
  fontSize: 19,
  lineHeight: 1.6,
  pageZoom: 1,
};

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

const settings = { ...defaults, ...loadJSON('br.settings', {}) };
const saveSettings = () => saveJSON('br.settings', settings);

const THEME_COLORS = { light: '#faf8f3', sepia: '#f4ecd8', dark: '#121212' };

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  document.querySelector('meta[name="theme-color"]').content = THEME_COLORS[settings.theme];
}
function applyFont() {
  document.documentElement.dataset.font = settings.font;
}
function applyTypography() {
  const root = document.documentElement.style;
  root.setProperty('--font-size', settings.fontSize + 'px');
  root.setProperty('--line-height', settings.lineHeight);
  root.setProperty('--page-zoom', settings.pageZoom);
}

function syncSheet() {
  for (const group of document.querySelectorAll('.segmented')) {
    const value = settings[group.dataset.setting];
    for (const b of group.children) b.classList.toggle('active', b.dataset.value === value);
  }
  if (settings.mode === 'text') {
    els.sizeRange.value = ((settings.fontSize - FONT_MIN) / (FONT_MAX - FONT_MIN)) * 100;
    els.sizeValue.textContent = Math.round(settings.fontSize) + 'px';
  } else {
    els.sizeRange.value = ((settings.pageZoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100;
    els.sizeValue.textContent = Math.round(settings.pageZoom * 100) + '%';
  }
  els.spacingRange.value = settings.lineHeight;
  els.spacingValue.textContent = settings.lineHeight.toFixed(1);
  document.body.classList.toggle('mode-pages', settings.mode === 'pages');
}

applyTheme();
applyFont();
applyTypography();
syncSheet();

/* ------------------------------------------------------------------ */
/* Document state                                                      */
/* ------------------------------------------------------------------ */

let pdf = null;
let docKey = null;       // used to remember the reading position per file
let numPages = 0;
let textBuilt = false;
let pagesBuilt = false;
let hasText = true;
let loadToken = 0;       // cancels stale work when a new file is opened

/* ------------------------------------------------------------------ */
/* Opening files                                                       */
/* ------------------------------------------------------------------ */

els.openBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files[0];
  if (file) openFile(file);
  els.fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('drag');
  });
}
for (const type of ['dragleave', 'drop']) {
  document.addEventListener(type, () => els.dropzone.classList.remove('drag'));
}
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find(
    (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (file) openFile(file);
});

async function openFile(file) {
  const token = ++loadToken;
  if (pdf) { pdf.destroy(); pdf = null; }
  pageObserver?.disconnect();

  docKey = `br.pos:${file.name}:${file.size}`;
  textBuilt = pagesBuilt = false;
  els.reader.replaceChildren();
  els.pages.replaceChildren();
  els.reader.hidden = els.pages.hidden = true;
  els.welcome.hidden = true;
  els.title.textContent = file.name.replace(/\.pdf$/i, '');
  document.title = els.title.textContent;
  setStatus('Opening…');

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjsLib.getDocument({ data }).promise;
    if (token !== loadToken) { doc.destroy(); return; }
    pdf = doc;
    numPages = pdf.numPages;

    const meta = await pdf.getMetadata().catch(() => null);
    const metaTitle = meta?.info?.Title?.trim();
    if (metaTitle && metaTitle.length > 2) {
      els.title.textContent = metaTitle;
      document.title = metaTitle;
    }

    await showMode(token);
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    setStatus(err?.name === 'PasswordException'
      ? 'This PDF is password protected and can’t be opened.'
      : 'Sorry, that file couldn’t be read as a PDF.');
    els.welcome.hidden = false;
  }
}

function setStatus(text) {
  els.status.hidden = !text;
  els.status.textContent = text || '';
}

async function showMode(token = loadToken) {
  if (!pdf) return;
  const pos = loadJSON(docKey, {});

  if (settings.mode === 'text') {
    if (!textBuilt) {
      await buildText(token);
      if (token !== loadToken) return;
      if (!hasText) {
        // Scanned / image-only PDF: there's no text to reflow, so show the pages.
        settings.mode = 'pages';
        syncSheet();
        setStatus('');
        await showMode(token);
        flash('No selectable text in this PDF, showing original pages');
        return;
      }
    }
    els.pages.hidden = true;
    els.reader.hidden = false;
    setStatus('');
    restoreText(pos);
  } else {
    if (!pagesBuilt) await buildPages(token);
    if (token !== loadToken) return;
    els.reader.hidden = true;
    els.pages.hidden = false;
    setStatus('');
    restorePages(pos);
  }
  updateProgress();
}

/* ------------------------------------------------------------------ */
/* Text extraction and reflow                                          */
/* ------------------------------------------------------------------ */

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Group a page's text items into visual lines. */
async function extractLines(page) {
  const content = await page.getTextContent();
  const lines = [];
  let cur = null;

  const push = () => {
    if (cur && cur.text.trim()) {
      cur.text = cur.text.replace(/\s+/g, ' ').trim();
      lines.push(cur);
    }
    cur = null;
  };

  for (const item of content.items) {
    if (!('str' in item)) continue;
    const [a, b, c, d, x, y] = item.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || item.height || 10;

    if (item.str) {
      if (cur && Math.abs(y - cur.y) <= size * 0.5) {
        const gap = x - cur.xEnd;
        if (gap > size * 0.12 && !/\s$/.test(cur.text) && !/^\s/.test(item.str)) cur.text += ' ';
        cur.text += item.str;
        cur.xEnd = Math.max(cur.xEnd, x + item.width);
        cur.size = Math.max(cur.size, size);
      } else {
        push();
        cur = { text: item.str, x, y, xEnd: x + item.width, size };
      }
    }
    if (item.hasEOL) push();
  }
  push();
  // Mark lines in the top/bottom margin, where page numbers and running headers live.
  const [, yMin, , yMax] = page.view;
  const band = (yMax - yMin) * 0.1;
  for (const l of lines) l.edge = l.y > yMax - band || l.y < yMin + band;
  return lines;
}

const isPageNumber = (t) =>
  /^(page\s*)?[\divxlc]+(\s*(of|\/)\s*\d+)?$/i.test(t) || /^[-–—]\s*\d+\s*[-–—]$/.test(t);

const normalizeRepeat = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');

/** Remove page numbers and running headers/footers that repeat across pages. */
function stripFurniture(pagesLines) {
  const counts = new Map();
  for (const lines of pagesLines) {
    const edge = new Set(lines.filter((l) => l.edge).map((l) => normalizeRepeat(l.text)));
    for (const k of edge) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const threshold = Math.max(3, pagesLines.length * 0.25);
  const repeated = new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));

  return pagesLines.map((lines) => lines.filter((l) => {
    if (!l.edge) return true;
    if (isPageNumber(l.text)) return false;
    if (repeated.has(normalizeRepeat(l.text)) && l.text.length < 120) return false;
    return true;
  }));
}

const endsSentence = (t) => /[.!?:;…"”’)\]]$/.test(t);

function joinLines(a, b) {
  // Re-join words hyphenated across a line break: "exam-" + "ple" → "example".
  if (/[a-zà-ÿ]-$/i.test(a) && /^[a-zà-ÿ]/.test(b)) return a.slice(0, -1) + b;
  return a + ' ' + b;
}

/** Turn every page's lines into a flat list of paragraphs / headings. */
function buildBlocks(pagesLines) {
  const bodySize = median(pagesLines.flat().map((l) => l.size)) || 10;
  const blocks = [];
  let para = null;

  const flush = () => { if (para) blocks.push(para); para = null; };

  pagesLines.forEach((lines, pageIndex) => {
    if (!lines.length) return;
    const gaps = [];
    for (let i = 1; i < lines.length; i++) {
      const g = lines[i - 1].y - lines[i].y;
      if (g > 0 && g < bodySize * 4) gaps.push(g);
    }
    const lineGap = median(gaps) || bodySize * 1.3;
    const left = median(lines.filter((l) => Math.abs(l.size - bodySize) < bodySize * 0.15).map((l) => l.x))
      || Math.min(...lines.map((l) => l.x));
    const right = Math.max(...lines.map((l) => l.xEnd));

    lines.forEach((line, i) => {
      const prev = i > 0 ? lines[i - 1] : null;
      const heading = line.size > bodySize * 1.15 && line.text.length < 160;
      const level = line.size > bodySize * 1.5 ? 2 : 3;
      const indented = line.x - left > bodySize * 0.8;

      let newBlock;
      if (!para) newBlock = true;
      else if (heading || para.heading) {
        // Consecutive lines of the same heading stay together.
        newBlock = !(heading && para.heading && prev && Math.abs(prev.size - line.size) < 0.5
          && prev.y - line.y < line.size * 2);
      } else if (!prev) {
        // First line of a new page: continue the paragraph unless it clearly ended.
        newBlock = endsSentence(para.text) && (indented || para.lastShort);
      } else {
        const gap = prev.y - line.y;
        newBlock =
          gap < 0 ||                                    // jumped up: new column / region
          gap > lineGap * 1.45 ||                       // blank space between paragraphs
          Math.abs(prev.size - line.size) > bodySize * 0.15 ||
          (indented && !(prev.x - left > bodySize * 0.8)) || // first-line indent
          (para.lastShort && endsSentence(prev.text));  // previous line ended early
      }

      if (newBlock) {
        flush();
        para = { text: line.text, heading, level, page: pageIndex + 1 };
      } else {
        para.text = joinLines(para.text, line.text);
      }
      para.lastShort = right - line.xEnd > (right - left) * 0.15;
    });
  });
  flush();
  return blocks;
}

async function buildText(token) {
  const pagesLines = [];
  let chars = 0;
  for (let n = 1; n <= numPages; n++) {
    if (token !== loadToken) return;
    if (n === 1 || n % 5 === 0) setStatus(`Preparing text… ${Math.round((n / numPages) * 100)}%`);
    const page = await pdf.getPage(n);
    const lines = await extractLines(page);
    page.cleanup();
    chars += lines.reduce((s, l) => s + l.text.length, 0);
    pagesLines.push(lines);
  }

  hasText = chars > Math.max(40, numPages * 20);
  if (!hasText) return;

  const blocks = buildBlocks(stripFurniture(pagesLines));

  // Group blocks into chunks so the browser can skip offscreen layout.
  const frag = document.createDocumentFragment();
  let chunk = null;
  let chunkPage = 0;
  blocks.forEach((b, i) => {
    if (!chunk || (b.page !== chunkPage && chunk.childElementCount >= 12)) {
      chunk = document.createElement('div');
      chunk.className = 'chunk';
      frag.append(chunk);
      chunkPage = b.page;
    }
    const el = document.createElement(b.heading ? `h${b.level}` : 'p');
    el.textContent = b.text;
    el.dataset.i = i;
    el.dataset.page = b.page;
    chunk.append(el);
  });
  els.reader.replaceChildren(frag);
  textBuilt = true;
}

/* ------------------------------------------------------------------ */
/* Original pages (continuous, no gaps)                                */
/* ------------------------------------------------------------------ */

let pageObserver = null;
const rendered = new Map(); // page number → rendered scale

async function buildPages(token) {
  setStatus('Loading pages…');
  const inner = document.createElement('div');
  inner.className = 'pages-inner';

  // Use page 1's shape as a placeholder for all pages, then correct as each loads.
  const first = await pdf.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  for (let n = 1; n <= numPages; n++) {
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = n;
    div.style.aspectRatio = `${vp.width} / ${vp.height}`;
    inner.append(div);
  }
  if (token !== loadToken) return;
  els.pages.replaceChildren(inner);
  rendered.clear();

  pageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const n = +e.target.dataset.page;
      if (e.isIntersecting) renderPage(n, e.target);
      else if (rendered.has(n)) unrenderPage(n, e.target);
    }
  }, { rootMargin: '150% 0px' });
  for (const div of inner.children) pageObserver.observe(div);
  pagesBuilt = true;
}

async function renderPage(n, div) {
  const scale = Math.min(window.devicePixelRatio || 1, 2) * settings.pageZoom;
  if (rendered.get(n) === scale) return;
  rendered.set(n, scale);

  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  div.style.aspectRatio = `${base.width} / ${base.height}`;
  const cssWidth = div.clientWidth || window.innerWidth;
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  try {
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  } catch { return; }
  if (rendered.get(n) !== scale) return; // superseded by a newer render
  div.replaceChildren(canvas);
}

function unrenderPage(n, div) {
  rendered.delete(n);
  div.replaceChildren();
}

let rerenderTimer = 0;
function rerenderVisiblePages() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    for (const div of els.pages.querySelectorAll('.page')) {
      const r = div.getBoundingClientRect();
      if (r.bottom > -innerHeight && r.top < innerHeight * 2) renderPage(+div.dataset.page, div);
    }
  }, 250);
}

/* ------------------------------------------------------------------ */
/* Reading position                                                    */
/* ------------------------------------------------------------------ */

const topOffset = () => els.toolbar.getBoundingClientRect().bottom;

/** The element at the top of the screen, and how far its top sits from the toolbar. */
function anchorPoint() {
  const container = settings.mode === 'text' ? els.reader : els.pages;
  const y = Math.max(topOffset(), 0) + 4;
  const x = container.getBoundingClientRect().left + container.clientWidth / 2;
  let el = document.elementFromPoint(Math.min(x, innerWidth - 1), y);
  if (settings.mode === 'text') el = el?.closest('#reader [data-i]');
  else el = el?.closest('.page');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { el, frac: r.height ? (y - r.top) / r.height : 0 };
}

let programmaticScrollUntil = 0;

function scrollToAnchor({ el, frac }) {
  programmaticScrollUntil = performance.now() + 250;
  const r = el.getBoundingClientRect();
  window.scrollTo(window.scrollX, window.scrollY + r.top + r.height * frac - (Math.max(topOffset(), 0) + 4));
}

function savePosition() {
  if (!pdf || !docKey) return;
  const a = anchorPoint();
  if (!a) return;
  const pos = loadJSON(docKey, {});
  if (settings.mode === 'text') pos.text = { i: +a.el.dataset.i, frac: a.frac };
  else pos.pages = { page: +a.el.dataset.page, frac: a.frac };
  pos.page = +a.el.dataset.page;
  saveJSON(docKey, pos);
}

function restoreText(pos) {
  let el = null, frac = 0;
  if (pos.text) {
    el = els.reader.querySelector(`[data-i="${pos.text.i}"]`);
    frac = pos.text.frac;
  } else if (pos.page) {
    el = els.reader.querySelector(`[data-page="${pos.page}"]`);
  }
  if (el) { el.scrollIntoView(); scrollToAnchor({ el, frac }); }
  else window.scrollTo(0, 0);
}

function restorePages(pos) {
  const n = pos.pages?.page || pos.page;
  const el = n && els.pages.querySelector(`.page[data-page="${n}"]`);
  if (el) scrollToAnchor({ el, frac: pos.pages?.frac || 0 });
  else window.scrollTo(0, 0);
}

/* ------------------------------------------------------------------ */
/* Zoom                                                                */
/* ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function setZoom(value) {
  const anchor = anchorPoint();
  if (settings.mode === 'text') settings.fontSize = clamp(value, FONT_MIN, FONT_MAX);
  else settings.pageZoom = clamp(value, ZOOM_MIN, ZOOM_MAX);
  applyTypography();
  if (anchor) scrollToAnchor(anchor);
  if (settings.mode === 'pages') rerenderVisiblePages();
  syncSheet();
  saveSettingsSoon();
}

const currentZoom = () => (settings.mode === 'text' ? settings.fontSize : settings.pageZoom);
const zoomStep = (dir) => {
  if (settings.mode === 'text') setZoom(Math.round(settings.fontSize + dir * 2));
  else setZoom(Math.round((settings.pageZoom + dir * 0.25) * 4) / 4);
};

els.zoomIn.addEventListener('click', () => zoomStep(1));
els.zoomOut.addEventListener('click', () => zoomStep(-1));

let saveTimer = 0;
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 300);
}

// Pinch-to-zoom: two-finger gestures change the text size (or page zoom)
// instead of zooming the whole web page.
let pinch = null;
let pinchFrame = 0;
const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

document.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2 && pdf && !els.sheet.contains(e.target)) {
    pinch = { start: touchDist(e.touches), zoom: currentZoom() };
    e.preventDefault();
  }
}, { passive: false });

document.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const ratio = touchDist(e.touches) / pinch.start;
  cancelAnimationFrame(pinchFrame);
  pinchFrame = requestAnimationFrame(() => setZoom(pinch ? pinch.zoom * ratio : currentZoom()));
}, { passive: false });

document.addEventListener('touchend', (e) => {
  if (pinch && e.touches.length < 2) {
    pinch = null;
    if (settings.mode === 'text') setZoom(Math.round(settings.fontSize));
  }
});

// iOS Safari fires its own gesture events for pinch; block them so the page doesn't zoom.
for (const type of ['gesturestart', 'gesturechange']) {
  document.addEventListener(type, (e) => { if (pdf) e.preventDefault(); });
}

// Ctrl/Cmd + wheel (and trackpad pinch on desktop) also zooms the text.
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !pdf) return;
  e.preventDefault();
  setZoom(currentZoom() * Math.exp(-e.deltaY * 0.01));
}, { passive: false });

/* ------------------------------------------------------------------ */
/* Theme, settings sheet                                               */
/* ------------------------------------------------------------------ */

els.themeBtn.addEventListener('click', () => {
  settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  syncSheet();
  saveSettings();
});

function openSheet(open) {
  els.sheet.hidden = els.backdrop.hidden = !open;
  if (open) syncSheet();
}
els.settingsBtn.addEventListener('click', () => openSheet(els.sheet.hidden));
els.backdrop.addEventListener('click', () => openSheet(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openSheet(false); });

for (const group of document.querySelectorAll('.segmented')) {
  group.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const key = group.dataset.setting;
    const value = btn.dataset.value;
    if (settings[key] === value) return;

    if (key === 'mode') {
      savePosition();
      settings.mode = value;
      saveSettings();
      syncSheet();
      await showMode();
      return;
    }
    if (key === 'font') {
      const anchor = anchorPoint();
      settings.font = value;
      applyFont();
      if (anchor) scrollToAnchor(anchor);
    }
    if (key === 'theme') {
      settings.theme = value;
      applyTheme();
    }
    saveSettings();
    syncSheet();
  });
}

els.sizeRange.addEventListener('input', () => {
  const t = els.sizeRange.value / 100;
  if (settings.mode === 'text') setZoom(Math.round(FONT_MIN + t * (FONT_MAX - FONT_MIN)));
  else setZoom(Math.round((ZOOM_MIN + t * (ZOOM_MAX - ZOOM_MIN)) * 20) / 20);
});

els.spacingRange.addEventListener('input', () => {
  const anchor = anchorPoint();
  settings.lineHeight = +els.spacingRange.value;
  applyTypography();
  if (anchor) scrollToAnchor(anchor);
  syncSheet();
  saveSettingsSoon();
});

/* ------------------------------------------------------------------ */
/* Scrolling: progress, page indicator, auto-hiding toolbar            */
/* ------------------------------------------------------------------ */

let lastY = window.scrollY;
let indicatorTimer = 0;
let posTimer = 0;

function updateProgress() {
  const max = document.documentElement.scrollHeight - innerHeight;
  els.progressBar.style.width = pdf && max > 0 ? (window.scrollY / max) * 100 + '%' : '0';
}

function updatePageIndicator() {
  const a = pdf && anchorPoint();
  if (!a) return;
  els.pageIndicator.hidden = false;
  els.pageIndicator.textContent = `Page ${a.el.dataset.page} of ${numPages}`;
  els.pageIndicator.classList.add('show');
  clearTimeout(indicatorTimer);
  indicatorTimer = setTimeout(() => els.pageIndicator.classList.remove('show'), 1200);
}

window.addEventListener('scroll', () => {
  const y = window.scrollY;
  if (pdf && !pinch && performance.now() > programmaticScrollUntil) {
    if (y > lastY + 8 && y > 120) els.toolbar.classList.add('hidden');
    else if (y < lastY - 8) els.toolbar.classList.remove('hidden');
  }
  lastY = y;
  updateProgress();
  if (pdf) {
    updatePageIndicator();
    clearTimeout(posTimer);
    posTimer = setTimeout(savePosition, 400);
  }
}, { passive: true });

// Tap the middle of the screen to bring the toolbar back.
document.addEventListener('click', (e) => {
  if (e.target.closest('#reader, #pages')) els.toolbar.classList.toggle('hidden');
});

window.addEventListener('resize', () => {
  if (settings.mode === 'pages' && pdf) rerenderVisiblePages();
  updateProgress();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });

function flash(text) {
  els.pageIndicator.hidden = false;
  els.pageIndicator.textContent = text;
  els.pageIndicator.classList.add('show');
  clearTimeout(indicatorTimer);
  indicatorTimer = setTimeout(() => els.pageIndicator.classList.remove('show'), 3500);
}
