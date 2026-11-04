// Snap by Motion Sync Studio — service worker (v2.0: Drive folders + social links)
//
// Scan:      browser login (Drive's own folder view, read by the panel) — no setup
//            or Drive API v3 with your own Client ID (advanced).
// Download:  each file is checked with a 1-byte request (exact name, size, permission),
//            then started as a normal Chrome download of Google's own per-file link.
//            If a download-manager extension (IDM, FDM, Motrix, JDownloader…) is installed,
//            it takes the download over; otherwise Chrome downloads it natively.
// No ZIP endpoint, no archive library, no file bytes in JavaScript memory, no backend.

import { getSettings, saveSettings, DEFAULTS } from '../core/settings.js';
import { getToken, invalidateToken, rememberAccount, signOut, SetupError, AuthError } from '../core/auth.js';
import * as drive from '../core/drive-api.js';
import * as session from '../core/session.js';
import { detectManager, onManagersChanged } from '../core/managers.js';
import { categorize, FOLDER_MIME, SHORTCUT_MIME, WORKSPACE_TYPES, isZipLike } from '../core/file-types.js';
import { folderParts, sanitizeSegment, numbered } from '../core/paths.js';
import { sendToHost } from '../social/menus.js';

const { FinalError, TransientError, BLOCKED_MSG } = session;
const MAX_RETRIES = 3;
const BACKOFF_MS = [2000, 5000, 15000];
const ACTIVE = new Set(['starting', 'downloading']);
const PENDING = new Set(['queued', 'starting', 'downloading', 'retrying']);

let state = freshState();
let settings = { ...DEFAULTS };
let seq = 0;
let scanCounter = 0;
let scanPort = null;
let index = new Map();
const byChrome = new Map();
const ports = new Set();
let pollTimer = null;
let lastPoll = null;
let manager = null; // detected download-manager extension, or null

async function refreshManager() { manager = await detectManager(); changed(); }
onManagersChanged(() => { refreshManager(); });

function freshState(folder = null) {
  return { phase: 'idle', message: '', folder, scan: { folders: 0, seen: 0 }, items: [], batch: null, account: null };
}
function rebuildIndex() { index = new Map(state.items.map((i) => [i.id, i])); }
const getItem = (id) => index.get(id);
const batchItems = () => (state.batch ? state.batch.ids.map(getItem).filter(Boolean) : []);
const isBusy = () => state.phase === 'scanning' || state.phase === 'downloading';
const useApi = () => settings.connection === 'api';

// ---------------------------------------------------------------- startup / persistence

const ready = (async () => {
  settings = await getSettings();
  manager = await detectManager();
  const { dlState } = await chrome.storage.session.get('dlState');
  if (dlState) {
    seq = dlState.seq || 0;
    delete dlState.seq;
    state = dlState;
    rebuildIndex();
    await reconcile();
  }
})();

async function reconcile() {
  for (const it of state.items) {
    if (it.status === 'starting' || it.status === 'retrying') it.status = 'queued';
    if (it.status === 'downloading' && it.engine === 'chrome') {
      const [d] = it.chromeDownloadId != null ? await chrome.downloads.search({ id: it.chromeDownloadId }) : [];
      if (!d) { if (manager) markHandedOff(it); else it.status = 'queued'; continue; }
      byChrome.set(d.id, it.id);
      if (d.state === 'complete') onChromeComplete(it, d);
      else if (d.state === 'interrupted') { byChrome.delete(d.id); it.status = 'queued'; it.resumeId = d.canResume ? d.id : null; }
    }
  }
  if (state.phase === 'scanning') {
    state.phase = state.items.length ? 'ready' : 'idle';
    state.message = 'The scan was interrupted. Click Scan folder to run it again.';
  }
  if (state.phase === 'downloading') { pump(); startPolling(); }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.session.set({ dlState: { ...state, seq } }).catch(() => {});
  }, 800);
}
let castTimer = null;
function scheduleBroadcast() {
  if (castTimer) return;
  castTimer = setTimeout(() => {
    castTimer = null;
    const msg = { type: 'state', state: view() };
    for (const p of ports) { try { p.postMessage(msg); } catch { /* gone */ } }
  }, 150);
}
function changed() { scheduleBroadcast(); scheduleSave(); }

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
    if (state.phase === 'downloading') pump();
    changed();
  }
});

// ---------------------------------------------------------------- view model

