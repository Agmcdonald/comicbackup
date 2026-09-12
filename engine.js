'use strict';
/**
 * engine.js — comicgrab core. Port of comicgrab.py.
 *
 * Zero Electron imports. Two frontends share it:
 *   cli.js   → grab(url, opts) with onProgress printing to stdout
 *   main.js  → grab(url, opts) with onProgress → IPC, plus
 *              fetchImpl = net.fetch and renderPage = hidden BrowserWindow
 *
 * Modes (detected from one fetch of the start URL):
 *   webtoon-series   episode list (webtoons.com /list, clones) → CBZ per episode
 *   webtoon-episode  single webtoon viewer page                → one CBZ
 *   chapter-list     page listing many chapters                → CBZ per chapter
 *   gallery          single paginated reader page              → one CBZ
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cheerio = require('cheerio');
const yazl = require('yazl');
const yauzl = require('yauzl');

// Site adapters: sites whose data is reachable without scraping HTML.
// Each exports { name, label, match(url), plan(ctx, url) }.
const SITE_ADAPTERS = [
  require('./sites/bobandgeorge'),
  require('./sites/comiccontrol'),  // matches on page markup, not URL
  require('./sites/mangadex'),
  require('./sites/comiceasel'),    // matches on page markup, not URL
];

// --- tuning ----------------------------------------------------------------
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

const WEBTOON_HOST = /(^|\.)webtoons?\.com$/i;

// HTML fingerprints of webtoon-style sites (slices hidden in data-url)
const WEBTOON_MARKERS = ['ul#_listEpisode', 'div.viewer_img img[data-url]', 'img._images'];

const IMAGE_SELECTORS = [
  '.reading-content img', // WordPress manga-reader themes
  'div.page-break img',
  '.entry-content img',
  'article img',
  'img',
];

const JUNK = /logo|icon|avatar|banner|sprite|thumb|\/ads?\/|analytic|emoji/i;
const NEXT_EXCLUDE = /chapter|episode|issue|volume/i;
const CHAPTER_HREF = /\b(?:chapter|ch|episode|ep)[-_./ ]?(\d+(?:\.\d+)?)/i;

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
};

const MAX_LIST_PAGES = 40;
const MAX_PAGES = 150;
const RETRIES = 5;          // network failures: backoff 2, 4, 8, 16 s
const HTTP_RETRIES = 3;     // 429 / 5xx
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const DELAY = 500;          // ms between requests — be polite
const MIN_BYTES = 3_000;
const MAX_NAME = 80;        // filename component length cap
const MAX_STRIP = 60_000;   // JPEG hard limit is 65,535 px per side

const MODE_LABEL = {
  'webtoon-series':  'webtoon series — one CBZ per episode',
  'webtoon-episode': 'webtoon episode — one CBZ',
  'chapter-list':    'chapter list — one CBZ per chapter',
  'gallery':         'single gallery — one CBZ',
};
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
  }
}

class CancelledError extends Error {
  constructor() { super('Cancelled'); this.cancelled = true; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hostnames whose presence in a DNS answer means a filtering resolver has
// substituted its own servers for the real ones.
const FILTER_TELLS = /watchguard|opendns|umbrella|dnsfilter|cleanbrowsing|blocked|filtered|safedns|webtitan|securly/i;

/**
 * When a host keeps resetting, look at its DNS answer: on filtered networks
 * (public Wi-Fi, some routers) the resolver returns its own block servers and
 * the connection then dies with ERR_CONNECTION_RESET / ECONNRESET, which looks
 * exactly like a broken app. One CNAME lookup usually names the culprit.
 * Returns a human explanation, or null when DNS looks normal. Never throws.
 */
async function diagnoseHost(hostname) {
  try {
    const dns = require('dns').promises;
    const [cnames, addrs] = await Promise.all([
      dns.resolveCname(hostname).catch(() => []),
      dns.resolve4(hostname).catch(() => []),
    ]);
    const tell = [...cnames, ...addrs.map(String)].find((n) => FILTER_TELLS.test(n));
    if (tell) {
      return `${hostname} resolves through "${tell}" — this network is filtering DNS ` +
             `and blocking the site. The app and the site are fine; try another network.`;
    }
    if (!cnames.length && !addrs.length) {
      return `${hostname} doesn't resolve at all on this network — DNS is blocking it. ` +
             `Try another network.`;
    }
  } catch { /* diagnosis must never make things worse */ }
  return null;
}

/** Node's fetch reports every network problem as "fetch failed" — the useful
 *  part (DNS, TLS, reset) is hidden in .cause. Unwrap it for the log. */
function why(e) {
  const parts = [];
  for (let c = e; c; c = c.cause) {
    const bit = c.code || c.message;
    if (bit && bit !== 'fetch failed' && !parts.includes(bit)) parts.push(bit);
  }
  return parts.length ? parts.join(': ') : (e.message || String(e));
}

