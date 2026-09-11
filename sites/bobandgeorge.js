'use strict';
/**
 * sites/bobandgeorge.js — adapter for The Bob and George Archives.
 *
 * The archive pages are empty shells filled in by index.js, but the data
 * behind them is a plain JSON endpoint:
 *
 *   getData.php?function=getComics&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *   getData.php?function=getStorylines
 *
 * Image paths follow the rules in the site's own index.js:
 *   standard      /archives/comics/YYMM/YYMMDD.<png|jpg|gif>
 *   ppt (multi)   /archives/comics/YYMM/YYMMDD/YYMMDD[a-z].png   (png → gif → jpg fallback)
 *   2004-09       /archives/comics/YYMM/YYMMDDa.png + YYMMDDb.<ext>
 *   2001-12-19    hard-coded 011219.jpg + 011219.gif
 *   htm           /archives/comics/YYMM/YYMMDD/ is a folder; its index.html lists
 *                 the PNG frames → those become pages
 *   mp4 / swf     a placeholder page goes in the CBZ; the file itself is saved to extras/
 *
 * plan() returns groups (one per year); the engine downloads and zips them.
 */

const BASE = 'https://www.bobandgeorge.com';
const API = `${BASE}/archives/getData.php`;
const FIRST = '2000-04-01';
const LAST = '2007-07-28';
const SERIES = 'Bob and George';

const match = (url) => /(^|\.)bobandgeorge\.com$/i.test(new URL(url).hostname);

const ymd = (date) => date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10); // 2000-04-01 → 000401
const ym = (date) => date.slice(2, 4) + date.slice(5, 7);
const plainTitle = (t) => String(t || '').replace(/<br\s*\/?>/gi, ' — ').replace(/<[^>]+>/g, '').trim();

/** Placeholder page for a strip that isn't an image. */
function placeholder(date, comic, extraName, suffix = '') {
  const kind = comic.filetype === 'mp4' ? 'a video' : 'a Flash animation';
  return {
    name: `${date}${suffix}.png`,
    generate: {
      width: 800, height: 200,
      lines: [
        `${date} — ${plainTitle(comic.title)}`,
        `This strip is ${kind} and can't be shown in a comic reader.`,
        `Saved alongside this file as  extras/${extraName}`,
        `${BASE}/archives/${date}`,
      ],
    },
  };
}

/**
 * Assets for one strip, in reading order.
 * Returns { images: [{url,name,fallbacks?} | {generate,name}], extras: [{url,name}] }
 */
