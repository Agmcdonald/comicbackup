'use strict';
/**
 * sites/comiceasel.js — adapter for WordPress sites running Comic Easel
 * (buttsmithy.com and many other webcomics).
 *
 * Detected from page markup: a `<div id="comic">` holding the strip plus the
 * theme's `<select name="chapter">` dropdown. Enumeration is two-level:
 *
 *   1. The chapter dropdown on any comic page lists every chapter, each
 *      pointing at that chapter's FIRST page.
 *   2. Each comic page carries a "Jump To" dropdown listing every page of its
 *      own chapter, in reading order.
 *
 * So planning costs one request per chapter, and each page's image is
 * resolved at download time from its post's `#comic img`.
 *
 * The dropdown's own order isn't story order, so chapters are sorted by the
 * number in their name ("Chapter 15.5" → 15.5); unnumbered ones go last.
 */

const GROUPS = ['chapter', 'all'];

const match = () => false; // markup-detected, like ComicControl

const matchDom = ($) =>
  $('#comic').length > 0 && $("select[name='chapter'], select#chapter").length > 0;

const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/** "Chapter 15.5" → 15.5, "P4 Chapter 2" → 2 (last number wins), "Misc" → Infinity. */
function chapterNumber(name) {
  const nums = clean(name).match(/\d+(?:\.\d+)?/g);
  return nums ? Number(nums[nums.length - 1]) : Number.POSITIVE_INFINITY;
}

/** The chapter dropdown: [{ name, firstPageUrl }] in story order. */
function readChapters($, baseUrl) {
  const out = [];
  $("select[name='chapter'] option, select#chapter option").each((_, el) => {
    const value = $(el).attr('value');
    const name = clean($(el).text());
    if (!value || !name || /^jump/i.test(name)) return;
    try { out.push({ name, firstPageUrl: new URL(value, baseUrl).toString() }); } catch { /* skip */ }
  });
  const seen = new Set();
  const uniq = out.filter((c) => !seen.has(c.firstPageUrl) && seen.add(c.firstPageUrl));
  uniq.sort((a, b) => chapterNumber(a.name) - chapterNumber(b.name));
  return uniq;
}

/** The "Jump To" dropdown on a chapter's page: that chapter's pages in order. */
function readPages($, baseUrl, chapterUrl) {
  const selects = [];
  $('select').each((_, sel) => {
    if ($(sel).attr('name') === 'chapter' || $(sel).attr('id') === 'chapter') return;
    const opts = [];
    $(sel).find('option').each((_, el) => {
      const value = $(el).attr('value');
      const title = clean($(el).text());
      if (!value || /^jump/i.test(title)) return;
      try { opts.push({ url: new URL(value, baseUrl).toString(), title }); } catch { /* skip */ }
    });
    if (opts.length) selects.push(opts);
  });
  // The jump-to select is the one that contains the page we're on.
  const own = selects.find((opts) => opts.some((o) => o.url === chapterUrl));
  const list = own || selects[0] || [];
  const seen = new Set();
  return list.filter((o) => !seen.has(o.url) && seen.add(o.url));
}

/** The strip image(s) on a comic post: everything inside div#comic. */
function comicImages($, pageUrl) {
  const urls = [];
  $('#comic img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src && !src.startsWith('data:')) {
      try { urls.push(new URL(src, pageUrl).toString()); } catch { /* skip */ }
    }
  });
  return [...new Set(urls)];
}

async function plan(ctx, url, { group } = {}) {
  const explicit = Boolean(group);
  if (group && !GROUPS.includes(group)) throw new Error(`comiceasel: group must be one of ${GROUPS.join(', ')}`);
  if (!explicit) group = 'chapter';

  const $start = await ctx.dom(url);
  const site = new URL(url).hostname.replace(/^www\./, '');
  const series = clean($start('meta[property="og:site_name"]').attr('content'))
    || clean(site.split('.')[0].replace(/^\w/, (c) => c.toUpperCase()));

  const chapters = readChapters($start, url);
  if (!chapters.length) throw new Error('No chapter dropdown found on this page.');
  ctx.info(`${series} — ${chapters.length} chapters; reading each chapter's page list…`);

  const groups = [];
  for (const [i, ch] of chapters.entries()) {
    ctx.check?.();
    const $ch = await ctx.dom(ch.firstPageUrl);
    const pages = readPages($ch, ch.firstPageUrl, ch.firstPageUrl);
    if (!pages.length) { ctx.warn(`${ch.name}: no page list found — skipped`); continue; }
    groups.push({
      no: i + 1,
      title: `${String(i + 1).padStart(3, '0')} - ${ch.name}`,
      images: pages.map((p, n) => ({
        name: `${String(n + 1).padStart(3, '0')} - ${p.title}`,
        minBytes: 0,
        referer: p.url,
        resolve: async (c) => {
          const imgs = comicImages(await c.dom(p.url), p.url);
          return imgs[0] || null;
        },
      })),
      extras: [],
      meta: { title: ch.name, web: ch.firstPageUrl, summary: `${pages.length} pages` },
    });
  }
  if (!groups.length) throw new Error('No readable chapters found.');

  if (group === 'all') {
    const all = groups.flatMap((g, gi) =>
      g.images.map((it) => ({ ...it, name: `${String(gi + 1).padStart(3, '0')}-${it.name}` })));
    return {
      series,
      groups: [{ no: 1, title: series, images: all, extras: [],
                 meta: { title: series, web: url, summary: `${groups.length} chapters` } }],
      delay: 400, referer: url,
    };
  }
  return { series, groups, delay: 400, referer: url };
}

module.exports = {
  name: 'comiceasel', label: 'Comic Easel site', groups: GROUPS, defaultGroup: 'chapter',
  match, matchDom, plan,
  _chapterNumber: chapterNumber,
};
