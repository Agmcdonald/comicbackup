'use strict';
/**
 * main.js — Electron shell around engine.js.
 *
 * Provides the two things the engine can't do on its own:
 *   fetchImpl  → net.fetch  (Chromium network stack, shares the session cookie jar)
 *   renderPage → hidden BrowserWindow that loads a JS-rendered reader and
 *                reports the <img> URLs the page actually resolved
 */

const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog, net, session, shell } = require('electron');
const { grab, CancelledError } = require('./engine');

const DEFAULT_OUT = path.join(os.homedir(), 'Downloads', 'Comics');
const RENDER_TIMEOUT = 60_000;

let win = null;
let active = null; // { controller } while a grab is running

function createWindow() {
  win = new BrowserWindow({
    width: 620,
    height: 720,
    minWidth: 520,
    minHeight: 560,
    title: 'ComicGrab',
    backgroundColor: '#e4e7ec',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // The renderer is a local page; it should never navigate or spawn windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

/** Load a page in a hidden window and return the image URLs it resolved. */
async function renderPage(url) {
  const hidden = new BrowserWindow({
    show: false,
    width: 1280,
    height: 2400,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await hidden.loadURL(url);
    // Nudge lazy-loaders that key off scroll position, then wait for images.
    await hidden.webContents.executeJavaScript(`
      (async () => {
        const step = window.innerHeight;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        window.scrollTo(0, 0);
        await Promise.all([...document.images].map((i) =>
          i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })));
      })()`, true);
    return await hidden.webContents.executeJavaScript(`
      [...document.querySelectorAll('img')]
        .map((i) => i.currentSrc || i.src || i.dataset.src || i.dataset.url)
        .filter((s) => s && !s.startsWith('data:'))`, true);
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy();
  }
}

function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// --- IPC -------------------------------------------------------------------
ipcMain.handle('grab', async (_e, params) => {
  if (active) return { error: 'A download is already running.' };
  const controller = new AbortController();
  active = { controller };

  const send = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('progress', msg); };

  try {
    const host = new URL(/^https?:\/\//i.test(params.url) ? params.url : 'https://' + params.url).hostname;
    if (/(^|\.)webtoons?\.com$/i.test(host)) {
      await session.defaultSession.cookies.set({
        url: 'https://www.webtoons.com', name: 'ageGatePass', value: 'true', domain: '.webtoons.com',
      });
    }
    const result = await grab(params.url, {
      episodes: params.episodes || 'all',
      name: params.name || undefined,
      outDir: params.outDir || DEFAULT_OUT,
      stitch: !!params.stitch,
      oneCbz: !!params.oneCbz,
      keep: !!params.keep,
      numbered: !!params.numbered,
      signal: controller.signal,
      onProgress: send,
      fetchImpl: (url, init) => net.fetch(url, init),
      renderPage: (url) => withTimeout(renderPage(url), RENDER_TIMEOUT, 'page render'),
    });
    return { ok: true, ...result };
  } catch (e) {
    if (e instanceof CancelledError || e?.cancelled) return { cancelled: true };
    return { error: e.message || String(e) };
  } finally {
    active = null;
  }
});

ipcMain.handle('cancel', () => {
  if (active) { active.controller.abort(); return true; }
  return false;
});

ipcMain.handle('defaultDir', () => DEFAULT_OUT);

ipcMain.handle('chooseDir', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, {
    defaultPath: current || DEFAULT_OUT,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('openPath', async (_e, p) => {
  if (typeof p !== 'string' || !p) return false;
  const err = await shell.openPath(p);
  return !err;
});

ipcMain.handle('showInFolder', (_e, p) => {
  if (typeof p === 'string' && p) shell.showItemInFolder(p);
});

// --- lifecycle -------------------------------------------------------------
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