function view() {
  const byCat = { video: 0, image: 0, audio: 0, document: 0, other: 0 };
  let selected = 0;
  for (const it of state.items) { byCat[it.category]++; if (it.selected) selected++; }
  let batch = null;
  if (state.batch) {
    const items = batchItems();
    const n = (fn) => items.filter(fn).length;
    batch = {
      ...state.batch,
      total: items.length,
      done: n((i) => i.status === 'done'),
      failed: n((i) => i.status === 'failed'),
      handedOff: n((i) => i.status === 'handedOff'),
      blocked: n((i) => i.status === 'blocked'),
      active: n((i) => ACTIVE.has(i.status)),
      queued: n((i) => i.status === 'queued' || i.status === 'retrying'),
      current: items.filter((i) => i.status === 'downloading').map((i) => i.targetName || i.name)
    };
    delete batch.used;
    batch.managerName = state.batch.managerName || manager?.name || null;
  }
  return {
    phase: state.phase,
    message: state.message,
    folder: state.folder,
    scan: state.scan,
    items: state.items,
    counts: { files: state.items.length, folders: state.scan.folders, items: state.items.length + state.scan.folders, byCat, selected },
    batch,
    account: state.account,
    manager,
    settings: {
      concurrency: settings.concurrency, recursive: settings.recursive, preserveFolders: settings.preserveFolders,
      connection: settings.connection, hasClientId: !!settings.clientId
    },
    version: chrome.runtime.getManifest().version
  };
}

// ---------------------------------------------------------------- messaging

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel' && port.name !== 'popup') return;
  ports.add(port);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (port === scanPort && state.phase === 'scanning') {
      quickScanFailed(scanCounter, 'The Drive tab was closed or reloaded during the scan.');
    }
  });
  port.onMessage.addListener(async (msg) => {
    await ready;
    try { await handle(msg, port); } catch (e) { console.error(e); state.message = String(e?.message || e); }
    changed();
  });
  ready.then(() => { try { port.postMessage({ type: 'state', state: view() }); } catch { /* closed */ } });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await ready;
    try {
      if (msg?.cmd === 'signIn') { await signInFlow(true); sendResponse({ ok: true, email: state.account }); }
      else if (msg?.cmd === 'signOut') { await signOut(); state.account = null; changed(); sendResponse({ ok: true }); }
      else if (msg?.cmd === 'getState') sendResponse(view());
      else if (msg?.cmd === 'getManager') { await refreshManager(); sendResponse({ ok: true, manager }); }
      else sendResponse({ ok: false });
    } catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
  })();
  return true;
});

async function handle(msg, port) {
  switch (msg?.cmd) {
    case 'ping': return;
    case 'setFolder': return setFolder(msg.folder);
    case 'scan': if (msg.folder) setFolder(msg.folder); return scan(port);
    case 'scanItems': return quickScanItems(msg);
    case 'scanDone': return quickScanDone(msg.scanId);
    case 'scanFailed': return quickScanFailed(msg.scanId, msg.error);
    case 'toggle': { const it = getItem(msg.id); if (it && it.status !== 'blocked') it.selected = !it.selected; return; }
    case 'select':
      for (const it of state.items) {
        if (it.status === 'blocked') continue;
        if (msg.mode === 'all') it.selected = true;
        else if (msg.mode === 'none') it.selected = false;
        else if (msg.mode === 'category' && (msg.category === 'all' || it.category === msg.category)) it.selected = true;
      }
      return;
    case 'selectDriveIds': {
      const ids = new Set(msg.ids || []);
      let n = 0;
      for (const it of state.items) if (ids.has(it.driveFileId) && it.status !== 'blocked') { it.selected = true; n++; }
      state.message = ids.size
        ? `Selected ${n} of the ${ids.size} item(s) highlighted in Drive.`
        : 'Nothing is highlighted in Drive. Click or Ctrl/Cmd-click files in Drive first.';
      return;
    }
    case 'download': return startDownloads();
    case 'stop': return stopDownloads();
    case 'retryFailed': return retryFailed();
    case 'retryItem': return retryItem(msg.id);
    case 'signIn': return signInFlow(true).catch((e) => { state.message = e.message; });
    case 'setSetting': settings = await saveSettings(msg.patch || {}); return;
    case 'openOptions': return chrome.runtime.openOptionsPage();
    case 'clearMessage': state.message = ''; return;
  }
}

