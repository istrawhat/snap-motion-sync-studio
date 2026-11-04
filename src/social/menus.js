// Snap: right-click "Download with Motrix" on any link, video, image or page.
// Hands the link to the native helper (host/snap_host.py), which finds the real file and queues it in Motrix.

export const HOST = 'com.motionsync.snap';

export function sendToHost(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: 'Snap helper not installed. Run install.sh in the Snap folder.\n(' + chrome.runtime.lastError.message + ')' });
      } else {
        resolve(res || { ok: false, error: 'No reply from the Snap helper.' });
      }
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  const contexts = ['link', 'video', 'audio', 'image', 'page'];
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'snap-best', title: 'Snap: download best quality', contexts });
    chrome.contextMenus.create({ id: 'snap-audio', title: 'Snap: download audio only', contexts });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const mode = { 'snap-best': 'best', 'snap-audio': 'audio' }[info.menuItemId];
  if (!mode) return;
  const url = info.linkUrl || info.srcUrl || info.pageUrl;
  const { cookies } = await chrome.storage.local.get({ cookies: false });
  const res = await sendToHost({ url, mode, cookies });
  if (res.ok) watchJobs();
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: res.ok ? 'Sent to Motrix' : 'Snap failed',
    message: res.ok ? res.message : res.error
  });
});

// Toolbar badge: shows the current download / convert percentage while Snap jobs are running.
let watching = false;

async function watchJobs() {
  if (watching) return;
  watching = true;
  try {
    for (;;) {
      const res = await sendToHost({ action: 'jobs' });
      const active = (res.jobs || []).filter((j) => !['done', 'failed'].includes(j.stage));
      if (!active.length) {
        const last = (res.jobs || [])[0];
        if (last && Date.now() / 1000 - last.updated < 30) {
          await chrome.action.setBadgeBackgroundColor({ color: last.stage === 'done' ? '#16a34a' : '#e5484d' });
          await chrome.action.setBadgeText({ text: last.stage === 'done' ? '✓' : '!' });
          await new Promise((r) => setTimeout(r, 8000));
        }
        await chrome.action.setBadgeText({ text: '' });
        return;
      }
      await chrome.action.setBadgeBackgroundColor({ color: '#6a5cf6' });
      await chrome.action.setBadgeText({ text: `${Math.floor(active[0].percent || 0)}%` });
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    watching = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'watchJobs') watchJobs();
});
