import { REFERENCE_IMAGE_TYPES, REFERENCE_LIMITS, type ReferenceImage } from './types';

const MAX_SIDE = 2048;
const MAX_SOURCE_BYTES = 30_000_000;

function imageType(file: File): string {
  if (file.type) return file.type;
  return /\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : /\.webp$/i.test(file.name) ? 'image/webp' : '';
}

export const isReferenceImage = (file: File): boolean => (REFERENCE_IMAGE_TYPES as readonly string[]).includes(imageType(file));

function dataURL(blob: Blob, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const aborted = () => { reader.abort(); reject(new DOMException('Cancelled', 'AbortError')); };
    reader.onload = () => { signal.removeEventListener('abort', aborted); resolve(String(reader.result)); };
    reader.onerror = () => { signal.removeEventListener('abort', aborted); reject(new Error('The image file could not be read.')); };
    signal.addEventListener('abort', aborted, { once: true });
    reader.readAsDataURL(blob);
  });
}

/**
 * Read a storyboard panel, sketch or photo. Phone photos of paper are often large, so an image
 * over the upload limit or 2048 px is re-encoded as JPEG here. Nothing is uploaded by this step.
 */
export async function readReferenceImage(file: File, signal: AbortSignal): Promise<ReferenceImage> {
  const mime = imageType(file);
  if (!(REFERENCE_IMAGE_TYPES as readonly string[]).includes(mime)) throw new Error('Choose a PNG, JPEG or WebP image.');
  if (!file.size || file.size > MAX_SOURCE_BYTES) throw new Error('Choose an image up to 30 MB.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('Your browser cannot read this image. Try a PNG or JPEG.'); }
  try {
    signal.throwIfAborted();
    const { width, height } = bitmap;
    if (!width || !height) throw new Error('The image dimensions could not be read.');
    const duration = REFERENCE_LIMITS.imageSeconds, scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    if (scale === 1 && file.size <= REFERENCE_LIMITS.maxImageBytes) return { dataUrl: await dataURL(file.slice(0, file.size, mime), signal), width, height, duration };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot prepare the image.');
    // Transparent sketches become ink on white paper rather than on black.
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob: Blob | null = null;
    for (const quality of [.9, .8, .65, .5]) {
      blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= REFERENCE_LIMITS.maxImageBytes) break;
    }
    signal.throwIfAborted();
    if (!blob || blob.size > REFERENCE_LIMITS.maxImageBytes) throw new Error('This image is too detailed to send. Try a smaller image.');
    return { dataUrl: await dataURL(blob, signal), width: canvas.width, height: canvas.height, duration };
  } finally { bitmap.close(); }
}