async function signInFlow(fresh) {
  if (fresh) await invalidateToken();
  await getToken({ interactive: true });
  state.account = await drive.getAccountEmail().catch(() => null);
  await rememberAccount(state.account);
  if (state.phase === 'setup' || state.phase === 'auth') state.phase = state.items.length ? 'ready' : 'idle';
  state.message = state.account ? `Signed in as ${state.account}.` : '';
  changed();
}

// ---------------------------------------------------------------- folder

function setFolder(f) {
  if (!f || !f.id) return;
  if (state.folder && state.folder.id === f.id) {
    state.folder.authuser = f.authuser ?? state.folder.authuser;
    state.folder.resourceKey = f.resourceKey || state.folder.resourceKey;
    if (!state.folder.apiName && f.name) state.folder.name = f.name;
    return;
  }
  if (isBusy()) return;
  const account = state.account;
  state = freshState({ id: f.id, name: f.name || 'This folder', authuser: f.authuser || 0, resourceKey: f.resourceKey || null });
  state.account = account;
  rebuildIndex();
  byChrome.clear();
}

// ---------------------------------------------------------------- scanning

function beginScan() {
  const myScan = ++scanCounter;
  state.phase = 'scanning';
  state.message = '';
  state.items = [];
  state.batch = null;
  state.scan = { folders: 0, seen: 0 };
  rebuildIndex();
  byChrome.clear();
  changed();
  return myScan;
}

async function scan(port) {
  if (state.phase === 'downloading') { state.message = 'Stop or finish the current downloads before scanning again.'; return; }
  if (state.phase === 'scanning') return;
  if (!state.folder) { state.message = 'Open a Google Drive folder first, then click Scan folder.'; return; }
  if (useApi()) return apiScan();
  if (!port || port.name !== 'panel') { state.message = 'Open the panel on the Drive tab and click Scan folder there.'; return; }

  const myScan = beginScan();
  scanPort = port;
  port.postMessage({ type: 'quickScan', scanId: myScan, folder: state.folder, recursive: !!settings.recursive });
}

function quickScanItems(msg) {
  if (msg.scanId !== scanCounter || state.phase !== 'scanning') return;
  state.scan.folders += msg.folders || 0;
  for (const f of msg.files || []) {
    state.scan.seen++;
    addItem({ id: f.id, name: f.name, mimeType: f.mimeType, resourceKey: f.resourceKey }, msg.pathParts || []);
  }
}

function quickScanDone(scanId) {
  if (scanId !== scanCounter || state.phase !== 'scanning') return;
  scanPort = null;
  state.phase = 'ready';
  state.message = state.items.length ? '' : 'No files found in this folder.';
}

async function quickScanFailed(scanId, error) {
  if (scanId !== scanCounter || state.phase !== 'scanning') return;
  scanPort = null;
  if (settings.clientId) {
    state.phase = 'idle';
    state.message = '';
    return apiScan();
  }
  const root = state.folder?.id === 'root';
  state.phase = state.items.length ? 'ready' : 'scanError';
  state.message = root
    ? 'The top level of My Drive can\u2019t be scanned this way. Open a folder inside My Drive and scan that.'
    : `Couldn\u2019t read this folder with your browser login: ${error}`;
  changed();
}

async function apiScan() {
  const folder = state.folder;
  const myScan = beginScan();
  try {
    await getToken({ interactive: true });
    if (!state.account) { state.account = await drive.getAccountEmail().catch(() => null); await rememberAccount(state.account); }
    const meta = await drive.getFile(folder.id, 'id,name,mimeType,driveId', folder.resourceKey);
    if (meta.mimeType !== FOLDER_MIME) throw new Error('This Drive page is not a folder.');
    folder.apiName = folder.id === 'root' ? 'My Drive' : meta.name;
    folder.name = folder.apiName;
    folder.driveId = meta.driveId || null;

    const recursive = !!settings.recursive;
    const visited = new Set([meta.id]);
    const queue = [{ id: meta.id, pathParts: [], driveId: folder.driveId, resourceKey: folder.resourceKey }];
    while (queue.length) {
      const dir = queue.shift();
      let pageToken;
      do {
        if (myScan !== scanCounter) return;
        const page = await drive.listChildren(dir.id, { pageToken, driveId: dir.driveId, resourceKey: dir.resourceKey });
        for (const f of page.files || []) {
          state.scan.seen++;
          if (f.mimeType === FOLDER_MIME) {
            state.scan.folders++;
            if (recursive && !visited.has(f.id)) {
              visited.add(f.id);
              queue.push({ id: f.id, pathParts: [...dir.pathParts, f.name], driveId: f.driveId || dir.driveId, resourceKey: f.resourceKey });
            }
          } else if (f.mimeType === SHORTCUT_MIME) {
            await addShortcut(f, dir, queue, visited, recursive);
          } else addItem(f, dir.pathParts);
        }
        pageToken = page.nextPageToken;
        changed();
      } while (pageToken);
    }
    state.phase = 'ready';
    state.message = state.items.length ? '' : 'No files found in this folder.';
  } catch (e) {
    if (myScan !== scanCounter) return;
    handleScanError(e);
  }
  changed();
}

