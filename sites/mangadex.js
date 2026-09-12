'use strict';
/**
 * sites/mangadex.js — adapter for mangadex.org, via its public API.
 *
 * The site is a single-page app, so there's nothing to scrape from the HTML.
 * The documented API (https://api.mangadex.org/docs/) gives everything:
 *
 *   /chapter/{id}?includes[]=manga        chapter metadata + which manga it belongs to
 *   /manga/{id}/feed?...                  every chapter of a title
 *   /at-home/server/{id}                  baseUrl + hash + page filenames for one chapter
 *
 * Page URLs are {baseUrl}/data/{hash}/{filename}. The at-home endpoint is rate
 * limited (~40/min) and its URLs are short-lived, so it's called lazily, once
 * per chapter, at download time — shared by every page item in that chapter.
 *
 * Accepts a chapter URL (one CBZ) or a title URL (one CBZ per chapter, or per
 * volume with -g volume).
 */

const API = 'https://api.mangadex.org';
const GROUPS = ['chapter', 'volume'];
const FEED_LIMIT = 500;
const DEFAULT_LANG = 'en';

const match = (url) => /(^|\.)mangadex\.org$/i.test(new URL(url).hostname);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function parseUrl(url) {
  const p = new URL(url).pathname.split('/').filter(Boolean);
  const kind = p[0];
  const id = (p[1] && UUID.test(p[1])) ? p[1] : null;
  if (!id || !['chapter', 'title', 'manga'].includes(kind)) {
    throw new Error('MangaDex: give me a chapter URL (/chapter/<id>) or a title URL (/title/<id>).');
  }
  return { kind: kind === 'manga' ? 'title' : kind, id };
}

const json = async (ctx, url) => (await ctx.fetch(url)).json();

const pickTitle = (titleObj = {}, alts = []) =>
  titleObj[DEFAULT_LANG] || Object.values(titleObj)[0]
  || alts.map((a) => a[DEFAULT_LANG] || Object.values(a)[0]).find(Boolean) || 'MangaDex title';

/** Label for one chapter: "Ch. 12 - Title" / "Vol. 2 Ch. 12" / "Oneshot". */
function chapterLabel(a) {
  const bits = [];
  if (a.volume) bits.push(`Vol. ${a.volume}`);
  if (a.chapter) bits.push(`Ch. ${a.chapter}`);
  const head = bits.join(' ') || 'Oneshot';
  return a.title ? `${head} - ${a.title}` : head;
}

/**
 * Page items for one chapter. The at-home call is deferred and memoised so all
 * pages of a chapter share a single request, and it only fires if the chapter
 * is actually being downloaded.
 */
