import { newId } from "../id.ts";
import { projectFetch } from '../project/client';
import './dialog.css';
import type { ShotRenderer } from '../shot-export/renderer';
import type { Shot } from '../types';
import { exportVideo, videoExportIssue } from '../shot-export/export';
import { briefInput, videoPackage, type BriefFrame, type VideoBrief } from './brief';
import { framedObjects } from './subjects';
import type { Workspace } from '../project/workspace';
import { copyText } from '../clipboard';
import { museInstruction } from './handoff';
import { MAX_OUTPUT_BYTES } from '../project/room';

interface Frame { time: number; label: string; previs: string; boxes: Map<string, [number, number, number, number]>; result?: string; savedId?: string; message: string; state: 'waiting' | 'running' | 'done' | 'failed' }

function toJPEG(source: CanvasImageSource, width: number, height: number, max: number): string {
  const scale = Math.min(1, max / Math.max(width, height)), canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', .9);
}

const frameTimes = (shot: Shot, time: number, mode: 'current' | 'keys', fps: number) => mode === 'current' ? [{ time: Math.max(shot.start, Math.min(time, shot.start + shot.duration - 1 / fps)), label: 'Current frame' }] : [
  { time: shot.start, label: 'Start' }, { time: shot.start + shot.duration / 2, label: 'Middle' }, { time: Math.max(shot.start, shot.start + shot.duration - 1 / fps), label: 'End' },
];

