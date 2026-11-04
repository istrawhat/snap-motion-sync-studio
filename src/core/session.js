// "No setup" mode: uses the Google login that already exists in this browser.
// Each file is checked with a 1-byte request before it is downloaded, which tells us:
//   - Google's exact original file name (Content-Disposition)
//   - the real size
//   - whether Google is refusing it (no permission, quota, sign-in needed)
// Nothing here bypasses restrictions: if Google says no, we report it.

import { filenameFromDisposition } from './paths.js';

export const BLOCKED_MSG = 'Google Drive blocked this file. You may not have permission to download it.';

export class FinalError extends Error {
  constructor(message, blocked = false) { super(message); this.name = 'FinalError'; this.blocked = blocked; }
}
export class TransientError extends Error {
  constructor(message) { super(message); this.name = 'TransientError'; }
}

export function fileUrl(id, authuser = 0, resourceKey) {
  const u = new URL('https://drive.usercontent.google.com/download');
  u.searchParams.set('id', id);
  u.searchParams.set('export', 'download');
  u.searchParams.set('confirm', 't');
  u.searchParams.set('authuser', String(authuser || 0));
  if (resourceKey) u.searchParams.set('resourcekey', resourceKey);
  return u.toString();
}

const DOCS_KIND = {
  'application/vnd.google-apps.document': 'document',
  'application/vnd.google-apps.spreadsheet': 'spreadsheets',
  'application/vnd.google-apps.presentation': 'presentation',
  'application/vnd.google-apps.drawing': 'drawings'
};

export function docsExportUrl(mime, id, fmt, authuser = 0) {
  const kind = DOCS_KIND[mime];
  const base = `https://docs.google.com/${kind}/d/${encodeURIComponent(id)}`;
  const u = (kind === 'presentation' || kind === 'drawings')
    ? new URL(`${base}/export/${fmt}`)
    : new URL(`${base}/export?format=${fmt}`);
  u.searchParams.set('authuser', String(authuser || 0));
  return u.toString();
}

function htmlVerdict(html, finalUrl) {
  if (/accounts\.google\.com/i.test(finalUrl) || /ServiceLogin|identifier/i.test(finalUrl)) {
    return new FinalError('Google wants you to sign in. Make sure this browser is signed in to an account that can open the file.', true);
  }
  if (/too many users have viewed or downloaded|download quota|quota exceeded/i.test(html)) {
    return new FinalError('Google\u2019s download limit for this file has been reached. Try again later (usually within 24 hours).');
  }
  if (/you need access|request access|you need permission|don't have permission|do not have permission/i.test(html)) {
    return new FinalError(BLOCKED_MSG, true);
  }
  return null;
}

/** Google's "can't scan for viruses — Download anyway" page: the same link the user would click. */
function confirmFormUrl(html) {
  const form = /<form[^>]*id="download-form"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const action = /action="([^"]+)"/i.exec(form[0]);
  if (!action) return null;
  const u = new URL(action[1].replace(/&amp;/g, '&'), 'https://drive.usercontent.google.com/');
  for (const m of form[1].matchAll(/<input[^>]*>/gi)) {
    const name = /name="([^"]+)"/i.exec(m[0]);
    const value = /value="([^"]*)"/i.exec(m[0]);
    if (name) u.searchParams.set(name[1], value ? value[1].replace(/&amp;/g, '&') : '');
  }
  return u.toString();
}

/**
 * @returns {Promise<{url:string, finalUrl:string, size:number, name:string, mime:string}>}
 */
export async function probeSession(url, depth = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let res;
  try {
    res = await fetch(url, { credentials: 'include', headers: { Range: 'bytes=0-0' }, signal: ctrl.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(timer);
    throw new TransientError(e?.name === 'AbortError' ? 'Google took too long to answer' : 'Network error');
  }
  const ct = res.headers.get('content-type') || '';
  const cd = res.headers.get('content-disposition') || '';
  const finalUrl = res.url || url;

  if (res.status === 429 || res.status >= 500) {
    clearTimeout(timer); ctrl.abort();
    throw new TransientError(`Google Drive is busy (HTTP ${res.status})`);
  }

  const looksLikePage = /text\/html/i.test(ct) && !/attachment/i.test(cd);
  if (!res.ok || looksLikePage) {
    let html = '';
    try { html = (await res.text()).slice(0, 200000); } catch { /* ignore */ }
    clearTimeout(timer);
    const v = htmlVerdict(html, finalUrl);
    if (v) throw v;
    const next = depth === 0 ? confirmFormUrl(html) : null;
    if (next) return probeSession(next, depth + 1);
    if (res.status === 404) throw new FinalError('File not found, or this Google account has no access to it.', true);
    if (res.status === 403 || res.status === 401) throw new FinalError(BLOCKED_MSG, true);
    throw new TransientError('Google returned a web page instead of the file');
  }

  let size = 0;
  const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
  if (range) size = Number(range[1]);
  else if (res.status === 200) size = Number(res.headers.get('content-length')) || 0;
  clearTimeout(timer);
  ctrl.abort(); // we only wanted the headers
  return { url, finalUrl, size, name: filenameFromDisposition(cd), mime: ct.split(';')[0].trim() };
}
