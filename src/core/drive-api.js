// Minimal Google Drive API v3 client (metadata only — file bytes are never fetched here,
// they go straight to Chrome's download manager).

import { getToken, invalidateToken } from './auth.js';

const API = 'https://www.googleapis.com/drive/v3';
const RETRY_MS = [2000, 5000, 15000];

export const LIST_FIELDS =
  'nextPageToken,files(id,name,mimeType,size,driveId,resourceKey,' +
  'shortcutDetails(targetId,targetMimeType,targetResourceKey),capabilities(canDownload))';
export const FILE_FIELDS = 'id,name,mimeType,size,driveId,resourceKey,capabilities(canDownload)';

export class DriveError extends Error {
  constructor(status, reason, message) {
    super(message || `Google Drive error ${status}`);
    this.name = 'DriveError';
    this.status = status;
    this.reason = reason;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const resourceKeyHeader = (id, rk) => (rk ? `${id}/${rk}` : undefined);

async function readError(res) {
  try {
    const j = await res.json();
    return { reason: j?.error?.errors?.[0]?.reason || j?.error?.status || '', message: j?.error?.message || '' };
  } catch { return { reason: '', message: '' }; }
}

async function call(path, params = {}, { resourceKeys } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let authRetried = false;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken();
    const headers = { Authorization: `Bearer ${token}` };
    if (resourceKeys) headers['X-Goog-Drive-Resource-Keys'] = resourceKeys;

    let res;
    try {
      res = await fetch(url, { headers });
    } catch {
      if (attempt < RETRY_MS.length) { await sleep(RETRY_MS[attempt]); continue; }
      throw new DriveError(0, 'network', 'Network error while talking to Google Drive.');
    }
    if (res.ok) return res.json();

    const { reason, message } = await readError(res);
    if (res.status === 401 && !authRetried) {
      authRetried = true; attempt--; await invalidateToken(); continue;
    }
    const transient = res.status === 429 || res.status >= 500 ||
      reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
    if (transient && attempt < RETRY_MS.length) { await sleep(RETRY_MS[attempt]); continue; }
    throw new DriveError(res.status, reason, message);
  }
}

export function getFile(id, fields = FILE_FIELDS, resourceKey) {
  return call(`/files/${encodeURIComponent(id)}`, { fields, supportsAllDrives: true },
    { resourceKeys: resourceKeyHeader(id, resourceKey) });
}

/** One page (up to 1000 items) of a folder's direct children. */
export function listChildren(folderId, { pageToken, driveId, resourceKey } = {}) {
  const params = {
    q: `'${folderId}' in parents and trashed = false`,
    fields: LIST_FIELDS,
    pageSize: 1000,
    pageToken,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    orderBy: 'folder,name_natural'
  };
  if (driveId) { params.corpora = 'drive'; params.driveId = driveId; }
  return call('/files', params, { resourceKeys: resourceKeyHeader(folderId, resourceKey) });
}

export async function getAccountEmail() {
  const j = await call('/about', { fields: 'user(emailAddress)' });
  return j?.user?.emailAddress || null;
}

// --- Individual download URLs (one file each, never a folder/ZIP endpoint) ---

export const mediaUrl = (id) =>
  `${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;

export const exportUrl = (id, mime) =>
  `${API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mime)}`;

export function sessionUrl(id, authuser = 0, resourceKey) {
  const u = new URL('https://drive.usercontent.google.com/download');
  u.searchParams.set('id', id);
  u.searchParams.set('export', 'download');
  u.searchParams.set('confirm', 't');
  u.searchParams.set('authuser', String(authuser || 0));
  if (resourceKey) u.searchParams.set('resourcekey', resourceKey);
  return u.toString();
}

/**
 * Asks Google *why* a download failed, by requesting just the first byte.
 * Returns { status, reason, message }. Used only to classify failures; never to bypass them.
 */
export async function probe(url, extraHeaders = {}) {
  try {
    const token = await getToken();
    const ctrl = new AbortController();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-0', ...extraHeaders },
      signal: ctrl.signal
    });
    if (res.ok) { ctrl.abort(); return { status: res.status, reason: '', message: '' }; }
    const { reason, message } = await readError(res);
    return { status: res.status, reason, message };
  } catch (e) {
    return { status: 0, reason: 'network', message: String(e?.message || e) };
  }
}