/** Muse Image renders finished film stills from clean previs frames; the composition stays the camera's. */
export function openLookFrames(renderer: ShotRenderer, shot: Shot, time: number, workspace: Workspace): void {
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
    <section class="look-handoffs"><div><h3>Generate with Muse</h3><p>Publish the frames shown here, references and prompt as a fixed, read-only page. Anyone with its link can view them. Your project and conversations stay private.</p></div><div data-handoffs></div><textarea data-instruction readonly hidden aria-label="Muse instruction"></textarea><div class="look-handoff-actions"><button data-publish>Create Muse link</button><button data-instruction-copy hidden>Copy instruction and link</button><a data-open-muse href="https://muse.ai/" target="_blank" rel="noopener noreferrer">Open Muse ↗</a><button data-import-video>Import finished video</button><input data-video type="file" accept="video/mp4,video/webm" hidden></div></section>
    <p class="look-message" role="status"></p><div class="look-actions"><button data-cancel hidden>Cancel</button><button data-brief title="Muse Spark writes a prompt for any image-to-video model from these frames and the shot's timing">Write video brief</button><button data-package hidden>Download package</button><button data-render class="primary-button">Render look frames</button></div>`;
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  find('.look-subtitle').textContent = `${shot.name} · ${camera.name} · composition locked to the shot camera`;
  const direction = find<HTMLTextAreaElement>('textarea'); direction.value = workspace.lookSettings(doc.id).direction;
  let mode: 'current' | 'keys' = 'keys', frames: Frame[] = [], style: string | undefined, busy = false, available = false, controller: AbortController | null = null, brief: VideoBrief | null = null;
  let anchor: string | undefined, loading = true, uploading = false;
  let publication: { id: string; archive: Blob } | null = null;
  const room = workspace.room;
  const save = (kind: 'look-frame' | 'video-brief', name: string, value: unknown) => workspace.putOutput({ id: newId(), kind, sceneId: doc.id, shotId: shot.id, name, mime: 'application/json' }, new Blob([JSON.stringify(value)], { type: 'application/json' }), room);
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
    find<HTMLFieldSetElement>('.look-settings').disabled = busy || uploading;
    find('[data-cancel]').hidden = !busy;
    const render = find<HTMLButtonElement>('[data-render]'); render.textContent = busy ? 'Working…' : 'Render look frames'; render.disabled = busy || uploading || loading || !available || !workspace.canEdit;
    find<HTMLButtonElement>('[data-brief]').disabled = busy || uploading || loading || !available || !workspace.canEdit;
    direction.readOnly = !workspace.canEdit; find<HTMLInputElement>('input[type=file]').disabled = !workspace.canEdit;
    const pack = find<HTMLButtonElement>('[data-package]'); pack.hidden = !brief; pack.disabled = busy || uploading;
    find<HTMLButtonElement>('[data-publish]').disabled = busy || uploading || loading || !workspace.canEdit || (!brief && !direction.value.trim());
    find<HTMLButtonElement>('[data-import-video]').disabled = busy || !workspace.canEdit;
    find<HTMLButtonElement>('[data-instruction-copy]').disabled = busy;
    find('.look-anchor').hidden = !(anchor && find<HTMLInputElement>('[data-anchor]').checked);
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
  const shared = () => {
    const receipts = (room?.handoffs ?? []).filter(value => value.sceneId === doc.id && value.shotId === shot.id);
    find('[data-handoffs]').replaceChildren(...receipts.map(receipt => {
      const row = document.createElement('div'); row.className = 'look-handoff-row';
      if (receipt.revokedAt) { const text = document.createElement('span'); text.textContent = `Withdrawn · ${new Date(receipt.createdAt).toLocaleString()}`; row.append(text); }
      else {
        const link = document.createElement('a'); link.href = workspace.handoffUrl(receipt); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `Reference page · ${new Date(receipt.createdAt).toLocaleString()}`;
        const copy = document.createElement('button'); copy.textContent = 'Use link'; copy.onclick = () => { find<HTMLTextAreaElement>('[data-instruction]').value = museInstruction(link.href); find('[data-instruction]').hidden = false; find('[data-instruction-copy]').hidden = false; };
        const withdraw = document.createElement('button'); withdraw.textContent = 'Withdraw'; withdraw.disabled = !workspace.canEdit;
        withdraw.onclick = async () => { withdraw.disabled = true; try { await workspace.withdrawHandoff(receipt.id); shared(); message('Reference link withdrawn. Existing copies downloaded by recipients are unaffected.'); } catch (error) { withdraw.disabled = false; message((error as Error).message); } };
        row.append(link, copy, withdraw);
      }
      return row;
    }));
  };
  dialog.addEventListener('close', () => { controller?.abort(); if (!busy) cleanup(); });
  find('[data-close]').onclick = () => dialog.close();
  find('[data-cancel]').onclick = () => { controller?.abort(); message('Cancelling…'); };
  find('[data-reset]').onclick = () => { if (!workspace.canEdit) return; anchor = undefined; workspace.setLookSettings(doc.id, { anchorId: null }); update(); };
  find('[data-anchor]').onchange = update;
  direction.oninput = () => { workspace.setLookSettings(doc.id, { direction: direction.value }); brief = null; publication = null; showBrief(); update(); };
  dialog.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.onclick = () => { mode = button.dataset.mode as typeof mode; brief = null; publication = null; capture(); draw(); showBrief(); update(); });
  find('[data-copy]').onclick = () => { if (brief) copyText(brief.prompt, dialog).then(() => message('Prompt copied.'), () => message('Copy failed. Select the prompt text instead.')); };
  find('[data-brief]').onclick = async () => {
    if (busy) return;
    busy = true; controller = new AbortController(); update(); message('Muse Spark is writing the video brief…');
    try {
      const sent: BriefFrame[] = [];
      for (const frame of frames.slice(0, 3)) {
        const image = await loadImage(frame.result ?? frame.previs);
        sent.push({ at: Math.max(0, frame.time - shot.start), image: toJPEG(image, image.naturalWidth, image.naturalHeight, 960), kind: frame.result ? 'look' : 'previs' });
      }
      const response = await projectFetch('/api/brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(briefInput(doc, shot, direction.value, sent)), signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message ?? 'The video brief could not be written.');
      brief = data as VideoBrief; showBrief();
      publication = null;
      await save('video-brief', shot.name + ' · video brief', { brief, direction: direction.value, frameIds: frames.flatMap(frame => frame.savedId ? [frame.savedId] : []) });
      message(sent.some(frame => frame.kind === 'look') ? 'Video brief ready.' : 'Video brief ready from previs frames. Render look frames first for a styled brief.');
    } catch (error) { message(controller.signal.aborted ? 'Cancelled.' : (error as Error).message); }
    finally { busy = false; if (dialog.open) update(); else cleanup(); }
  };
  const makePackage = async () => {
    let previs: Blob | null = null;
    if (!videoExportIssue()) {
      renderer.resize(1280, 720);
      try { previs = await exportVideo(renderer, shot, doc.fps ?? 24, controller!.signal, (done, total) => message(`Preparing previs ${done} / ${total} frames…`)); }
      catch (error) { if (controller!.signal.aborted) throw error; message('Video encoding failed; this snapshot will contain still references.'); }
    }
    const value: VideoBrief = brief ?? { prompt: direction.value.trim(), camera: 'Match the framing and movement shown by the previs frames and animation.', beats: [], negative: 'No extra cuts, subjects, text or slideshow.', model: 'creator' };
    return videoPackage(doc, shot, value, direction.value, frames.map(frame => ({ at: Math.max(0, frame.time - shot.start), look: frame.result, previs: frame.previs })), previs,
      [...(style ? [{ image: style, role: 'style' as const, label: 'Style reference' }] : []), ...(anchor ? [{ image: anchor, role: 'scene' as const, label: 'Scene continuity reference' }] : [])]);
  };
  find('[data-publish]').onclick = async () => {
    if (busy || (!brief && !direction.value.trim())) return;
    busy = true; controller = new AbortController(); update(); message('Preparing the reference snapshot…');
    try {
      publication ??= { id: newId(), archive: await makePackage() };
      message('Publishing references…');
      const receipt = await workspace.publishHandoff(publication.archive, publication.id, room);
      find<HTMLTextAreaElement>('[data-instruction]').value = museInstruction(workspace.handoffUrl(receipt));
      find('[data-instruction]').hidden = false; find('[data-instruction-copy]').hidden = false;
      shared(); publication = null;
      const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
      message(local ? 'Reference page saved. This is a local link; Muse can open it after the application is deployed at a public HTTPS address.' : 'Reference page published. Copy the instruction and send it in your official Muse conversation.');
    } catch (error) { message(controller.signal.aborted ? 'Preparation cancelled. No new generation was started.' : (error as Error).message); }
    finally { busy = false; if (dialog.open) update(); else cleanup(); }
  };
  find('[data-instruction-copy]').onclick = () => copyText(find<HTMLTextAreaElement>('[data-instruction]').value, dialog).then(() => message('Instruction and link copied. Paste them in Muse.'), () => { find<HTMLTextAreaElement>('[data-instruction]').select(); message('Select and copy the instruction.'); });
  find('[data-import-video]').onclick = () => find<HTMLInputElement>('[data-video]').click();
  find<HTMLInputElement>('[data-video]').onchange = async () => {
    const file = find<HTMLInputElement>('[data-video]').files?.[0]; if (!file) return;
    try {
      if (file.size > MAX_OUTPUT_BYTES) throw new Error('Finished videos must be smaller than 64 MB.');
      const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const mime = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 ? 'video/webm' : String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp' ? 'video/mp4' : null;
      if (!mime) throw new Error('Choose an MP4 or WebM video file.');
      await workspace.putOutput({ id: newId(), kind: 'final-video', sceneId: doc.id, shotId: shot.id, name: shot.name + ' · ' + file.name.slice(0, 100), mime }, file, room); message('Finished video saved with this shot in Project results.');
    }
    catch (error) { message((error as Error).message); }
    finally { find<HTMLInputElement>('[data-video]').value = ''; }
  };
  find('[data-package]').onclick = async () => {
    if (busy || !brief) return;
    busy = true; controller = new AbortController(); update();
    try {
      const blob = await makePackage();
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = (shot.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'shot') + '-video-package.zip'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      message(`Package ready · ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
    } catch (error) { message(controller.signal.aborted ? 'Cancelled. No package was saved.' : (error as Error).message); }
    finally { busy = false; if (dialog.open) update(); else cleanup(); }
  };
  find<HTMLInputElement>('.look-settings input[type=file]').onchange = async event => {
    const file = (event.target as HTMLInputElement).files?.[0]; style = undefined; publication = null;
    if (!file) return;
    uploading = true; update(); message('Saving the style reference…');
    try { const bitmap = await createImageBitmap(file); style = toJPEG(bitmap, bitmap.width, bitmap.height, 1024); bitmap.close(); const saved = await workspace.putOutput({ id: newId(), kind: 'style-reference', sceneId: doc.id, shotId: '', name: 'Style reference', mime: 'image/jpeg' }, await (await fetch(style)).blob(), room); workspace.setLookSettings(doc.id, { styleId: saved.id }); message('Style reference saved with this project.'); }
    catch (error) { message((error as Error).message); }
    finally { uploading = false; if (dialog.open) update(); }
  };
  find('[data-render]').onclick = async () => {
    if (busy) return;
    const look = direction.value.trim();
    if (!look) { message('Describe the look and mood first.'); direction.focus(); return; }
    busy = true; controller = new AbortController(); capture(); brief = null; publication = null; showBrief(); update();
    const consistent = find<HTMLInputElement>('[data-anchor]').checked;
    frames.forEach(frame => { frame.state = 'waiting'; frame.result = undefined; frame.message = ''; });
    let done = 0, previous: string | undefined, saveProblem = "";
    try {
      for (const frame of frames) {
        frame.state = 'running'; draw(); message(`Rendering ${frame.label.toLowerCase()} · ${done + 1} of ${frames.length}`);
        // Within one render, each frame follows the previous finished frame, so neighbouring frames change only by the blocking between them.
        const reference = consistent ? previous ?? anchor : undefined;
        const subjects = framedObjects(doc, shot.cameraId, frame.time).map(({ object, position, depth }) => ({ name: object.name.trim().slice(0, 80), position, depth, ...(frame.boxes.has(object.id) ? { box: frame.boxes.get(object.id) } : {}) }));
        const body = { frame: frame.previs, direction: look, subjects, ...(reference ? { anchor: reference } : {}), ...(style ? { style } : {}) };
        try {
          const response = await projectFetch('/api/look', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error?.message ?? 'The look frame could not be rendered.');
          frame.result = data.image; frame.state = 'done'; done++;
          // A small anchor carries the look without pulling later frames towards its composition.
          previous = await new Promise<string>(resolve => {
            const image = new Image(); image.onload = () => resolve(toJPEG(image, image.naturalWidth, image.naturalHeight, 512)); image.onerror = () => resolve(data.image); image.src = data.image;
          });
          const saved = await save('look-frame', shot.name + ' · ' + frame.label, { time: frame.time, previs: frame.previs, image: data.image, direction: look }); frame.savedId = saved.id;
          if (consistent && !anchor) { anchor = previous; workspace.setLookSettings(doc.id, { anchorId: saved.id }); }
        } catch (error) {
          frame.state = frame.result ? 'done' : 'failed'; frame.message = controller.signal.aborted ? 'Cancelled' : (error as Error).message;
          if (frame.result) { saveProblem = 'Image ready and kept on this device. ' + frame.message; break; }
          if (controller.signal.aborted) break;
        }
        draw();
      }
      message(saveProblem || (controller.signal.aborted ? 'Cancelled. Finished frames are kept.' : `${done} of ${frames.length} look frame${frames.length === 1 ? '' : 's'} ready.`));
    } finally {
      busy = false; frames.filter(frame => frame.state !== 'done' && frame.state !== 'failed').forEach(frame => { frame.state = 'waiting'; });
      if (dialog.open) { draw(); update(); } else cleanup();
    }
  };
  document.body.append(dialog);
  try { capture(); draw(); shared(); update(); dialog.showModal(); } catch (error) { cleanup(); throw error; }
  projectFetch('/api/look').then(response => response.json()).then(data => { available = Boolean(data.available); if (!available) message('Muse Image is not configured on this server. Set MODEL_API_KEY to render look frames.'); update(); })
    .catch(() => { message('The look-frame service could not be reached.'); });
  void (async () => {
    try {
      const settings = workspace.lookSettings(doc.id);
      if (settings.anchorId) anchor = JSON.parse(await (await workspace.output(settings.anchorId)).text()).image;
      if (settings.styleId) style = await new Promise<string>((resolve, reject) => { void workspace.output(settings.styleId!).then(blob => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); }, reject); });
      const savedFrames = room?.outputs.filter(output => output.kind === 'look-frame' && output.sceneId === doc.id && output.shotId === shot.id) ?? [];
      const loaded = new Set<number>();
      for (const output of savedFrames) { const value = JSON.parse(await (await workspace.output(output.id)).text()), frame = frames.find(frame => Math.abs(frame.time - value.time) < .001); if (frame && !loaded.has(frame.time)) { frame.result = value.image; frame.previs = value.previs; frame.state = 'done'; frame.savedId = output.id; loaded.add(frame.time); } }
      const savedBrief = room?.outputs.find(output => output.kind === 'video-brief' && output.sceneId === doc.id && output.shotId === shot.id);
      if (savedBrief) brief = JSON.parse(await (await workspace.output(savedBrief.id)).text()).brief;
      if (loaded.size || brief) message('Saved results restored. Render again to use the current scene.');
    } catch (error) { message((error as Error).message); }
    finally { loading = false; if (dialog.open) { draw(); showBrief(); update(); } }
  })();
}