async function addShortcut(f, dir, queue, visited, recursive) {
  const t = f.shortcutDetails || {};
  if (!t.targetId) return;
  if (t.targetMimeType === FOLDER_MIME) {
    state.scan.folders++;
    if (!recursive || visited.has(t.targetId)) return;
    visited.add(t.targetId);
    let driveId = null;
    try { driveId = (await drive.getFile(t.targetId, 'id,driveId', t.targetResourceKey)).driveId || null; } catch { /* default corpus */ }
    queue.push({ id: t.targetId, pathParts: [...dir.pathParts, f.name], driveId, resourceKey: t.targetResourceKey });
    return;
  }
  try { addItem(await drive.getFile(t.targetId, drive.FILE_FIELDS, t.targetResourceKey), dir.pathParts); }
  catch { addItem({ id: t.targetId, name: f.name, mimeType: t.targetMimeType || '' }, dir.pathParts, 'This shortcut points to a file you cannot access.'); }
}

function addItem(f, pathParts, forcedError) {
  const mime = f.mimeType || '';
  const ws = WORKSPACE_TYPES[mime];
  const size = Number(f.size) || 0;
  const it = {
    id: 'i' + (++seq), driveFileId: f.id, resourceKey: f.resourceKey || null,
    name: f.name || 'untitled', pathParts: pathParts || [], mimeType: mime,
    size, driveSize: size, category: ws ? ws.category : categorize(f.name, mime), workspace: !!ws,
    selected: false, status: 'idle', error: '', attempts: 0,
    engine: null, chromeDownloadId: null, gid: null, resumeId: null, received: 0, targetName: null
  };
  if (forcedError) { it.status = 'blocked'; it.error = forcedError; }
  else if (f.capabilities && f.capabilities.canDownload === false) { it.status = 'blocked'; it.error = BLOCKED_MSG; }
  else if (!ws && mime.startsWith('application/vnd.google-apps.') && mime !== SHORTCUT_MIME) {
    it.status = 'blocked'; it.error = 'This kind of Google file (Form, Site, Map\u2026) cannot be downloaded or exported.';
  }
  state.items.push(it);
  index.set(it.id, it);
}

function handleScanError(e) {
  const keep = state.items.length > 0;
  if (e instanceof SetupError) { state.phase = 'setup'; state.message = e.message; return; }
  if (e instanceof AuthError) { state.phase = 'auth'; state.message = e.message; return; }
  let msg;
  if (e instanceof drive.DriveError && e.status === 404) {
    msg = `Google Drive can't find this folder${state.account ? ` for ${state.account}` : ''}. Make sure the extension is signed in with the same Google account as this Drive tab.`;
  } else if (e instanceof drive.DriveError && e.status === 403) {
    msg = `Google Drive refused to list this folder${e.message ? `: ${e.message}` : '.'}`;
  } else msg = `Scan failed: ${e?.message || e}`;
  state.phase = keep ? 'ready' : 'scanError';
  state.message = keep ? `Scan stopped early. ${msg}` : msg;
}

// ---------------------------------------------------------------- download queue

function newBatch(items) {
  return {
    ids: items.map((i) => i.id), startedAt: Date.now(), finishedAt: null, zipCreated: 0,
    speed: 0, eta: null, bytesDone: 0, bytesTotal: items.reduce((a, i) => a + (i.size || 0), 0),
    used: {}, managerName: null
  };
}

function resetForQueue(it, keepName = false) {
  it.status = 'queued'; it.attempts = 0; it.error = ''; it.received = 0;
  it.chromeDownloadId = null; it.gid = null; it.resumeId = null; it.engine = null;
  if (!keepName) it.targetName = null;
}

