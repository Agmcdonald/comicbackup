'use strict';
/**
 * sites/comiccontrol.js — adapter for sites running ComicControl.
 *
 * Detected from the page itself (not the URL), so it covers any site on the
 * platform: shortpacked.com, egscomics.com, dumbingofage.com and friends.
 * The tells are `<img id="cc-comic">` and `<a class="cc-next" rel="next">`.
 *
 * Every ComicControl site has /comic/archive with a <select> naming every
 * strip in publication order:
 *
 *   <option value="comic/just-a-toy-store">January 17, 2005 - Just a Toy Store</option>
 *
 * That gives the full list in one request. The image URL isn't derivable from
 * the slug, so each page is visited lazily at download time (item.resolve) —
 * that way pages stream in with progress instead of stalling on a 2,000-page
 * planning pass.
 */

// Most ComicControl sites live at /comic/, but a site hosting several comics
// gives each its own root (marycagle.com/letsspeakenglish/...), so the start
// URL's first path segment is tried first.
const ARCHIVE_PATHS = ['/comic/archive', '/archive'];

function archiveCandidates(url) {
  const u = new URL(url);
  const seg = u.pathname.split('/').filter(Boolean)[0];
  const paths = [];
  if (seg && seg !== 'archive') paths.push(`/${seg}/archive`);
  for (const p of ARCHIVE_PATHS) if (!paths.includes(p)) paths.push(p);
  return paths.map((p) => u.origin + p);
}
const GROUPS = ['chapter', 'year', 'all'];
const MIN_CHAPTERS = 2;      // fewer than this and chapter splitting isn't worth offering
const MAX_CHAPTER_SHARE = 0.5; // a 'chapter' holding half the strips isn't a chapter

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
                'july', 'august', 'september', 'october', 'november', 'december'];

/** URL-based match: never — this adapter identifies itself from the HTML. */
const match = () => false;

/** Called with the already-fetched DOM of the start URL. */
const matchDom = ($) => $('#cc-comic').length > 0 || $('a.cc-next, a.cc-first').length > 0;

const plainTitle = (t) => String(t || '').replace(/\s+/g, ' ').trim();

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Archive option label → { date, title }. Two formats in the wild:
 *   "January 17, 2005 - Just a Toy Store"   (shortpacked, egscomics)
 *   "06/30/2015 - Stage 0 - Page 1"         (streetfightercomics)
 * Only the FIRST " - " separates the date from the title — titles contain more.
 */
function parseOption(text) {
  const t = plainTitle(text);
  let m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*-\s*([\s\S]*)$/.exec(t);
  if (m) {
    const mon = MONTHS.indexOf(m[1].toLowerCase());
    return { date: mon < 0 ? null : iso(m[3], mon + 1, Number(m[2])), title: plainTitle(m[4]) };
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*([\s\S]*)$/.exec(t);       // MM/DD/YYYY
  if (m) return { date: iso(m[3], Number(m[1]), Number(m[2])), title: plainTitle(m[4]) };
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})\s*-\s*([\s\S]*)$/.exec(t);            // YYYY-MM-DD
  if (m) return { date: iso(m[1], Number(m[2]), Number(m[3])), title: plainTitle(m[4]) };
  return { date: null, title: t };
}

/**
 * Chapter name from a slug: "stage-7-page-2" → "stage-7", "ch3-04" → "ch3".
 * Strips a trailing page number and any "page"/"pg"/"p" word before it.
 */
function slugChapter(slug) {
  const base = slug.replace(/^.*\//, '');
  if (/^\d{4}[-_]\d{1,2}([-_]\d{1,2})?/.test(base) || /^\d+$/.test(base)) return null; // a date, not a chapter
  const cut = base.replace(/[-_]?(?:page|pg|pt|part|p)?[-_]?\d+$/i, '');
  return cut && cut !== base && /[a-z]/i.test(cut) ? cut : null;
}

/** Pretty label for a chapter slug: "stage-7" → "Stage 7". */
function chapterLabel(slug) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b([a-z])/g, (c) => c.toUpperCase())
             .replace(/\b(\D+?)\s*(\d+)\b/, '$1 $2').trim();
}

/** Sort key so "stage-2" comes before "stage-10". */
function chapterKey(slug) {
  const n = /(\d+(?:\.\d+)?)\s*$/.exec(slug);
  return n ? Number(n[1]) : Number.POSITIVE_INFINITY;
}

/**
 * What splits make sense for this archive? Chapters need most strips to carry a
 * recognisable chapter slug, at least two distinct ones, and no single chapter
 * swallowing half the archive (which just means the slugs aren't chaptered).
 */
function analyse(strips) {
  const dated = strips.filter((s) => s.date).length;
  const chapters = new Map();
  let slugged = 0;
  for (const s of strips) {
    const ch = slugChapter(s.slug);
    if (!ch) continue;
    slugged++;
    chapters.set(ch, (chapters.get(ch) || 0) + 1);
  }
  const biggest = Math.max(0, ...chapters.values());
  const hasChapters = chapters.size >= MIN_CHAPTERS
    && slugged >= strips.length * 0.8
    && biggest <= strips.length * MAX_CHAPTER_SHARE;
  return {
    dates: dated >= strips.length * 0.8,
    years: new Set(strips.filter((s) => s.date).map((s) => s.date.slice(0, 4))).size,
    chapters: hasChapters ? chapters.size : 0,
  };
}

/** The comic image on a strip page. */
function comicImage($, pageUrl) {
  const img = $('#cc-comic').first();
  const src = img.attr('src') || img.attr('data-src');
  if (!src) return null;
  return new URL(src, pageUrl).toString();
}