/** Bound per-run context: fetch impl, progress sink, cookies, options. */
class Ctx {
  constructor(opts) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.onProgress = opts.onProgress || (() => {});
    this.renderPage = opts.renderPage || null; // async (url) => [imgUrl, ...]
    this.signal = opts.signal || null;         // AbortSignal for cancellation
    this.delay = opts.delay ?? DELAY;          // ms between requests; adapters may lower it
    this.opts = opts;
    this.cookies = {}; // host-suffix → 'k=v; k2=v2'
  }
  emit(type, data = {}) { this.onProgress({ type, ...data }); }
  check() { if (this.signal?.aborted) throw new CancelledError(); }

  /** One DNS diagnosis per host per run, after a connection reset. */
  async explainReset(url) {
    const host = new URL(url).hostname;
    this._diagnosed ??= new Set();
    if (this._diagnosed.has(host)) return;
    this._diagnosed.add(host);
    const verdict = await diagnoseHost(host);
    if (verdict) this.emit('warn', { msg: verdict, diagnosis: true });
  }
  info(msg) { this.emit('info', { msg }); }
  warn(msg) { this.emit('warn', { msg }); }

  cookieHeader(url) {
    const host = new URL(url).hostname;
    return Object.entries(this.cookies)
      .filter(([suffix]) => host === suffix || host.endsWith('.' + suffix))
      .map(([, v]) => v).join('; ');
  }

  /** GET with retry + backoff on network failures, 429, and 5xx. */
  async fetch(url, { timeout = 30_000, headers = {} } = {}) {
    const cookie = this.cookieHeader(url);
    const h = { ...HEADERS, ...headers };
    if (cookie) h.Cookie = cookie;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        const signals = [AbortSignal.timeout(timeout)];
        if (this.signal) signals.push(this.signal);
        const res = await this.fetchImpl(url, {
          headers: h, redirect: 'follow', signal: AbortSignal.any(signals),
        });
        if (RETRY_STATUS.has(res.status) && attempt < HTTP_RETRIES) {
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.ok) throw new HttpError(res.status, url);
        return res;
      } catch (e) {
        if (this.signal?.aborted) throw new CancelledError();
        if (attempt === RETRIES || e instanceof HttpError) throw e;
        const reason = why(e);
        this.warn(`retry ${attempt}/${RETRIES - 1} for ${url} (${reason})`);
        if (/CONNECTION_RESET|ECONNRESET|CONNECTION_REFUSED|ECONNREFUSED|ENOTFOUND|NAME_NOT_RESOLVED/i.test(reason)) {
          await this.explainReset(url);
        }
        await sleep(2000 * 2 ** (attempt - 1));
      }
    }
  }

  async dom(url) {
    const res = await this.fetch(url);
    return cheerio.load(await res.text());
  }
}

