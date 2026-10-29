import './dialog.css';
import type { ShotRenderer } from '../shot-export/renderer';
import type { Shot } from '../types';
import { lookSubjects } from './subjects';

interface Frame { time: number; label: string; previs: string; result?: string; message: string; state: 'waiting' | 'running' | 'done' | 'failed' }
const DIRECTION_KEY = 'littletake.look.direction';
/** The first approved frame of a scene anchors the look of every later frame and shot while the page is open. */
const anchors = new Map<string, string>();

const storage = { get(key: string) { try { return localStorage.getItem(key); } catch { return null; } }, set(key: string, value: string) { try { localStorage.setItem(key, value); } catch {} } };

function toJPEG(source: CanvasImageSource, width: number, height: number, max: number): string {
  const scale = Math.min(1, max / Math.max(width, height)), canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', .9);
}

const frameTimes = (shot: Shot, time: number, mode: 'current' | 'keys', fps: number) => mode === 'current' ? [{ time, label: 'Current frame' }] : [
  { time: shot.start, label: 'Start' }, { time: shot.start + shot.duration / 2, label: 'Middle' }, { time: Math.max(shot.start, shot.start + shot.duration - 1 / fps), label: 'End' },
];

/** Muse Image renders finished film stills from clean previs frames; the composition stays the camera's. */
export function openLookFrames(renderer: ShotRenderer, shot: Shot, time: number): void {
  shot = structuredClone(shot);
  const doc = renderer.document, camera = doc.cameras.find(item => item.id === shot.cameraId)!;
  const dialog = document.createElement('dialog'); dialog.className = 'look-dialog'; dialog.setAttribute('aria-label', 'Look frames');
  dialog.innerHTML = `<div class="look-heading"><div><small>MUSE IMAGE</small><h2>Look frames</h2></div><button data-close aria-label="Close look frames">✕</button></div>
    <p class="look-subtitle"></p><div class="look-layout"><div class="look-frames" aria-live="polite"></div>
    <fieldset class="look-settings"><div class="look-tabs" role="tablist" aria-label="Frames"><button role="tab" data-mode="keys" aria-selected="true">Start · middle · end</button><button role="tab" data-mode="current" aria-selected="false">Current frame</button></div>
    <label>Look and mood<textarea rows="5" maxlength="600" placeholder="e.g. 1930s European grand hotel, pastel pink and lavender, symmetrical, soft daylight, 35 mm film grain"></textarea></label>
    <label>Style reference <span>(optional)</span><input type="file" accept="image/png,image/jpeg,image/webp"></label>
    <label class="look-check"><input type="checkbox" data-anchor checked> Keep the look consistent across frames and shots</label>
    <p class="look-anchor" hidden>Matching the approved look of this scene · <button data-reset>Reset look</button></p>
    <p class="look-note">Composition, camera and blocking come from the previs. Each frame costs one Muse Image call.</p></fieldset></div>
    <p class="look-message" role="status"></p><div class="look-actions"><button data-cancel hidden>Cancel</button><button data-render class="primary-button">Render look frames</button></div>`;
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  find('.look-subtitle').textContent = `${shot.name} · ${camera.name} · composition locked to the shot camera`;
  const direction = find<HTMLTextAreaElement>('textarea'); direction.value = storage.get(DIRECTION_KEY) ?? '';
  let mode: 'current' | 'keys' = 'keys', frames: Frame[] = [], style: string | undefined, busy = false, available = false, controller: AbortController | null = null;
  const message = (text: string) => { find('.look-message').textContent = text; };

  const capture = () => {
    renderer.resize(1280, 720);
    frames = frameTimes(shot, time, mode, doc.fps ?? 24).map(item => ({ ...item, previs: toJPEG(renderer.render(item.time), 1280, 720, 1280), message: '', state: 'waiting' }));
  };
  const draw = () => {
    const columns = document.createElement('div'); columns.className = 'look-columns'; columns.innerHTML = '<span>PREVIS</span><span>MUSE IMAGE LOOK</span>';
    find('.look-frames').replaceChildren(columns, ...frames.map(frame => {
      const card = document.createElement('figure'); card.className = 'look-card'; card.dataset.state = frame.state;
      const previs = new Image(); previs.src = frame.previs; previs.alt = `Previs at ${frame.time.toFixed(2)}s`;
      const result = document.createElement('div'); result.className = 'look-result';
      if (frame.result) { const image = new Image(); image.src = frame.result; image.alt = `Look frame at ${frame.time.toFixed(2)}s`; result.append(image); }
      else result.textContent = frame.state === 'running' ? 'Rendering…' : frame.state === 'failed' ? frame.message : 'Not rendered yet';
      const caption = document.createElement('figcaption'); caption.textContent = `${frame.label} · ${frame.time.toFixed(2)}s`;
      if (frame.result) {
        const link = document.createElement('a'); link.href = frame.result; link.textContent = 'Download';
        link.download = `${(shot.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'shot')}-look-${frame.time.toFixed(2)}s.${frame.result.slice(11, frame.result.indexOf(';')).replace('jpeg', 'jpg')}`;
        caption.append(link);
      }
      card.append(previs, result, caption); return card;
    }));
  };
  const update = () => {
    find<HTMLFieldSetElement>('.look-settings').disabled = busy;
    find('[data-cancel]').hidden = !busy;
    const render = find<HTMLButtonElement>('[data-render]'); render.textContent = busy ? 'Rendering…' : 'Render look frames'; render.disabled = busy || !available;
    find('.look-anchor').hidden = !(anchors.has(doc.id) && find<HTMLInputElement>('[data-anchor]').checked);
    dialog.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => { const active = button.dataset.mode === mode; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  };
  const cleanup = () => { renderer.dispose(); dialog.remove(); };
  dialog.addEventListener('close', () => { controller?.abort(); if (!busy) cleanup(); });
  find('[data-close]').onclick = () => dialog.close();
  find('[data-cancel]').onclick = () => { controller?.abort(); message('Cancelling…'); };
  find('[data-reset]').onclick = () => { anchors.delete(doc.id); update(); };
  find('[data-anchor]').onchange = update;
  direction.oninput = () => storage.set(DIRECTION_KEY, direction.value);
  dialog.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.onclick = () => { mode = button.dataset.mode as typeof mode; capture(); draw(); update(); });
  find<HTMLInputElement>('input[type=file]').onchange = async event => {
    const file = (event.target as HTMLInputElement).files?.[0]; style = undefined;
    if (!file) return;
    try { const bitmap = await createImageBitmap(file); style = toJPEG(bitmap, bitmap.width, bitmap.height, 1024); bitmap.close(); message(''); }
    catch { message('That style reference could not be read. Choose a PNG, JPEG or WebP image.'); }
  };
  find('[data-render]').onclick = async () => {
    if (busy) return;
    const look = direction.value.trim();
    if (!look) { message('Describe the look and mood first.'); direction.focus(); return; }
    busy = true; controller = new AbortController(); update();
    const consistent = find<HTMLInputElement>('[data-anchor]').checked;
    frames.forEach(frame => { frame.state = 'waiting'; frame.result = undefined; frame.message = ''; });
    let done = 0;
    try {
      for (const frame of frames) {
        frame.state = 'running'; draw(); message(`Rendering ${frame.label.toLowerCase()} · ${done + 1} of ${frames.length}`);
        const body = { frame: frame.previs, direction: look, subjects: lookSubjects(doc, shot.cameraId, frame.time), ...(consistent && anchors.has(doc.id) ? { anchor: anchors.get(doc.id) } : {}), ...(style ? { style } : {}) };
        try {
          const response = await fetch('/api/look', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error?.message ?? 'The look frame could not be rendered.');
          frame.result = data.image; frame.state = 'done'; done++;
          // A small anchor carries the look without pulling later frames towards its composition.
          if (consistent && !anchors.has(doc.id)) anchors.set(doc.id, await new Promise<string>(resolve => {
            const image = new Image(); image.onload = () => resolve(toJPEG(image, image.naturalWidth, image.naturalHeight, 512)); image.onerror = () => resolve(data.image); image.src = data.image;
          }));
        } catch (error) {
          frame.state = 'failed'; frame.message = controller.signal.aborted ? 'Cancelled' : (error as Error).message;
          if (controller.signal.aborted) break;
        }
        draw();
      }
      message(controller.signal.aborted ? 'Cancelled. Finished frames are kept.' : `${done} of ${frames.length} look frame${frames.length === 1 ? '' : 's'} ready.`);
    } finally {
      busy = false; frames.filter(frame => frame.state !== 'done' && frame.state !== 'failed').forEach(frame => { frame.state = 'waiting'; });
      if (dialog.open) { draw(); update(); } else cleanup();
    }
  };
  document.body.append(dialog);
  try { capture(); draw(); update(); dialog.showModal(); } catch (error) { cleanup(); throw error; }
  fetch('/api/look').then(response => response.json()).then(data => { available = Boolean(data.available); if (!available) message('Muse Image is not configured on this server. Set MODEL_API_KEY to render look frames.'); update(); })
    .catch(() => { message('The look-frame service could not be reached.'); });
}
