// File and folder names. Rule: keep Google's original name exactly (same letters, same case,
// same extension). Only characters that Windows/macOS cannot store in a file name are replaced.

const ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const MAX_SEGMENT = 180;

export function sanitizeSegment(raw) {
  let s = String(raw ?? '').replace(ILLEGAL, '_').replace(/[. ]+$/, '');
  if (!s.trim()) s = '_';
  if (/^\.+$/.test(s)) s = '_' + s;
  if (RESERVED.test(s)) s = '_' + s;
  if (s.length > MAX_SEGMENT) {
    const m = /(\.[A-Za-z0-9]{1,10})$/.exec(s);
    const ext = m ? m[1] : '';
    s = s.slice(0, MAX_SEGMENT - ext.length) + ext;
  }
  return s;
}

/** Sub-folder parts (already sanitized) for a file, or [] when folders are flattened. */
export function folderParts({ rootName, pathParts = [], preserve, includeRoot }) {
  if (!preserve) return [];
  const parts = [];
  if (includeRoot && rootName) parts.push(rootName);
  parts.push(...pathParts);
  return parts.map(sanitizeSegment);
}

/** "Name.ext" -> "Name (2).ext" */
export function numbered(name, n) {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,10})?$/.exec(name);
  return `${m[1]} (${n})${m[2] || ''}`;
}

/** Reads the real file name Google sends in the Content-Disposition header. */
export function filenameFromDisposition(cd) {
  if (!cd) return '';
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (m) {
    try { return decodeURIComponent(m[2].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  m = /filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd);
  if (!m) return '';
  let v = m[1].trim().replace(/\\(.)/g, '$1');
  if (/[\u0080-\u00ff]/.test(v)) {
    try { v = new TextDecoder().decode(Uint8Array.from(v, (c) => c.charCodeAt(0))); } catch { /* keep */ }
  }
  return v;
}
