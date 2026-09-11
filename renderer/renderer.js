'use strict';
/* renderer.js — wires the form to window.comicgrab (see preload.js). */

const $ = (id) => document.getElementById(id);
const els = {
  url: $('url'), out: $('out'), choose: $('choose'), episodes: $('episodes'), name: $('name'),
  stitch: $('stitch'), oneCbz: $('oneCbz'), keep: $('keep'), numbered: $('numbered'),
  go: $('go'), cancel: $('cancel'), open: $('open'), status: $('status'),
  progress: $('progress'), itemTitle: $('itemTitle'), itemCount: $('itemCount'),
  tiles: $('tiles'), pageCount: $('pageCount'), log: $('log'),
};

let running = false;
let lastOutDir = null;
let tileTotal = 0;

// --- log -------------------------------------------------------------------
function log(text, cls) {
  const line = document.createElement('span');
  if (cls) line.className = cls;
  line.textContent = text + '\n';
  els.log.appendChild(line);
  // keep the log bounded so a 40-episode run doesn't bloat the DOM
  while (els.log.childNodes.length > 2000) els.log.removeChild(els.log.firstChild);
  els.log.scrollTop = els.log.scrollHeight;
}

// --- page tiles ------------------------------------------------------------
function resetTiles() {
  tileTotal = 0;
  els.tiles.replaceChildren();
  els.tiles.classList.add('indeterminate');
  // a few grey tiles pulse while we don't yet know how many pages there are
  for (let i = 0; i < 12; i++) els.tiles.appendChild(document.createElement('i'));
  els.pageCount.textContent = 'Finding pages…';
}

function buildTiles(total) {
  tileTotal = total;
  els.tiles.classList.remove('indeterminate');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < total; i++) frag.appendChild(document.createElement('i'));
  els.tiles.replaceChildren(frag);
}

function fillTile(done, total) {
  if (total !== tileTotal) buildTiles(total);
  const tile = els.tiles.children[done - 1];
  if (tile) tile.classList.add('on');
  els.pageCount.textContent = `${done} of ${total} pages`;
}

// --- progress events -------------------------------------------------------
function onProgress(ev) {
  switch (ev.type) {
    case 'mode':
      els.status.textContent = ev.msg;
      log(ev.msg);
      break;
    case 'item':
      els.itemTitle.textContent = ev.title;
      els.itemCount.textContent = `${ev.index} of ${ev.total}`;
      resetTiles();
      log(ev.msg);
      break;
    case 'download':
      fillTile(ev.done, ev.total);
      break;
    case 'cbz':
      log(ev.msg, 'ok');
      break;
    case 'warn':
      log(ev.msg, 'warn');
      break;
    case 'done':
      els.status.textContent = ev.msg;
      log(ev.msg, 'ok');
      break;
    default:
      if (ev.msg) log(ev.msg);
  }
}

// --- run control -----------------------------------------------------------
function setRunning(on) {
  running = on;
  els.go.disabled = on;
  els.cancel.disabled = !on;
  for (const k of ['url', 'out', 'choose', 'episodes', 'name', 'stitch', 'oneCbz', 'keep', 'numbered']) {
    els[k].disabled = on;
  }
  if (on) { els.open.hidden = true; els.progress.classList.add('on'); }
}

async function start() {
  const url = els.url.value.trim();
  if (!url) { els.url.focus(); els.status.textContent = 'Enter a comic URL first.'; return; }
  if (els.stitch.checked && els.oneCbz.checked) {
    els.status.textContent = 'Choose either stitching or one CBZ, not both.';
    return;
  }

  els.log.replaceChildren();
  els.status.textContent = 'Starting…';
  els.itemTitle.textContent = 'Reading the page…';
  els.itemCount.textContent = '';
  resetTiles();
  setRunning(true);

  const result = await window.comicgrab.grab({
    url,
    outDir: els.out.value.trim(),
    episodes: els.episodes.value.trim() || 'all',
    name: els.name.value.trim(),
    stitch: els.stitch.checked,
    oneCbz: els.oneCbz.checked,
    keep: els.keep.checked,
    numbered: els.numbered.checked,
  });

  setRunning(false);
  if (result.cancelled) {
    els.status.textContent = 'Cancelled.';
    log('Cancelled. Partial folders are left in place for you to delete.', 'warn');
  } else if (result.error) {
    els.status.textContent = 'Stopped: ' + result.error;
    log(result.error, 'err');
  } else {
    lastOutDir = result.outDir;
    els.open.hidden = false;
    els.itemTitle.textContent = result.series;
    els.itemCount.textContent = `${result.files.length} CBZ`;
    els.pageCount.textContent = 'Finished';
  }
}

async function cancel() {
  if (!running) return;
  els.cancel.disabled = true;
  els.status.textContent = 'Cancelling after the current page…';
  await window.comicgrab.cancel();
}

// --- wiring ----------------------------------------------------------------
els.go.addEventListener('click', start);
els.cancel.addEventListener('click', cancel);
els.url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !running) start(); });
els.choose.addEventListener('click', async () => {
  const dir = await window.comicgrab.chooseDir(els.out.value.trim());
  if (dir) els.out.value = dir;
});
els.open.addEventListener('click', () => { if (lastOutDir) window.comicgrab.openPath(lastOutDir); });

window.comicgrab.onProgress(onProgress);
window.comicgrab.defaultDir().then((d) => { if (!els.out.value) els.out.value = d; });
els.url.focus();