// --- shared plumbing -------------------------------------------------------
function safeName(s) {
  s = String(s)
    .replace(/:/g, '\u2236')            // ':' is illegal on macOS/Windows; '∶' looks the same
    .replace(/[\\/*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')                // collapse gaps left by stripped characters
    .trim().replace(/^\.+|\.+$/g, '');
  return s.slice(0, MAX_NAME).trimEnd() || 'untitled';
}

/** "Series - Episode title.cbz", or "0001 - Episode title.cbz" with numbered. */
function cbzName(ctx, series, no, title) {
  const s = safeName(series), t = safeName(title);
  // "Street Fighter - Street Fighter.cbz" → just "Street Fighter.cbz"
  const stem = ctx.opts.numbered ? `${numTag(no)} - ${t}` : (s === t ? s : `${s} - ${t}`);
  return `${stem}.cbz`;
}

/** Drop a trailing ' | Site Name' / ' - Site Name' segment. */
function cleanTitle(raw) {
  const parts = String(raw).split(/\s+[|–—-]\s+/);
  let t = parts.length > 1 ? parts.slice(0, -1).join(' - ') : String(raw);
  t = t.replace(/\s+/g, ' ').trim();
  return t ? safeName(t) : 'comic';
}

function ogTitle($, fallback = 'comic') {
  const og = $('meta[property="og:title"]').attr('content');
  if (og) return cleanTitle(og);
  const t = $('title').first().text().trim();
  if (t) return cleanTitle(t);
  return cleanTitle(fallback);
}

/** 5 -> '0005', 10.5 -> '0010.5' — sortable names, handles half chapters. */
function numTag(no) {
  const s = Number(no).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  const [whole, frac] = s.split('.');
  const tag = String(parseInt(whole, 10)).padStart(4, '0');
  return frac ? `${tag}.${frac}` : tag;
}

function withPage(url, page) {
  const u = new URL(url);
  u.searchParams.set('page', String(page));
  return u.toString();
}

/** 'all' -> null, else a Set of numbers from '3', '1-10', '1,4,9-12'. */
function parseEpisodeSpec(spec) {
  const s = String(spec ?? '').trim().toLowerCase();
  if (s === '' || s === 'all') return null;
  const wanted = new Set();
  const num = (x) => {
    const n = Number(x);
    if (!Number.isFinite(n)) {
      throw new Error(`Bad episodes value "${spec}" — use "all", "3", "1-10", or "1,4,9-12".`);
    }
    return n;
  };
  for (let part of s.split(',')) {
    part = part.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const [lo, hi] = part.split('-', 2);
      for (let n = num(lo); n <= num(hi) + 1e-9; n += 1) wanted.add(Math.round(n * 100) / 100);
    } else {
      wanted.add(Math.round(num(part) * 100) / 100);
    }
  }
  return wanted;
}

function applySelection(ctx, items, spec) {
  const wanted = parseEpisodeSpec(spec);
  if (wanted === null) return items;
  const picked = items.filter((it) => wanted.has(it.no));
  const have = new Set(items.map((it) => it.no));
  const missing = [...wanted].filter((n) => !have.has(n)).sort((a, b) => a - b);
  if (missing.length) ctx.info(`note: not found: ${missing.map(numTag).join(', ')}`);
  return picked;
}

function extFor(url, ctype) {
  let ext = path.extname(new URL(url).pathname).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) ext = MIME_EXT[ctype] || '.jpg';
  return ext;
}

const absUrl = (href, base) => { try { return new URL(href, base).toString(); } catch { return null; } };
// ---------------------------------------------------------------------------

// --- detection -------------------------------------------------------------
/** Fetch once, decide the strategy. Returns { mode, $, chapters }. */
async function classify(ctx, url) {
  const $ = await ctx.dom(url);
  const u = new URL(url);
  const markers = WEBTOON_MARKERS.some((sel) => $(sel).length > 0);

  if (WEBTOON_HOST.test(u.hostname) || markers) {
    if (u.pathname.includes('/viewer')) return { mode: 'webtoon-episode', $, chapters: [] };
    return { mode: 'webtoon-series', $, chapters: [] };
  }

  // If the URL itself is a chapter, it's a gallery — even though the page
  // will have prev/next/dropdown links that look like a chapter list.
  if (CHAPTER_HREF.test(u.pathname)) return { mode: 'gallery', $, chapters: [] };

  const chapters = findChapters($, url);
  if (chapters.length >= 3) return { mode: 'chapter-list', $, chapters };
  return { mode: 'gallery', $, chapters: [] };
}

/** Heuristic: >=3 anchors whose href/text mentions chapter/ch/ep <number>. */
function findChapters($, pageUrl) {
  const here = new URL(pageUrl).hostname;
  const seenUrls = new Set(), seenNums = new Set(), out = [];
  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href');
    if (!raw || /^(#|javascript:|mailto:)/i.test(raw)) return;
    const href = absUrl(raw, pageUrl);
    if (!href || new URL(href).hostname !== here || seenUrls.has(href)) return;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const m = CHAPTER_HREF.exec(href) || CHAPTER_HREF.exec(text);
    if (!m) return;
    const no = Math.round(parseFloat(m[1]) * 100) / 100;
    if (seenNums.has(no)) return;
    seenUrls.add(href);
    seenNums.add(no);
    out.push({ no, title: text || `Chapter ${numTag(no)}`, url: href });
  });
  out.sort((a, b) => a.no - b.no);
  return out;
}
// ---------------------------------------------------------------------------

// --- webtoon-style ---------------------------------------------------------
/** Walk the paginated episode list. Returns [{no, title, url}]. */
async function listWebtoonEpisodes(ctx, listUrl) {
  const found = [], seen = new Set();
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    ctx.check();
    const url = withPage(listUrl, page);
    ctx.info(`list page ${page}`);
    const $ = await ctx.dom(url);
    let fresh = 0;
    $("a[href*='episode_no=']").each((_, el) => {
      const href = absUrl($(el).attr('href'), url);
      if (!href || seen.has(href)) return;
      seen.add(href);
      fresh++;
      const no = parseInt(new URL(href).searchParams.get('episode_no') || '0', 10);
      const subj = $(el).find('.subj').first();
      const title = (subj.length ? subj.text() : $(el).text()).trim() || `Episode ${no}`;
      found.push({ no, title, url: href });
    });
    if (fresh === 0) break;
    await sleep(DELAY);
  }
  found.sort((a, b) => a.no - b.no);
  return found;
}

/** Slices live on img._images with the real URL in data-url. */
function webtoonSlices($) {
  const urls = [];
  $('div.viewer_img img[data-url], img._images').each((_, el) => {
    const src = $(el).attr('data-url') || $(el).attr('src');
    if (src && src.startsWith('http')) urls.push(src);
  });
  return [...new Set(urls)];
}
// ---------------------------------------------------------------------------

// --- generic gallery -------------------------------------------------------
function largestFromSrcset(srcset) {
  let best = null, bestW = -1;
  for (const cand of srcset.split(',')) {
    const parts = cand.trim().split(/\s+/);
    if (!parts[0] || parts[0].startsWith('data:')) continue;
    let w = -1;
    if (parts[1] && parts[1].endsWith('w')) {
      const n = parseInt(parts[1].slice(0, -1), 10);
      if (Number.isFinite(n)) w = n;
    }
    if (w > bestW) { best = parts[0]; bestW = w; }
  }
  return best;
}

/** Lazy-load attrs first (usually the original); srcset last — on WordPress
 *  those entries are resized variants like -1024x1536.jpg. */
function bestSrc($, el, baseUrl) {
  for (const attr of ['data-src', 'data-url', 'data-lazy-src', 'data-original', 'src']) {
    const val = $(el).attr(attr);
    if (val && !val.startsWith('data:')) return absUrl(val.trim(), baseUrl);
  }
  const srcset = $(el).attr('srcset') || $(el).attr('data-srcset');
  if (srcset) {
    const cand = largestFromSrcset(srcset);
    if (cand) return absUrl(cand, baseUrl);
  }
  return null;
}

function extractImages($, pageUrl) {
  for (const selector of IMAGE_SELECTORS) {
    const urls = [];
    $(selector).each((_, el) => {
      const src = bestSrc($, el, pageUrl);
      if (src && !JUNK.test(src)) urls.push(src);
    });
    const uniq = [...new Set(urls)];
    if (uniq.length) return uniq;
  }
  return [];
}

