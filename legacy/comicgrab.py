#!/usr/bin/env python3
"""
comicgrab.py — one downloader for both comic site styles.

Give it any comic URL and it figures out what it's looking at:

  webtoon-series   episode list (webtoons.com /list, clones) → CBZ per episode
  webtoon-episode  single webtoon viewer page                → one CBZ
  chapter-list     page listing many chapters                → CBZ per chapter
  gallery          single paginated reader page              → one CBZ

Usage:
    python3 comicgrab.py <url> [-e 1-10] [-n "Name"] [--stitch] [--one-cbz] [--keep] [-o DIR]
"""

import argparse
import re
import shutil
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from xml.sax.saxutils import escape

import requests
from bs4 import BeautifulSoup

# --- tuning ----------------------------------------------------------------
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/124.0.0.0 Safari/537.36"),
    "Accept-Language": "en-US,en;q=0.9",
}

WEBTOON_HOST = re.compile(r"(^|\.)webtoons?\.com$", re.I)

# HTML fingerprints of webtoon-style sites (slices hidden in data-url)
WEBTOON_MARKERS = [
    "ul#_listEpisode",
    "div.viewer_img img[data-url]",
    "img._images",
]

IMAGE_SELECTORS = [
    ".reading-content img",      # WordPress manga-reader themes
    "div.page-break img",
    ".entry-content img",
    "article img",
    "img",
]

JUNK = re.compile(r"logo|icon|avatar|banner|sprite|thumb|/ads?/|analytic|emoji", re.I)
NEXT_EXCLUDE = re.compile(r"chapter|episode|issue|volume", re.I)
CHAPTER_HREF = re.compile(r"\b(?:chapter|ch|episode|ep)[-_./ ]?(\d+(?:\.\d+)?)", re.I)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
MIME_EXT = {"image/jpeg": ".jpg", "image/png": ".png",
            "image/gif": ".gif", "image/webp": ".webp"}

MAX_LIST_PAGES = 40
MAX_PAGES = 150
RETRIES = 3
RETRY_STATUS = {429, 500, 502, 503, 504}
DELAY = 0.5
MIN_BYTES = 3_000
MAX_NAME = 80          # filename component length cap
MAX_STRIP = 60_000     # JPEG hard limit is 65,535 px per side; stay under it

MODE_LABEL = {
    "webtoon-series":  "webtoon series — one CBZ per episode",
    "webtoon-episode": "webtoon episode — one CBZ",
    "chapter-list":    "chapter list — one CBZ per chapter",
    "gallery":         "single gallery — one CBZ",
}
# ---------------------------------------------------------------------------


# --- shared plumbing -------------------------------------------------------
def fetch(session, url, **kw):
    """GET with retry + backoff on network failures, 429, and 5xx."""
    timeout = kw.pop("timeout", 30)
    for attempt in range(1, RETRIES + 1):
        try:
            r = session.get(url, timeout=timeout, **kw)
            if r.status_code in RETRY_STATUS and attempt < RETRIES:
                raise requests.ConnectionError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r
        except (requests.ConnectionError, requests.Timeout) as e:
            if attempt == RETRIES:
                raise
            print(f"  ! retry {attempt}/{RETRIES - 1} for {url} ({e})")
            time.sleep(attempt * 2)


def get_soup(session, url):
    return BeautifulSoup(fetch(session, url).text, "html.parser")


def safe_name(s):
    s = re.sub(r'[\\/*?:"<>|]+', "", s).strip().strip(".")
    return s[:MAX_NAME].rstrip() or "untitled"


def clean_title(raw):
    """Drop a trailing ' | Site Name' / ' - Site Name' segment."""
    parts = re.split(r"\s+[|–—-]\s+", raw)
    t = " - ".join(parts[:-1]) if len(parts) > 1 else raw
    t = re.sub(r"\s+", " ", t).strip()
    return safe_name(t) if t else "comic"


def og_title(soup, fallback="comic"):
    og = soup.find("meta", property="og:title")
    if og and og.get("content"):
        return clean_title(og["content"])
    if soup.title:
        return clean_title(soup.title.get_text(strip=True))
    return clean_title(fallback)


def num_tag(no):
    """5 -> '0005', 10.5 -> '0010.5' — sortable names, handles half chapters."""
    s = f"{no:.2f}".rstrip("0").rstrip(".")
    whole, _, frac = s.partition(".")
    tag = f"{int(whole):04d}"
    return f"{tag}.{frac}" if frac else tag