async function stripAssets(ctx, date, comic) {
  const ft = comic.filetype;
  const dir = `${BASE}/archives/comics/${ym(date)}`;
  const stem = ymd(date);
  const title = plainTitle(comic.title);

  if (date === '2001-12-19') {
    return { images: [
      { url: `${dir}/${stem}.jpg`, name: `${date}a.jpg` },
      { url: `${dir}/${stem}.gif`, name: `${date}b.gif` },
    ], extras: [] };
  }

  if (ft === 'mp4' || ft === 'swf') {
    const images = [], extras = [];
    // Month of Destruction strips have a static header image above the animation.
    if (date.startsWith('2004-09')) images.push({ url: `${dir}/${stem}a.png`, name: `${date}a.png` });
    const file = date.startsWith('2004-09') ? `${dir}/${stem}b.${ft}` : `${dir}/${stem}.${ft}`;
    const extraName = `${date} - ${title || 'untitled'}.${ft}`;
    extras.push({ url: file, name: extraName });
    images.push(placeholder(date, comic, extraName, date.startsWith('2004-09') ? 'b' : ''));
    return { images, extras };
  }

  if (ft === 'htm') {
    // The strip is a folder with an index.html. The comic itself is the <img>
    // with id/class "comic" (several of them for the 2003 animation); the
    // class="text" images are hover labels and frame.png is a mask — skip those.
    const folder = `${dir}/${stem}/`;
    const html = await (await ctx.fetch(folder)).text();
    const seen = new Set(), images = [];
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
      const tag = m[0];
      const src = (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1];
      const id = (tag.match(/\bid=["']([^"']+)["']/i) || [])[1] || '';
      const cls = (tag.match(/\bclass=["']([^"']+)["']/i) || [])[1] || '';
      if (!src || /^https?:/i.test(src) || seen.has(src)) continue;
      if (!(/^comic/i.test(id) || /\bcomic\b/i.test(cls))) continue;
      if (/^frame\b/i.test(src.replace(/^.*\//, ''))) continue; // mask overlay, not a page
      seen.add(src);
      const base = src.replace(/^.*\//, '');
      images.push({ url: new URL(src, folder).toString(), name: `${date}-${base}`, minBytes: 0 });
    }
    if (!images.length) ctx.warn(`${date}: html strip but no comic frames found in ${folder}`);
    return { images, extras: [] };
  }

  if (date.startsWith('2004-09')) {
    return { images: [
      { url: `${dir}/${stem}a.png`, name: `${date}a.png` },
      { url: `${dir}/${stem}b.${ft}`, name: `${date}b.${ft}` },
    ], extras: [] };
  }

  if (ft === 'ppt') {
    const parts = Math.ceil(Number(comic.height) / 200);
    return { images: Array.from({ length: parts }, (_, i) => {
      const letter = String.fromCharCode(97 + i);
      const p = `${dir}/${stem}/${stem}${letter}`;
      return { url: `${p}.png`, name: `${date}${letter}.png`, fallbacks: [`${p}.gif`, `${p}.jpg`] };
    }), extras: [] };
  }

  return { images: [{ url: `${dir}/${stem}.${ft}`, name: `${date}.${ft}` }], extras: [] };
}

const GROUPS = ['year', 'storyline'];

async function plan(ctx, url, { group = 'year' } = {}) {
  if (!GROUPS.includes(group)) throw new Error(`bobandgeorge: group must be one of ${GROUPS.join(', ')}`);
  ctx.info('fetching the comic index from getData.php…');
  const comics = await (await ctx.fetch(`${API}?function=getComics&startDate=${FIRST}&endDate=${LAST}`)).json();
  const storylines = await (await ctx.fetch(`${API}?function=getStorylines`)).json();

  const dates = Object.keys(comics).sort();
  ctx.info(`${dates.length} strips, ${storylines.length} storylines (${dates[0]} → ${dates[dates.length - 1]})`);

  // Bucket strips either by calendar year or by storyline index.
  const buckets = new Map(); // key → { images, extras, storylines:Set, dates:[] }
  const special = [];
  for (const date of dates) {
    const comic = comics[date];
    const assets = await stripAssets(ctx, date, comic);
    if (['mp4', 'swf', 'htm'].includes(comic.filetype)) special.push(`${date} (${comic.filetype})`);
    const key = group === 'year' ? date.slice(0, 4) : String(Number(comic.storyline));
    if (!buckets.has(key)) buckets.set(key, { images: [], extras: [], storylines: new Set(), dates: [] });
    const b = buckets.get(key);
    // Sprite strips can legitimately compress to under 3 KB (a black-panel gag is ~2 KB),
    // so the engine's size floor is wrong here; the content-type check still guards errors.
    b.images.push(...assets.images.map((it) => (it.generate ? it : { minBytes: 0, ...it })));
    b.extras.push(...assets.extras);
    b.dates.push(date);
    const s = storylines[Number(comic.storyline)];
    if (s) b.storylines.add(s.title);
  }
  if (special.length) {
    ctx.info(`${special.length} non-image strips handled (html → frames, video/flash → placeholder page + extras/): ${special.join(', ')}`);
  }

  let groups;
  if (group === 'year') {
    groups = [...buckets.entries()].map(([year, b]) => ({
      no: Number(year),
      title: year,
      images: b.images,
      extras: b.extras,
      meta: {
        title: `${SERIES} ${year}`,
        web: `${BASE}/archives/${year}-01-01`,
        summary: `Storylines: ${[...b.storylines].join('; ')}`,
      },
    }));
  } else {
    // Storyline titles aren't chronological on their own, so the file name carries the
    // arc's order: "Bob and George - 023 - Title.cbz". -e selects by that number.
    groups = [...buckets.entries()]
      .map(([idx, b]) => ({ idx: Number(idx), b }))
      .sort((a, c) => a.idx - c.idx)
      .map(({ idx, b }, i) => {
        const sl = storylines[idx] || {};
        const n = i + 1;
        const arc = plainTitle(sl.title) || `Storyline ${n}`;
        const sub = plainTitle(sl.subtitle);
        return {
          no: n,
          title: `${String(n).padStart(3, '0')} - ${arc}`,
          images: b.images,
          extras: b.extras,
          meta: {
            title: sub ? `${arc} — ${sub}` : arc,
            web: `${BASE}/archives/${b.dates[0]}`,
            summary: [plainTitle(sl.description), `${b.dates[0]} → ${b.dates[b.dates.length - 1]} (${b.dates.length} strips)`]
              .filter(Boolean).join(' '),
          },
        };
      });
  }

  return { series: SERIES, groups, delay: 150, referer: `${BASE}/archives/` };
}

module.exports = { name: 'bobandgeorge', label: 'Bob and George archive', groups: GROUPS, defaultGroup: 'year', match, plan, _stripAssets: stripAssets };
