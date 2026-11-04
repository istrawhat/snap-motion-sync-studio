// Snap popup. Link mode: video/social link -> pick quality -> Motrix (via the native helper).
// Drive mode: status and shortcuts for the in-page Google Drive panel (individual files, no ZIP).
const HOST = "com.motionsync.snap";
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");

const RES_NAMES = { 4320: "8K", 2160: "4K", 1440: "2K", 1080: "Full HD", 720: "HD", 480: "SD" };
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24"><path d="M12 8v5m0 3.5v.01M10.3 3.9L2.4 17.5A2 2 0 004.1 20.5h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>';

let state = { url: "", info: null, tab: "video", all: false, selected: null };

// Talk to the helper straight from the popup, so a stale background script can never get in the way.
function host(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, { cookies: $("#cookies").checked, ...payload }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: "Can't reach the Snap helper. Run install.sh in the Snap folder.\n\n" + chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, error: "No reply from the helper." });
      }
    });
  });
}

function render(id) {
  view.replaceChildren($("#" + id).content.cloneNode(true));
  return view.firstElementChild;
}

function formatSize(bytes, approx) {
  if (!bytes) return "—";
  const mb = bytes / 1048576;
  const text = mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb >= 100 ? Math.round(mb) + " MB" : mb.toFixed(1) + " MB";
  return (approx ? "~" : "") + text;
}