async function startDownloads() {
  if (isBusy()) return;
  const sel = state.items.filter((i) => i.selected && i.status !== 'blocked');
  if (!sel.length) { state.message = state.items.length ? 'Select at least one file first.' : 'Click Scan folder first.'; return; }

  if (useApi()) { try { await getToken({ interactive: true }); } catch (e) { handleScanError(e); return; } }
  let todo = sel.filter((i) => i.status !== 'done');
  const skipped = sel.length - todo.length;
  if (!todo.length) todo = sel;
  todo.forEach((i) => resetForQueue(i));
  state.batch = newBatch(todo);
  await refreshManager();
  state.phase = 'downloading';
  state.message = skipped && todo.length !== sel.length ? `${skipped} file(s) already saved earlier were skipped.` : '';
  pump();
  startPolling();
}

function pump() {
  if (state.phase !== 'downloading' || !state.batch) return;
  const limit = Math.max(1, Math.min(5, Number(settings.concurrency) || 3));
  const items = batchItems();
  let active = items.filter((i) => ACTIVE.has(i.status)).length;
  for (const it of items) {
    if (active >= limit) break;
    if (it.status === 'queued') { active++; startItem(it); }
  }
  checkFinished();
}

/** Works out the exact URL, name and size for one file, and checks Google will allow it. */
async function resolve(it) {
  const ws = it.workspace ? WORKSPACE_TYPES[it.mimeType] : null;
  let fmt = null;
  if (ws) { const pref = settings[ws.settingKey]; fmt = ws.formats[pref] ? pref : ws.defaultFormat; }
  const withExt = (n) => (ws && !n.toLowerCase().endsWith('.' + fmt) ? `${n}.${fmt}` : n);

  // Every mode downloads through Google's plain per-file link with the browser's own login,
  // so download-manager extensions can take it over. (Advanced mode is only used for scanning.)
  const authuser = state.folder?.authuser || 0;
  const url = ws ? session.docsExportUrl(it.mimeType, it.driveFileId, fmt, authuser)
                 : session.fileUrl(it.driveFileId, authuser, it.resourceKey);
  const p = await session.probeSession(url);
  return { url: p.url, finalUrl: p.finalUrl, headers: [], name: withExt(p.name || it.name), size: p.size };
}

/** Exact original name; only numbered if two files in THIS download would collide. */
function reserveName(it, name) {
  if (it.targetName) return it.targetName;
  const dirKey = folderParts({ rootName: state.folder?.name, pathParts: it.pathParts, preserve: settings.preserveFolders, includeRoot: settings.includeRootFolder }).join('/');
  const used = state.batch.used;
  let candidate = sanitizeSegment(name);
  for (let n = 2; used[`${dirKey}/${candidate}`.toLowerCase()]; n++) candidate = numbered(sanitizeSegment(name), n);
  used[`${dirKey}/${candidate}`.toLowerCase()] = true;
  it.targetName = candidate;
  return candidate;
}

async function startItem(it) {
  it.status = 'starting';
  it.attempts++;
  changed();

  if (it.resumeId != null) {
    const rid = it.resumeId;
    it.resumeId = null;
    try {
      byChrome.set(rid, it.id);
      it.chromeDownloadId = rid; it.engine = 'chrome'; it.status = 'downloading';
      await chrome.downloads.resume(rid);
      changed();
      return;
    } catch {
      byChrome.delete(rid);
      chrome.downloads.cancel(rid).catch(() => {});
      it.status = 'starting';
    }
  }

  let r;
  try { r = await resolve(it); } catch (e) { return onFailure(it, { kind: 'resolve', error: e }); }
  if (it.status !== 'starting') return;
  if (r.size) { it.size = r.size; if (!it.driveSize) it.driveSize = r.size; }
  const name = reserveName(it, r.name);
  const parts = folderParts({ rootName: state.folder?.name, pathParts: it.pathParts, preserve: settings.preserveFolders, includeRoot: settings.includeRootFolder });

  if (manager?.name === 'Motrix' && await startMotrix(it, r, parts, name)) return;
  try { await startChrome(it, r, parts, name); } catch (e) { onFailure(it, { kind: 'start', error: e }); }
}

