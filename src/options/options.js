import { getSettings, saveSettings } from '../core/settings.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['concurrency', 'recursive', 'preserveFolders', 'includeRootFolder', 'ifExists',
  'exportDocs', 'exportSheets', 'exportSlides', 'exportDrawings', 'clientId'];

function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 1600);
}
function say(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = `muted small ${cls}`; }

function syncVisibility() {
  $('apiBox').hidden = document.querySelector('input[name=connection]:checked')?.value !== 'api';
}

async function load() {
  $('redirect').textContent = chrome.identity.getRedirectURL();
  const s = await getSettings();
  for (const k of FIELDS) {
    const el = $(k);
    if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = String(s[k] ?? '');
  }
  document.querySelector(`input[name=connection][value=${s.connection}]`).checked = true;
  if (s.connection === 'api') document.querySelector('details').open = true;
  syncVisibility();
  const st = await chrome.runtime.sendMessage({ cmd: 'getState' }).catch(() => null);
  if (st?.account) say('account', `Signed in as ${st.account}`, 'ok');
}

for (const k of FIELDS) {
  $(k).addEventListener('change', async (e) => {
    const el = e.target;
    const value = el.type === 'checkbox' ? el.checked : (k === 'concurrency' ? Number(el.value) : el.value);
    await saveSettings({ [k]: value });
    toast('Saved');
  });
}
document.querySelectorAll('input[name=connection]').forEach((r) => r.addEventListener('change', async () => {
  await saveSettings({ [r.name]: r.value });
  syncVisibility();
  toast('Saved');
}));

async function showManager() {
  const el = $('mgr');
  el.textContent = 'Checking\u2026'; el.className = 'mgr';
  const r = await chrome.runtime.sendMessage({ cmd: 'getManager' }).catch(() => null);
  if (r?.manager) { el.textContent = `Download manager found: ${r.manager.name}. Files will be sent to it.`; el.className = 'mgr ok'; }
  else el.textContent = 'No download manager extension found. Files will download in Chrome.';
}
$('recheck').addEventListener('click', showManager);
showManager();

$('signIn').addEventListener('click', async () => {
  const id = $('clientId').value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(id)) { say('account', 'A Client ID ends in .apps.googleusercontent.com', 'bad'); return; }
  await saveSettings({ clientId: id });
  $('signIn').disabled = true;
  say('account', 'Waiting for Google\u2026');
  const r = await chrome.runtime.sendMessage({ cmd: 'signIn' }).catch((e) => ({ ok: false, error: String(e) }));
  $('signIn').disabled = false;
  if (r?.ok) say('account', `Signed in as ${r.email || 'your Google account'}`, 'ok');
  else say('account', `Sign-in failed: ${r?.error || 'unknown error'}`, 'bad');
});
$('signOut').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ cmd: 'signOut' }).catch(() => {});
  say('account', 'Signed out');
});
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  await navigator.clipboard.writeText($(b.dataset.copy).textContent);
  toast('Copied');
}));

load();