/** Keep 'next' pagination inside this work: compare path prefixes up to the
 *  shorter of the two. Known gap: a two-segment start URL still lets
 *  ch-1 -> ch-2 through; NEXT_EXCLUDE catches the usual link text. */
function sameScope(a, b) {
  const seg = (u) => new URL(u).pathname.split('/').filter(Boolean);
  const pa = seg(a), pb = seg(b);
  const depth = Math.min(pa.length, pb.length, 3);
  return pa.slice(0, depth).join('/') === pb.slice(0, depth).join('/');
}

function findNextPage($, pageUrl, startUrl) {
  let next = null;
  $('a[rel=next], a.next_page, a.next, .pagination a, a.page-numbers').each((_, el) => {
    if (next) return;
    const text = $(el).text().trim().toLowerCase();
    const href = $(el).attr('href');
    if (!href) return;
    if (!(text.includes('next') || text === '›' || text === '»')) return;
    if (NEXT_EXCLUDE.test(text)) return;
    const nxt = absUrl(href, pageUrl);
    if (nxt && nxt !== pageUrl && sameScope(nxt, startUrl)) next = nxt;
  });
  return next;
}

/** Walk a paginated reader; drop images repeated across pages (site chrome).
 *  If nothing is found and a renderPage hook exists, fall back to the live DOM. */
async function collectImageUrls(ctx, startUrl) {
  const perPage = [], seenPages = new Set();
  let url = startUrl;
  while (url && !seenPages.has(url) && seenPages.size < MAX_PAGES) {
    ctx.check();
    seenPages.add(url);
    ctx.info(`reading ${url}`);
    const $ = await ctx.dom(url);
    perPage.push(extractImages($, url));
    url = findNextPage($, url, startUrl);
    if (url) await sleep(DELAY);
  }
  const hits = new Map();
  for (const urls of perPage) for (const u of urls) hits.set(u, (hits.get(u) || 0) + 1);
  const ordered = [...new Set(perPage.flat())].filter((u) => hits.get(u) === 1);

  if (ordered.length === 0 && ctx.renderPage) {
    ctx.info('no images in static HTML — rendering page in browser');
    const rendered = await ctx.renderPage(startUrl);
    return [...new Set((rendered || []).filter((u) => u && !JUNK.test(u)))];
  }
  return ordered;
}
// ---------------------------------------------------------------------------