/**
 * Motrix's own browser extension keeps only the file name, so every file would land loose in its
 * download folder. Instead, hand the file to Motrix ourselves (through the Snap helper) with the
 * folder path and the browser's Google login, so "Keep folders" works there too.
 * Returns false when the helper isn't available, and the normal Chrome hand-off is used instead.
 */
async function startMotrix(it, r, parts, name) {
  const fallback = (why) => {
    state.message = `Motrix will get these files without folders: ${why}`;
    changed();
    return false;
  };
  if (!chrome.cookies) return fallback('reload Snap in chrome://extensions to finish the update.');
  let cookies = [];
  try { cookies = await chrome.cookies.getAll({ url: r.url }); } catch (e) { return fallback(String(e?.message || e)); }
  if (!cookies.length) return fallback('no Google login found in this browser.');
  const headers = {
    Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    'User-Agent': navigator.userAgent
  };
  const res = await sendToHost({
    action: 'add', url: r.url, out: name, subdir: parts, headers, overwrite: settings.ifExists !== 'rename'
  });
  if (!res.ok) return fallback(res.error.split('\n')[0]);
  if (it.status !== 'starting') return true;
  it.engine = 'motrix'; it.gid = res.gid; it.startedAt = Date.now();
  markHandedOff(it);
  return true;
}

async function startChrome(it, r, parts, name) {
  const req = {
    url: r.url,
    filename: [...parts, name].join('/'),
    conflictAction: settings.ifExists === 'rename' ? 'uniquify' : 'overwrite',
    saveAs: false
  };
  if (r.headers.length) req.headers = r.headers;
  const id = await chrome.downloads.download(req);
  if (it.status !== 'starting') { chrome.downloads.cancel(id).catch(() => {}); return; }
  it.engine = 'chrome'; it.chromeDownloadId = id; it.status = 'downloading'; it.startedAt = Date.now();
  byChrome.set(id, it.id);
  changed();
  const [d] = await chrome.downloads.search({ id });
  if (d && d.state === 'complete') onChromeComplete(it, d);
  else if (d && d.state === 'interrupted') onChromeInterrupted(it, d);
}

// --- Chrome engine events

chrome.downloads.onCreated.addListener(async (d) => {
  await ready;
  const it = getItem(byChrome.get(d.id));
  if (it && d.totalBytes > 0 && !it.size) { it.size = d.totalBytes; changed(); }
});

chrome.downloads.onChanged.addListener(async (delta) => {
  await ready;
  const it = getItem(byChrome.get(delta.id));
  if (!it) return;
  if (delta.totalBytes && delta.totalBytes.current > 0 && !it.size) it.size = delta.totalBytes.current;
  if (delta.state) {
    const [d] = await chrome.downloads.search({ id: delta.id });
    if (delta.state.current === 'complete') onChromeComplete(it, d || {});
    else if (delta.state.current === 'interrupted') onChromeInterrupted(it, d || { id: delta.id, error: delta.error?.current });
  }
  changed();
});

function finishItem(it, got, savedName) {
  if (!it.workspace && it.driveSize > 0 && got > 0 && got < it.driveSize) return false;
  it.status = 'done'; it.error = '';
  it.received = got || it.size;
  if (!it.size) it.size = it.received;
  if (state.batch && isZipLike(savedName, '') && !isZipLike(it.name, it.mimeType)) state.batch.zipCreated++;
  pump();
  changed();
  return true;
}

function onChromeComplete(it, d) {
  if (it.status !== 'downloading') return;
  byChrome.delete(it.chromeDownloadId);
  const got = d.totalBytes > 0 ? d.totalBytes : (d.bytesReceived || 0);
  if (!finishItem(it, got, d.filename || it.targetName)) {
    chrome.downloads.removeFile(d.id).catch(() => {});
    onFailure(it, { kind: 'short' });
  }
}

/**
 * Download-manager extensions take a download over by cancelling (and often erasing) Chrome's
 * copy straight after it starts. That looks like a very early "cancel" with almost no bytes.
 */
function looksHandedOff(it, d) {
  const age = Date.now() - (it.startedAt || 0);
  const bytes = d?.bytesReceived || 0;
  if (manager) return age < 20000 && bytes < 4 * 1024 * 1024;
  return age < 3000 && bytes === 0; // nobody cancels that fast by hand
}