/** Archive <option>s point at strip pages; drop the "Select a comic..." placeholder
 *  and anything pointing off-site. Values are relative ("letsspeakenglish/slug"). */
function archiveOptions(html, archiveUrl) {
  const origin = new URL(archiveUrl).origin;
  return [...html.matchAll(/<option\s+value=["']([^"']*)["'][^>]*>([^<]*)/gi)]
    .filter(([, value]) => {
      if (!value || value === '#') return false;
      if (/^https?:/i.test(value)) return value.startsWith(origin);
      return true;
    });
}

async function fetchArchive(ctx, url) {
  for (const archiveUrl of archiveCandidates(url)) {
    try {
      const html = await (await ctx.fetch(archiveUrl)).text();
      const opts = archiveOptions(html, archiveUrl);
      if (opts.length > 1) return { archiveUrl, opts };
    } catch { /* try the next path */ }
  }
  return { archiveUrl: null, opts: [] };
}

async function plan(ctx, url, { group } = {}) {
  const explicitGroup = Boolean(group);
  if (group && !GROUPS.includes(group)) throw new Error(`comiccontrol: group must be one of ${GROUPS.join(', ')}`);

  const origin = new URL(url).origin;
  const site = new URL(url).hostname.replace(/^www\./, '');
  ctx.info(`reading the archive list from ${site}…`);
  const { archiveUrl, opts } = await fetchArchive(ctx, url);
  if (!opts.length) {
    throw new Error('No archive list found — tried ' + archiveCandidates(url).join(', '));
  }

  // Series name from the strip page. On a domain hosting several comics the
  // site name is the author's, so the page <title> is the better source.
  const $ = await ctx.dom(url);
  const titles = [$('title').first().text(), $('meta[property="og:site_name"]').attr('content')]
    .map((t) => plainTitle(t || '').split(/\s+[|–—-]\s+/)[0].trim())
    .filter(Boolean);
  const series = titles[0] || site;

  const strips = opts.map(([, value, text]) => {
    const { date, title } = parseOption(text);
    const slug = value.replace(/[?#].*$/, '').replace(/\/$/, '').replace(/^.*\//, '');
    // Option values are site-root-relative ("letsspeakenglish/slug"), NOT relative
    // to the archive page — resolving against archiveUrl doubles the path segment.
    const href = /^https?:/i.test(value) ? value : new URL(value.replace(/^\/*/, '/'), origin).toString();
    return { url: href, date, title, slug };
  });

  const shape = analyse(strips);
  const span = shape.dates ? ` (${strips[0].date} → ${strips[strips.length - 1].date})` : '';
  ctx.info(`${strips.length} strips${span}` +
    (shape.chapters ? `, ${shape.chapters} chapters detected` : '') +
    (shape.dates ? '' : ', no dates in the archive list'));

  // Pick the split that actually fits this archive when the caller didn't choose.
  if (!explicitGroup) {
    group = shape.chapters ? 'chapter' : (shape.dates && shape.years > 1 ? 'year' : 'all');
    ctx.info(`splitting by ${group}` +
      (group === 'chapter' ? ' (page slugs name the chapters)'
       : group === 'all' ? ' — one file for the whole run' : ''));
  }
  if (group === 'year' && !shape.dates) {
    ctx.warn("this archive has no dates, so year splitting isn't possible — using one file instead");
    group = 'all';
  }
  if (group === 'chapter' && !shape.chapters) {
    ctx.warn("no chapter structure in the page slugs — using " + (shape.dates ? 'years' : 'one file') + ' instead');
    group = shape.dates ? 'year' : 'all';
  }

  const buckets = new Map();
  for (const s of strips) {
    const key = group === 'all' ? series
      : group === 'chapter' ? (slugChapter(s.slug) || 'extras')
      : (s.date ? s.date.slice(0, 4) : 'undated');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }

  let entries = [...buckets.entries()];
  if (group === 'chapter') entries.sort((a, b) => chapterKey(a[0]) - chapterKey(b[0]));

  const groups = entries.map(([key, list], i) => ({
    no: group === 'all' ? 1 : group === 'chapter' ? i + 1 : (Number(key) || i + 1),
    title: group === 'all' ? series
      : group === 'chapter' ? `${String(i + 1).padStart(3, '0')} - ${chapterLabel(key)}`
      : key,
    images: list.map((s, n) => ({
      // Resolved at download time: fetch the strip page, take #cc-comic.
      // EGS names its strips by date, so "2002-01-21 - 2002-01-21" would be silly.
      name: [s.date || String(n + 1).padStart(4, '0'),
             s.title && s.title !== s.date ? s.title : null].filter(Boolean).join(' - '),
      minBytes: 0,
      resolve: async (c) => comicImage(await c.dom(s.url), s.url),
      referer: s.url,
    })),
    extras: [],
    meta: {
      title: group === 'all' ? series
        : group === 'chapter' ? chapterLabel(key)
        : `${series} ${key}`,
      web: list[0].url,
      summary: `${list.length} strips${list[0].date ? ` (${list[0].date} → ${list[list.length - 1].date})` : ''}`,
    },
  }));

  return { series, groups, delay: 400, referer: archiveUrl || url };
}

module.exports = {
  name: 'comiccontrol',
  label: 'ComicControl archive',
  groups: GROUPS,
  defaultGroup: 'auto',
  match, matchDom, plan,
  _parseOption: parseOption, _slugChapter: slugChapter, _analyse: analyse, _chapterLabel: chapterLabel,
};