def with_page(url, page):
    p = urlparse(url)
    q = parse_qs(p.query)
    q["page"] = [str(page)]
    return p._replace(query=urlencode(q, doseq=True)).geturl()


def parse_episode_spec(spec):
    """'all' -> None, else a set of numbers from '3', '1-10', '1,4,9-12'."""
    if spec.strip().lower() in ("", "all"):
        return None
    wanted = set()
    try:
        for part in spec.split(","):
            part = part.strip()
            if "-" in part:
                lo, hi = part.split("-", 1)
                n = float(lo)
                while n <= float(hi) + 1e-9:
                    wanted.add(round(n, 2))
                    n += 1
            else:
                wanted.add(round(float(part), 2))
    except ValueError:
        sys.exit(f'Bad -e/--episodes value "{spec}" — use "all", "3", "1-10", or "1,4,9-12".')
    return wanted


def apply_selection(items, spec):
    wanted = parse_episode_spec(spec)
    if wanted is None:
        return items
    picked = [it for it in items if it[0] in wanted]
    missing = sorted(wanted - {it[0] for it in items})
    if missing:
        print(f"  note: not found: {', '.join(num_tag(m) for m in missing)}")
    return picked
# ---------------------------------------------------------------------------


# --- detection -------------------------------------------------------------
def classify(session, url):
    """Fetch once, decide the strategy.
    Returns (mode, soup, chapters) — chapters only for chapter-list mode."""
    soup = get_soup(session, url)
    path = urlparse(url).path
    markers = any(soup.select(sel) for sel in WEBTOON_MARKERS)

    if WEBTOON_HOST.search(urlparse(url).netloc) or markers:
        if "/viewer" in path:
            return "webtoon-episode", soup, []
        return "webtoon-series", soup, []

    # If the URL itself is a chapter, it's a gallery — even though the page
    # will have prev/next/dropdown links that look like a chapter list.
    if CHAPTER_HREF.search(path):
        return "gallery", soup, []

    chapters = find_chapters(soup, url)
    if len(chapters) >= 3:
        return "chapter-list", soup, chapters
    return "gallery", soup, []


def find_chapters(soup, page_url):
    """Heuristic: >=3 anchors whose href/text mentions chapter/ch/ep <number>."""
    seen_urls, seen_nums, out = set(), set(), []
    here = urlparse(page_url).netloc
    for a in soup.select("a[href]"):
        raw = a.get("href")
        if not raw or raw.startswith(("#", "javascript:", "mailto:")):
            continue
        href = urljoin(page_url, raw)
        if urlparse(href).netloc != here or href in seen_urls:
            continue
        text = a.get_text(" ", strip=True)
        m = CHAPTER_HREF.search(href) or CHAPTER_HREF.search(text)
        if not m:
            continue
        no = round(float(m.group(1)), 2)
        if no in seen_nums:
            continue
        seen_urls.add(href)
        seen_nums.add(no)
        out.append((no, text or f"Chapter {num_tag(no)}", href))
    out.sort(key=lambda t: t[0])
    return out
# ---------------------------------------------------------------------------


# --- webtoon-style ---------------------------------------------------------
def list_webtoon_episodes(session, list_url):
    """Walk the paginated episode list. Returns [(no, title, url)]."""
    found, seen = [], set()
    for page in range(1, MAX_LIST_PAGES + 1):
        url = with_page(list_url, page)
        print(f"  list page {page}")
        soup = get_soup(session, url)
        fresh = 0
        for a in soup.select("a[href*='episode_no=']"):
            href = urljoin(url, a.get("href"))
            if href in seen:
                continue
            seen.add(href)
            fresh += 1
            no = int(parse_qs(urlparse(href).query).get("episode_no", ["0"])[0])
            subj = a.select_one(".subj") or a
            found.append((no, subj.get_text(strip=True) or f"Episode {no}", href))
        if fresh == 0:
            break
        time.sleep(DELAY)
    found.sort(key=lambda t: t[0])
    return found


def webtoon_slices(soup):
    """Slices live on img._images with the real URL in data-url."""
    urls = []
    for img in soup.select("div.viewer_img img[data-url], img._images"):
        src = img.get("data-url") or img.get("src")
        if src and src.startswith("http"):
            urls.append(src)
    return list(dict.fromkeys(urls))
