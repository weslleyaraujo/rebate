import { zipSync } from 'fflate';

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