function formatDuration(sec) {
  if (!sec) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function showMessage(ok, title, text) {
  const el = render("t-message");
  el.classList.add(ok ? "ok" : "err");
  $(".badge", el).innerHTML = ok ? CHECK : CROSS;
  $("h2", el).textContent = title;
  $("p", el).textContent = text || "";
  $(".again", el).onclick = () => { $("#url").value = ""; $("#url").focus(); render("t-empty"); };
}

async function lookup(url) {
  url = (url || "").trim();
  if (!/^https?:\/\//i.test(url)) return showMessage(false, "That's not a link", "Copy a full link starting with https://");
  state = { ...state, url, info: null, tab: "video", selected: null };
  render("t-loading");
  const res = await host({ action: "list", url });
  if (state.url !== url) return; // a newer link was pasted meanwhile
  if (!res.ok) return showMessage(false, "Couldn't read this link", res.error);
  if (res.direct) return send({ url, mode: "direct" }, "Plain file sent to Motrix");
  state.info = res;
  renderResult();
}

// Default view: one row per resolution, preferring the most compatible format.
function visibleChoices() {
  const kind = state.tab;
  const list = (state.info.choices || []).filter((c) => c.kind === kind);
  if (state.all) return list;
  if (kind === "audio") return list.filter((c) => c.ext !== "WEBM");
  const pref = { "H.264": 0, AV1: 1, VP9: 2, "H.265": 3 };
  const rank = (c) => (pref[c.codec] ?? 4) + (c.ext === "MP4" ? 0 : 10) + (c.parts.every((p) => p.http) ? 0 : 20);
  const byRes = new Map();
  for (const c of list) {
    const prev = byRes.get(c.label);
    if (!prev || rank(c) < rank(prev)) byRes.set(c.label, c);
  }
  return [...byRes.values()];
}

function renderResult() {
  const info = state.info;
  const el = render("t-result");
  $(".title", el).textContent = info.title || "Untitled";
  $(".meta", el).textContent = info.multi ? `${info.multi} items` : info.site || "";
  $(".duration", el).textContent = formatDuration(info.duration);
  const img = $(".thumb img", el);
  if (info.thumbnail) img.src = info.thumbnail; else img.remove();
  $("#all", el).checked = state.all;

  if (info.multi) {
    $(".tabs", el).remove();
    $(".list", el).innerHTML = `<div class="none">This link has ${info.multi} items. They'll all download in the best quality.</div>`;
    setButton("Download all", "");
    $("#download").onclick = () => send({ url: state.url, mode: "best" }, `${info.multi} items sent to Motrix`);
  } else {
    el.querySelectorAll(".tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === state.tab);
      b.onclick = () => { state.tab = b.dataset.tab; state.selected = null; renderResult(); };
    });
    el.querySelectorAll(".convert-opts button").forEach((b) => (b.onclick = () => {
      state.convert = b.dataset.convert;
      chrome.storage.local.set({ convertTo: state.convert });
      renderConvert();
    }));
    $("#all", el).onchange = (e) => { state.all = e.target.checked; chrome.storage.local.set({ all: state.all }); state.selected = null; renderResult(); };
    renderList();
    $("#download").onclick = () => {
      const c = state.selected;
      const convert = $("#convert-row").hidden ? "" : state.convert;
      if (c) send({ action: "choice", url: state.url, title: info.title, choice: c, convert }, null);
    };
  }
  $("#raw").onclick = () => send({ url: state.url, mode: "direct" }, "Raw link sent to Motrix");
}

function renderList() {
  const list = $(".list");
  const choices = visibleChoices();
  list.replaceChildren();
  if (!choices.length) {
    list.innerHTML = `<div class="none">No ${state.tab} formats found for this link.</div>`;
    setButton("Download", "");
    $("#download").disabled = true;
    return;
  }
  if (!state.selected || !choices.includes(state.selected)) state.selected = choices[0];
  choices.forEach((c, i) => {
    const row = document.createElement("button");
    row.className = "q" + (c === state.selected ? " selected" : "");
    const height = parseInt(c.label, 10);
    const name = c.kind === "video" ? RES_NAMES[height] || "" : "";
    const pills = [
      i === 0 ? '<span class="pill best">Best</span>' : "",
      c.hdr ? '<span class="pill hdr">HDR</span>' : "",
      c.codec === "H.264" ? '<span class="pill ok" title="Plays everywhere, including QuickTime and phones">Universal</span>' : "",
    ].join("");
    const via = c.parts.every((p) => p.http) ? "" : " · via yt-dlp";
    row.innerHTML = `
      <span class="radio"></span>
      <span class="q-main">
        <span class="q-top"><span class="q-res"></span><span class="q-name"></span>${pills}</span>
        <div class="q-fmt"></div>
      </span>
      <span class="q-size"></span>`;
    $(".q-res", row).textContent = c.label;
    $(".q-name", row).textContent = name;
    $(".q-fmt", row).textContent = `${c.codec} · ${c.ext}${via}`;
    $(".q-size", row).textContent = formatSize(c.size, c.approx);
    row.onclick = () => { state.selected = c; renderList(); };
    row.ondblclick = () => $("#download").click();
    list.append(row);
  });
  setButton("Download", formatSize(state.selected.size, state.selected.approx));
  $("#download").disabled = false;
  const sel = state.selected;
  const canConvert = sel.kind === "video" && !["H.264", "H.265"].includes(sel.codec) && sel.parts.length === 2 && sel.parts.every((p) => p.http);
  $("#convert-row").hidden = !canConvert;
  if (canConvert) renderConvert();
}

// Measured on this Mac's hardware encoder at 4K: H.264 ~60 fps, H.265 ~105 fps. Smaller frames go faster.
const ENCODE_FPS_4K = { h264: 60, hevc: 105 };
const SIZE_FACTOR = { h264: 1.5, hevc: 1.1 };

function renderConvert() {
  const sel = state.selected;
  document.querySelectorAll(".convert-opts button").forEach((b) => b.classList.toggle("on", b.dataset.convert === state.convert));
  const est = $("#convert-est");
  if (!state.convert) { est.textContent = formatSize(sel.size, sel.approx); return; }
  const [video, audio] = sel.parts;
  const vbytes = video.filesize || sel.size;
  const size = vbytes * SIZE_FACTOR[state.convert] + (audio.filesize || 0);
  const height = parseInt(sel.label, 10) || 1080;
  const fps = parseInt(sel.label.split("p")[1], 10) || 30;
  const encodeFps = ENCODE_FPS_4K[state.convert] * Math.max(1, (2160 * 2160) / (height * height));
  const secs = state.info.duration ? (state.info.duration * fps) / encodeFps : 0;
  est.textContent = `~${formatSize(size)}${secs ? ` · ~${formatTime(secs)} to convert` : ""}`;
}

function formatTime(sec) {
  sec = Math.max(1, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return m < 60 ? `${m}:${String(s).padStart(2, "0")}` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function setButton(label, sub) {
  $("#download span").textContent = label;
  $("#download small").textContent = sub && sub !== "—" ? sub : "";
}

async function send(payload, okTitle, okText) {
  const btn = $("#download");
  if (btn) { btn.disabled = true; $("span", btn).textContent = "Sending…"; }
  const res = await host(payload);
  if (res.ok && okTitle === null) { chrome.runtime.sendMessage({ type: "watchJobs" }).catch(() => {}); return setMode("activity"); }
  if (res.ok) showMessage(true, okTitle, okText || res.message);
  else showMessage(false, "Download failed", res.error);
}

// Events
$("#url").addEventListener("keydown", (e) => { if (e.key === "Enter") lookup(e.target.value); });
$("#url").addEventListener("paste", (e) => {
  const text = e.clipboardData.getData("text");
  setTimeout(() => lookup(text), 0);
});
$("#tab").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url) { $("#url").value = tab.url; lookup(tab.url); }
};
$("#cookies").onchange = (e) => chrome.storage.local.set({ cookies: e.target.checked });

// ------------------------------------------------------------ Drive mode

let drive = { state: null, tab: null, folder: null, onDrive: false, port: null };

function parseFolder(url, title) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/drive(?:\/u\/(\d+))?\/(?:folders\/([A-Za-z0-9_-]+)|(my-drive))/);
    if (!m) return null;
    const id = m[2] || "root";
    return {
      id,
      name: id === "root" ? "My Drive" : (title || "").replace(/\s*[-–]\s*Google Drive\s*$/i, "").trim() || "This folder",
      authuser: Number(m[1] || 0),
      resourceKey: u.searchParams.get("resourcekey"),
    };
  } catch { return null; }
}