function chapterPages(ctx, id, pages, prefix) {
  let cached = null;
  const server = () => (cached ||= json(ctx, `${API}/at-home/server/${id}`).then((d) => {
    if (d.result !== 'ok') throw new Error(`at-home said ${d.result}`);
    return d;
  }));
  const count = Math.max(1, Number(pages) || 1);
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}${String(i + 1).padStart(3, '0')}`,
    minBytes: 0,
    resolve: async () => {
      const d = await server();
      const file = d.chapter.data[i];
      return file ? `${d.baseUrl}/data/${d.chapter.hash}/${file}` : null;
    },
  }));
}

async function listFeed(ctx, mangaId, lang) {
  const out = [];
  for (let offset = 0; offset < 10_000; offset += FEED_LIMIT) {
    const q = new URLSearchParams({ limit: String(FEED_LIMIT), offset: String(offset) });
    q.append('order[volume]', 'asc');
    q.append('order[chapter]', 'asc');
    for (const l of lang) q.append('translatedLanguage[]', l);
    for (const c of ['safe', 'suggestive', 'erotica', 'pornographic']) q.append('contentRating[]', c);
    const d = await json(ctx, `${API}/manga/${mangaId}/feed?${q}`);
    if (d.result !== 'ok') throw new Error(`feed said ${d.result}`);
    out.push(...d.data);
    if (out.length >= d.total || !d.data.length) break;
  }
  return out;
}

async function plan(ctx, url, { group } = {}) {
  const explicit = Boolean(group);
  if (group && !GROUPS.includes(group)) throw new Error(`mangadex: group must be one of ${GROUPS.join(', ')}`);
  const { kind, id } = parseUrl(url);

  // ---- a single chapter -----------------------------------------------------
  if (kind === 'chapter') {
    const d = await json(ctx, `${API}/chapter/${id}?includes[]=manga`);
    if (d.result !== 'ok') throw new Error(`chapter lookup said ${d.result}`);
    const a = d.data.attributes;
    const manga = d.data.relationships.find((r) => r.type === 'manga');
    const series = manga ? pickTitle(manga.attributes?.title, manga.attributes?.altTitles) : 'MangaDex title';
    const label = chapterLabel(a);
    ctx.info(`${series} — ${label} (${a.pages} pages, ${a.translatedLanguage})`);
    return {
      series,
      groups: [{
        no: Number(a.chapter) || 1,
        title: label,
        images: chapterPages(ctx, id, a.pages, ''),
        extras: [],
        meta: { title: a.title || label, web: url,
                summary: [a.volume && `Volume ${a.volume}`, a.chapter && `Chapter ${a.chapter}`,
                          `language: ${a.translatedLanguage}`].filter(Boolean).join(' · ') },
      }],
      delay: 350,
      referer: 'https://mangadex.org/',
    };
  }

  // ---- a whole title --------------------------------------------------------
  const m = await json(ctx, `${API}/manga/${id}`);
  if (m.result !== 'ok') throw new Error(`title lookup said ${m.result}`);
  const series = pickTitle(m.data.attributes.title, m.data.attributes.altTitles);

  ctx.info(`${series} — reading the chapter list…`);
  let feed = await listFeed(ctx, id, [DEFAULT_LANG]);
  if (!feed.length) {
    ctx.warn(`no ${DEFAULT_LANG} chapters — taking every language instead`);
    feed = await listFeed(ctx, id, []);
  }
  // One chapter per number: several groups often translate the same chapter.
  const seen = new Set();
  const chapters = feed.filter((c) => {
    const key = `${c.attributes.volume ?? ''}/${c.attributes.chapter ?? c.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Number(c.attributes.pages) > 0;
  });
  if (!chapters.length) throw new Error('No readable chapters found for this title.');

  const volumes = new Set(chapters.map((c) => c.attributes.volume).filter(Boolean));
  ctx.info(`${chapters.length} chapters${volumes.size ? `, ${volumes.size} volumes` : ''}`);
  if (!explicit) group = 'chapter';
  if (group === 'volume' && !volumes.size) {
    ctx.warn('this title has no volume numbers — one file per chapter instead');
    group = 'chapter';
  }

  if (group === 'chapter') {
    return {
      series,
      groups: chapters.map((c, i) => {
        const a = c.attributes;
        const label = chapterLabel(a);
        return {
          no: Number(a.chapter) || i + 1,
          title: label,
          images: chapterPages(ctx, c.id, a.pages, ''),
          extras: [],
          meta: { title: a.title || label, web: `https://mangadex.org/chapter/${c.id}`,
                  summary: `language: ${a.translatedLanguage}` },
        };
      }),
      delay: 350,
      referer: 'https://mangadex.org/',
    };
  }

  const byVol = new Map();
  for (const c of chapters) {
    const v = c.attributes.volume || 'no volume';
    if (!byVol.has(v)) byVol.set(v, []);
    byVol.get(v).push(c);
  }
  return {
    series,
    groups: [...byVol.entries()].map(([v, list], i) => ({
      no: Number(v) || i + 1,
      title: v === 'no volume' ? v : `Vol. ${v}`,
      images: list.flatMap((c) =>
        chapterPages(ctx, c.id, c.attributes.pages, `${String(Number(c.attributes.chapter) || 0).padStart(4, '0')}-`)),
      extras: [],
      meta: { title: `Volume ${v}`, web: `https://mangadex.org/title/${id}`,
              summary: `${list.length} chapters` },
    })),
    delay: 350,
    referer: 'https://mangadex.org/',
  };
}

module.exports = {
  name: 'mangadex', label: 'MangaDex', groups: GROUPS, defaultGroup: 'chapter',
  match, plan, _parseUrl: parseUrl, _chapterLabel: chapterLabel,
};
