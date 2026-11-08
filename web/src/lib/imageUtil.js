import { zipSync, unzipSync } from 'fflate';

export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

export function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

export function loadImage(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('could not decode image'));
    };
    img.src = url;
  });
}

/**
 * Downscale a file to a max side (in px) for a fast in-browser preview.
 * Returns { blob, factor } where factor = previewPx / originalPx. The caller
 * uses `factor` to scale pixel-sized params (offsets/roughness/feather) so the
 * preview matches the eventual native export.
 */
export async function downscaleFile(file, maxSide = 2560, quality = 0.95) {
  const { img, url } = await loadImage(file);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const factor = longest > maxSide ? maxSide / longest : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * factor));
  const h = Math.max(1, Math.round(img.naturalHeight * factor));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality),
  );
  URL.revokeObjectURL(url);
  return { blob, factor };
}

export function objectUrlFor(buffer, mime) {
  const blob = buffer instanceof Blob ? buffer : new Blob([buffer], { type: mime });
  return URL.createObjectURL(blob);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadBuffer(buffer, mime, name) {
  downloadBlob(new Blob([buffer], { type: mime }), name);
}

/**
 * Build a ZIP archive of { name, buffer, mime } entries using fflate.
 * Returns a Blob of type application/zip.
 */
export function zipEntries(entries) {
  const files = {};
  for (const e of entries) {
    files[e.name] = e.buffer instanceof Uint8Array
      ? e.buffer
      : new Uint8Array(e.buffer);
  }
  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped], { type: 'application/zip' });
}

export function baseName(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

const IMAGE_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

export function isZipFile(file) {
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return (
    name.endsWith('.zip') ||
    type === 'application/zip' ||
    type === 'application/x-zip-compressed'
  );
}

export function isImageFile(file) {
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return (
    /^image\/(jpeg|jpg|png|webp|tiff?)$/.test(type) ||
    /\.(jpe?g|png|webp|tiff?)$/.test(name)
  );
}

/**
 * Extract supported image files from ZIP bytes. `unzipSync` returns a flat
 * map keyed by each entry's full path, so nested directories are handled for
 * free — we just walk every entry and keep the images, skipping directory
 * placeholders and macOS junk.
 */
export function extractImagesFromZipBuffer(buf) {
  const entries = unzipSync(new Uint8Array(buf));
  const files = [];
  const used = new Map(); // basename -> count, to de-collide duplicate names
  for (const [path, data] of Object.entries(entries)) {
    if (!data || data.length === 0) continue; // directory entry (0 bytes)
    const parts = path.split('/');
    if (parts.includes('__MACOSX')) continue;
    const name = parts[parts.length - 1];
    if (!name || name.startsWith('.')) continue; // .DS_Store etc.
    const ext = (name.split('.').pop() || '').toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) continue; // not a supported image

    const n = used.get(name) || 0;
    used.set(name, n + 1);
    const finalName =
      n === 0 ? name : `${name.slice(0, name.length - ext.length - 1)}-${n + 1}.${ext}`;
    files.push(new File([data], finalName, { type: mime }));
  }
  return files;
}

/** Read a ZIP File (e.g. a Google Takeout export) and return its image files. */
export async function extractImagesFromZip(zipFile) {
  const buf = await readFileAsArrayBuffer(zipFile);
  return extractImagesFromZipBuffer(buf);
}