// --- output ----------------------------------------------------------------
/** Render a simple text card (used for strips that aren't images: video, flash). */
async function generatePage({ width = 800, height = 200, lines = [] }, outPath) {
  let sharp;
  try { sharp = require('sharp'); } catch { throw new Error('placeholder pages need sharp:  npm install sharp'); }
  const fs = 20, lh = 28;
  const startY = Math.round(height / 2 - ((lines.length - 1) * lh) / 2);
  const text = lines.map((l, i) =>
    `<text x="${width / 2}" y="${startY + i * lh}" text-anchor="middle" dominant-baseline="middle" ` +
    `font-family="Helvetica, Arial, sans-serif" font-size="${i === 0 ? fs + 2 : fs - 4}" ` +
    `font-weight="${i === 0 ? 'bold' : 'normal'}" fill="#222">${esc(l)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#fff"/>` +
    `<rect x="3" y="3" width="${width - 6}" height="${height - 6}" fill="none" stroke="#222" stroke-width="3"/>` +
    text + `</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

/** Download arbitrary files (video, flash) — status-checked only, no image filtering. */
async function downloadFiles(ctx, items, dest, referer) {
  await fs.promises.mkdir(dest, { recursive: true });
  const saved = [];
  for (const it of items) {
    ctx.check();
    const p = path.join(dest, safeName(path.parse(it.name).name) + path.extname(it.name));
    if (fs.existsSync(p) && fs.statSync(p).size > 0) { saved.push(p); continue; } // already have it
    try {
      const res = await ctx.fetch(it.url, { timeout: 300_000, headers: { Referer: referer } });
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.promises.writeFile(p, buf);
      saved.push(p);
      ctx.info(`extra: ${path.basename(p)} (${Math.floor(buf.length / 1024)} KB)`);
    } catch (e) {
      ctx.warn(`skipped extra ${it.url} (${why(e)})`);
    }
    await sleep(ctx.delay);
  }
  return saved;
}

/** The filename downloadImages will produce for a named item (null if unnamed). */
function plannedName(item) {
  const it = typeof item === 'string' ? { url: item } : item;
  if (it.generate) return safeName(path.parse(it.name || '').name || 'page') + '.png';
  if (!it.name) return null;
  const ext = path.extname(it.name).toLowerCase();
  // Unknown extension (resolved at download time) → match on the stem instead.
  return safeName(path.parse(it.name).name) + (IMAGE_EXTS.has(ext) ? ext : '');
}

/** Extract every entry of a CBZ except ComicInfo.xml into dir. Returns extracted names. */
function extractCbz(cbzPath, dir) {
  return new Promise((resolve, reject) => {
    const names = [];
    yauzl.open(cbzPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      zip.on('end', () => resolve(names));
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName) || entry.fileName === 'ComicInfo.xml') return zip.readEntry();
        const out = path.join(dir, path.basename(entry.fileName));
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          stream.pipe(fs.createWriteStream(out))
            .on('finish', () => { names.push(path.basename(entry.fileName)); zip.readEntry(); })
            .on('error', reject);
        });
      });
      zip.readEntry();
    });
  });
}

/** items: URL strings, or { url, name?, fallbacks?, minBytes? } — fallbacks are tried on a 404 —
 *  or { generate: { width, height, lines }, name } for a rendered placeholder page. */
async function downloadImages(ctx, items, dest, referer) {
  await fs.promises.mkdir(dest, { recursive: true });
  const saved = [];
  for (const [i, item] of items.entries()) {
    ctx.check();
    const it = typeof item === 'string' ? { url: item } : item;
    if (it.generate) {
      const p = path.join(dest, safeName(path.parse(it.name || `page-${i + 1}`).name) + '.png');
      await generatePage(it.generate, p);
      saved.push(p);
      ctx.emit('download', { done: i + 1, total: items.length, file: path.basename(p), bytes: 0,
                             msg: `[${i + 1}/${items.length}] ${path.basename(p)} (placeholder)` });
      continue;
    }
    if (it.resolve && !it.url) {
      try {
        it.url = await it.resolve(ctx);
      } catch (e) {
        ctx.warn(`skipped ${it.name || 'page'} (${why(e)})`);
        continue;
      }
      if (!it.url) { ctx.warn(`skipped ${it.name || 'page'} (no comic image on the page)`); continue; }
    }
    const candidates = [it.url, ...(it.fallbacks || [])];
    let res = null, u = it.url, lastErr = null;
    for (const cand of candidates) {
      try {
        res = await ctx.fetch(cand, { timeout: 60_000, headers: { Referer: it.referer || referer } });
        u = cand;
        break;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof HttpError && e.status === 404)) break;
      }
    }
    if (!res) {
      ctx.warn(`skipped ${u} (${lastErr ? why(lastErr) : 'no response'})`);
      continue;
    }
    const ctype = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ctype.startsWith('image/')) {
      ctx.warn(`skipped ${u} (not an image: ${ctype || 'unknown'})`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < (it.minBytes ?? MIN_BYTES)) {
      ctx.warn(`skipped ${u} (only ${buf.length} bytes)`);
      continue;
    }
    const fname = it.name
      ? safeName(path.parse(it.name).name) + (IMAGE_EXTS.has(path.extname(it.name).toLowerCase())
          ? path.extname(it.name) : extFor(u, ctype))
      : `${String(saved.length + 1).padStart(4, '0')}${extFor(u, ctype)}`;
    const p = path.join(dest, fname);
    await fs.promises.writeFile(p, buf);
    saved.push(p);
    ctx.emit('download', {
      done: i + 1, total: items.length, file: path.basename(p), bytes: buf.length,
      msg: `[${i + 1}/${items.length}] ${path.basename(p)} (${Math.floor(buf.length / 1024)} KB)`,
    });
    await sleep(ctx.delay);
  }
  return saved;
}

/** Stack slices vertically. JPEG can't exceed 65,535 px on a side, so a long
 *  episode is split into full-01.jpg, full-02.jpg, ... under MAX_STRIP. */
async function stitch(paths, outDir) {
  let sharp;
  try { sharp = require('sharp'); } catch {
    throw new Error('--stitch needs sharp:  npm install sharp');
  }
  const metas = [];
  for (const p of paths) {
    const m = await sharp(p).metadata();
    metas.push({ p, w: m.width, h: m.height });
  }
  const width = Math.max(...metas.map((m) => m.w));

  const chunks = [];
  let cur = [], curH = 0;
  for (const m of metas) {
    if (cur.length && curH + m.h > MAX_STRIP) { chunks.push(cur); cur = []; curH = 0; }
    cur.push(m);
    curH += m.h;
  }
  if (cur.length) chunks.push(cur);

  const outs = [];
  for (const [i, chunk] of chunks.entries()) {
    const height = chunk.reduce((s, m) => s + m.h, 0);
    let top = 0;
    const layers = chunk.map((m) => { const l = { input: m.p, top, left: 0 }; top += m.h; return l; });
    const name = chunks.length === 1 ? 'full.jpg' : `full-${String(i + 1).padStart(2, '0')}.jpg`;
    const out = path.join(outDir, name);
    await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
      .composite(layers)
      .jpeg({ quality: 92 })
      .toFile(out);
    outs.push(out);
  }
  return outs;
}

async function maybeStitch(ctx, saved) {
  if (!ctx.opts.stitch) return saved;
  ctx.info(`stitching ${saved.length} slice(s)`);
  return stitch(saved, path.dirname(saved[0]));
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function comicInfoXml({ series, web, count, number = null, title = '', summary = '' }) {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <Series>${esc(series)}</Series>`,
  ];
  if (number !== null && number !== undefined) lines.push(`  <Number>${Number(number)}</Number>`);
  if (title) lines.push(`  <Title>${esc(title)}</Title>`);
  if (summary) lines.push(`  <Summary>${esc(summary)}</Summary>`);
  lines.push(`  <Web>${esc(web)}</Web>`, `  <PageCount>${count}</PageCount>`, '</ComicInfo>');
  return lines.join('\n') + '\n';
}

function writeZip(entries, outPath, meta) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(comicInfoXml(meta), 'utf8'), 'ComicInfo.xml', { compress: false });
    for (const { file, name } of entries) zip.addFile(file, name, { compress: false });
    zip.end();
    zip.outputStream
      .pipe(fs.createWriteStream(outPath))
      .on('close', () => resolve(outPath))
      .on('error', reject);
  });
}

