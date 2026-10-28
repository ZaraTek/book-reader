import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

const $ = (sel) => document.querySelector(sel);

const els = {
  toolbar: $('#toolbar'),
  title: $('#title'),
  openBtn: $('#open-btn'),
  libraryBtn: $('#library-btn'),
  library: $('#library'),
  libraryList: $('#library-list'),
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
  tocBtn: $('#toc-btn'),
  toc: $('#toc'),
  tocList: $('#toc-list'),
  tocHeading: $('#toc-heading'),
  gotoForm: $('#goto-form'),
  gotoInput: $('#goto-input'),
  gotoTotal: $('#goto-total'),
  backBtn: $('#back-btn'),
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
let bookId = null;       // library id of the open book: "<file name>:<size>"
let docKey = null;       // used to remember the reading position per file
let numPages = 0;
let textBuilt = false;
let pagesBuilt = false;
let hasText = true;
let loadToken = 0;       // cancels stale work when a new file is opened

/* ------------------------------------------------------------------ */
/* Opening files                                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Library: PDFs saved on this device (IndexedDB)                      */
/* ------------------------------------------------------------------ */

let dbPromise = null;
function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('book-reader', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('books', { keyPath: 'id' }); // metadata
      req.result.createObjectStore('files');                    // id → PDF bytes
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const request = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const completed = (t) => new Promise((resolve, reject) => {
  t.oncomplete = () => resolve();
  t.onerror = t.onabort = () => reject(t.error);
});

const library = {
  async list() {
    const books = await request((await db()).transaction('books').objectStore('books').getAll());
    return books.sort((a, b) => b.lastOpened - a.lastOpened);
  },
  async get(id) {
    return request((await db()).transaction('books').objectStore('books').get(id));
  },
  async data(id) {
    return request((await db()).transaction('files').objectStore('files').get(id));
  },
  async add(book, data) {
    const t = (await db()).transaction(['books', 'files'], 'readwrite');
    t.objectStore('files').put(data, book.id);
    t.objectStore('books').put(book);
    return completed(t);
  },
  async update(id, changes) {
    const t = (await db()).transaction('books', 'readwrite');
    const books = t.objectStore('books');
    const r = books.get(id);
    r.onsuccess = () => { if (r.result) books.put({ ...r.result, ...changes }); };
    return completed(t);
  },
  async remove(id) {
    const t = (await db()).transaction(['books', 'files'], 'readwrite');
    t.objectStore('books').delete(id);
    t.objectStore('files').delete(id);
    try { localStorage.removeItem(`br.pos:${id}`); } catch { /* storage unavailable */ }
    return completed(t);
  },
};

async function renderLibrary() {
  const books = await library.list().catch(() => []);
  if (pdf) return; // a book was opened meanwhile
  els.welcome.classList.toggle('has-books', books.length > 0);
  els.library.hidden = !books.length;
  els.libraryList.replaceChildren(...books.map((book) => {
    const li = document.createElement('li');
    li.className = 'book';

    const open = document.createElement('button');
    open.className = 'book-open';
    const title = document.createElement('div');
    title.className = 'book-title';
    title.textContent = book.title;
    const meta = document.createElement('div');
    meta.className = 'book-meta';
    const pct = Math.round((book.progress || 0) * 100);
    meta.textContent = book.page && book.numPages
      ? `Page ${book.page} of ${book.numPages} · ${pct}%`
      : 'Not started';
    const bar = document.createElement('div');
    bar.className = 'book-bar';
    bar.append(Object.assign(document.createElement('span'), { style: `width: ${pct}%` }));
    open.append(title, meta, bar);
    open.addEventListener('click', () => openFromLibrary(book.id));

    const del = document.createElement('button');
    del.className = 'icon-btn book-delete';
    del.setAttribute('aria-label', `Remove ${book.title}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
    del.addEventListener('click', async () => {
      if (!confirm(`Remove “${book.title}” from your library?`)) return;
      await library.remove(book.id).catch(() => {});
      renderLibrary();
    });

    li.append(open, del);
    return li;
  }));
}

let persistAsked = false;
function keepStorage() {
  // Ask the browser not to clear saved books when the device is low on space.
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}

async function openFromLibrary(id) {
  const [book, data] = await Promise.all([library.get(id), library.data(id)]).catch(() => []);
  if (!book || !data) {
    flash('That book couldn’t be loaded from your library');
    renderLibrary();
    return;
  }
  library.update(id, { lastOpened: Date.now() }).catch(() => {});
  openBook(book, new Uint8Array(data));
}

/** Close the open book and show the library. */
function closeBook() {
  savePosition();
  loadToken++;
  pdf?.destroy();
  pdf = null;
  bookId = docKey = null;
  pageObserver?.disconnect();
  els.reader.replaceChildren();
  els.pages.replaceChildren();
  els.reader.hidden = els.pages.hidden = true;
  els.backBtn.hidden = els.tocBtn.hidden = els.libraryBtn.hidden = true;
  els.openBtn.hidden = false;
  els.pageIndicator.classList.remove('show');
  els.toolbar.classList.remove('hidden');
  els.title.textContent = document.title = 'Book Reader';
  setStatus('');
  els.welcome.hidden = false;
  document.body.classList.remove('reading');
  window.scrollTo(0, 0);
  updateProgress();
  renderLibrary();
}

els.openBtn.addEventListener('click', () => els.fileInput.click());
els.libraryBtn.addEventListener('click', closeBook);
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
  const data = new Uint8Array(await file.arrayBuffer());
  const id = `${file.name}:${file.size}`;
  const saved = await library.get(id).catch(() => null);
  const book = saved || {
    id,
    name: file.name,
    size: file.size,
    title: file.name.replace(/\.pdf$/i, ''),
    added: Date.now(),
  };
  if (saved) {
    library.update(id, { lastOpened: Date.now() }).catch(() => {});
  } else {
    library.add({ ...book, lastOpened: Date.now() }, data)
      .then(keepStorage)
      .catch((err) => {
        console.warn(err);
        flash('Couldn’t save this book to your library (storage may be full)');
      });
  }
  // PDF.js takes ownership of the bytes it's given, so hand it a copy.
  openBook(book, data.slice());
}

async function openBook(book, data) {
  const token = ++loadToken;
  if (pdf) { pdf.destroy(); pdf = null; }
  pageObserver?.disconnect();

  bookId = book.id;
  docKey = `br.pos:${book.id}`;
  textBuilt = pagesBuilt = false;
  linkCache.clear();
  linkTargets.clear();
  backAnchor = null;
  els.backBtn.hidden = els.tocBtn.hidden = els.tocHeading.hidden = true;
  els.tocList.replaceChildren();
  els.reader.replaceChildren();
  els.pages.replaceChildren();
  els.reader.hidden = els.pages.hidden = true;
  els.welcome.hidden = true;
  document.body.classList.add('reading');
  els.openBtn.hidden = true;
  els.libraryBtn.hidden = false;
  els.title.textContent = book.title;
  document.title = book.title;
  setStatus('Opening…');

  try {
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
    library.update(book.id, { title: els.title.textContent, numPages }).catch(() => {});

    els.tocBtn.hidden = false;
    buildToc(token);
    await showMode(token);
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    setStatus(err?.name === 'PasswordException'
      ? 'This PDF is password protected and can’t be opened.'
      : 'Sorry, that file couldn’t be read as a PDF.');
    pdf = null;
    bookId = docKey = null;
    els.welcome.hidden = els.openBtn.hidden = false;
    document.body.classList.remove('reading');
    els.libraryBtn.hidden = els.tocBtn.hidden = true;
    renderLibrary();
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
    textLayoutChanged();
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

/*
 * Text is kept as "segments": runs of text that are either plain or belong to one
 * PDF link, so links survive being reflowed into paragraphs.
 */
function appendSeg(segs, text, link) {
  const last = segs[segs.length - 1];
  if (last && last.link === link) last.text += text;
  else segs.push({ text, link });
}

/** Collapse whitespace across a line's segments and trim the ends. */
function normalizeSegs(segs) {
  const out = [];
  for (const seg of segs) {
    let text = seg.text.replace(/\s+/g, ' ');
    const prev = out[out.length - 1];
    if ((!prev || prev.text.endsWith(' ')) && text.startsWith(' ')) text = text.slice(1);
    if (text) appendSeg(out, text, seg.link);
  }
  const last = out[out.length - 1];
  if (last) last.text = last.text.trimEnd();
  return out.filter((seg) => seg.text);
}

/** Split a text item into segments according to which link rectangles cover each character. */
function itemSegments(item, x, y, size, links) {
  const midY = y + size * 0.35;
  const hits = links.filter((l) =>
    midY >= l.rect[1] - 2 && midY <= l.rect[3] + 2 && x < l.rect[2] && x + item.width > l.rect[0]);
  if (!hits.length) return [{ text: item.str, link: null }];

  // Character positions are estimated, so decide link membership per whole word.
  const segs = [];
  const charWidth = item.width / Math.max(item.str.length, 1);
  const linkAt = (cx) => hits.find((l) => cx >= l.rect[0] && cx <= l.rect[2]) || null;
  const tokens = [...item.str.matchAll(/\S+|\s+/g)];
  const wordLinks = tokens.map((t) => (/\S/.test(t[0])
    ? linkAt(x + (t.index + t[0].length / 2) * charWidth) : undefined));
  tokens.forEach((t, i) => {
    let link = wordLinks[i];
    if (link === undefined) link = wordLinks[i - 1] && wordLinks[i - 1] === wordLinks[i + 1] ? wordLinks[i - 1] : null;
    appendSeg(segs, t[0], link);
  });
  return segs;
}

/** A page's link annotations, with rectangles normalized to [x1, y1, x2, y2]. */
const linkCache = new Map();
function pageLinks(page) {
  if (!linkCache.has(page.pageNumber)) {
    linkCache.set(page.pageNumber, page.getAnnotations({ intent: 'display' }).then((annots) =>
      annots
        .filter((a) => a.subtype === 'Link' && (a.dest || a.url))
        .map((a) => {
          const [x1, y1, x2, y2] = a.rect;
          return {
            dest: a.dest || null,
            url: a.url || null,
            rect: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
          };
        }))
      .catch(() => []));
  }
  return linkCache.get(page.pageNumber);
}

/** Group a page's text items into visual lines. */
async function extractLines(page) {
  const [content, links] = await Promise.all([page.getTextContent(), pageLinks(page)]);
  const lines = [];
  let cur = null;

  const push = () => {
    if (cur && cur.text.trim()) {
      cur.text = cur.text.replace(/\s+/g, ' ').trim();
      cur.segs = normalizeSegs(cur.segs);
      lines.push(cur);
    }
    cur = null;
  };

  for (const item of content.items) {
    if (!('str' in item)) continue;
    const [a, b, c, d, x, y] = item.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || item.height || 10;

    if (item.str) {
      const segs = itemSegments(item, x, y, size, links);
      if (cur && Math.abs(y - cur.y) <= size * 0.5) {
        const gap = x - cur.xEnd;
        if (gap > size * 0.12 && !/\s$/.test(cur.text) && !/^\s/.test(item.str)) {
          const prevLink = cur.segs[cur.segs.length - 1]?.link;
          cur.text += ' ';
          appendSeg(cur.segs, ' ', prevLink === segs[0].link ? prevLink : null);
        }
        cur.text += item.str;
        for (const seg of segs) appendSeg(cur.segs, seg.text, seg.link);
        cur.xEnd = Math.max(cur.xEnd, x + item.width);
        cur.size = Math.max(cur.size, size);
      } else {
        push();
        cur = { text: item.str, segs, x, y, xEnd: x + item.width, size };
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

// A line that is one whole link, e.g. an entry on a contents page.
const isLinkLine = (l) => l.segs.length === 1 && l.segs[0].link;
// "Chapter 3 .......... 42" style contents entries.
const isTocLine = (t) => /(\.\s?){3,}\s*\d+$|…\s*\d+$/.test(t);

const endsSentence = (t) => /[.!?:;…"”’)\]]$/.test(t);

function joinLines(para, line) {
  const last = para.segs[para.segs.length - 1];
  const first = line.segs[0];
  // Re-join words hyphenated across a line break: "exam-" + "ple" → "example".
  if (/[a-zà-ÿ]-$/i.test(para.text) && /^[a-zà-ÿ]/.test(line.text)) {
    para.text = para.text.slice(0, -1) + line.text;
    last.text = last.text.slice(0, -1);
  } else {
    para.text += ' ' + line.text;
    appendSeg(para.segs, ' ', last.link === first.link ? last.link : null);
  }
  for (const seg of line.segs) appendSeg(para.segs, seg.text, seg.link);
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
          (para.lastShort && endsSentence(prev.text)) || // previous line ended early
          isTocLine(prev.text) ||
          ((isLinkLine(prev) || isLinkLine(line)) && prev.segs.at(-1).link !== line.segs[0].link);
      }

      if (newBlock) {
        flush();
        para = {
          text: line.text,
          segs: line.segs.map((seg) => ({ ...seg })),
          heading, level, page: pageIndex + 1, y: line.y,
        };
      } else {
        joinLines(para, line);
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
    for (const seg of b.segs) el.append(seg.link ? linkElement(seg.link, seg.text) : seg.text);
    el.dataset.i = i;
    el.dataset.page = b.page;
    el.dataset.y = Math.round(b.y);
    chunk.append(el);
  });
  for (const c of frag.children) c.dataset.chars = c.textContent.length;
  els.reader.replaceChildren(frag);
  textBuilt = true;
}

/* ------------------------------------------------------------------ */
/* Chunk heights                                                       */
/* ------------------------------------------------------------------ */

// Offscreen chunks skip layout (content-visibility: auto), so the browser places
// them using contain-intrinsic-size. Estimate it from the text length right away,
// then measure the real heights in the background so jumps and scrolling are exact.

let lastUserScroll = 0;
let measureGen = 0;
let measureTimer = 0;

/** Lay a chunk out for real and return its height. */
function chunkHeight(chunk) {
  chunk.style.contentVisibility = 'visible';
  const h = chunk.offsetHeight;
  chunk.style.contentVisibility = '';
  return h;
}

function estimateChunks() {
  const chunks = [...els.reader.querySelectorAll('.chunk')];
  const sample = chunks.reduce((a, b) => (+b.dataset.chars > +a.dataset.chars ? b : a), chunks[0]);
  if (!sample || !+sample.dataset.chars) return;
  const perChar = chunkHeight(sample) / +sample.dataset.chars;
  for (const c of chunks) c.style.containIntrinsicSize = Math.round(+c.dataset.chars * perChar) + 'px';
}

function measureChunks(delay = 400) {
  const gen = ++measureGen;
  clearTimeout(measureTimer);
  const chunks = [...els.reader.querySelectorAll('.chunk')];
  let i = 0;
  const step = () => {
    if (gen !== measureGen || els.reader.hidden) return;
    // Correcting heights above the screen shifts the page, which would interrupt
    // a scroll in progress, so wait until the reader is still.
    if (performance.now() - lastUserScroll < 300 || pinch) {
      measureTimer = setTimeout(step, 300);
      return;
    }
    const anchor = anchorPoint();
    const before = anchor?.el.getBoundingClientRect().top;
    const until = performance.now() + 8;
    while (i < chunks.length && performance.now() < until) {
      const c = chunks[i++];
      c.style.containIntrinsicSize = chunkHeight(c) + 'px';
    }
    const shift = anchor ? anchor.el.getBoundingClientRect().top - before : 0;
    if (Math.abs(shift) > 0.5) {
      programmaticScrollUntil = performance.now() + 250;
      window.scrollBy(0, shift);
    }
    if (i < chunks.length) measureTimer = setTimeout(step, 16);
  };
  measureTimer = setTimeout(step, delay);
}

/** Call after anything that changes how tall the text is. */
function textLayoutChanged() {
  if (!textBuilt || els.reader.hidden) return;
  estimateChunks();
  measureChunks();
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

  // Clickable areas on top of the page image for the PDF's own links.
  const [vx1, vy1, vx2, vy2] = page.view;
  const w = vx2 - vx1, h = vy2 - vy1;
  const overlays = (await pageLinks(page)).map((link) => {
    const a = linkElement(link);
    a.className = 'link-overlay';
    a.style.left = ((link.rect[0] - vx1) / w) * 100 + '%';
    a.style.top = ((vy2 - link.rect[3]) / h) * 100 + '%';
    a.style.width = ((link.rect[2] - link.rect[0]) / w) * 100 + '%';
    a.style.height = ((link.rect[3] - link.rect[1]) / h) * 100 + '%';
    return a;
  });
  if (rendered.get(n) !== scale) return;
  div.replaceChildren(canvas, ...overlays);
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
  const x = Math.min(container.getBoundingClientRect().left + container.clientWidth / 2, innerWidth - 1);
  let el = null, y = 0;
  // Probe a little further down if the top of the screen is padding or margin.
  for (const dy of [4, 24, 48, 96]) {
    y = Math.max(topOffset(), 0) + dy;
    el = document.elementFromPoint(x, y)?.closest(settings.mode === 'text' ? '#reader [data-i]' : '.page');
    if (el) break;
  }
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

  const max = document.documentElement.scrollHeight - innerHeight;
  library.update(bookId, {
    page: pos.page,
    progress: max > 0 ? clamp(window.scrollY / max, 0, 1) : 0,
    lastOpened: Date.now(),
  }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Links and table of contents                                         */
/* ------------------------------------------------------------------ */

const linkTargets = new Map(); // link id → PDF link
let nextLinkId = 0;

function linkElement(link, text) {
  const a = document.createElement('a');
  if (text) a.textContent = text;
  if (link.url && !link.dest) {
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  } else {
    const id = String(nextLinkId++);
    linkTargets.set(id, link);
    a.href = '#';
    a.dataset.link = id;
  }
  return a;
}

/** Resolve a PDF destination to { page, top } (top is in PDF units, or null). */
async function resolveDest(dest) {
  const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit)) return null;
  const [ref, kind, ...args] = explicit;
  const pageIndex = Number.isInteger(ref) ? ref : await pdf.getPageIndex(ref);
  let top = null;
  switch (kind?.name) {
    case 'XYZ': top = args[1]; break;
    case 'FitH': case 'FitBH': top = args[0]; break;
    case 'FitR': top = args[3]; break;
  }
  return { page: pageIndex + 1, top: typeof top === 'number' ? top : null };
}

/** Find where a destination lands in the current view, as an anchor for scrollToAnchor. */
const normTitle = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function destAnchor({ page, top }, title) {
  if (settings.mode === 'pages') {
    const el = els.pages.querySelector(`.page[data-page="${page}"]`);
    if (!el) return null;
    if (top == null) return { el, frac: 0 };
    const [, y1, , y2] = (await pdf.getPage(page)).view;
    return { el, frac: clamp((y2 - top) / (y2 - y1), 0, 1) };
  }
  const blocks = [...els.reader.querySelectorAll('[data-i]')];
  // The first block on that page at or below the target point, else the next page's first block.
  const onPage = blocks.filter((b) => +b.dataset.page === page);
  // Bookmarks often point at just a page; if a block on it starts with the bookmark's title, go there.
  const wanted = title && normTitle(title);
  const titled = wanted && onPage.find((b) => normTitle(b.textContent).startsWith(wanted));
  const el = titled || (top == null ? onPage[0] : onPage.find((b) => +b.dataset.y <= top + 2))
    || blocks.find((b) => +b.dataset.page > page)
    || onPage[onPage.length - 1];
  return el ? { el, frac: 0 } : null;
}

/** Scroll to an anchor, then correct once lazily-laid-out content around it has settled. */
function jumpTo(anchor) {
  // Lay out the target's chunk for real so its position inside the chunk is exact.
  const chunk = anchor.el.closest('.chunk');
  if (chunk) chunk.style.contentVisibility = 'visible';
  anchor.el.scrollIntoView();
  scrollToAnchor(anchor);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    scrollToAnchor(anchor);
    if (chunk) chunk.style.contentVisibility = '';
  }));
}

let backTimer = 0;
let backAnchor = null;

async function followDest(dest, title) {
  const target = await resolveDest(dest).catch(() => null);
  const anchor = target && await destAnchor(target, title);
  if (!anchor) { flash('That link’s destination couldn’t be found'); return; }
  jumpWithBack(anchor);
}

/** Jump somewhere, offering a Back button to return to the current spot. */
function jumpWithBack(anchor) {
  backAnchor = anchorPoint() || { scrollY: window.scrollY };
  jumpTo(anchor);
  els.toolbar.classList.remove('hidden');
  els.backBtn.hidden = false;
  clearTimeout(backTimer);
  backTimer = setTimeout(() => { els.backBtn.hidden = true; }, 15000);
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  e.preventDefault();
  const link = linkTargets.get(a.dataset.link);
  if (link?.dest) followDest(link.dest, link.title);
});

els.backBtn.addEventListener('click', () => {
  if (backAnchor?.el?.isConnected) jumpTo(backAnchor);
  else if (backAnchor) window.scrollTo(0, backAnchor.scrollY);
  backAnchor = null;
  els.backBtn.hidden = true;
});

async function buildToc(token) {
  const outline = await pdf.getOutline().catch(() => null);
  if (token !== loadToken) return;
  els.tocHeading.hidden = !outline?.length;
  if (!outline?.length) return;

  const build = (items) => {
    const ul = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      const a = linkElement({ dest: item.dest, url: item.url, title: item.title }, item.title);
      a.addEventListener('click', () => openSheet(false));
      li.append(a);
      if (item.items?.length) li.append(build(item.items));
      ul.append(li);
    }
    return ul;
  };
  els.tocList.replaceChildren(build(outline));
}

/** The start of PDF page n in the current view. */
function pageAnchor(n) {
  if (settings.mode === 'pages') {
    const el = els.pages.querySelector(`.page[data-page="${n}"]`);
    return el && { el, frac: 0 };
  }
  const blocks = [...els.reader.querySelectorAll('[data-i]')];
  const first = blocks.find((b) => +b.dataset.page >= n);
  // If no paragraph starts on page n, it's the middle of one that began earlier.
  const el = first && +first.dataset.page === n ? first : blocks.findLast((b) => +b.dataset.page < n) || first;
  return el && { el, frac: 0 };
}

els.gotoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const n = Number(els.gotoInput.value);
  if (!Number.isInteger(n) || n < 1 || n > numPages) {
    els.gotoInput.setCustomValidity('invalid');
    els.gotoInput.select();
    return;
  }
  const anchor = pageAnchor(n);
  if (!anchor) return;
  els.gotoInput.blur();
  openSheet(false);
  jumpWithBack(anchor);
});
els.gotoInput.addEventListener('input', () => els.gotoInput.setCustomValidity(''));

function restoreText(pos) {
  let el = null, frac = 0;
  if (pos.text) {
    el = els.reader.querySelector(`[data-i="${pos.text.i}"]`);
    frac = pos.text.frac;
  } else if (pos.page) {
    el = els.reader.querySelector(`[data-page="${pos.page}"]`);
  }
  if (el) jumpTo({ el, frac });
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
  if (settings.mode === 'text') textLayoutChanged();
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
  if (e.touches.length === 2 && pdf && !e.target.closest('.sheet')) {
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

// A finger on the screen may be about to scroll; treat it like scrolling.
document.addEventListener('touchmove', () => { lastUserScroll = performance.now(); }, { passive: true });

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

function openSheet(open, sheet = els.sheet) {
  els.sheet.hidden = els.toc.hidden = true;
  sheet.hidden = els.backdrop.hidden = !open;
  if (open) syncSheet();
}
els.settingsBtn.addEventListener('click', () => openSheet(els.sheet.hidden));
els.tocBtn.addEventListener('click', () => {
  const current = anchorPoint()?.el.dataset.page;
  els.gotoInput.value = '';
  els.gotoInput.placeholder = current || '';
  els.gotoInput.max = numPages;
  els.gotoInput.setCustomValidity('');
  els.gotoTotal.textContent = `of ${numPages}`;
  openSheet(els.toc.hidden, els.toc);
});
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
      textLayoutChanged();
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
  textLayoutChanged();
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
    lastUserScroll = performance.now();
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
  if (e.target.closest('#reader, #pages') && !e.target.closest('a')) els.toolbar.classList.toggle('hidden');
});

let lastWidth = innerWidth;
window.addEventListener('resize', () => {
  if (settings.mode === 'pages' && pdf) rerenderVisiblePages();
  if (innerWidth !== lastWidth && pdf) {
    // Width changes rewrap the text (e.g. rotating the phone); height changes are just
    // the browser's address bar showing or hiding.
    lastWidth = innerWidth;
    const anchor = anchorPoint();
    textLayoutChanged();
    if (anchor) scrollToAnchor(anchor);
  }
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

renderLibrary();
