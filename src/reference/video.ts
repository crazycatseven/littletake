import { REFERENCE_LIMITS, type ReferenceVideo } from './types';

/** Read the original clip, not a montage of screenshots. Nothing is uploaded here. */
export async function readReferenceVideo(file: File, signal: AbortSignal): Promise<ReferenceVideo> {
  const mime = file.type || (/\.mp4$/i.test(file.name) ? 'video/mp4' : /\.webm$/i.test(file.name) ? 'video/webm' : '');
  if (!['video/mp4', 'video/webm'].includes(mime)) throw new Error('Choose an MP4 or WebM video.');
  if (!file.size || file.size > REFERENCE_LIMITS.maxVideoBytes) throw new Error('Choose a clip up to 3 MB for this first version.');
  signal.throwIfAborted();
  const video = document.createElement('video'), url = URL.createObjectURL(file);
  video.preload = 'metadata'; video.muted = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); video.onloadedmetadata = null; video.onerror = null; signal.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      const aborted = () => finish(new DOMException('Cancelled', 'AbortError'));
      const timer = setTimeout(() => finish(new Error('The video could not be opened. Try an H.264 MP4 clip.')), 12_000);
      video.onloadedmetadata = () => finish();
      video.onerror = () => finish(new Error('Your browser cannot read this video. Try an H.264 MP4 clip.'));
      signal.addEventListener('abort', aborted, { once: true });
      video.src = url;
    });
    const { duration, videoWidth: width, videoHeight: height } = video;
    if (!Number.isFinite(duration) || duration < REFERENCE_LIMITS.minSeconds || duration > REFERENCE_LIMITS.maxSeconds) throw new Error('Choose a clip between 1 and 60 seconds. A single continuous shot works best.');
    if (!width || !height || width > 8192 || height > 8192) throw new Error('The video dimensions could not be read. Try another clip.');
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      const aborted = () => { reader.abort(); reject(new DOMException('Cancelled', 'AbortError')); };
      reader.onload = () => { signal.removeEventListener('abort', aborted); resolve(String(reader.result)); };
      reader.onerror = () => { signal.removeEventListener('abort', aborted); reject(new Error('The video file could not be read.')); };
      reader.onabort = () => signal.removeEventListener('abort', aborted);
      signal.addEventListener('abort', aborted, { once: true });
      reader.readAsDataURL(file.slice(0, file.size, mime));
    });
    signal.throwIfAborted();
    return { dataUrl, duration, width, height };
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}
