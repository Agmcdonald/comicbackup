# ComicGrab

Back up webcomics and webtoons for offline reading. Paste a comic URL, get `.cbz` files.

Works as a desktop app (macOS / Windows, via Electron) and as a plain command-line tool (Node only). Both share one engine.

## What it handles

| Detected mode | Input | Output |
|---|---|---|
| webtoon series | a webtoons.com `/list?title_no=…` page (or a clone using the same markup) | one CBZ per episode |
| webtoon episode | a single `/viewer?…` page | one CBZ |
| chapter list | a page linking to many chapters | one CBZ per chapter |
| gallery | a single (possibly paginated) reader page | one CBZ |

Each CBZ contains a `ComicInfo.xml` with series, episode number, title, and source URL. Files are named `Series - Episode title.cbz` (pass `--numbered` for `0001 - Episode title.cbz`).

The desktop app has one trick the CLI doesn't: when a reader builds its pages with JavaScript and the static HTML has no images, it loads the page in a hidden browser window and reads the live DOM.

## Site adapters

Some sites are JS-rendered shells over a data API. Those get an adapter in `sites/` that skips HTML scraping and builds the image list directly:

| Site | Grouping | Notes |
|---|---|---|
| bobandgeorge.com | one CBZ per year (2000–2007), or per storyline with `-g storyline` (136 files, `Series - 001 - Arc title.cbz`) | pulls the full index from `getData.php`; pages are named by strip date; storyline titles go in ComicInfo Summary; html strips contribute their comic frames as pages; video/flash strips get a placeholder page in the CBZ and the file itself is saved to `extras/` next to the CBZs |

`-e` selects years for adapter sites (`-e 2000-2003`). To add a site, copy `sites/bobandgeorge.js`, implement `match(url)` and `plan(ctx, url)`, and register it in `SITE_ADAPTERS` in `engine.js`.

## Command line

```
npm install --omit=dev
node cli.js "<url>" [-e 1-10] [-n "Name"] [-o DIR] [--stitch] [--one-cbz] [--keep] [--numbered]
```

| Flag | |
|---|---|
| `-e, --episodes` | `all` (default), `3`, `1-10`, `1,4,9-12` |
| `-n, --name` | override the detected series title |
| `-o, --out` | output folder (default `~/Downloads/Comics`) |
| `--stitch` | merge each episode into tall JPEG strip(s), split under 60,000 px |
| `--one-cbz` | series modes: everything in a single CBZ |
| `--keep` | keep the loose image folders after zipping |
| `--numbered` | `0001 - Title.cbz` naming |
| `--repair` | adapter sites: open the existing CBZ, fetch only the pages it's missing, rewrite it — use after a run with skipped pages |
| `--force` | re-download files that already exist (by default an existing CBZ is skipped) |
| `-g, --group` | adapter sites: how to split — bobandgeorge: `year` (default) or `storyline` |

Needs Node 20.3 or newer.

## Desktop app

```
npm install
npm start          # run it
npm run dist       # build the .dmg (mac) / NSIS installer (win) into dist/
```

Unsigned builds: on macOS right-click → Open the first time; Windows SmartScreen will warn.

## Layout

```
engine.js          the downloader — no Electron imports; grab(url, opts)
cli.js             argv → engine.grab()
main.js            Electron main: window, IPC, net.fetch, hidden-window render fallback
preload.js         the bridge exposed to the renderer as window.comicgrab
renderer/          the UI
test/e2e.js        spins up a mock comic site and runs the generic modes
```

`npm test` runs the mock-site test (needs the dependencies installed).

## Library

Every CBZ written is recorded in `~/.comicgrab/history.json` (series, title, page count, source URL, path, date). The app's **Library** button lists them; clicking a row reveals the file. On any run, an episode/year whose CBZ already exists on disk is skipped — pass `--force` (or tick "Re-download") to redo it, or `--repair` to fill in only missing pages.

## Tuning per site

If a gallery site returns "No images found", inspect the page, find the container around the comic images, and add its selector to `IMAGE_SELECTORS` at the top of `engine.js`. The other knobs (`JUNK`, `NEXT_EXCLUDE`, `MIN_BYTES`, `DELAY`) live in the same block.

## History

Started as `comic2cbz.py`, grew into `comicgrab.py` (multi-mode), then ported to Node so one engine could power both a CLI and a cross-platform desktop app. The Python originals are in `legacy/`.