function markHandedOff(it) {
  byChrome.delete(it.chromeDownloadId);
  it.status = 'handedOff';
  it.error = '';
  it.handedTo = manager?.name || 'your download manager';
  if (state.batch) {
    state.batch.managerName = it.handedTo;
    if (isZipLike(it.targetName, '') && !isZipLike(it.name, it.mimeType)) state.batch.zipCreated++;
  }
  // Small gap between hand-offs so the download manager isn't flooded with dialogs.
  setTimeout(() => { pump(); changed(); }, 700);
  changed();
}

chrome.downloads.onErased.addListener(async (id) => {
  await ready;
  const it = getItem(byChrome.get(id));
  if (it && it.status === 'downloading') markHandedOff(it);
});

function onChromeInterrupted(it, d) {
  if (it.status !== 'downloading') return;
  if (d.error === 'USER_CANCELED' && looksHandedOff(it, d)) { markHandedOff(it); return; }
  byChrome.delete(it.chromeDownloadId);
  onFailure(it, { kind: 'interrupted', reason: d.error || 'UNKNOWN', canResume: !!d.canResume, downloadId: d.id });
}

// --- failures and retries

async function onFailure(it, info) {
  if (state.phase !== 'downloading' || !PENDING.has(it.status)) return;
  const v = await classify(it, info);
  if (state.phase !== 'downloading' || !PENDING.has(it.status)) return;

  if (v.transient && it.attempts <= MAX_RETRIES) {
    const delay = BACKOFF_MS[Math.min(it.attempts - 1, BACKOFF_MS.length - 1)];
    it.status = 'retrying';
    it.error = `${v.message}. Retrying in ${Math.round(delay / 1000)}s (attempt ${it.attempts + 1} of ${MAX_RETRIES + 1}).`;
    it.resumeId = v.resumable && info.canResume ? info.downloadId : null;
    if (it.resumeId == null && info.downloadId != null) chrome.downloads.cancel(info.downloadId).catch(() => {});
    it.gid = null;
    setTimeout(() => {
      if (it.status === 'retrying' && state.phase === 'downloading') { it.status = 'queued'; pump(); changed(); }
    }, delay);
  } else {
    it.status = v.blocked ? 'blocked' : 'failed';
    it.error = v.message;
    it.resumeId = null; it.gid = null;
    if (info.downloadId != null) chrome.downloads.cancel(info.downloadId).catch(() => {});
  }
  pump();
  changed();
}

const FILE_ERRORS = {
  FILE_NO_SPACE: 'Not enough disk space',
  FILE_NAME_TOO_LONG: 'File name or folder path is too long for your computer',
  FILE_ACCESS_DENIED: 'Chrome could not write to your Downloads folder',
  FILE_TOO_LARGE: 'File is too large for the destination disk (FAT32 drives are limited to 4 GB)',
  FILE_VIRUS_INFECTED: 'Blocked by your antivirus',
  FILE_BLOCKED: 'Blocked by Chrome or your organisation\u2019s policy',
  FILE_SECURITY_CHECK_FAILED: 'Blocked by a security check'
};

function fromError(e) {
  if (e instanceof FinalError) return { transient: false, blocked: e.blocked, message: e.message };
  if (e instanceof TransientError) return { transient: true, message: e.message };
  if (e instanceof SetupError || e instanceof AuthError) return { transient: false, message: e.message };
  return { transient: true, message: `Could not start the download (${e?.message || e})` };
}

/** Re-checks a file with Google after a server-side failure, to get the real reason. */
async function recheck(it, fallbackMsg) {
  try { await resolve(it); return { transient: true, message: fallbackMsg }; }
  catch (e) { return fromError(e); }
}

async function classify(it, info) {
  if (info.kind === 'resolve' || info.kind === 'start') return fromError(info.error);
  if (info.kind === 'short') return { transient: true, message: 'The saved file was smaller than the original' };
  const r = info.reason || 'UNKNOWN';
  if (r === 'USER_CANCELED') return { transient: false, message: 'Cancelled' };
  if (r === 'USER_SHUTDOWN' || r === 'CRASH') return { transient: true, resumable: true, message: 'Chrome was interrupted' };
  if (r.startsWith('NETWORK_')) return { transient: true, resumable: true, message: 'Network interruption' };
  if (FILE_ERRORS[r]) return { transient: false, message: FILE_ERRORS[r] };
  if (r.startsWith('FILE_')) return { transient: true, message: 'Temporary disk error' };
  if (r === 'SERVER_UNAUTHORIZED' && useApi()) { await invalidateToken(); return { transient: true, message: 'Google sign-in expired' }; }
  return recheck(it, `Download failed (${r})`);
}

