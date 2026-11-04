// Detects installed download-manager browser extensions (IDM, FDM, Motrix, JDownloader, …).
// Those extensions take over downloads that appear in Chrome's download list, so Snap simply
// starts each file as a normal Chrome download and lets them pick it up.

const KNOWN = [
  [/internet download manager|\bidm\b/i, 'Internet Download Manager'],
  [/free download manager|\bfdm\b/i, 'Free Download Manager'],
  [/motrix/i, 'Motrix'],
  [/jdownloader|myjdownloader/i, 'JDownloader'],
  [/gopeed/i, 'Gopeed'],
  [/\bab download manager|abdm/i, 'AB Download Manager'],
  [/neat download manager|\bndm\b/i, 'Neat Download Manager'],
  [/xtreme download manager|\bxdm\b/i, 'Xtreme Download Manager'],
  [/download accelerator|\bdap\b/i, 'Download Accelerator Plus'],
  [/eagleget/i, 'EagleGet'],
  [/flashget/i, 'FlashGet'],
  [/ant download manager/i, 'Ant Download Manager'],
  [/persepolis/i, 'Persepolis'],
  [/\buget\b/i, 'uGet'],
  [/aria2/i, 'Aria2'],
  [/folx/i, 'Folx'],
  [/download manager|downloader/i, null] // generic: use the extension's own name
];

/** @returns {Promise<{id:string, name:string}|null>} */
export async function detectManager() {
  if (!chrome.management?.getAll) return null;
  let all = [];
  try { all = await chrome.management.getAll(); } catch { return null; }
  for (const [re, label] of KNOWN) {
    const hit = all.find((x) =>
      x.enabled && x.type === 'extension' && x.id !== chrome.runtime.id &&
      (x.permissions || []).includes('downloads') && re.test(`${x.name} ${x.shortName || ''}`));
    if (hit) return { id: hit.id, name: label || hit.shortName || hit.name };
  }
  return null;
}

export function onManagersChanged(cb) {
  if (!chrome.management) return;
  for (const ev of ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled']) {
    try { chrome.management[ev].addListener(cb); } catch { /* not available */ }
  }
}
