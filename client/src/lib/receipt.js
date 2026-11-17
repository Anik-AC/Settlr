import { api } from './api.js';

const MAX_EDGE = 1600; // px — plenty for legible receipt text, keeps uploads ~200–500 KB
const QUALITY = 0.82;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file isn’t an image this browser can open. Try a JPEG or PNG photo.'));
    };
    img.src = url;
  });
}

/**
 * Shrink a camera photo to a JPEG data URL. Browsers apply EXIF rotation
 * when drawing, so portrait phone shots stay upright.
 * Returns { dataUrl, previewUrl } — revoke previewUrl when done.
 */
export async function prepareReceiptImage(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Choose a photo of the bill.');
  const { img, url } = await loadImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs -> white, not black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL('image/jpeg', QUALITY), previewUrl: url };
}

// The server (Vercel) accepts request bodies up to 4.5 MB; keep all photos together under ~4 MB.
const MAX_TOTAL_CHARS = 4_000_000;

async function reencode(dataUrl, scale, quality) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Couldn’t process that photo.'));
    i.src = dataUrl;
  });
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

/** Shrink a set of photos step by step until they fit in one upload. */
export async function fitPhotos(dataUrls) {
  const size = (list) => list.reduce((a, d) => a + d.length, 0);
  let list = dataUrls;
  let scale = 1;
  let quality = QUALITY;
  while (size(list) > MAX_TOTAL_CHARS && scale > 0.35) {
    scale *= 0.8;
    quality = Math.max(0.6, quality - 0.05);
    list = await Promise.all(dataUrls.map((d) => reencode(d, scale, quality)));
  }
  if (size(list) > MAX_TOTAL_CHARS) throw new Error('These photos are too large to send together. Try fewer photos.');
  return list;
}

/**
 * Send all photos of one bill (in order) to the server, which reads them together.
 * Returns the normalized receipt (amounts in cents).
 */
export async function scanReceipt(dataUrls) {
  const images = await fitPhotos(Array.isArray(dataUrls) ? dataUrls : [dataUrls]);
  const { receipt } = await api.post('/receipts/scan', { images });
  return receipt;
}