function driveNote(text) { const n = $("#note"); n.textContent = text; n.hidden = !text; }

async function showPanel() {
  try { await chrome.tabs.sendMessage(drive.tab.id, { cmd: "showPanel" }); return true; }
  catch {
    driveNote("This Drive tab was open before Snap was installed. Reloading it now…");
    chrome.tabs.reload(drive.tab.id);
    return false;
  }
}

function renderDrive() {
  const { state: st, folder, onDrive } = drive;
  $("#page").textContent = onDrive ? "Google Drive" : "Open a Google Drive folder to start";
  $("#folder").textContent = folder ? folder.name : (onDrive ? "Not inside a folder" : "No folder open");
  $("#dest").textContent = st ? (st.manager ? st.manager.name : "Chrome") : "…";

  let found = "—", headline = "";
  if (st && folder && st.folder && st.folder.id === folder.id && st.counts.files) {
    const v = st.counts.byCat.video;
    found = v ? `${v} video${v === 1 ? "" : "s"}` : `${st.counts.files} files`;
    const fin = st.batch ? st.batch.done + (st.batch.handedOff || 0) : 0;
    if (st.phase === "downloading" && st.batch) headline = `Downloading ${fin} / ${st.batch.total}`;
    if (st.phase === "done" && st.batch) headline = `${fin} of ${st.batch.total} done · ${st.batch.zipCreated} ZIP files`;
  }
  $("#found").textContent = found;
  $("#headline").textContent = headline;
  $("#headline").hidden = !headline;

  const a = $("#actions");
  a.innerHTML = "";
  const add = (label, cls, fn, disabled) => {
    const b = document.createElement("button");
    b.className = cls; b.textContent = label; b.disabled = !!disabled; b.onclick = fn; a.appendChild(b);
  };
  if (st?.settings?.connection === "api" && !st.settings.hasClientId) {
    driveNote("Google Drive API mode is on but has no Client ID. Open settings to add one, or switch back to your browser login.");
    return add("Open setup", "primary", () => chrome.runtime.openOptionsPage());
  }
  if (!onDrive) return add("Open Google Drive", "primary", () => chrome.tabs.create({ url: "https://drive.google.com/drive/my-drive" }));
  add("Scan folder", "primary", async () => {
    try { await chrome.tabs.sendMessage(drive.tab.id, { cmd: "startScan" }); window.close(); }
    catch { await showPanel(); }
  }, !folder || st?.phase === "downloading" || st?.phase === "scanning");
  add("Open Snap panel", "secondary", async () => { if (await showPanel()) window.close(); });
}

async function initDrive() {
  if (drive.port) return renderDrive();
  drive.port = chrome.runtime.connect({ name: "popup" });
  drive.port.onMessage.addListener((m) => { if (m?.type === "state") { drive.state = m.state; renderDrive(); } });
  if (drive.onDrive) {
    try { drive.folder = await chrome.tabs.sendMessage(drive.tab.id, { cmd: "getFolder" }); }
    catch { drive.folder = parseFolder(drive.tab.url, drive.tab.title); }
  }
  renderDrive();
}
$("#settings").onclick = () => chrome.runtime.openOptionsPage();

// ------------------------------------------------------------ Activity

const STAGES = { downloading: "Download", joining: "Join", converting: "Convert", done: "Done" };
let jobsTimer = null;

function startActivity() {
  if (!jobsTimer) jobsTimer = setInterval(refreshJobs, 1000);
  refreshJobs();
}

async function refreshJobs() {
  const res = await host({ action: "jobs" });
  if (!res.ok) { if (!$("#activity-mode").hidden) $("#jobs").innerHTML = `<div class="none">${res.error}</div>`; return; }
  const active = res.jobs.filter((j) => !["done", "failed"].includes(j.stage)).length;
  $("#active-count").textContent = active;
  $("#active-count").hidden = !active;
  if (!$("#activity-mode").hidden) renderJobs(res.jobs);
}

function formatSpeed(bps) { return bps ? formatSize(bps).replace("~", "") + "/s" : ""; }