# ---------------------------------------------------------------------------


# --- generic gallery -------------------------------------------------------
def largest_from_srcset(srcset):
    best, best_w = None, -1
    for cand in srcset.split(","):
        parts = cand.strip().split()
        if not parts or parts[0].startswith("data:"):
            continue
        w = -1
        if len(parts) > 1 and parts[1].endswith("w"):
            try:
                w = int(parts[1][:-1])
            except ValueError:
                pass
        if w > best_w:
            best, best_w = parts[0], w
    return best


def best_src(img, base_url):
    """Lazy-load attrs first (usually the original); srcset last — on
    WordPress those entries are resized variants like -1024x1536.jpg."""
    for attr in ("data-src", "data-url", "data-lazy-src", "data-original", "src"):
        val = img.get(attr)
        if val and not val.startswith("data:"):
            return urljoin(base_url, val.strip())
    srcset = img.get("srcset") or img.get("data-srcset")
    if srcset:
        cand = largest_from_srcset(srcset)
        if cand:
            return urljoin(base_url, cand)
    return None


def extract_images(soup, page_url):
    for selector in IMAGE_SELECTORS:
        urls = []
        for img in soup.select(selector):
            src = best_src(img, page_url)
            if src and not JUNK.search(src):
                urls.append(src)
        urls = list(dict.fromkeys(urls))
        if urls:
            return urls
    return []


def _same_scope(a, b):
    """Keep 'next' pagination inside this work: compare path prefixes up to
    the shorter of the two. Known gap: a two-segment start URL still lets
    ch-1 -> ch-2 through; NEXT_EXCLUDE catches the usual link text."""
    pa = [s for s in urlparse(a).path.split("/") if s]
    pb = [s for s in urlparse(b).path.split("/") if s]
    depth = min(len(pa), len(pb), 3)
    return pa[:depth] == pb[:depth]


def find_next_page(soup, page_url, start_url):
    for a in soup.select("a[rel=next], a.next_page, a.next, .pagination a, a.page-numbers"):
        text = a.get_text(strip=True).lower()
        href = a.get("href")
        if not href:
            continue
        if not ("next" in text or text in ("›", "»")):
            continue
        if NEXT_EXCLUDE.search(text):
            continue
        nxt = urljoin(page_url, href)
        if nxt != page_url and _same_scope(nxt, start_url):
            return nxt
    return None


def collect_image_urls(session, start_url):
    """Walk a paginated reader; drop images repeated across pages (site chrome)."""
    per_page, seen_pages, url = [], set(), start_url
    while url and url not in seen_pages and len(seen_pages) < MAX_PAGES:
        seen_pages.add(url)
        print(f"  reading {url}")
        soup = get_soup(session, url)
        per_page.append(extract_images(soup, url))
        url = find_next_page(soup, url, start_url)
        if url:
            time.sleep(DELAY)
    hits = Counter(u for urls in per_page for u in urls)
    ordered = [u for urls in per_page for u in urls]
    return [u for u in dict.fromkeys(ordered) if hits[u] == 1]
# ---------------------------------------------------------------------------


# --- output ----------------------------------------------------------------
def download_images(session, urls, dest, referer):
    dest.mkdir(parents=True, exist_ok=True)
    saved = []
    for n, u in enumerate(urls, 1):
        try:
            r = fetch(session, u, timeout=60, headers={"Referer": referer})
        except requests.RequestException as e:
            print(f"  ! skipped {u} ({e})")
            continue
        ctype = r.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if not ctype.startswith("image/"):
            print(f"  ! skipped {u} (not an image: {ctype or 'unknown'})")
            continue
        if len(r.content) < MIN_BYTES:
            print(f"  ! skipped {u} (only {len(r.content)} bytes)")
            continue
        ext = Path(urlparse(u).path).suffix.lower()
        if ext not in IMAGE_EXTS:
            ext = MIME_EXT.get(ctype, ".jpg")
        p = dest / f"{len(saved) + 1:04d}{ext}"
        p.write_bytes(r.content)
        saved.append(p)
        print(f"  [{n}/{len(urls)}] {p.name} ({len(r.content) // 1024} KB)")
        time.sleep(DELAY)
    return saved


