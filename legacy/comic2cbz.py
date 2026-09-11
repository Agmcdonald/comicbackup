#!/usr/bin/env python3
"""
comic2cbz.py — download a webcomic and bundle the pages into a .cbz file.

Usage:
    python3 comic2cbz.py                 # prompts for a URL
    python3 comic2cbz.py <url>           # or pass it directly
"""

import re
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path
from urllib.parse import urljoin, urlparse
from xml.sax.saxutils import escape

import requests
from bs4 import BeautifulSoup

# --- Settings you may need to tweak per-site ------------------------------
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/124.0.0.0 Safari/537.36"),
    "Accept-Language": "en-US,en;q=0.9",
}

# Tried in order — the first selector that yields images wins.
IMAGE_SELECTORS = [
    ".reading-content img",      # common WordPress manga-reader themes
    "div.page-break img",
    ".entry-content img",
    "article img",
    "img",
]

# Skip if any of these appear in the image URL
JUNK = re.compile(r"logo|icon|avatar|banner|sprite|thumb|/ads?/|analytic|emoji", re.I)

# "Next" links whose text contains these are chapter/series navigation, not
# in-chapter pagination.
NEXT_EXCLUDE = re.compile(r"chapter|episode|issue|volume", re.I)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
MIME_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
            "image/webp": ".webp"}

MAX_PAGES = 150      # safety cap when following "next page" links
MIN_BYTES = 8_000    # ignore tiny images (spacers, tracking pixels)
RETRIES = 3          # per image
DELAY = 0.5          # seconds between requests — be polite
# ---------------------------------------------------------------------------


def fetch(session, url, **kw):
    """GET with simple retry + backoff."""
    for attempt in range(1, RETRIES + 1):
        try:
            r = session.get(url, timeout=kw.pop("timeout", 30), **kw)
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            if attempt == RETRIES:
                raise
            print(f"  ! retry {attempt}/{RETRIES - 1} for {url} ({e})")
            time.sleep(attempt * 2)


def get_soup(session, url):
    r = fetch(session, url)
    return BeautifulSoup(r.text, "html.parser")


def _largest_from_srcset(srcset):
    """Pick the widest candidate from a srcset string."""
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
    """Most likely full-size URL for an <img> tag (handles lazy-loading)."""
    srcset = img.get("srcset") or img.get("data-srcset")
    if srcset:
        cand = _largest_from_srcset(srcset)
        if cand:
            return urljoin(base_url, cand)
    for attr in ("data-src", "data-lazy-src", "data-original", "src"):
        val = img.get(attr)
        if val and not val.startswith("data:"):
            return urljoin(base_url, val.strip())
    return None


def extract_images(soup, page_url):
    for selector in IMAGE_SELECTORS:
        urls = []
        for img in soup.select(selector):
            src = best_src(img, page_url)
            if src and not JUNK.search(src):
                urls.append(src)
        urls = list(dict.fromkeys(urls))  # dedupe, keep order
        if urls:
            return urls
    return []


def _same_chapter(a, b):
    """Keep 'next' navigation inside this chapter: same path up to the
    chapter segment (one level deeper than the old 'same comic' check)."""
    pa = [s for s in urlparse(a).path.split("/") if s]
    pb = [s for s in urlparse(b).path.split("/") if s]
    depth = min(len(pb), 3)
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
        if nxt != page_url and _same_chapter(nxt, start_url):
            return nxt
    return None


def collect_image_urls(session, start_url):
    """Walk the (possibly paginated) gallery, return ordered image URLs.

    Any image appearing on more than one page is treated as site chrome
    (header art, sidebar ads) and dropped. Note: this also drops a page
    the comic legitimately repeats — rare, but worth knowing.
    """
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


def download_images(session, urls, dest: Path, referer):
    dest.mkdir(parents=True, exist_ok=True)
    saved = []
    for n, url in enumerate(urls, 1):
        try:
            r = fetch(session, url, timeout=60, headers={"Referer": referer})
        except requests.RequestException as e:
            print(f"  ! skipped {url} ({e})")
            continue

        ctype = r.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if not ctype.startswith("image/"):
            print(f"  ! skipped {url} (not an image: {ctype or 'unknown'})")
            continue
        if len(r.content) < MIN_BYTES:
            continue

        ext = Path(urlparse(url).path).suffix.lower()
        if ext not in IMAGE_EXTS:
            ext = MIME_EXT.get(ctype, ".jpg")

        # number by what we actually saved, so there are no gaps
        path = dest / f"{len(saved) + 1:03d}{ext}"
        path.write_bytes(r.content)
        saved.append(path)
        print(f"  [{n}/{len(urls)}] {path.name}  ({len(r.content) // 1024} KB)")
        time.sleep(DELAY)
    return saved


def comic_info_xml(title, source_url, page_count):
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
        f"  <Title>{escape(title)}</Title>\n"
        f"  <Web>{escape(source_url)}</Web>\n"
        f"  <PageCount>{page_count}</PageCount>\n"
        "</ComicInfo>\n"
    )


def make_cbz(files, cbz_path: Path, title, source_url):
    # ZIP_STORED: images are already compressed, no point re-compressing.
    # Only the files we downloaded go in — no .DS_Store, no stale leftovers.
    with zipfile.ZipFile(cbz_path, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("ComicInfo.xml", comic_info_xml(title, source_url, len(files)))
        for img in files:
            zf.write(img, arcname=img.name)


def clean_title(raw):
    """Drop a trailing ' - Site Name' / ' | Site Name' without mangling
    hyphenated titles like 'Spider-Man'."""
    parts = re.split(r"\s+[|–—-]\s+", raw)
    title = " - ".join(parts[:-1]) if len(parts) > 1 else raw
    title = re.sub(r'[\\/*?:"<>|]+', "", title).strip().strip(".")
    return title or "comic"


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else input("Comic URL: ").strip()
    if not url.startswith("http"):
        url = "https://" + url

    session = requests.Session()
    session.headers.update(HEADERS)

    soup = get_soup(session, url)
    raw = soup.title.get_text(strip=True) if soup.title else urlparse(url).netloc
    title = clean_title(raw)

    print("Scanning pages…")
    images = collect_image_urls(session, url)
    if not images:
        sys.exit("No images found. Right-click a comic page → Inspect, find the "
                 "container class around the images, and add it to IMAGE_SELECTORS.")

    print(f'"{title}" — {len(images)} image(s). Downloading…')
    out_dir = Path.home() / "Downloads" / title
    saved = download_images(session, images, out_dir, referer=url)
    if not saved:
        sys.exit("Nothing was downloaded.")

    cbz = out_dir.parent / f"{title}.cbz"
    make_cbz(saved, cbz, title, url)
    print(f"\nDone → {cbz}")


if __name__ == "__main__":
    main()
