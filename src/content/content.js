// Snap by Motion Sync Studio — content script.
// Detects the current Drive folder and shows a floating panel in an isolated Shadow DOM.
// It never clicks Drive's own buttons and never touches Drive's page styles.

(() => {
  if (window.__noZipDownloader) return;
  window.__noZipDownloader = true;

  const APP_NAME = 'Snap by Motion Sync Studio';
  const VERSION = chrome.runtime.getManifest().version;
  const PANEL_W = 344;
  const CAT_LABEL = { video: 'Videos', image: 'Images', audio: 'Audio', document: 'Documents', other: 'Other' };
  const CAT_WORD = { video: ['video', 'videos'], image: ['image', 'images'], audio: ['audio file', 'audio files'], document: ['document', 'documents'], other: ['other', 'other'] };

  let state = null;
  let port = null;
  let dead = false;
  let currentFolder = null;
  let filter = 'all';
  let showList = true;
  let minimized = false;
  let pos = null;
  let ui = null;

  // ------------------------------------------------------------ folder detection

  function detectFolder() {
    const m = location.pathname.match(/^\/drive(?:\/u\/(\d+))?\/(?:folders\/([A-Za-z0-9_-]+)|(my-drive))/);
    if (!m) return null;
    const id = m[2] || 'root';
    let name = document.title.replace(/\s*[-\u2013]\s*Google Drive\s*$/i, '').trim();
    if (id === 'root') name = 'My Drive';
    return {
      id,
      name: name || 'This folder',
      authuser: Number(m[1] || 0),
      resourceKey: new URLSearchParams(location.search).get('resourcekey') || null
    };
  }

  // Items the user has highlighted in Drive's own list (secondary feature).
  function driveSelectedIds() {
    const ids = new Set();
    document.querySelectorAll('[aria-selected="true"][data-id]').forEach((el) => {
      const id = el.getAttribute('data-id');
      if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) ids.add(id);
    });
    return [...ids];
  }

  // ------------------------------------------------------------ messaging

  function connect() {
    if (dead) return;
    try { port = chrome.runtime.connect({ name: 'panel' }); } catch { dead = true; return; }
    port.onMessage.addListener((m) => {
      if (m?.type === 'state') { state = m.state; scheduleRender(); }
      else if (m?.type === 'quickScan') quickScan(m);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (!chrome.runtime?.id) { dead = true; ui?.host.remove(); return; } // extension was reloaded/removed
      setTimeout(connect, 1000);
    });
    port.postMessage({ cmd: 'setFolder', folder: detectFolder() });
  }

  function send(msg) {
    if (dead) return;
    if (!port) connect();
    try { port?.postMessage(msg); } catch {
      port = null;
      setTimeout(() => { connect(); try { port?.postMessage(msg); } catch { /* give up */ } }, 300);
    }
  }

  let lastKey = '';
  function checkLocation(force) {
    const f = detectFolder();
    const key = f ? `${f.id}|${f.name}` : 'none';
    if (force || key !== lastKey) {
      lastKey = key;
      currentFolder = f;
      if (f) send({ cmd: 'setFolder', folder: f });
      scheduleRender();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.cmd === 'getFolder') { sendResponse(detectFolder()); return; }
    if (msg?.cmd === 'startScan') { minimized = false; savePos(); scheduleRender(); send({ cmd: 'scan', folder: detectFolder() }); sendResponse({ ok: true }); return; }
    if (msg?.cmd === 'showPanel') { minimized = false; savePos(); scheduleRender(); sendResponse({ ok: true }); }
  });

  // ------------------------------------------------------------ no-setup folder scan
  // Reads Drive's own lightweight folder view (drive.google.com/embeddedfolderview) with the
  // login already in this tab. Same page origin, same permissions as you have in Drive.

  let activeScan = 0;
  const DOC_HREF = [
    [/docs\.google\.com\/document\/d\/([\w-]+)/, 'application/vnd.google-apps.document'],
    [/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/, 'application/vnd.google-apps.spreadsheet'],
    [/docs\.google\.com\/presentation\/d\/([\w-]+)/, 'application/vnd.google-apps.presentation'],
    [/docs\.google\.com\/drawings\/d\/([\w-]+)/, 'application/vnd.google-apps.drawing']
  ];

  async function fetchFolder(id, resourceKey, authuser) {
    const u = new URL('/embeddedfolderview', location.origin);
    u.searchParams.set('id', id);
    if (resourceKey) u.searchParams.set('resourcekey', resourceKey);
    if (authuser) u.searchParams.set('authuser', String(authuser));
    let res;
    try { res = await fetch(u, { credentials: 'include' }); }
    catch { throw new Error('network error while reading the folder'); }
    if (res.status === 404) throw new Error('Google says this folder doesn\u2019t exist, or this account can\u2019t open it.');
    if (!res.ok) throw new Error(`Google answered HTTP ${res.status} for the folder listing.`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const entries = [...doc.querySelectorAll('.flip-entry')];
    if (!entries.length) {
      if (/flip-entries|folder-view|flip-empty/i.test(html)) return [];
      throw new Error('Google didn\u2019t return a folder listing (you may need to request access).');
    }
    const out = [];
    for (const el of entries) {
      const a = el.querySelector('a[href]');
      const href = a ? a.getAttribute('href') : '';
      const icon = (el.querySelector('img') || {}).src || '';
      const name = (el.querySelector('.flip-entry-title')?.textContent || '').trim();
      let entryId = (el.id || '').replace(/^entry-/, '');
      let mime = '';
      const m = /\/type\/([^?#]+)/.exec(icon);
      if (m) { try { mime = decodeURIComponent(m[1]); } catch { mime = m[1]; } }
      let isFolder = mime === 'application/vnd.google-apps.folder';
      // Prefer the id in the link: for shortcuts it points at the real target.
      let hm = /\/folders\/([\w-]+)/.exec(href);
      if (hm) { entryId = hm[1]; isFolder = true; }
      else if ((hm = /\/file\/d\/([\w-]+)/.exec(href))) entryId = hm[1];
      else for (const [re, wsMime] of DOC_HREF) { const d = re.exec(href); if (d) { entryId = d[1]; mime = wsMime; break; } }
      let rk = null;
      try { rk = href ? new URL(href, location.origin).searchParams.get('resourcekey') : null; } catch { /* ignore */ }
      if (mime === 'application/vnd.google-apps.shortcut') mime = '';
      if (entryId && name) out.push({ id: entryId, name, mimeType: mime, isFolder, resourceKey: rk });
    }
    return out;
  }

  async function quickScan({ scanId, folder, recursive }) {
    activeScan = scanId;
    const queue = [{ id: folder.id, rk: folder.resourceKey, pathParts: [] }];
    const seen = new Set([folder.id]);
    try {
      while (queue.length) {
        if (activeScan !== scanId) return;
        const dir = queue.shift();
        const list = await fetchFolder(dir.id, dir.rk, folder.authuser);
        const files = [];
        let folders = 0;
        for (const e of list) {
          if (e.isFolder) {
            folders++;
            if (recursive && !seen.has(e.id)) { seen.add(e.id); queue.push({ id: e.id, rk: e.resourceKey, pathParts: [...dir.pathParts, e.name] }); }
          } else files.push({ id: e.id, name: e.name, mimeType: e.mimeType, resourceKey: e.resourceKey });
        }
        send({ cmd: 'scanItems', scanId, pathParts: dir.pathParts, files, folders });
      }
      send({ cmd: 'scanDone', scanId });
    } catch (e) {
      send({ cmd: 'scanFailed', scanId, error: String(e?.message || e) });
    }
  }

  // ------------------------------------------------------------ formatting helpers

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function fmtBytes(n) {
    if (!n || n < 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  }
  function fmtTime(sec) {
    if (sec == null || !isFinite(sec)) return '--:--';
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  const extUpper = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || ''); return m ? m[1].toUpperCase() : ''; };

  // ------------------------------------------------------------ styles

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap { font: 13px/1.4 "Google Sans Text", "Google Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #e9ebf1; -webkit-font-smoothing: antialiased; }
  .panel { width: ${PANEL_W}px; background: #151820; border: 1px solid rgba(255,255,255,.08); border-radius: 12px;
    box-shadow: 0 14px 36px rgba(0,0,0,.42), 0 2px 6px rgba(0,0,0,.28); overflow: hidden; }
  .hdr { display: flex; align-items: center; gap: 9px; padding: 9px 8px 9px 12px; background: #111318;
    border-bottom: 1px solid rgba(255,255,255,.06); cursor: grab; user-select: none; touch-action: none; }
  .hdr.drag { cursor: grabbing; }
  .logo { width: 22px; height: 22px; flex: none; border-radius: 6px; background: linear-gradient(135deg,#7B6BFF,#5236F0 60%,#C13BE8); display: grid; place-items: center; }
  .title { flex: 1; min-width: 0; font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .by { color: #aab0c0; font-weight: 500; }
  .ver { color: #7d8396; font-weight: 500; font-size: 11px; margin-left: 4px; }
  .icon { border: 0; background: transparent; color: #8a90a2; width: 26px; height: 26px; border-radius: 6px; cursor: pointer;
    font: 600 14px/1 system-ui, sans-serif; display: grid; place-items: center; }
  .icon:hover { background: rgba(255,255,255,.07); color: #fff; }
  .body { padding: 14px 14px 12px; }
  .status { display: flex; align-items: center; gap: 7px; font-size: 10.5px; font-weight: 700; letter-spacing: .09em;
    text-transform: uppercase; color: #8a90a2; }
  .status i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .status[data-tone=busy] { color: #6b97ff; }
  .status[data-tone=busy] i { animation: pulse 1.1s ease-in-out infinite; }
  .status[data-tone=ok] { color: #3ecf8e; }
  .status[data-tone=bad] { color: #ff6b6b; }
  .status[data-tone=warn] { color: #f5b841; }
  @keyframes pulse { 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { .status i { animation: none !important; } .bar i { transition: none !important; } }
  .headline { font-size: 21px; font-weight: 650; letter-spacing: -.015em; margin-top: 5px; line-height: 1.2; }
  .sub { color: #8a90a2; font-size: 12px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .breakdown { color: #6f7588; font-size: 11.5px; margin-top: 2px; }
  .notice { margin-top: 10px; padding: 8px 10px; border-radius: 8px; font-size: 12px; color: #c9cdd8;
    background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07); }
  .notice.bad { background: rgba(255,107,107,.08); border-color: rgba(255,107,107,.25); color: #ffc2c2; }
  .notice.warn { background: rgba(245,184,65,.08); border-color: rgba(245,184,65,.25); color: #f7d899; }
  .notice + .notice { margin-top: 6px; }
  .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .tab { flex: 1 1 calc(50% - 3px); padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.08);
    background: #1b1f29; color: #c9cdd8; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
  .tab:hover { border-color: rgba(255,255,255,.16); }
  .tab.on { background: rgba(106,92,246,.15); border-color: rgba(107,151,255,.6); color: #fff; }
  .selrow { display: flex; justify-content: space-between; gap: 8px; margin-top: 12px; font-size: 12px; color: #d4d7e0; }
  .kind { color: #7d8396; }
  .bar { height: 4px; background: rgba(255,255,255,.07); border-radius: 4px; overflow: hidden; margin-top: 8px; }
  .bar i { display: block; height: 100%; width: 0; background: #6a5cf6; border-radius: 4px; transition: width .5s ease; }
  .bar.ok i { background: #3ecf8e; }
  .bar.bad i { background: #f5b841; }
  .stats { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; color: #7d8396; font-size: 11px; margin-top: 7px; }
  .stats b { color: #c9cdd8; font-weight: 500; }
  .stats .cur { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tools { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-top: 12px; font-size: 11.5px; }
  .tools .sp { flex: 1; }
  .link { background: none; border: 0; padding: 0; color: #a99cff; cursor: pointer; font: inherit; }
  .link:hover { text-decoration: underline; }
  .list { margin-top: 8px; max-height: 232px; overflow: auto; border: 1px solid rgba(255,255,255,.06); border-radius: 8px;
    background: #111318; overscroll-behavior: contain; }
  .list::-webkit-scrollbar { width: 8px; } .list::-webkit-scrollbar-thumb { background: #2a2f3b; border-radius: 8px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border-bottom: 1px solid rgba(255,255,255,.04); cursor: pointer; }
  .row:last-child { border-bottom: 0; }
  .row:hover { background: rgba(255,255,255,.03); }
  .row.off { cursor: default; opacity: .6; }
  .row input { accent-color: #6a5cf6; margin: 0; flex: none; }
  .nm { flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nm small { color: #646a7d; font-size: 11px; }
  .meta { flex: none; font-size: 11px; color: #7d8396; display: flex; align-items: center; gap: 6px; }
  .chip { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: rgba(255,255,255,.06); color: #aab0c0; }
  .chip.busy { background: rgba(106,92,246,.15); color: #9dbaff; }
  .chip.ok { background: rgba(62,207,142,.12); color: #5fdca3; }
  .chip.bad { background: rgba(255,107,107,.12); color: #ff8f8f; }
  .chip.warn { background: rgba(245,184,65,.12); color: #f5c564; }
  .mini { border: 1px solid rgba(255,255,255,.12); background: #1f2430; color: #e9ebf1; border-radius: 6px; padding: 2px 7px;
    font: inherit; font-size: 10.5px; cursor: pointer; }
  .more { padding: 8px; text-align: center; color: #6f7588; font-size: 11px; }
  .actions { display: flex; gap: 8px; margin-top: 14px; }
  .btn { flex: 1; height: 36px; border-radius: 9px; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
  .btn.secondary { background: #1f2430; border-color: rgba(255,255,255,.09); color: #e9ebf1; }
  .btn.secondary:hover:not(:disabled) { background: #262c3a; }
  .btn.primary { background: #6a5cf6; color: #fff; }
  .btn.primary:hover:not(:disabled) { background: #7c6dfa; }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn:focus-visible, .tab:focus-visible, .link:focus-visible, .icon:focus-visible, .mini:focus-visible, select:focus-visible, .pill:focus-visible {
    outline: 2px solid #a99cff; outline-offset: 2px; }
  .footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.06);
    font-size: 11.5px; color: #7d8396; }
  .footer label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .footer .sp { flex: 1; }
  .via { flex-basis: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .via b { color: #c9cdd8; font-weight: 600; }
  .footer input { accent-color: #6a5cf6; margin: 0; }
  select { background: #1b1f29; color: #e9ebf1; border: 1px solid rgba(255,255,255,.1); border-radius: 6px; font: inherit; font-size: 11.5px; padding: 2px 4px; }
  .pill { display: flex; align-items: center; gap: 8px; padding: 5px 12px 5px 5px; background: #151820; border: 1px solid rgba(255,255,255,.1);
    border-radius: 999px; box-shadow: 0 8px 24px rgba(0,0,0,.4); cursor: pointer; color: #e9ebf1; font: inherit; font-size: 12px; font-weight: 600;
    user-select: none; touch-action: none; }
  .pill .logo { width: 24px; height: 24px; border-radius: 50%; }
  .pill small { color: #8a90a2; font-weight: 500; }
  `;

  const LOGO = `<svg width="14" height="14" viewBox="0 0 32 32" fill="#fff" aria-hidden="true"><path d="M18.6 4.2 10.4 15.6a.9.9 0 0 0 .73 1.42h3.8l-1.7 6.8c-.17.68.7 1.1 1.12.53l8.1-11.2a.9.9 0 0 0-.73-1.42h-3.7l1.85-7.07c.17-.68-.72-1.08-1.2-.5Z"/><path d="M6.8 20.4a1.6 1.6 0 0 1 1.6 1.6v2h15.2v-2a1.6 1.6 0 0 1 3.2 0v2.6a2.6 2.6 0 0 1-2.6 2.6H8a2.6 2.6 0 0 1-2.6-2.6V22a1.6 1.6 0 0 1 1.4-1.6Z"/></svg>`;

  // ------------------------------------------------------------ mount

  function mount() {
    const host = document.createElement('div');
    host.id = 'nozip-downloader-root';
    host.style.cssText = 'position:fixed;z-index:99999;top:72px;left:0;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <button class="pill" data-act="expand" title="Open ${APP_NAME}"><span class="logo">${LOGO}</span><span class="pl"></span></button>
        <section class="panel" role="dialog" aria-label="${APP_NAME}">
          <header class="hdr">
            <span class="logo">${LOGO}</span>
            <span class="title">Snap<span class="by"> by Motion Sync Studio</span><span class="ver">v${VERSION}</span></span>
            <button class="icon" data-act="minimize" title="Minimize" aria-label="Minimize">&#8212;</button>
          </header>
          <div class="body">
            <div class="status"><i></i><span></span></div>
            <div class="headline"></div>
            <div class="sub"></div>
            <div class="breakdown"></div>
            <div class="notices"></div>
            <div class="tabs"></div>
            <div class="selrow"></div>
            <div class="progress"></div>
            <div class="tools"></div>
            <div class="list"></div>
            <div class="actions"></div>
            <div class="footer"></div>
          </div>
        </section>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    ui = {
      host, root,
      pill: $('.pill'), pillLabel: $('.pl'), panel: $('.panel'), hdr: $('.hdr'),
      status: $('.status'), statusText: $('.status span'), headline: $('.headline'), sub: $('.sub'),
      breakdown: $('.breakdown'), notices: $('.notices'), tabs: $('.tabs'), selrow: $('.selrow'),
      progress: $('.progress'), tools: $('.tools'), list: $('.list'), actions: $('.actions'), footer: $('.footer')
    };
    document.documentElement.appendChild(host);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    makeDraggable(ui.hdr);
    makeDraggable(ui.pill);
    window.addEventListener('resize', () => applyPos());
  }

  // ------------------------------------------------------------ position / drag

  async function loadPos() {
    try {
      const { panelPos } = await chrome.storage.local.get('panelPos');
      if (panelPos) { pos = { left: panelPos.left, top: panelPos.top }; minimized = !!panelPos.minimized; }
    } catch { /* ignore */ }
  }
  function savePos() {
    try { chrome.storage.local.set({ panelPos: { ...(pos || {}), minimized } }); } catch { /* extension reloaded */ }
  }
  function applyPos() {
    if (!ui) return;
    const w = minimized ? (ui.pill.offsetWidth || 160) : PANEL_W;
    let left = pos?.left ?? (window.innerWidth - PANEL_W - 24);
    let top = pos?.top ?? 72;
    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - w - 8));
    top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - 48));
    ui.host.style.left = `${left}px`;
    ui.host.style.top = `${top}px`;
  }
  let suppressClick = false;
  function makeDraggable(handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (handle === ui.hdr && e.target.closest('button')) return;
      const r = ui.host.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const sx = e.clientX, sy = e.clientY;
      let moved = false;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        moved = true;
        ui.hdr.classList.add('drag');
        pos = { left: ev.clientX - dx, top: ev.clientY - dy };
        applyPos();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        ui.hdr.classList.remove('drag');
        if (moved) { suppressClick = true; setTimeout(() => (suppressClick = false), 0); savePos(); }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // ------------------------------------------------------------ events

  function onClick(e) {
    if (suppressClick) { e.preventDefault(); return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    switch (act) {
      case 'expand': minimized = false; savePos(); render(); applyPos(); return;
      case 'minimize': minimized = true; savePos(); render(); applyPos(); return;
      case 'scan': send({ cmd: 'scan', folder: detectFolder() }); return;
      case 'download': send({ cmd: 'download' }); return;
      case 'stop': send({ cmd: 'stop' }); return;
      case 'retryFailed': send({ cmd: 'retryFailed' }); return;
      case 'retryItem': e.preventDefault(); send({ cmd: 'retryItem', id: el.dataset.id }); return;
      case 'filter': filter = el.dataset.cat; render(); return;
      case 'selAll': send({ cmd: 'select', mode: 'all' }); return;
      case 'selNone': send({ cmd: 'select', mode: 'none' }); return;
      case 'selFiltered': send({ cmd: 'select', mode: 'category', category: filter }); return;
      case 'selDrive': send({ cmd: 'selectDriveIds', ids: driveSelectedIds() }); return;
      case 'toggleList': showList = !showList; render(); return;
      case 'signIn': send({ cmd: 'signIn' }); return;
      case 'options': send({ cmd: 'openOptions' }); return;
      case 'dismiss': send({ cmd: 'clearMessage' }); return;
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.matches('input[data-item]')) send({ cmd: 'toggle', id: t.dataset.item });
    else if (t.matches('select[data-set=concurrency]')) send({ cmd: 'setSetting', patch: { concurrency: Number(t.value) } });
    else if (t.matches('input[data-set=recursive]')) send({ cmd: 'setSetting', patch: { recursive: t.checked } });
    else if (t.matches('input[data-set=preserveFolders]')) send({ cmd: 'setSetting', patch: { preserveFolders: t.checked } });
  }

  // ------------------------------------------------------------ render

  let raf = 0;
  function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

  function setHTML(el, html) {
    if (el.__h === html) return;
    el.__h = html;
    const top = el.scrollTop;
    el.innerHTML = html;
    el.scrollTop = top;
    el.style.display = html ? '' : 'none';
  }

  function render() {
    if (!ui) return;
    ui.panel.style.display = minimized ? 'none' : '';
    ui.pill.style.display = minimized ? '' : 'none';

    const s = state;
    if (!s) {
      ui.status.dataset.tone = 'idle';
      ui.statusText.textContent = 'Connecting\u2026';
      ui.pillLabel.textContent = 'Snap';
      return;
    }
    const c = s.counts;
    const b = s.batch;
    const folderName = s.folder?.name || currentFolder?.name || '';
    const otherFolder = currentFolder && s.folder && currentFolder.id !== s.folder.id;
    const files = c.files;
    const v = c.byCat.video;
    const busy = s.phase === 'scanning' || s.phase === 'downloading';
    if (filter !== 'all' && !c.byCat[filter]) filter = 'all';
    const finished = b ? b.done + (b.handedOff || 0) : 0;
    const dest = b?.handedOff ? (b.done ? `saved or sent to ${b.managerName}` : `sent to ${b.managerName}`) : 'saved to Downloads';

    // status line
    let label, tone;
    switch (s.phase) {
      case 'scanning': label = 'Scanning...'; tone = 'busy'; break;
      case 'downloading': label = 'Downloading'; tone = 'busy'; break;
      case 'done': label = `Done \u00b7 ${plural(b?.zipCreated || 0, 'ZIP file', 'ZIP files')}`; tone = (b?.zipCreated ? 'warn' : 'ok'); break;
      case 'error': label = 'Download error'; tone = 'bad'; break;
      case 'setup': label = 'Setup needed'; tone = 'warn'; break;
      case 'auth': label = 'Sign-in needed'; tone = 'warn'; break;
      case 'scanError': label = 'Scan error'; tone = 'bad'; break;
      default: label = (s.folder || currentFolder) ? 'Ready' : 'Open a folder'; tone = 'idle';
    }
    ui.status.dataset.tone = tone;
    ui.statusText.textContent = label;

    // headline
    let headline;
    if (!files && s.phase !== 'scanning') headline = folderName || 'Open a Google Drive folder';
    else headline = v > 0 ? `${plural(v, 'video', 'videos')} found` : `${plural(files, 'file', 'files')} found`;
    ui.headline.textContent = headline;

    // sub line
    let sub;
    if (s.phase === 'done' && b) sub = `${finished} of ${b.total} ${dest}`;
    else if (s.phase === 'error' && b) sub = `${finished} / ${b.total} files \u00b7 ${plural(b.failed + b.blocked, 'file', 'files')} failed`;
    else if (files || s.phase === 'scanning') sub = `${folderName} \u00b7 ${plural(c.items, 'item', 'items')}`;
    else if (s.folder || currentFolder) sub = 'Find every file in this folder, then download them one by one.';
    else sub = 'Go into a folder in My Drive, Shared with me or a shared drive.';
    ui.sub.textContent = sub;
    ui.sub.title = sub;

    // breakdown (only when mixed)
    const nonzero = Object.keys(CAT_LABEL).filter((k) => c.byCat[k]);
    let bd = '';
    if (files && (nonzero.length > 1 || c.folders)) {
      const parts = nonzero.map((k) => plural(c.byCat[k], CAT_WORD[k][0], CAT_WORD[k][1]));
      if (c.folders) parts.push(plural(c.folders, 'subfolder', 'subfolders'));
      bd = parts.join(' \u00b7 ');
    }
    setHTML(ui.breakdown, esc(bd));

    // notices
    let notes = '';
    if (otherFolder && !busy) {
      notes += `<div class="notice warn">Showing results for \u201c${esc(s.folder.name)}\u201d. Click Scan folder to scan \u201c${esc(currentFolder.name)}\u201d instead.</div>`;
    }
    if (s.phase === 'setup') {
      notes += `<div class="notice warn">${esc(s.message)} Or switch back to “Use my browser’s Google login” in Settings. <button class="link" data-act="options">Open settings</button></div>`;
    } else if (s.message) {
      const cls = s.phase === 'scanError' ? 'bad' : (s.phase === 'auth' ? 'warn' : '');
      notes += `<div class="notice ${cls}">${esc(s.message)} <button class="link" data-act="dismiss">Dismiss</button></div>`;
    }
    if (b && b.blocked && (s.phase === 'error' || s.phase === 'done' || s.phase === 'downloading')) {
      notes += `<div class="notice bad">Google Drive blocked ${plural(b.blocked, 'file', 'files')}. You may not have permission to download ${b.blocked === 1 ? 'it' : 'them'}.</div>`;
    }
    setHTML(ui.notices, notes);

    // filter tabs
    let tabs = '';
    if (files) {
      const list = [['all', 'All', files], ...nonzero.map((k) => [k, CAT_LABEL[k], c.byCat[k]])];
      tabs = list.map(([k, l, n]) => `<button class="tab ${filter === k ? 'on' : ''}" data-act="filter" data-cat="${k}">${l} (${n})</button>`).join('');
    }
    setHTML(ui.tabs, tabs);

    // selection row
    const inFilter = s.items.filter((i) => filter === 'all' || i.category === filter);
    let selrow = '';
    if (files) {
      let left;
      const showBatch = b && ['downloading', 'done', 'error'].includes(s.phase);
      if (showBatch) left = `${finished} / ${b.total} files`;
      else {
        const selIn = inFilter.filter((i) => i.selected).length;
        left = `${selIn} / ${inFilter.length} files`;
        if (filter !== 'all' && c.selected !== selIn) left += ` <span class="kind">(${c.selected} total)</span>`;
      }
      const pool = showBatch ? s.items.filter((i) => b.ids.includes(i.id)) : s.items.filter((i) => i.selected);
      const exts = new Set((pool.length ? pool : inFilter).map((i) => extUpper(i.name)));
      const kind = exts.size === 1 && [...exts][0] ? `Individual ${[...exts][0]}s` : 'Individual files';
      selrow = `<span>${left}</span><span class="kind">${esc(kind)}</span>`;
    }
    setHTML(ui.selrow, selrow);

    // progress
    let prog = '';
    if (b && ['downloading', 'done', 'error'].includes(s.phase)) {
      const pct = (b.bytesTotal > 0 && !b.handedOff) ? Math.min(1, b.bytesDone / b.bytesTotal) : (b.total ? finished / b.total : 0);
      const finalPct = s.phase === 'done' ? 1 : pct;
      const cls = s.phase === 'done' ? 'ok' : (s.phase === 'error' ? 'bad' : '');
      prog = `<div class="bar ${cls}"><i style="width:${(finalPct * 100).toFixed(1)}%"></i></div>`;
      if (s.phase === 'downloading') {
        if (b.handedOff && !b.current.length) {
          prog += `<div class="stats"><span>Sending files to <b>${esc(b.managerName)}</b>\u2026</span><span>${b.queued} left</span></div>`;
        } else {
        const cur = b.current.length ? b.current[0] + (b.current.length > 1 ? ` +${b.current.length - 1}` : '') : 'Starting\u2026';
        prog += `<div class="stats">
          <span class="cur">Current: <b>${esc(cur)}</b></span><span><b>${b.speed ? fmtBytes(b.speed) + '/s' : '\u2014'}</b></span>
          <span>${fmtBytes(b.bytesDone) || '0 B'}${b.bytesTotal ? ' of ' + fmtBytes(b.bytesTotal) : ''} \u00b7 ${b.queued} queued</span><span>ETA <b>${fmtTime(b.eta)}</b></span>
        </div>`;
        }
      } else {
        const took = b.finishedAt && b.startedAt ? fmtTime((b.finishedAt - b.startedAt) / 1000) : '';
        const what = b.handedOff ? `${b.handedOff} handed to ${esc(b.managerName)}${b.done ? `, ${fmtBytes(b.bytesDone)} saved by Chrome` : ''}` : `${fmtBytes(b.bytesDone) || ''} saved individually`;
        prog += `<div class="stats"><span>${what}</span><span>${took ? 'in ' + took : ''}</span></div>`;
      }
    }
    setHTML(ui.progress, prog);

    // tools
    let tools = '';
    if (files) {
      tools = `<button class="link" data-act="selAll">Select all</button>` +
        (filter !== 'all' ? `<button class="link" data-act="selFiltered">Select ${esc(CAT_LABEL[filter].toLowerCase())}</button>` : '') +
        `<button class="link" data-act="selNone">Deselect all</button>` +
        `<button class="link" data-act="selDrive" title="Select the files you have highlighted in Drive's list">Use Drive selection</button>` +
        `<span class="sp"></span><button class="link" data-act="toggleList">${showList ? 'Hide files' : 'Show files'}</button>`;
    }
    setHTML(ui.tools, tools);

    // file list
    let list = '';
    if (files && showList) {
      const LIMIT = 1500;
      list = inFilter.slice(0, LIMIT).map(rowHTML).join('');
      if (inFilter.length > LIMIT) list += `<div class="more">+${inFilter.length - LIMIT} more (use Select all / filters)</div>`;
    }
    setHTML(ui.list, list);

    // actions
    let actions = '';
    const canDl = c.selected > 0;
    if (s.phase === 'setup') {
      actions = `<button class="btn primary" data-act="options">Open setup</button>`;
    } else if (s.phase === 'auth') {
      actions = `<button class="btn secondary" data-act="scan">Scan folder</button><button class="btn primary" data-act="signIn">Sign in with Google</button>`;
    } else if (s.phase === 'downloading') {
      actions = `<button class="btn secondary" data-act="stop">Stop</button><button class="btn primary" disabled>Downloading\u2026</button>`;
    } else if (s.phase === 'scanning') {
      actions = `<button class="btn secondary" disabled>Scanning\u2026</button><button class="btn primary" disabled>Download selected</button>`;
    } else if (s.phase === 'error' && b && b.failed) {
      actions = `<button class="btn secondary" data-act="scan">Scan folder</button><button class="btn primary" data-act="retryFailed">Retry failed</button>`;
    } else if (!files) {
      actions = `<button class="btn primary" data-act="scan" ${(s.folder || currentFolder) ? '' : 'disabled'}>Scan folder</button>`;
    } else {
      actions = `<button class="btn secondary" data-act="scan">Scan folder</button><button class="btn primary" data-act="download" ${canDl ? '' : 'disabled'}>Download selected</button>`;
    }
    setHTML(ui.actions, actions);

    // footer (rebuilt only when settings change, so the dropdown never closes under you)
    const st = s.settings || {};
    const footer = `
      <span class="via" title="${s.manager ? esc(s.manager.name) + ' takes over each download automatically. Without it, Chrome downloads the files.' : 'No download manager extension found, so Chrome downloads the files.'}">To: <b>${s.manager ? esc(s.manager.name) : 'Chrome'}</b></span>
      <label title="How many files download at the same time">Parallel
        <select data-set="concurrency">${[1, 2, 3, 5].map((n) => `<option value="${n}" ${Number(st.concurrency) === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </label>
      <label title="Also scan folders inside this folder"><input type="checkbox" data-set="recursive" ${st.recursive ? 'checked' : ''}>Subfolders</label>
      <label title="Recreate the Drive folder structure inside Downloads"><input type="checkbox" data-set="preserveFolders" ${st.preserveFolders ? 'checked' : ''}>Keep folders</label>
      <span class="sp"></span>
      <button class="icon" data-act="options" title="Settings${s.account ? ' \u00b7 ' + esc(s.account) : ''}" aria-label="Settings">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
      </button>`;
    setHTML(ui.footer, footer);

    // minimized pill
    let pill = 'Snap';
    if (s.phase === 'scanning') pill = `Scanning\u2026 <small>${files} found</small>`;
    else if (s.phase === 'downloading' && b) pill = `Downloading <small>${finished} / ${b.total}</small>`;
    else if (s.phase === 'done' && b) pill = `Done <small>${finished} / ${b.total} \u00b7 ${b.zipCreated} ZIP</small>`;
    else if (s.phase === 'error' && b) pill = `Error <small>${b.failed + b.blocked} failed</small>`;
    else if (files) pill = `${esc(headline)}`;
    if (ui.pillLabel.__h !== pill) { ui.pillLabel.__h = pill; ui.pillLabel.innerHTML = pill; }
  }

  const shortName = (n) => ({ 'Internet Download Manager': 'IDM', 'Free Download Manager': 'FDM', 'Neat Download Manager': 'NDM', 'Xtreme Download Manager': 'XDM', 'AB Download Manager': 'ABDM', 'Download Accelerator Plus': 'DAP' }[n] || n || 'manager');

  function rowHTML(it) {
    const off = it.status === 'blocked';
    const locked = ['queued', 'starting', 'downloading', 'retrying'].includes(it.status);
    let meta = '';
    switch (it.status) {
      case 'queued': meta = `<span class="chip">Queued</span>`; break;
      case 'starting': meta = `<span class="chip busy">Starting</span>`; break;
      case 'downloading': {
        const pct = it.size ? Math.floor((it.received / it.size) * 100) : null;
        meta = `<span class="chip busy">${pct != null ? pct + '%' : fmtBytes(it.received) || '\u2026'}</span>`;
        break;
      }
      case 'retrying': meta = `<span class="chip warn" title="${esc(it.error)}">Retrying</span>`; break;
      case 'done': meta = `<span class="chip ok">Saved</span>`; break;
      case 'handedOff': meta = `<span class="chip ok" title="Taken over by ${esc(it.handedTo)}">Sent to ${esc(shortName(it.handedTo))}</span>`; break;
      case 'failed': meta = `<span class="chip bad" title="${esc(it.error)}">Failed</span><button class="mini" data-act="retryItem" data-id="${it.id}">Retry</button>`; break;
      case 'blocked': meta = `<span class="chip bad" title="${esc(it.error)}">Blocked</span>`; break;
      default: meta = it.workspace ? 'Export' : esc(fmtBytes(it.size));
    }
    const path = it.pathParts && it.pathParts.length ? ` <small>${esc(it.pathParts.join(' / '))}</small>` : '';
    const title = it.error ? `${it.name} \u2014 ${it.error}` : it.name;
    return `<label class="row ${off ? 'off' : ''}" title="${esc(title)}">
      <input type="checkbox" data-item="${it.id}" ${it.selected ? 'checked' : ''} ${off || locked ? 'disabled' : ''}>
      <span class="nm">${esc(it.targetName || it.name)}${path}</span><span class="meta">${meta}</span></label>`;
  }

  // ------------------------------------------------------------ boot

  (async () => {
    await loadPos();
    if (!pos && !detectFolder()) minimized = true; // start small on pages that aren't folders
    mount();
    applyPos();
    render();
    connect();
    checkLocation(true);
    setInterval(() => checkLocation(false), 1000);
    setInterval(() => send({ cmd: 'ping' }), 20000); // keeps the background worker attached while open
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkLocation(true); });
    window.addEventListener('focus', () => checkLocation(true));
  })();
})();