def stitch(paths, out_dir):
    """Stack slices vertically. JPEG can't exceed 65,535 px on a side, so a
    long episode is split into full-01.jpg, full-02.jpg, ... under MAX_STRIP.
    Returns the list of strip paths."""
    try:
        from PIL import Image
    except ImportError:
        sys.exit("--stitch needs Pillow:  pip3 install pillow")

    ims = [Image.open(p).convert("RGB") for p in paths]
    width = max(im.width for im in ims)

    # group slices into chunks whose combined height stays under MAX_STRIP
    chunks, cur, cur_h = [], [], 0
    for im in ims:
        if cur and cur_h + im.height > MAX_STRIP:
            chunks.append(cur)
            cur, cur_h = [], 0
        cur.append(im)
        cur_h += im.height
    if cur:
        chunks.append(cur)

    outs = []
    for i, chunk in enumerate(chunks, 1):
        canvas = Image.new("RGB", (width, sum(im.height for im in chunk)), "white")
        y = 0
        for im in chunk:
            canvas.paste(im, (0, y))
            y += im.height
        name = "full.jpg" if len(chunks) == 1 else f"full-{i:02d}.jpg"
        out = out_dir / name
        canvas.save(out, "JPEG", quality=92)
        outs.append(out)

    for im in ims:
        im.close()
    return outs


def maybe_stitch(saved, args):
    if not args.stitch:
        return saved
    return stitch(saved, saved[0].parent)


def comic_info_xml(series, web, count, number=None, title=""):
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
        f"  <Series>{escape(series)}</Series>",
    ]
    if number is not None:
        lines.append(f"  <Number>{number:g}</Number>")
    if title:
        lines.append(f"  <Title>{escape(title)}</Title>")
    lines += [f"  <Web>{escape(web)}</Web>",
              f"  <PageCount>{count}</PageCount>",
              "</ComicInfo>"]
    return "\n".join(lines) + "\n"