function checkFinished() {
  if (state.phase !== 'downloading' || !state.batch) return;
  const items = batchItems();
  if (items.some((i) => PENDING.has(i.status))) return;
  stopPolling();
  state.batch.finishedAt = Date.now();
  state.batch.speed = 0;
  state.batch.eta = 0;
  const bad = items.filter((i) => i.status === 'failed' || i.status === 'blocked').length;
  state.phase = bad ? 'error' : 'done';
  changed();
}

async function stopDownloads() {
  if (state.phase !== 'downloading') return;
  for (const it of batchItems()) {
    if (it.status === 'downloading' || it.status === 'starting') {
      if (it.chromeDownloadId != null && it.engine === 'chrome') { byChrome.delete(it.chromeDownloadId); chrome.downloads.cancel(it.chromeDownloadId).catch(() => {}); }
      it.status = 'idle'; it.error = 'Stopped'; it.gid = null;
    } else if (it.status === 'queued' || it.status === 'retrying') {
      if (it.resumeId != null) chrome.downloads.cancel(it.resumeId).catch(() => {});
      it.status = 'idle'; it.error = ''; it.resumeId = null;
    }
  }
  stopPolling();
  state.phase = 'ready';
  state.message = 'Downloads stopped. Files that were already saved are kept.';
}

async function retryFailed() {
  if (isBusy()) return;
  const failed = state.items.filter((i) => i.status === 'failed');
  if (!failed.length) { state.message = 'There are no failed files to retry.'; return; }
  if (!state.batch) state.batch = newBatch([]);
  await refreshManager();
  failed.forEach((i) => resetForQueue(i, true));
  for (const it of failed) if (!state.batch.ids.includes(it.id)) state.batch.ids.push(it.id);
  state.batch.finishedAt = null;
  state.phase = 'downloading';
  state.message = '';
  pump();
  startPolling();
}

async function retryItem(id) {
  const it = getItem(id);
  if (!it || it.status !== 'failed' || state.phase === 'scanning') return;
  if (!state.batch) state.batch = newBatch([]);
  resetForQueue(it, true);
  if (!state.batch.ids.includes(it.id)) state.batch.ids.push(it.id);
  if (state.phase !== 'downloading') { state.batch.finishedAt = null; state.phase = 'downloading'; startPolling(); }
  pump();
}

// ---------------------------------------------------------------- progress (real numbers only)

function startPolling() {
  if (pollTimer) return;
  lastPoll = null;
  pollTimer = setInterval(poll, 1000);
  poll();
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

let polling = false;
async function poll() {
  if (state.phase !== 'downloading' || !state.batch) { stopPolling(); return; }
  if (polling) return;
  polling = true;
  try {
    // Calling a Chrome API every second also keeps this background worker awake.
    const running = await chrome.downloads.search({ state: 'in_progress' });
    const live = new Map(running.map((d) => [d.id, d]));
    const items = batchItems();
    for (const it of items) {
      if (it.status !== 'downloading') continue;
      if (it.engine === 'chrome') {
        const d = live.get(it.chromeDownloadId);
        if (d) { it.received = d.bytesReceived; if (d.totalBytes > 0 && !it.size) it.size = d.totalBytes; }
      }
    }
    let received = 0, total = 0, remaining = 0;
    for (const it of items) {
      if (it.status !== 'handedOff') total += it.size || 0;
      if (it.status === 'handedOff') continue;
      if (it.status === 'done') received += it.size || it.received;
      else if (it.status === 'downloading') received += it.received;
      if (PENDING.has(it.status)) remaining += Math.max(0, (it.size || 0) - (it.status === 'downloading' ? it.received : 0));
    }
    const b = state.batch;
    if (!b) return;
    const now = Date.now();
    if (lastPoll) {
      const inst = Math.max(0, received - lastPoll.b) / Math.max((now - lastPoll.t) / 1000, 0.001);
      b.speed = b.speed ? b.speed * 0.7 + inst * 0.3 : inst;
    }
    lastPoll = { t: now, b: received };
    b.bytesDone = received;
    b.bytesTotal = total;
    b.eta = b.speed > 1 ? Math.round(remaining / b.speed) : null;
    changed();
  } finally { polling = false; }
}
