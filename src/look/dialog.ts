import './dialog.css';
import type { ShotRenderer } from '../shot-export/renderer';
import type { Shot } from '../types';
import { exportVideo, videoExportIssue } from '../shot-export/export';
import { briefInput, videoPackage, type BriefFrame, type VideoBrief } from './brief';
import { framedObjects } from './subjects';

interface Frame { time: number; label: string; previs: string; boxes: Map<string, [number, number, number, number]>; result?: string; message: string; state: 'waiting' | 'running' | 'done' | 'failed' }
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
    <section class="look-brief" hidden><div class="look-brief-head"><small>VIDEO BRIEF · MUSE SPARK</small><button data-copy>Copy prompt</button></div><p data-prompt></p>
    <dl><dt>Camera</dt><dd data-camera></dd><dt>Beats</dt><dd><ol data-beats></ol></dd><dt>Avoid</dt><dd data-negative></dd></dl></section>
    <p class="look-message" role="status"></p><div class="look-actions"><button data-cancel hidden>Cancel</button><button data-brief title="Muse Spark writes a prompt for any image-to-video model from these frames and the shot's timing">Write video brief</button><button data-package hidden>Download package</button><button data-render class="primary-button">Render look frames</button></div>`;
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  find('.look-subtitle').textContent = `${shot.name} · ${camera.name} · composition locked to the shot camera`;
  const direction = find<HTMLTextAreaElement>('textarea'); direction.value = storage.get(DIRECTION_KEY) ?? '';
  let mode: 'current' | 'keys' = 'keys', frames: Frame[] = [], style: string | undefined, busy = false, available = false, controller: AbortController | null = null, brief: VideoBrief | null = null;
  const message = (text: string) => { find('.look-message').textContent = text; };

  const capture = () => {
    renderer.resize(1280, 720);
    frames = frameTimes(shot, time, mode, doc.fps ?? 24).map(item => { const previs = toJPEG(renderer.render(item.time), 1280, 720, 1280); return { ...item, previs, boxes: renderer.screenBoxes(), message: '', state: 'waiting' }; });
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
    find<HTMLButtonElement>('[data-brief]').disabled = busy || !available;
    const pack = find<HTMLButtonElement>('[data-package]'); pack.hidden = !brief; pack.disabled = busy;
    find('.look-anchor').hidden = !(anchors.has(doc.id) && find<HTMLInputElement>('[data-anchor]').checked);
    dialog.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => { const active = button.dataset.mode === mode; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  };
  const showBrief = () => {
    find('.look-brief').hidden = !brief;
    if (!brief) return;
    find('[data-prompt]').textContent = brief.prompt; find('[data-camera]').textContent = brief.camera; find('[data-negative]').textContent = brief.negative || '—';
    find('[data-beats]').replaceChildren(...brief.beats.map(beat => { const item = document.createElement('li'); item.textContent = `${beat.at.toFixed(2)} s · ${beat.action}`; return item; }));
  };
  const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('A frame could not be read.')); image.src = src; });
  const cleanup = () => { renderer.dispose(); dialog.remove(); };
  dialog.addEventListener('close', () => { controller?.abort(); if (!busy) cleanup(); });
  find('[data-close]').onclick = () => dialog.close();
  find('[data-cancel]').onclick = () => { controller?.abort(); message('Cancelling…'); };
  find('[data-reset]').onclick = () => { anchors.delete(doc.id); update(); };
  find('[data-anchor]').onchange = update;
  direction.oninput = () => storage.set(DIRECTION_KEY, direction.value);
  dialog.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.onclick = () => { mode = button.dataset.mode as typeof mode; brief = null; capture(); draw(); showBrief(); update(); });
  find('[data-copy]').onclick = () => { if (brief) navigator.clipboard.writeText(brief.prompt).then(() => message('Prompt copied.'), () => message('Copy failed. Select the prompt text instead.')); };
  find('[data-brief]').onclick = async () => {
    if (busy) return;
    busy = true; controller = new AbortController(); update(); message('Muse Spark is writing the video brief…');
    try {
      const sent: BriefFrame[] = [];
      for (const frame of frames.slice(0, 3)) {
        const image = await loadImage(frame.result ?? frame.previs);
        sent.push({ at: Math.max(0, frame.time - shot.start), image: toJPEG(image, image.naturalWidth, image.naturalHeight, 960), kind: frame.result ? 'look' : 'previs' });
      }
      const response = await fetch('/api/brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(briefInput(doc, shot, direction.value, sent)), signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message ?? 'The video brief could not be written.');
      brief = data as VideoBrief; showBrief();
      message(sent.some(frame => frame.kind === 'look') ? 'Video brief ready.' : 'Video brief ready from previs frames. Render look frames first for a styled brief.');
    } catch (error) { message(controller.signal.aborted ? 'Cancelled.' : (error as Error).message); }
    finally { busy = false; if (dialog.open) update(); else cleanup(); }
  };
  find('[data-package]').onclick = async () => {
    if (busy || !brief) return;
    busy = true; controller = new AbortController(); update();
    let previs: Blob | null = null;
    try {
      if (!videoExportIssue()) {
        renderer.resize(1280, 720);
        try { previs = await exportVideo(renderer, shot, doc.fps ?? 24, controller.signal, (done, total) => message(`Rendering previs ${done} / ${total} frames…`)); }
        catch (error) { if (controller.signal.aborted) throw error; }
      }
      const blob = await videoPackage(doc, shot, brief, direction.value, frames.map(frame => ({ at: Math.max(0, frame.time - shot.start), look: frame.result, previs: frame.previs })), previs);
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = (shot.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'shot') + '-video-package.zip'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      message(`Package ready · ${(blob.size / 1024 / 1024).toFixed(2)} MB${previs ? '' : ' · previs video skipped: this browser cannot encode WebM'}`);
    } catch (error) { message(controller.signal.aborted ? 'Cancelled. No package was saved.' : (error as Error).message); }
    finally { busy = false; if (dialog.open) update(); else cleanup(); }
  };
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
    let done = 0, previous: string | undefined;
    try {
      for (const frame of frames) {
        frame.state = 'running'; draw(); message(`Rendering ${frame.label.toLowerCase()} · ${done + 1} of ${frames.length}`);
        // Within one render, each frame follows the previous finished frame, so neighbouring frames change only by the blocking between them.
        const reference = consistent ? previous ?? anchors.get(doc.id) : undefined;
        const subjects = framedObjects(doc, shot.cameraId, frame.time).map(({ object, position, depth }) => ({ name: object.name.trim().slice(0, 80), position, depth, ...(frame.boxes.has(object.id) ? { box: frame.boxes.get(object.id) } : {}) }));
        const body = { frame: frame.previs, direction: look, subjects, ...(reference ? { anchor: reference } : {}), ...(style ? { style } : {}) };
        try {
          const response = await fetch('/api/look', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error?.message ?? 'The look frame could not be rendered.');
          frame.result = data.image; frame.state = 'done'; done++;
          // A small anchor carries the look without pulling later frames towards its composition.
          previous = await new Promise<string>(resolve => {
            const image = new Image(); image.onload = () => resolve(toJPEG(image, image.naturalWidth, image.naturalHeight, 512)); image.onerror = () => resolve(data.image); image.src = data.image;
          });
          if (consistent && !anchors.has(doc.id)) anchors.set(doc.id, previous);
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