const FINDER = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>';

function jobLine(j) {
  const target = { h264: "H.264", hevc: "H.265" }[j.convert];
  if (j.stage === "downloading") {
    const of = j.total ? ` · ${formatSize(j.done_bytes || 0)} of ${formatSize(j.total)}` : "";
    return [`Downloading${j.speed ? " · " + formatSpeed(j.speed) : ""}${of}`, j.eta ? `${formatTime(j.eta)} left` : ""];
  }
  if (j.stage === "joining") return ["Joining video + audio", j.eta ? `${formatTime(j.eta)} left` : ""];
  if (j.stage === "converting") return [`Converting to ${target}${j.speed ? ` · ${j.speed}×` : ""}`, j.eta ? `${formatTime(j.eta)} left` : ""];
  return ["", ""];
}

function renderJobs(jobs) {
  const box = $("#jobs");
  if (!jobs.length) {
    box.innerHTML = '<div class="none">Nothing here yet. Downloads from the Link tab show their progress here.</div>';
    return;
  }
  const active = jobs.filter((j) => !["done", "failed"].includes(j.stage));
  // Keep the popup within Chrome's 600px limit: fewer finished rows when more jobs are running.
  const finished = jobs.filter((j) => ["done", "failed"].includes(j.stage)).slice(0, Math.max(2, 5 - Math.max(0, active.length - 2)));
  const nodes = [];

  for (const j of active) {
    const el = document.createElement("div");
    el.className = `job ${j.stage}`;
    el.innerHTML = `
      <div class="job-top"><span class="stage-dot"></span><span class="job-title"></span><span class="job-pct"></span></div>
      <div class="bar"><i></i></div>
      <div class="job-meta"><span class="m"></span><span class="r"></span></div>`;
    const [meta, right] = jobLine(j);
    $(".job-title", el).textContent = j.title || "Download";
    $(".job-title", el).title = j.title || "";
    $(".job-pct", el).textContent = `${Math.floor(j.percent || 0)}%`;
    $(".bar i", el).style.width = `${j.percent || 0}%`;
    $(".m", el).textContent = meta;
    $(".r", el).textContent = right;
    nodes.push(el);
  }

  if (finished.length) {
    const h = document.createElement("div");
    h.className = "group";
    h.textContent = "Finished";
    nodes.push(h);
    const list = document.createElement("div");
    list.className = "done-list";
    for (const j of finished) {
      const row = document.createElement("div");
      row.className = `done-row ${j.stage}`;
      row.innerHTML = `<span class="mark"></span><span class="job-title"></span><span class="done-size"></span>`;
      $(".mark", row).textContent = j.stage === "done" ? "✓" : "!";
      $(".job-title", row).textContent = j.title || "Download";
      $(".job-title", row).title = j.stage === "failed" ? j.error || "Failed" : j.title || "";
      $(".done-size", row).textContent = j.stage === "done" ? formatSize(j.size) : "Failed";
      if (j.stage === "done" && j.output) {
        const b = document.createElement("button");
        b.className = "finder"; b.title = "Show in Finder"; b.innerHTML = FINDER;
        b.onclick = () => host({ action: "reveal", path: j.output });
        row.append(b);
      }
      list.append(row);
    }
    nodes.push(list);
  }
  box.replaceChildren(...nodes);
}

$("#clear-jobs").onclick = async () => { const res = await host({ action: "clear_jobs" }); if (res.ok) renderJobs(res.jobs); };

// ------------------------------------------------------------ mode switch + start

let linkStarted = false;

async function startLink() {
  if (linkStarted) return;
  linkStarted = true;
  render("t-empty");
  try {
    const clip = (await navigator.clipboard.readText()).trim();
    if (/^https?:\/\/\S+$/i.test(clip) && !/^https:\/\/drive\.google\.com\//.test(clip)) { $("#url").value = clip; lookup(clip); return; }
  } catch (e) { /* clipboard not available */ }
  $("#url").focus();
}

function setMode(mode) {
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#link-mode").hidden = mode !== "link";
  $("#drive-mode").hidden = mode !== "drive";
  $("#activity-mode").hidden = mode !== "activity";
  if (mode === "link") startLink();
  else if (mode === "drive") initDrive();
  else startActivity();
}
document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

chrome.storage.local.get({ cookies: false, all: false, convertTo: "" }, async (s) => {
  $("#cookies").checked = s.cookies;
  state.all = s.all;
  state.convert = s.convertTo;
  refreshJobs();
  [drive.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  drive.onDrive = !!drive.tab?.url?.startsWith("https://drive.google.com/");
  // On a Drive page, open straight into Drive mode; anywhere else, Link mode.
  setMode(drive.onDrive ? "drive" : "link");
});
