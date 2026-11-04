// File categorisation and Google Workspace export formats.

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
export const CATEGORIES = ['video', 'image', 'audio', 'document', 'other'];

const EXT = {
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mts', 'm2ts', 'mxf', 'wmv', 'flv', '3gp', 'mpg', 'mpeg', 'braw', 'r3d'],
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tiff', 'tif', 'heic', 'heif', 'bmp', 'svg', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'psd'],
  audio: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'opus', 'aif', 'aiff', 'wma'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp', 'csv', 'md', 'pages', 'numbers', 'key', 'epub']
};
const EXT_TO_CAT = {};
for (const [cat, list] of Object.entries(EXT)) for (const e of list) EXT_TO_CAT[e] = cat;

export function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function categorize(name, mime = '') {
  const byExt = EXT_TO_CAT[extOf(name)];
  if (byExt) return byExt;
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || mime.startsWith('text/') ||
      mime.includes('officedocument') || mime.includes('msword') || mime.includes('ms-excel') ||
      mime.includes('ms-powerpoint') || mime.includes('opendocument')) return 'document';
  return 'other';
}

const M = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  txt: 'text/plain',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml'
};

// Google-native files have no bytes of their own; they must be exported.
export const WORKSPACE_TYPES = {
  'application/vnd.google-apps.document': {
    label: 'Google Doc', category: 'document', settingKey: 'exportDocs', defaultFormat: 'docx',
    formats: { docx: M.docx, pdf: M.pdf, odt: M.odt, txt: M.txt }
  },
  'application/vnd.google-apps.spreadsheet': {
    label: 'Google Sheet', category: 'document', settingKey: 'exportSheets', defaultFormat: 'xlsx',
    formats: { xlsx: M.xlsx, csv: M.csv, pdf: M.pdf, ods: M.ods }
  },
  'application/vnd.google-apps.presentation': {
    label: 'Google Slides', category: 'document', settingKey: 'exportSlides', defaultFormat: 'pptx',
    formats: { pptx: M.pptx, pdf: M.pdf }
  },
  'application/vnd.google-apps.drawing': {
    label: 'Google Drawing', category: 'image', settingKey: 'exportDrawings', defaultFormat: 'pdf',
    formats: { pdf: M.pdf, png: M.png, jpg: M.jpg, svg: M.svg }
  }
};

export function isZipLike(name, mime) {
  return /\.zip$/i.test(name || '') || /(^|\/)(x-)?zip(-compressed)?$/i.test(mime || '');
}
