import { icon } from '../icons';
import { newId } from "../id.ts";
import { projectFetch } from '../project/client';
import './dialog.css';
import type { ShotRenderer } from '../shot-export/renderer';
import type { Shot } from '../types';
import { briefInput, videoPackage, type BriefFrame, type VideoBrief } from './brief';
import { BRIEF_LIMITS, referenceJPEG, renderStoryboards, storyboardTimes, type StoryboardPage } from './storyboard';
import { framedObjects } from './subjects';
import type { Workspace } from '../project/workspace';
import { copyText } from '../clipboard';
import { museInstruction, videoPrompt } from './handoff';
import { MAX_OUTPUT_BYTES } from '../project/room';

interface Frame { time: number; label: string; previs: string; boxes: Map<string, [number, number, number, number]>; result?: string; savedId?: string; message: string; state: 'waiting' | 'running' | 'done' | 'failed' }

function toJPEG(source: CanvasImageSource, width: number, height: number, max: number): string {
  const scale = Math.min(1, max / Math.max(width, height)), canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', .9);
}

/** Render owns the frozen renderer; this panel prepares references and an editable Muse instruction. */
export function mountMusePreparation(dialog: HTMLElement, renderer: ShotRenderer, shot: Shot, workspace: Workspace, onBusyChange: () => void) {
  shot = structuredClone(shot);
  const doc = renderer.document, camera = doc.cameras.find(item => item.id === shot.cameraId)!;
  dialog.className = 'muse-preparation';
  dialog.innerHTML = `<p class="look-subtitle">Prepare reference images and a prompt to use in your Muse conversation.</p><div class="look-layout"><div><h3>Storyboards</h3><p class="look-sampling">One frame every 0.5 s + the last frame · 9 frames per page</p><div class="look-storyboards" aria-live="polite"></div><button data-prepare hidden>Prepare storyboards</button><details class="look-source-frames"><summary>First frame & individual images</summary><p>Download the 1920 × 1080 first frame separately for the opening composition.</p><div class="look-frames"></div></details></div>
    <fieldset class="look-settings"><label>Creative direction<textarea data-direction rows="5" maxlength="600" placeholder="Describe the intended action and final look, e.g. a silver knight faces a red dragon on a cliff at sunset; tense, realistic fantasy."></textarea></label>
    <button data-brief class="primary-button">Generate prompt</button><p class="look-note">Muse reads these frames, object motion and camera timing to organize your prompt. One Muse Spark call.</p>
    <details class="look-styling"><summary>Style reference frames (optional)</summary><p>Turn the proxies into finished reference images before preparing your prompt.</p>
    <label>Style reference <span>(optional)</span><input type="file" accept="image/png,image/jpeg,image/webp"></label>
    <label class="look-check"><input type="checkbox" data-anchor checked> Keep the look consistent across frames and shots</label>
    <p class="look-anchor" hidden>Matching the approved look of this scene · <button data-reset>Reset look</button></p>
    <p class="look-note">Styles the first, middle and last reference only. At most 3 Muse Image calls; storyboards keep the original composition and timing.</p><button data-render>Generate up to 3 styled frames</button></details></fieldset></div>
    <section class="look-brief"><div class="look-brief-head"><label for="museVideoPrompt">Prompt for Muse</label><button data-copy>Copy full prompt</button></div><textarea id="museVideoPrompt" data-prompt rows="10" maxlength="12000" placeholder="Generate a prompt from your shot, or write your own here. You can edit every part before copying or exporting."></textarea></section>
    <p class="look-message" role="status"></p><div class="look-actions"><button data-cancel hidden>Cancel</button><button data-package class="primary-button">Download storyboards & prompt</button><a data-open-muse href="https://muse.ai/" target="_blank" rel="noopener noreferrer">Open Muse ${icon('external')}</a></div><p class="look-upload-help">In Muse, attach the first-frame image and all storyboard pages, then paste the prompt. These are image inputs; render a video separately in the Video tab.</p>
    <details class="look-handoffs"><summary>Share a reference link or import the finished video</summary><p>Publish a fixed page with these images and this prompt. Anyone with the link can view it. Send it to Muse manually; generation does not start here.</p><div data-handoffs></div><textarea data-instruction readonly hidden aria-label="Muse instruction"></textarea><div class="look-handoff-actions"><button data-publish>Create reference link</button><button data-instruction-copy hidden>Copy instruction and link</button><button data-import-video>Import finished video</button><input data-video type="file" accept="video/mp4,video/webm" hidden></div></details>`;
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  find('.look-subtitle').textContent = `${shot.name} · ${camera.name} · ${shot.duration.toFixed(2)}s. Prepare images and an editable prompt for Muse.`;
  const direction = find<HTMLTextAreaElement>('[data-direction]'), prompt = find<HTMLTextAreaElement>('[data-prompt]'); direction.value = workspace.lookSettings(doc.id).direction;
  let frames: Frame[] = [], pages: StoryboardPage[] = [], style: string | undefined, busy = true, imageAvailable = false, briefAvailable = false, controller: AbortController | null = new AbortController(), brief: VideoBrief | null = null, disposed = false;
  let briefId = newId(), saveTimer: ReturnType<typeof setTimeout> | undefined;
  let anchor: string | undefined, loading = true, uploading = false;
  let publication: { id: string; archive: Blob } | null = null;
  const room = workspace.room;
  const save = (kind: 'look-frame' | 'video-brief', name: string, value: unknown) => workspace.putOutput({ id: kind === 'video-brief' ? briefId : newId(), kind, sceneId: doc.id, shotId: shot.id, name, mime: 'application/json' }, new Blob([JSON.stringify(value)], { type: 'application/json' }), room);
  const message = (text: string) => { if (!disposed) find('.look-message').textContent = text; };
  const savePrompt = async () => {
    clearTimeout(saveTimer); saveTimer = undefined;
    if (brief && videoPrompt(shot,brief,direction.value).trim()) await save('video-brief', shot.name + ' · video brief', { brief: structuredClone(brief), direction: direction.value, frameIds: frames.flatMap(frame => frame.savedId ? [frame.savedId] : []) });
  };

  const sourceFrames = () => frames.map(frame => ({ at: Math.max(0, frame.time - shot.start), look: frame.result, previs: frame.previs }));
  const styleFrames = () => [...new Set([frames[0], frames[Math.floor((frames.length - 1) / 2)], frames.at(-1)!])].filter(Boolean);
  const capture = async (signal: AbortSignal) => {
    const times = storyboardTimes(shot, doc.fps ?? 24), captured: Frame[] = [];
    for (const [index, time] of times.entries()) {
      signal.throwIfAborted();
      // Render one full-size opening image; keep subsequent source frames at 720p.
      const width = index === 0 ? 1920 : 1280;
      if (index < 2) renderer.resize(width, width * 9 / 16);
      const previs = toJPEG(renderer.render(time), width, width * 9 / 16, width);
      captured.push({ time, label: index === 0 ? 'First frame' : index === times.length - 1 ? 'Last frame' : `Frame ${index + 1}`, previs, boxes: renderer.screenBoxes(), message: '', state: 'waiting' });
      message(`Preparing storyboards · ${index + 1} / ${times.length} frames`);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const sheets = await renderStoryboards(shot, captured.map(frame => ({ at: Math.max(0, frame.time - shot.start), previs: frame.previs })), signal);
    signal.throwIfAborted(); frames = captured; pages = sheets; publication = null;
  };
  const drawPages = () => {
    if (disposed) return;
    find('.look-storyboards').replaceChildren(...pages.map((page, index) => {
      const figure = document.createElement('figure'); figure.className = 'look-storyboard';
      const link = document.createElement('a'); link.href = page.image; link.download = `storyboard-${String(index + 1).padStart(2,'0')}.jpg`; link.title = 'Download this storyboard page';
      const image = new Image(); image.src = page.image; image.alt = `Storyboard page ${index + 1}, frames ${page.frames[0].index}–${page.frames.at(-1)!.index}`; image.loading = 'lazy'; link.append(image);
      const caption = document.createElement('figcaption'); caption.textContent = `Page ${index + 1} / ${pages.length} · ${page.frames[0].at.toFixed(2)}–${page.frames.at(-1)!.at.toFixed(2)} s`;
      const download = document.createElement('a'); download.href = page.image; download.download = link.download; download.textContent = 'Download page'; caption.append(download);
      figure.append(link, caption); return figure;
    }));
    if (frames.length) {
      const first = document.createElement('a'); first.href = frames[0].previs; first.download = 'first-frame.jpg'; first.textContent = 'Download first frame · 1920 × 1080'; first.className = 'look-first-frame'; find('.look-storyboards').prepend(first);
    }
  };
  const draw = () => {
    if (disposed) return;
    find('.look-frames').replaceChildren(...frames.map((frame, index) => {
      const styled = !!frame.result || frame.state === 'running' || frame.state === 'failed';
      const card = document.createElement('figure'); card.className = `look-card${styled ? ' has-look' : ''}`; card.dataset.state = frame.state;
      const previs = new Image(); previs.src = frame.previs; previs.alt = `Previs at ${(frame.time-shot.start).toFixed(2)}s`; previs.loading = 'lazy';
      const result = document.createElement('div'); result.className = 'look-result';
      if (frame.result) { const image = new Image(); image.src = frame.result; image.alt = `Look frame at ${(frame.time-shot.start).toFixed(2)}s`; result.append(image); }
      else result.textContent = frame.state === 'running' ? 'Rendering…' : frame.state === 'failed' ? frame.message : 'Not rendered yet';
      const caption = document.createElement('figcaption'); caption.textContent = `${index + 1}. ${frame.label} · ${(frame.time-shot.start).toFixed(2)}s`;
      for (const [kind,image] of [['previs',frame.previs],['look',frame.result]] as const) if (image) {
        const link = document.createElement('a'); link.href = image; link.textContent = kind === 'previs' ? 'Download reference' : 'Download styled image';
        link.download = `${(shot.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'shot')}-${kind}-${index+1}.${image.slice(11, image.indexOf(';')).replace('jpeg', 'jpg')}`;
        caption.append(link);
      }
      card.append(previs); if (styled) card.append(result); card.append(caption); return card;
    }));
  };
  const update = () => {
    if (disposed) return;
    find<HTMLFieldSetElement>('.look-settings').disabled = busy || uploading || loading;
    find('[data-cancel]').hidden = !busy;
    const render = find<HTMLButtonElement>('[data-render]'); render.disabled = busy || uploading || loading || !pages.length || !imageAvailable || !workspace.canEdit;
    find<HTMLButtonElement>('[data-brief]').disabled = busy || uploading || loading || !pages.length || !briefAvailable || !workspace.canEdit;
    direction.readOnly = !workspace.canEdit; find<HTMLInputElement>('input[type=file]').disabled = !workspace.canEdit;
    const hasPrompt = !!brief && !!videoPrompt(shot,brief,direction.value).trim();
    prompt.readOnly = busy || uploading || loading || !workspace.canEdit;
    find<HTMLButtonElement>('[data-copy]').disabled = busy || uploading || !hasPrompt;
    find<HTMLButtonElement>('[data-package]').disabled = busy || uploading || loading || !pages.length || !hasPrompt;
    find<HTMLButtonElement>('[data-publish]').disabled = busy || uploading || loading || !pages.length || !workspace.canEdit || !hasPrompt;
    find<HTMLButtonElement>('[data-import-video]').disabled = busy || uploading || !workspace.canEdit;
    find<HTMLButtonElement>('[data-instruction-copy]').disabled = busy;
    find('.look-anchor').hidden = !(anchor && find<HTMLInputElement>('[data-anchor]').checked);
    find('[data-prepare]').hidden = busy || !!pages.length;
    find<HTMLButtonElement>('[data-prepare]').disabled = loading || uploading;
    onBusyChange();
  };
  const showBrief = () => {
    prompt.value = brief ? videoPrompt(shot,brief,direction.value) : '';
  };
  const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('A frame could not be read.')); image.src = src; });
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
  find('[data-cancel]').onclick = () => { controller?.abort(); message('Cancelling…'); };
  find('[data-reset]').onclick = () => { if (!workspace.canEdit) return; anchor = undefined; workspace.setLookSettings(doc.id, { anchorId: null }); update(); };
  find('[data-anchor]').onchange = update;
  direction.oninput = () => { workspace.setLookSettings(doc.id, { direction: direction.value }); publication = null; if (brief) message('Direction changed. Generate again or edit the prompt to include it.'); update(); };
  find('[data-prepare]').onclick = async () => {
    if (busy || loading) return;
    busy = true; controller = new AbortController(); update();
    try { await capture(controller.signal); drawPages(); draw(); message(`${frames.length} frames · ${pages.length} storyboard pages ready.`); }
    catch (error) { message(controller.signal.aborted ? 'Preparation cancelled. Try again when ready.' : (error as Error).message); }
    finally { busy = false; update(); }
  };
  prompt.oninput = () => {
    brief ??= { prompt: prompt.value.trim().slice(0,4000) || 'Creator prompt', camera: '', beats: [], negative: '', model: 'creator' };
    brief.promptText = prompt.value; publication = null; clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void savePrompt().catch(error => message(`Prompt is available here, but could not be saved. ${error.message}`)); }, 600);
    update();
  };
  find('[data-copy]').onclick = () => { if (brief) copyText(videoPrompt(shot,brief,direction.value), dialog).then(() => message('Full prompt copied. Attach the reference images in Muse.'), () => { prompt.select(); message('Select and copy the prompt.'); }); };
  find('[data-brief]').onclick = async () => {
    if (busy) return;
    busy = true; controller = new AbortController(); update(); message('Muse Spark is writing the video brief…');
    try {
      const sent: BriefFrame[] = [];
      // All pages reach the writer; never truncate a long shot to its first few moments.
      for (const frame of styleFrames().filter(frame => frame === frames[0] || frame.result)) {
        const image = await loadImage(frame.result ?? frame.previs);
        sent.push({ at: Math.max(0, frame.time - shot.start), image: referenceJPEG(image, image.naturalWidth, image.naturalHeight, 1280), kind: frame.result ? 'look' : 'previs' });
      }
      sent.push(...pages.map(page => ({ at: page.frames[0].at, image: page.image, kind: 'storyboard' as const, tiles: page.frames })));
      const body = JSON.stringify(briefInput(doc, shot, direction.value, sent));
      if (new Blob([body]).size > BRIEF_LIMITS.maxBodyBytes) throw new Error('These references are too large for prompt generation. You can write the prompt manually and download all images.');
      controller.signal.throwIfAborted();
      const response = await projectFetch('/api/brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message ?? 'The video brief could not be written.');
      controller.signal.throwIfAborted();
      brief = data as VideoBrief; showBrief();
      publication = null;
      brief.promptText = videoPrompt(shot,brief,direction.value);
      await savePrompt();
      message('Prompt ready. Edit it below, then copy it and attach the reference images in Muse.');
    } catch (error) { message(controller.signal.aborted ? 'Cancelled.' : (error as Error).message); }
    finally { busy = false; update(); }
  };
  const makePackage = async () => {
    if (!brief || !videoPrompt(shot,brief,direction.value).trim()) throw new Error('Write or generate a prompt before preparing references.');
    return videoPackage(doc, shot, brief, direction.value, sourceFrames(), pages,
      [...(style ? [{ image: style, role: 'style' as const, label: 'Style reference' }] : []), ...(anchor ? [{ image: anchor, role: 'scene' as const, label: 'Scene continuity reference' }] : [])]);
  };
  find('[data-publish]').onclick = async () => {
    if (busy || !brief || !videoPrompt(shot,brief,direction.value).trim()) return;
    busy = true; controller = new AbortController(); update(); message('Preparing the reference snapshot…');
    try {
      publication ??= { id: newId(), archive: await makePackage() };
      controller.signal.throwIfAborted();
      message('Publishing references…');
      const receipt = await workspace.publishHandoff(publication.archive, publication.id, room);
      find<HTMLTextAreaElement>('[data-instruction]').value = museInstruction(workspace.handoffUrl(receipt));
      find('[data-instruction]').hidden = false; find('[data-instruction-copy]').hidden = false;
      shared(); publication = null;
      const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
      message(local ? 'Reference page saved. This is a local link; Muse can open it after the application is deployed at a public HTTPS address.' : 'Reference page published. Copy the instruction and send it in your official Muse conversation.');
    } catch (error) { message(controller.signal.aborted ? 'Preparation cancelled. No new generation was started.' : (error as Error).message); }
    finally { busy = false; update(); }
  };
  find('[data-instruction-copy]').onclick = () => copyText(find<HTMLTextAreaElement>('[data-instruction]').value, dialog).then(() => message('Instruction and link copied. Paste them in Muse.'), () => { find<HTMLTextAreaElement>('[data-instruction]').select(); message('Select and copy the instruction.'); });
  find('[data-import-video]').onclick = () => find<HTMLInputElement>('[data-video]').click();
  find<HTMLInputElement>('[data-video]').onchange = async () => {
    const file = find<HTMLInputElement>('[data-video]').files?.[0]; if (!file) return;
    uploading = true; update();
    try {
      if (file.size > MAX_OUTPUT_BYTES) throw new Error('Finished videos must be smaller than 64 MB.');
      const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const mime = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 ? 'video/webm' : String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp' ? 'video/mp4' : null;
      if (!mime) throw new Error('Choose an MP4 or WebM video file.');
      await workspace.putOutput({ id: newId(), kind: 'final-video', sceneId: doc.id, shotId: shot.id, name: shot.name + ' · ' + file.name.slice(0, 100), mime }, file, room); message('Finished video added to Renders.');
    }
    catch (error) { message((error as Error).message); }
    finally { uploading = false; find<HTMLInputElement>('[data-video]').value = ''; update(); }
  };
  find('[data-package]').onclick = async () => {
    if (busy || !brief) return;
    busy = true; controller = new AbortController(); update();
    try {
      const blob = await makePackage();
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = (shot.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'shot') + '-video-package.zip'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      message(`Package ready · ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
    } catch (error) { message(controller.signal.aborted ? 'Cancelled. No package was saved.' : (error as Error).message); }
    finally { busy = false; update(); }
  };
  find<HTMLInputElement>('.look-settings input[type=file]').onchange = async event => {
    const file = (event.target as HTMLInputElement).files?.[0]; style = undefined; publication = null;
    if (!file) return;
    uploading = true; update(); message('Saving the style reference…');
    try { const bitmap = await createImageBitmap(file); style = toJPEG(bitmap, bitmap.width, bitmap.height, 1024); bitmap.close(); const saved = await workspace.putOutput({ id: newId(), kind: 'style-reference', sceneId: doc.id, shotId: '', name: 'Style reference', mime: 'image/jpeg' }, await (await fetch(style)).blob(), room); workspace.setLookSettings(doc.id, { styleId: saved.id }); message('Style reference saved with this project.'); }
    catch (error) { message((error as Error).message); }
    finally { uploading = false; update(); }
  };
  find('[data-render]').onclick = async () => {
    if (busy) return;
    const look = direction.value.trim();
    if (!look) { message('Describe the look and mood first.'); direction.focus(); return; }
    busy = true; controller = new AbortController(); publication = null; update();
    const selected = styleFrames();
    const consistent = find<HTMLInputElement>('[data-anchor]').checked;
    selected.forEach(frame => { frame.state = 'waiting'; frame.result = undefined; frame.savedId = undefined; frame.message = ''; });
    find<HTMLDetailsElement>('.look-source-frames').open = true;
    let done = 0, previous: string | undefined, saveProblem = "";
    try {
      for (const frame of selected) {
        if (controller.signal.aborted) break;
        frame.state = 'running'; draw(); message(`Rendering ${frame.label.toLowerCase()} · ${done + 1} of ${selected.length}`);
        // Within one render, each frame follows the previous finished frame, so neighbouring frames change only by the blocking between them.
        const reference = consistent ? previous ?? anchor : undefined;
        const subjects = framedObjects(doc, shot.cameraId, frame.time).map(({ object, position, depth }) => ({ name: object.name.trim().slice(0, 80), position, depth, ...(frame.boxes.has(object.id) ? { box: frame.boxes.get(object.id) } : {}) }));
        const original = await loadImage(frame.previs);
        const body = { frame: referenceJPEG(original, original.naturalWidth, original.naturalHeight, 1280), direction: look, subjects, ...(reference ? { anchor: reference } : {}), ...(style ? { style } : {}) };
        try {
          const response = await projectFetch('/api/look', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error?.message ?? 'The look frame could not be rendered.');
          controller.signal.throwIfAborted();
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
      message(saveProblem || (controller.signal.aborted ? 'Cancelled. Finished frames are kept.' : `${done} of ${selected.length} styled frames ready. Generate the prompt again to include their appearance.`));
    } catch (error) { message(controller.signal.aborted ? 'Cancelled. Finished frames are kept.' : (error as Error).message);
    } finally {
      busy = false; frames.filter(frame => frame.state !== 'done' && frame.state !== 'failed').forEach(frame => { frame.state = 'waiting'; });
      draw(); update();
    }
  };
  shared(); update();
  const connection = new AbortController();
  void Promise.allSettled([
    projectFetch('/api/look', { signal: connection.signal }).then(response => response.json()).then(data => { imageAvailable = Boolean(data.available); update(); }),
    projectFetch('/api/brief', { signal: connection.signal }).then(response => response.json()).then(data => { briefAvailable = Boolean(data.available); if (!briefAvailable) message('Prompt generation is unavailable. You can still write a prompt and download references.'); update(); })
      .catch(() => message('Prompt generation could not be reached. You can still write a prompt and download references.')),
  ]);
  void (async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      // Cancelling image capture must still leave the creator's saved prompt available.
      const savedBrief = room?.outputs.find(output => output.kind === 'video-brief' && output.sceneId === doc.id && output.shotId === shot.id);
      if (savedBrief) { const value = JSON.parse(await (await workspace.output(savedBrief.id)).text()); brief = value.brief; briefId = savedBrief.id; if (brief) brief.promptText ??= videoPrompt(shot,brief,value.direction ?? direction.value); }
      await capture(controller!.signal); drawPages(); draw();
      const settings = workspace.lookSettings(doc.id);
      if (settings.anchorId) anchor = JSON.parse(await (await workspace.output(settings.anchorId)).text()).image;
      if (settings.styleId) style = await new Promise<string>((resolve, reject) => { void workspace.output(settings.styleId!).then(blob => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); }, reject); });
      const savedFrames = room?.outputs.filter(output => output.kind === 'look-frame' && output.sceneId === doc.id && output.shotId === shot.id) ?? [];
      const loaded = new Set<number>();
      for (const output of savedFrames) { const value = JSON.parse(await (await workspace.output(output.id)).text()), frame = frames.find(frame => Math.abs(frame.time - value.time) < .001); if (frame && value.previs === frame.previs && !loaded.has(frame.time)) { frame.result = value.image; frame.state = 'done'; frame.savedId = output.id; loaded.add(frame.time); } }
      if (loaded.size || brief) message('Saved prompt and matching reference images restored. If the shot has changed, regenerate the prompt.');
      if (!loaded.size && !brief) message(`${frames.length} frames · ${pages.length} storyboard page${pages.length === 1 ? '' : 's'}. Generate a prompt or write your own below.`);
    } catch (error) { message(controller!.signal.aborted ? 'Preparation cancelled. Try again when ready.' : (error as Error).message); }
    finally { loading = false; busy = false; if (!disposed) { draw(); showBrief(); update(); } }
  })();
  return {
    get busy() { return busy || uploading; },
    cancel() { controller?.abort(); },
    dispose() { if (saveTimer) void savePrompt().catch(() => {}); disposed = true; connection.abort(); controller?.abort(); },
  };
}