def make_cbz(files, cbz_path, series, web, number=None, title=""):
    with zipfile.ZipFile(cbz_path, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("ComicInfo.xml",
                    comic_info_xml(series, web, len(files), number, title))
        for img in sorted(files):
            zf.write(img, arcname=img.name)


def merge_cbz(out_path, series, web, tagged):
    """--one-cbz: everything in one file, names like 0003-0012.jpg."""
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("ComicInfo.xml", comic_info_xml(series, web, len(tagged)))
        for no, p in tagged:
            zf.write(p, arcname=f"{num_tag(no)}-{p.name}")


def cleanup(folder, args):
    """Loose images are scratch; the CBZ is the deliverable (unless --keep)."""
    if not args.keep:
        shutil.rmtree(folder, ignore_errors=True)
# ---------------------------------------------------------------------------


# --- runners ---------------------------------------------------------------
def run_series(session, items, series, out_root, source_url, args, kind):
    """Shared loop for webtoon episodes AND generic chapters."""
    tagged, dirs, done = [], [], 0
    label = "ep" if kind == "webtoon" else "ch"
    referer = f"https://{urlparse(items[0][2]).netloc}/" if kind == "webtoon" else None
    for no, title, url in items:
        print(f"  {label} {num_tag(no)}: {title}")
        if kind == "webtoon":
            soup = get_soup(session, url)
            urls = webtoon_slices(soup)
            if not urls:
                print("    ! no images (Fast Pass, deleted, or age-gated) — skipped")
                continue
        else:
            urls = collect_image_urls(session, url)
            if not urls:
                print("    ! no images found — skipped")
                continue

        ch_dir = out_root / num_tag(no)
        saved = download_images(session, urls, ch_dir, referer or url)
        if not saved:
            continue
        dirs.append(ch_dir)

        if args.one_cbz:
            tagged.extend((no, p) for p in saved)
            continue

        files = maybe_stitch(saved, args)
        make_cbz(files, out_root / f"{num_tag(no)} - {safe_name(title)}.cbz",
                 series, url, number=no, title=title)
        cleanup(ch_dir, args)
        done += 1

    if args.one_cbz and tagged:
        merge_cbz(out_root / f"{safe_name(series)}.cbz", series, source_url, tagged)
        for d in dirs:
            cleanup(d, args)
        return 1
    return done


def run_gallery(session, url, out_root, title, args):
    print("Scanning gallery…")
    images = collect_image_urls(session, url)
    if not images:
        sys.exit("No images found. Inspect the page, find the container around "
                 "the comic images, and add its selector to IMAGE_SELECTORS.")
    print(f"{len(images)} image(s). Downloading…")
    saved = download_images(session, images, out_root / "pages", referer=url)
    if not saved:
        sys.exit("Nothing was downloaded.")
    files = maybe_stitch(saved, args)
    make_cbz(files, out_root / f"{safe_name(title)}.cbz", title, url, title=title)
    cleanup(out_root / "pages", args)
    return 1


def run_webtoon_episode(session, url, soup, base, args):
    no = float(parse_qs(urlparse(url).query).get("episode_no", ["1"])[0])
    # og:title is reliable on the viewer; the breadcrumb link is a fallback
    # because the first '/list?' anchor is sometimes a logo with no text.
    series = og_title(soup, "")
    if series in ("comic", "untitled"):
        crumbs = [a for a in soup.select("a[href*='/list?']") if a.get_text(strip=True)]
        if crumbs:
            series = clean_title(crumbs[0].get_text(strip=True))
    h1 = soup.select_one("h1.subj, h1")
    ep_title = h1.get_text(strip=True) if h1 else f"Ep {num_tag(no)}"
    urls = webtoon_slices(soup)
    if not urls:
        sys.exit("No slices found — Fast Pass-locked, deleted, or age-gated?")
    print(f'Series: {series} — episode {num_tag(no)}: {ep_title}')
    out = base / series
    saved = download_images(session, urls, out / "pages", referer=url)
    if not saved:
        sys.exit("Nothing was downloaded.")
    files = maybe_stitch(saved, args)
    make_cbz(files, out / f"{num_tag(no)} - {safe_name(ep_title)}.cbz",
             series, url, number=no, title=ep_title)
    cleanup(out / "pages", args)
    return 1
# ---------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(
        description="Download a comic (any style) and save it as .cbz files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="examples:\n"
               '  comicgrab.py "https://www.webtoons.com/en/.../list?title_no=10656"\n'
               "  comicgrab.py <any-comic-url> -e 1-10 --stitch\n")
    ap.add_argument("url")
    ap.add_argument("-e", "--episodes", default="all",
                    help='series modes: "all", "3", "1-10", "1,4,9-12"')
    ap.add_argument("-n", "--name", help="override the detected series title")
    ap.add_argument("-o", "--out",
                    default=str(Path.home() / "Downloads" / "Comics"))
    ap.add_argument("--stitch", action="store_true",
                    help="merge each episode/gallery into one tall JPEG "
                         "(split into parts if longer than ~60k px)")
    ap.add_argument("--one-cbz", action="store_true",
                    help="series modes: merge everything into a single CBZ")
    ap.add_argument("--keep", action="store_true",
                    help="keep the loose image folders after zipping")
    args = ap.parse_args()

    if args.stitch and args.one_cbz:
        ap.error("--stitch and --one-cbz can't be combined; pick one.")

    url = args.url.strip()
    if not url.startswith("http"):
        url = "https://" + url

    session = requests.Session()
    session.headers.update(HEADERS)
    if WEBTOON_HOST.search(urlparse(url).netloc):
        session.cookies.set("ageGatePass", "true", domain=".webtoons.com")

    mode, soup, chapters = classify(session, url)
    print(f"Detected: {MODE_LABEL[mode]}")

    base = Path(args.out).expanduser()
    series = args.name or og_title(soup, urlparse(url).netloc)

    if mode == "webtoon-series":
        print(f"Series: {series}\nScanning episode list…")
        episodes = list_webtoon_episodes(session, url)
        episodes = apply_selection(episodes, args.episodes)
        if not episodes:
            sys.exit("No (matching) episodes found.")
        print(f"{len(episodes)} episode(s).")
        done = run_series(session, episodes, series, base / series, url,
                          args, kind="webtoon")
    elif mode == "chapter-list":
        chapters = apply_selection(chapters, args.episodes)
        if not chapters:
            sys.exit("No (matching) chapters found.")
        print(f"Series: {series} — {len(chapters)} chapter(s).")
        done = run_series(session, chapters, series, base / series, url,
                          args, kind="chapter")
    elif mode == "webtoon-episode":
        done = run_webtoon_episode(session, url, soup, base, args)
    else:
        print(f'Title: "{series}"')
        done = run_gallery(session, url, base / series, series, args)

    print(f"\nDone — {done} CBZ file(s) under {base}")


if __name__ == "__main__":
    main()
