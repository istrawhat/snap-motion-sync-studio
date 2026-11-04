// Persistent user settings (chrome.storage.local). Shared by service worker and options page.

export const DEFAULTS = Object.freeze({
  connection: 'browser',    // 'browser' = use the Google login already in this browser (no setup)
                            // 'api'     = Google Drive API with your own Client ID (advanced)
  ifExists: 'overwrite',    // 'overwrite' keeps exact names; 'rename' adds (1), (2)...
  clientId: '',
  concurrency: 3,
  recursive: true,
  preserveFolders: true,
  includeRootFolder: true,
  exportDocs: 'docx',
  exportSheets: 'xlsx',
  exportSlides: 'pptx',
  exportDrawings: 'pdf'
});

export const CONCURRENCY_CHOICES = [1, 2, 3, 5];

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  for (const k of ['downloadMethod', 'downloader', 'motrixUrl', 'motrixSecret', 'motrixDir']) delete s[k]; // removed options
  return s;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  next.concurrency = CONCURRENCY_CHOICES.includes(Number(next.concurrency)) ? Number(next.concurrency) : DEFAULTS.concurrency;
  if (typeof next.clientId === 'string') next.clientId = next.clientId.trim();
  for (const k of ['downloader', 'motrixUrl', 'motrixSecret', 'motrixDir']) delete next[k];
  await chrome.storage.local.set({ settings: next });
  return next;
}