function makeCbz(files, cbzPath, meta) {
  const entries = [...files].sort().map((f) => ({ file: f, name: path.basename(f) }));
  return writeZip(entries, cbzPath, { ...meta, count: files.length });
}

/** --one-cbz: everything in one file, names like 0003-0012.jpg. */
function mergeCbz(cbzPath, meta, tagged) {
  const entries = tagged.map(({ no, file }) => ({ file, name: `${numTag(no)}-${path.basename(file)}` }));
  return writeZip(entries, cbzPath, { ...meta, count: tagged.length });
}

/** Loose images are scratch; the CBZ is the deliverable (unless keep). */
async function cleanup(ctx, folder) {
  if (!ctx.opts.keep) await fs.promises.rm(folder, { recursive: true, force: true });
}
// ---------------------------------------------------------------------------

// --- history -----------------------------------------------------------------
const HISTORY_PATH = path.join(os.homedir(), '.comicgrab', 'history.json');

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch { return []; }
}

/** Append one record per CBZ written. Same file for CLI and app. */
async function recordHistory(ctx, entry) {
  if (ctx.opts.noHistory) return;
  try {
    await fs.promises.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
    const list = readHistory().filter((e) => e.file !== entry.file); // one record per path
    list.push({ when: new Date().toISOString(), ...entry });
    await fs.promises.writeFile(HISTORY_PATH, JSON.stringify(list, null, 2));
  } catch (e) {
    ctx.warn(`history not saved (${e.message})`);
  }
}

/** Skip work whose CBZ already exists, unless repairing or forcing. */
function haveAlready(ctx, cbz) {
  if (ctx.opts.force || ctx.opts.repair) return false;
  if (!fs.existsSync(cbz)) return false;
  ctx.emit('skip', { path: cbz, msg: `already have ${path.basename(cbz)} — skipped (force to re-download)` });
  return true;
}

// --- runners ---------------------------------------------------------------
/** Shared loop for webtoon episodes AND generic chapters. */
async function runSeries(ctx, items, series, outRoot, sourceUrl, kind) {
  const tagged = [], dirs = [], made = [];
  const label = kind === 'webtoon' ? 'ep' : 'ch';
  const referer = kind === 'webtoon' ? `https://${new URL(items[0].url).hostname}/` : null;
  await fs.promises.mkdir(outRoot, { recursive: true });

  for (const [idx, { no, title, url }] of items.entries()) {
    ctx.check();
    ctx.emit('item', { index: idx + 1, total: items.length, no, title, msg: `${label} ${numTag(no)}: ${title}` });
    if (!ctx.opts.oneCbz && haveAlready(ctx, path.join(outRoot, cbzName(ctx, series, no, title)))) {
      made.push(path.join(outRoot, cbzName(ctx, series, no, title)));
      continue;
    }
    let urls;
    if (kind === 'webtoon') {
      urls = webtoonSlices(await ctx.dom(url));
      if (!urls.length) { ctx.warn('no images (Fast Pass, deleted, or age-gated) — skipped'); continue; }
    } else {
      urls = await collectImageUrls(ctx, url);
      if (!urls.length) { ctx.warn('no images found — skipped'); continue; }
    }

    const chDir = path.join(outRoot, numTag(no));
    const saved = await downloadImages(ctx, urls, chDir, referer || url);
    if (!saved.length) continue;
    dirs.push(chDir);

    if (ctx.opts.oneCbz) {
      for (const p of saved) tagged.push({ no, file: p });
      continue;
    }

    const files = await maybeStitch(ctx, saved);
    const cbz = path.join(outRoot, cbzName(ctx, series, no, title));
    await makeCbz(files, cbz, { series, web: url, number: no, title });
    await cleanup(ctx, chDir);
    made.push(cbz);
    ctx.emit('cbz', { path: cbz, msg: `wrote ${path.basename(cbz)}` });
    await recordHistory(ctx, { series, title, number: no, file: cbz, pages: files.length, source: url, mode: kind });
  }

  if (ctx.opts.oneCbz && tagged.length) {
    const cbz = path.join(outRoot, `${safeName(series)}.cbz`);
    await mergeCbz(cbz, { series, web: sourceUrl }, tagged);
    for (const d of dirs) await cleanup(ctx, d);
    made.push(cbz);
    ctx.emit('cbz', { path: cbz, msg: `wrote ${path.basename(cbz)}` });
    await recordHistory(ctx, { series, title: series, number: null, file: cbz, pages: tagged.length, source: sourceUrl, mode: `${kind}-merged` });
  }
  return made;
}

/** Site-adapter path: the adapter already knows every image; we just download and zip. */
async function runPlanned(ctx, planned, outRoot, sourceUrl) {
  const groups = applySelection(ctx, planned.groups, ctx.opts.episodes ?? 'all');
  if (!groups.length) throw new Error('No (matching) parts found.');
  if (planned.delay !== undefined && ctx.opts.delay === undefined) ctx.delay = planned.delay;
  const referer = planned.referer || sourceUrl;
  await fs.promises.mkdir(outRoot, { recursive: true });
  const made = [];
  for (const [idx, g] of groups.entries()) {
    ctx.check();
    ctx.emit('item', { index: idx + 1, total: groups.length, no: g.no, title: g.title,
                       msg: `${g.title}: ${g.images.length} image(s)` });
    const dir = path.join(outRoot, safeName(g.title));
    const cbz = path.join(outRoot, cbzName(ctx, planned.series, g.no, g.title));

    if (haveAlready(ctx, cbz)) { made.push(cbz); continue; }

    let items = g.images;
    let existing = [];
    if (ctx.opts.repair && fs.existsSync(cbz) && !ctx.opts.stitch) {
      const names = g.images.map(plannedName);
      if (names.every(Boolean)) {
        await fs.promises.mkdir(dir, { recursive: true });
        const present = await extractCbz(cbz, dir);
        const have = new Set(present);
        const stems = new Set(present.map((n) => path.parse(n).name));
        items = g.images.filter((it, i) => !(have.has(names[i]) || stems.has(path.parse(names[i]).name)));
        existing = [...have].map((n) => path.join(dir, n));
        if (!items.length) {
          ctx.info(`${g.title}: complete (${have.size} pages) — nothing to repair`);
          await cleanup(ctx, dir);
          made.push(cbz);
          continue;
        }
        ctx.info(`${g.title}: ${have.size} pages present, fetching ${items.length} missing`);
      } else {
        ctx.warn(`${g.title}: pages aren't named, can't repair — re-downloading`);
      }
    }

    const saved = await downloadImages(ctx, items, dir, referer);
    if (!saved.length && !existing.length) { ctx.warn(`nothing downloaded for ${g.title} — skipped`); continue; }
    const files = await maybeStitch(ctx, [...existing, ...saved]);
    await makeCbz(files, cbz, { series: planned.series, web: sourceUrl, number: g.no, title: g.title, ...g.meta });
    await cleanup(ctx, dir);
    made.push(cbz);
    ctx.emit('cbz', { path: cbz, msg: `wrote ${path.basename(cbz)}` });
    await recordHistory(ctx, { series: planned.series, title: g.title, number: g.no, file: cbz, pages: files.length,
                               source: sourceUrl, mode: `site:${planned.site || 'adapter'}` });
    if (g.extras?.length) {
      ctx.info(`${g.extras.length} non-image strip(s) → extras/`);
      await downloadFiles(ctx, g.extras, path.join(outRoot, 'extras'), referer);
    }
  }
  return made;
}

async function runGallery(ctx, url, outRoot, title) {
  const cbzPath = path.join(outRoot, `${safeName(title)}.cbz`);
  if (haveAlready(ctx, cbzPath)) return [cbzPath];
  ctx.info('scanning gallery…');
  const images = await collectImageUrls(ctx, url);
  if (!images.length) {
    throw new Error('No images found. Inspect the page, find the container around ' +
                    'the comic images, and add its selector to IMAGE_SELECTORS.');
  }
  ctx.info(`${images.length} image(s). downloading…`);
  const pages = path.join(outRoot, 'pages');
  const saved = await downloadImages(ctx, images, pages, url);
  if (!saved.length) throw new Error('Nothing was downloaded.');
  const files = await maybeStitch(ctx, saved);
  const cbz = cbzPath;
  await makeCbz(files, cbz, { series: title, web: url, title });
  await cleanup(ctx, pages);
  ctx.emit('cbz', { path: cbz, msg: `wrote ${path.basename(cbz)}` });
  await recordHistory(ctx, { series: title, title, number: null, file: cbz, pages: files.length, source: url, mode: 'gallery' });
  return [cbz];
}

async function runWebtoonEpisode(ctx, url, $, base) {
  const no = parseFloat(new URL(url).searchParams.get('episode_no') || '1');
  // og:title is reliable on the viewer; the breadcrumb link is a fallback
  // because the first '/list?' anchor is sometimes a logo with no text.
  let series = ogTitle($, '');
  if (series === 'comic' || series === 'untitled') {
    const crumb = $("a[href*='/list?']").filter((_, a) => $(a).text().trim().length > 0).first();
    if (crumb.length) series = cleanTitle(crumb.text().trim());
  }
  const h1 = $('h1.subj, h1').first();
  const epTitle = (h1.length ? h1.text().trim() : '') || `Ep ${numTag(no)}`;
  const urls = webtoonSlices($);
  if (!urls.length) throw new Error('No slices found — Fast Pass-locked, deleted, or age-gated?');
  ctx.info(`series: ${series} — episode ${numTag(no)}: ${epTitle}`);
  const out = path.join(base, series);
  if (haveAlready(ctx, path.join(out, cbzName(ctx, series, no, epTitle)))) return [path.join(out, cbzName(ctx, series, no, epTitle))];
  const pages = path.join(out, 'pages');
  const saved = await downloadImages(ctx, urls, pages, url);
  if (!saved.length) throw new Error('Nothing was downloaded.');
  const files = await maybeStitch(ctx, saved);
  const cbz = path.join(out, cbzName(ctx, series, no, epTitle));
  await makeCbz(files, cbz, { series, web: url, number: no, title: epTitle });
  await cleanup(ctx, pages);
  ctx.emit('cbz', { path: cbz, msg: `wrote ${path.basename(cbz)}` });
  await recordHistory(ctx, { series, title: epTitle, number: no, file: cbz, pages: files.length, source: url, mode: 'webtoon-episode' });
  return [cbz];
}
// ---------------------------------------------------------------------------

/**
 * grab(url, opts) → { mode, series, outDir, files: [cbzPath, ...] }
 *
 * opts:
 *   episodes   'all' | '3' | '1-10' | '1,4,9-12'
 *   name       override the detected series title
 *   outDir     default ~/Downloads/Comics
 *   stitch     merge each episode/gallery into tall JPEG strip(s)
 *   oneCbz     series modes: merge everything into a single CBZ
 *   keep       keep loose image folders after zipping
 *   numbered   prefix per-episode CBZ names with 0001 - instead of the series title
 *   signal     AbortSignal — abort to cancel; grab() rejects with CancelledError
 *   delay      ms between requests (default 500; site adapters may set their own)
 *   repair     site adapters: open an existing CBZ, fetch only the pages it's missing, rewrite it
 *   force      re-download even when the CBZ already exists (default: skip existing)
 *   group      site adapters: how to split ('year', 'storyline', …) — adapter-specific
 *   noHistory  don't record written files in ~/.comicgrab/history.json
 *   onProgress ({type, msg, ...}) => void   types: info warn item download cbz
 *   fetchImpl  fetch-compatible function (Electron: net.fetch)
 *   renderPage async (url) => [imgUrl] — live-DOM fallback for JS-rendered readers
 */
async function grab(inputUrl, opts = {}) {
  const ctx = new Ctx(opts);
  if (opts.stitch && opts.oneCbz) throw new Error("stitch and oneCbz can't be combined; pick one.");

  let url = String(inputUrl).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  new URL(url); // throws on garbage

  if (WEBTOON_HOST.test(new URL(url).hostname)) ctx.cookies['webtoons.com'] = 'ageGatePass=true';

  const base = path.resolve(opts.outDir || path.join(os.homedir(), 'Downloads', 'Comics'));

  const adapter = SITE_ADAPTERS.find((a) => a.match(url));
  if (adapter) {
    const mode = `site:${adapter.name}`;
    const gsel0 = opts.group || adapter.defaultGroup;
    const groupLabel = !adapter.groups ? ''
      : gsel0 === 'auto' ? ''
      : gsel0 === 'all' ? ' — one CBZ for everything'
      : ` — one CBZ per ${gsel0}`;
    ctx.emit('mode', { mode, msg: `detected: ${adapter.label}${groupLabel}` });
    const planned = await adapter.plan(ctx, url, { group: opts.group });
    const series = opts.name ? safeName(opts.name) : planned.series;
    planned.series = series;
    planned.site = adapter.name;
    const files = await runPlanned(ctx, planned, path.join(base, series), url);
    ctx.emit('done', { files, msg: `done — ${files.length} CBZ file(s) under ${base}` });
    return { mode, series, outDir: base, files };
  }

  const { mode, $, chapters } = await classify(ctx, url);

  const domAdapter = SITE_ADAPTERS.find((a) => a.matchDom?.($, url));
  if (domAdapter) {
    const m = `site:${domAdapter.name}`;
    const gsel = opts.group || domAdapter.defaultGroup;
    const gl = !domAdapter.groups ? ''
      : gsel === 'auto' ? ''
      : gsel === 'all' ? ' — one CBZ for everything'
      : ` — one CBZ per ${gsel}`;
    ctx.emit('mode', { mode: m, msg: `detected: ${domAdapter.label}${gl}` });
    const planned = await domAdapter.plan(ctx, url, { group: opts.group });
    planned.series = opts.name ? safeName(opts.name) : safeName(planned.series);
    planned.site = domAdapter.name;
    const files = await runPlanned(ctx, planned, path.join(base, planned.series), url);
    ctx.emit('done', { files, msg: `done — ${files.length} CBZ file(s) under ${base}` });
    return { mode: m, series: planned.series, outDir: base, files };
  }

  ctx.emit('mode', { mode, msg: `detected: ${MODE_LABEL[mode]}` });

  const series = opts.name ? safeName(opts.name) : ogTitle($, new URL(url).hostname);
  let files;

  if (mode === 'webtoon-series') {
    ctx.info(`series: ${series} — scanning episode list…`);
    let episodes = await listWebtoonEpisodes(ctx, url);
    episodes = applySelection(ctx, episodes, opts.episodes ?? 'all');
    if (!episodes.length) throw new Error('No (matching) episodes found.');
    ctx.info(`${episodes.length} episode(s).`);
    files = await runSeries(ctx, episodes, series, path.join(base, series), url, 'webtoon');
  } else if (mode === 'chapter-list') {
    const picked = applySelection(ctx, chapters, opts.episodes ?? 'all');
    if (!picked.length) throw new Error('No (matching) chapters found.');
    ctx.info(`series: ${series} — ${picked.length} chapter(s).`);
    files = await runSeries(ctx, picked, series, path.join(base, series), url, 'chapter');
  } else if (mode === 'webtoon-episode') {
    files = await runWebtoonEpisode(ctx, url, $, base);
  } else {
    ctx.info(`title: "${series}"`);
    files = await runGallery(ctx, url, path.join(base, series), series);
  }

  ctx.emit('done', { files, msg: `done — ${files.length} CBZ file(s) under ${base}` });
  return { mode, series, outDir: base, files };
}

module.exports = {
  grab, classify, MODE_LABEL, HttpError, CancelledError, SITE_ADAPTERS, readHistory, HISTORY_PATH, why,
  // exported for tests
  _internal: {
    safeName, cleanTitle, numTag, parseEpisodeSpec, largestFromSrcset,
    sameScope, findChapters, extractImages, stitch, comicInfoXml, CHAPTER_HREF,
  },
};
