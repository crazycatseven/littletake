import { icon } from '../icons';
import { newId } from "../id.ts";
import { projectFetch } from '../project/client';
import './dialog.css';
import type { ShotRenderer } from '../shot-export/renderer';
import type { Shot } from '../types';
import { briefInput, videoPackage, type BriefFrame, type VideoBrief } from './brief';
import { BRIEF_LIMITS, downloadStoryboardImage, referenceJPEG, renderStoryboards, storyboardTimes, type StoryboardPage } from './storyboard';
import { framedObjects, inPicture } from './subjects';
import { h3Prompt, shotFacts } from './h3';
import type { Workspace } from '../project/workspace';
import { copyText } from '../clipboard';
import { MUSE_URL, museInstruction, videoPrompt, type HandoffReceipt } from './handoff';
import { loadAppearance } from '../appearance/images';
import { appearanceFile, appearanceInstructions, type AppearanceImage } from '../appearance/model';
import { AIStoryboard, keyPanelTimes, type CapturedPanel } from './ai-storyboard';
import { drawBoardPanel } from './board-panel';
import { worldTransform } from '../placement/hierarchy';
import { evaluateFov } from '../model';

import { storyboardStyleIds, storyboardStyles, type StoryboardStyle } from './styles';

interface Frame { time: number; previs: string; boxes: Map<string, [number, number, number, number]>; result?: string; savedId?: string }

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
  // Measured once from the previs: shot size, angle, over-the-shoulder relation, camera move and effect timing.
  const facts = shotFacts(doc, shot, renderer.assets);
  dialog.className = 'muse-preparation';
  dialog.innerHTML = `<div class="board-modes" role="tablist" aria-label="Storyboard type">
      <button role="tab" data-board-mode="proxy" aria-selected="true">Proxy storyboard</button><button role="tab" data-board-mode="ai" aria-selected="false">${icon('sparkles')} AI storyboard</button></div>
    <div class="look-layout"><div class="look-monitor"><section data-proxy-board aria-label="Proxy storyboard pages"><div class="look-storyboards"></div></section>
      <section class="ai-storyboard" hidden aria-label="AI storyboard panels"></section><button data-prepare hidden>Retry preview</button></div>
    <div class="look-sidebar"><fieldset class="look-settings">
      <label class="look-field">Visual style<select data-preset>${storyboardStyleIds.map(id => '<option value="' + id + '">' + storyboardStyles[id].label + '</option>').join('')}</select></label>
      <details class="look-options"><summary>Other requirements</summary>
        <label class="look-field">Extra direction <textarea data-direction rows="3" maxlength="600" placeholder="Anything Muse should emphasize or avoid?"></textarea></label>
        <label class="look-field" data-ai-settings hidden>Style reference <input type="file" accept="image/png,image/jpeg,image/webp"><small data-style-status></small></label>
        <section class="look-appearance" hidden><h3>Object references</h3><div class="look-appearance-images"></div></section>
      </details>
      <div class="look-generate"><button data-generate-board hidden>${icon('sparkles')} <span>Generate storyboard</span></button><button data-brief>${icon('sparkles')} <span>Generate prompt</span></button></div>
      <details class="look-brief" hidden><summary>Video prompt</summary><textarea aria-label="Generated video prompt" data-prompt rows="6" maxlength="12000"></textarea><button data-copy>${icon('duplicate')} Copy prompt</button><label class="look-field">Prompt for MiniMax H3 <textarea aria-label="MiniMax H3 prompt" data-h3 rows="6" readonly></textarea><small>Use with this shot's depth pass. Effects are left out of the depth pass, so this prompt names them.</small></label><button data-copy-h3>${icon('duplicate')} Copy H3 prompt</button></details>
    </fieldset><p class="look-message" role="status"></p><button data-cancel hidden>Cancel</button></div></div>
    <footer class="look-footer"><div class="look-actions">
      <button data-package>${icon('download')} Download package</button><button data-page hidden>Download image</button>
      <button data-publish class="primary-button">${icon('sparkles')} <span>Render with Muse</span></button>
      <a data-open-muse class="primary-button" target="_blank" rel="noopener noreferrer" hidden><span>Open Muse</span> ${icon('external')}</a></div>
      <section class="muse-link-result" aria-label="Muse reference link" hidden>
        <label><span data-link-label>Reference link</span><input type="text" data-link readonly></label><button data-copy-link>${icon('duplicate')} Copy link</button>
        <p data-link-status role="status"></p>
      </section>
      <details class="look-handoffs" hidden><summary>Previous links</summary><div data-handoffs></div></details>
    </footer>`;
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const direction = find<HTMLTextAreaElement>('[data-direction]'), prompt = find<HTMLTextAreaElement>('[data-prompt]'), preset = find<HTMLSelectElement>('[data-preset]');
  const settings = workspace.lookSettings(doc.id);
  direction.value = settings.direction; preset.value = settings.stylePreset ?? 'scene';
  const stylePreset = () => preset.value as StoryboardStyle;
  let frames: Frame[] = [], pages: StoryboardPage[] = [], style: string | undefined, busy = true, imageAvailable = false, controller: AbortController | null = new AbortController(), brief: VideoBrief | null = null, disposed = false;
  let briefAvailable: boolean | undefined;
  let briefId = newId(), saveTimer: ReturnType<typeof setTimeout> | undefined;
  let loading = true, uploading = false, mode: 'proxy' | 'ai' = 'proxy', board: AIStoryboard | undefined;
  let publication: { id: string; archive: Blob; receipt?: HandoffReceipt } | null = null;
  let displayedLink: HandoffReceipt | null = null, receipts: HandoffReceipt[] = [], publishing = false;
  const room = workspace.room;
  let briefContext: string | null = null;
  let appearance: AppearanceImage[] = [], appearanceError = '';
  const moments = () => mode === 'ai' ? board?.panels.map(panel => ({ at: panel.data.at, note: panel.data.note.trim() })) : undefined;
  const defaultTimes = keyPanelTimes(shot, doc.fps ?? 24);
  const context = () => {
    const panels = moments() ?? [];
    const custom = panels.some((panel, i) => panel.note || panel.at !== defaultTimes[i]);
    const images = appearance.map(image => [image.id, room?.outputs.find(o => o.id === image.id)?.updatedAt, image.bindings]);
    return JSON.stringify([shot.name, shot.start, shot.duration, doc.fps, direction.value.trim(), stylePreset(), workspace.lookSettings(doc.id).styleId, images, custom ? panels : []]);
  };
  const currentBrief = () => !!brief && !!videoPrompt(shot, brief, direction.value).trim() && briefContext === context();
  const loadReferences = async () => {
    try {
      appearance = await loadAppearance(workspace, doc, new Set([...frames.flatMap(frame => [...frame.boxes.keys()]), ...(board?.panels.flatMap(panel => [...panel.source.visible]) ?? [])]), room);
      appearanceError = '';
      find('.look-appearance').hidden = !appearance.length;
      find('.look-appearance-images').replaceChildren(...appearance.map(reference => {
        const figure = document.createElement('figure'), image = new Image(), caption = document.createElement('figcaption'), link = document.createElement('a');
        image.src = reference.image; image.alt = reference.bindings.map(binding => binding.objectName).join(', ');
        caption.textContent = reference.bindings.map(binding => `${binding.objectName} · ${binding.primary ? 'Primary' : 'Detail'}`).join('; ');
        link.href = reference.image; link.download = appearanceFile(reference); link.title = 'Download appearance reference'; link.onclick = event => { event.preventDefault(); downloadStoryboardImage(reference.image, link.download); }; link.append(image); figure.append(link, caption); return figure;
      }));
    } catch (error) { appearanceError = (error as Error).message; throw error; }
  };
  const message = (text: string) => { if (!disposed) find('.look-message').textContent = text; };
  const savePrompt = async () => {
    clearTimeout(saveTimer); saveTimer = undefined;
    if (!brief || !videoPrompt(shot,brief,direction.value).trim()) return;
    const data = { brief, direction: direction.value, source: renderer.sourceState, context: briefContext, frameIds: frames.flatMap(frame => frame.savedId ? [frame.savedId] : []) };
    await workspace.putOutput({ id: briefId, kind: 'video-brief', sceneId: doc.id, shotId: shot.id, name: shot.name + ' · video brief', mime: 'application/json' }, new Blob([JSON.stringify(data)], { type: 'application/json' }), room);
  };

  const sourceFrames = async (signal: AbortSignal) => mode === 'ai' ? board!.frames(signal) : frames.map(frame => ({ at: Math.max(0, frame.time - shot.start), look: frame.result, previs: frame.previs }));
  const styleFrames = () => [...new Set([frames[0], frames[Math.floor((frames.length - 1) / 2)], frames.at(-1)!])].filter(Boolean);
  const capturePanel = (at: number): CapturedPanel => {
    renderer.resize(1280, 720); const canvas = renderer.render(shot.start + at), previs = referenceJPEG(canvas, 1280, 720, 1280), boxes = renderer.screenBoxes();
    const pose = worldTransform(doc, camera.id, shot.start + at);
    return { previs, input: previs, visible: new Set(boxes.keys()), camera: { position: pose.position, rotation: pose.rotation, fov: evaluateFov(camera, shot.start + at) }, subjects: framedObjects(doc, shot.cameraId, shot.start + at).filter(({ object }) => inPicture(boxes.get(object.id))).slice(0, 40).map(({ object, position, depth }) => ({
      id: object.id, name: object.name.trim().slice(0, 80), position, depth, box: boxes.get(object.id),
      ...(object.asset || object.kind === 'human' ? { view: renderer.subjectView(object.id) } : {}),
    })) };
  };
  const activePages = () => mode === 'ai' ? board!.pages() : pages;
  const runBoard = async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (busy || uploading || loading) return;
    busy = true; controller = new AbortController(); update(); drawAI();
    try { await operation(controller.signal); await loadReferences(); clearPublication(); }
    catch (error) { message(controller.signal.aborted ? 'Cancelled. Finished images and previous versions are kept.' : (error as Error).message); }
    finally { busy = false; drawAI(); update(); }
  };
  const drawAI = () => {
    if (disposed || !board || mode !== 'ai') return;
    drawBoardPanel(find('.ai-storyboard'), board, busy || uploading || loading || !workspace.canEdit || !!appearanceError, imageAvailable, operation => { void runBoard(operation); });
  };
  const capture = async (signal: AbortSignal) => {
    const times = storyboardTimes(shot, doc.fps ?? 24), captured: Frame[] = [];
    for (const [index, time] of times.entries()) {
      signal.throwIfAborted();
      // Render one full-size opening image; keep subsequent source frames at 720p.
      const width = index === 0 ? 1920 : 1280;
      if (index < 2) renderer.resize(width, width * 9 / 16);
      const previs = toJPEG(renderer.render(time), width, width * 9 / 16, width);
      captured.push({ time, previs, boxes: renderer.screenBoxes() });
      message(`Preparing storyboards · ${index + 1} / ${times.length} frames`);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const sheets = await renderStoryboards(shot, captured.map(frame => ({ at: Math.max(0, frame.time - shot.start), previs: frame.previs })), signal);
    signal.throwIfAborted(); frames = captured; pages = sheets; clearPublication();
  };
  const drawPages = (index = 0) => {
    if (disposed || !pages[index]) return;
    const page = pages[index], figure = document.createElement('figure'), image = new Image();
    figure.className = 'look-storyboard'; image.src = page.image;
    image.alt = `Storyboard page ${index + 1}, frames ${page.frames[0].index}–${page.frames.at(-1)!.index}`; figure.append(image);
    const caption = document.createElement('figcaption');
    const pageButton = (offset: number) => {
      const button = document.createElement('button'); button.type = 'button';
      button.innerHTML = icon(offset < 0 ? 'arrow-left' : 'arrow-right');
      button.setAttribute('aria-label', offset < 0 ? 'Previous storyboard page' : 'Next storyboard page');
      button.disabled = !pages[index + offset]; button.onclick = () => drawPages(index + offset);
      return button;
    };
    if (pages.length > 1) caption.append(pageButton(-1));
    caption.append(`Page ${index + 1} of ${pages.length} · ${page.frames[0].at.toFixed(2)}–${page.frames.at(-1)!.at.toFixed(2)} s`);
    if (pages.length > 1) caption.append(pageButton(1));
    const link = document.createElement('a'); link.href = page.image; link.download = `storyboard-${String(index + 1).padStart(2,'0')}.jpg`;
    link.textContent = 'Download page'; link.onclick = event => { event.preventDefault(); downloadStoryboardImage(page.image, link.download); };
    caption.append(link); figure.append(caption); find('.look-storyboards').replaceChildren(figure);
  };
  const update = () => {
    if (disposed) return;
    find<HTMLFieldSetElement>('.look-settings').disabled = busy || uploading || loading;
    find('.ai-storyboard').inert = busy || uploading || loading;
    find('[data-cancel]').hidden = !busy;
    const ready = mode === 'proxy' ? !!pages.length : !!board?.complete;
    dialog.dataset.boardMode = mode;
    find('[data-page]').hidden = mode !== 'ai'; find<HTMLButtonElement>('[data-page]').disabled = busy || uploading || loading || !ready;
    find('.look-brief').hidden = !brief;
    find<HTMLButtonElement>('[data-brief]').disabled = busy || uploading || loading || !!appearanceError || !pages.length || !briefAvailable || !workspace.canEdit;
    preset.disabled = !workspace.canEdit; direction.readOnly = !workspace.canEdit; find<HTMLInputElement>('input[type=file]').disabled = !workspace.canEdit;
    const hasPrompt = !!brief && !!videoPrompt(shot,brief,direction.value).trim();
    prompt.readOnly = busy || uploading || loading || !workspace.canEdit;
    find<HTMLButtonElement>('[data-copy]').disabled = busy || uploading || !hasPrompt;
    find<HTMLButtonElement>('[data-copy-h3]').disabled = busy || uploading || !hasPrompt;
    const canPrepare = currentBrief() || (briefAvailable && workspace.canEdit);
    const unavailable = busy || uploading || loading || !!appearanceError;
    find<HTMLButtonElement>('[data-package]').disabled = unavailable || !ready || !canPrepare;
    const generateBoard = find<HTMLButtonElement>('[data-generate-board]');
    generateBoard.hidden = mode !== 'ai';
    generateBoard.disabled = unavailable || !canPrepare || !workspace.canEdit || !imageAvailable || !board?.panels.length || !!board.saveError;
    find('[data-generate-board] span').textContent = board?.result ? 'Regenerate storyboard' : 'Generate storyboard';
    find('[data-brief] span').textContent = currentBrief() ? 'Regenerate prompt' : 'Generate prompt';
    const canPublishBoard = ready || (mode === 'ai' && !generateBoard.disabled);
    find<HTMLButtonElement>('[data-publish]').disabled = unavailable || !workspace.canEdit || !canPrepare || !canPublishBoard;
    find('[data-publish]').hidden = displayedLink !== null;
    find('[data-publish] span').textContent = publishing ? 'Preparing link…' : 'Render with Muse';
    find('[data-open-muse]').hidden = !displayedLink;
    find('.muse-link-result').hidden = !displayedLink;
    dialog.querySelectorAll<HTMLButtonElement>('[data-board-mode]').forEach(button => { button.disabled = busy || uploading || loading; button.setAttribute('aria-selected', String(button.dataset.boardMode === mode)); button.tabIndex = button.dataset.boardMode === mode ? 0 : -1; });
    find('[data-proxy-board]').hidden = mode !== 'proxy'; find('.ai-storyboard').hidden = mode !== 'ai'; find('[data-ai-settings]').hidden = mode !== 'ai';
    find('[data-prepare]').hidden = busy || (!!pages.length && !appearanceError);
    find('[data-prepare]').textContent = appearanceError ? 'Retry reference images' : 'Retry preview';
    find<HTMLButtonElement>('[data-prepare]').disabled = loading || uploading;
    onBusyChange();
  };
  const showBrief = () => {
    prompt.value = brief ? videoPrompt(shot,brief,direction.value) : '';
    find<HTMLTextAreaElement>('[data-h3]').value = brief ? h3Prompt(facts, brief) : '';
  };
  const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('A frame could not be read.')); image.src = src; });
  const linkField = find<HTMLInputElement>('[data-link]');
  const linkStatus = (text: string) => { find('[data-link-status]').textContent = text; };
  const clearPublication = () => { publication = null; displayedLink = null; linkField.value = ''; linkStatus(''); };
  const showLink = (receipt: HandoffReceipt) => {
    displayedLink = receipt;
    linkField.value = workspace.handoffUrl(receipt);
    const shared = workspace.canShareWithMuse;
    find('[data-link-label]').textContent = shared ? 'Reference link' : 'Local preview link';
    find<HTMLAnchorElement>('[data-open-muse]').href = shared ? MUSE_URL : linkField.value;
    find('[data-open-muse] span').textContent = shared ? 'Open Muse' : 'Open local preview';
    update();
  };
  const copyRequest = async () => {
    const link = linkField.value;
    try {
      await copyText(museInstruction(link), dialog);
      if (linkField.value === link) linkStatus('Render request copied. Paste it into Muse and send.');
    } catch {
      if (linkField.value === link) linkStatus('Copy the link, then ask Muse to render the shot.');
    }
  };
  linkField.onclick = () => linkField.select();
  find('[data-copy-link]').onclick = async () => {
    try { await copyText(linkField.value, dialog); linkStatus('Link copied.'); }
    catch { linkField.focus(); linkField.select(); linkStatus('Select and copy the link.'); }
  };
  const shared = () => {
    const links = receipts.filter(value => value.sceneId === doc.id && value.shotId === shot.id && !value.revokedAt);
    find('.look-handoffs').hidden = !links.length;
    find('[data-handoffs]').replaceChildren(...links.map(receipt => {
      const row = document.createElement('div'); row.className = 'look-handoff-row';
      const link = document.createElement('a'); link.href = workspace.handoffUrl(receipt); link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = new Date(receipt.createdAt).toLocaleString();
      const copy = document.createElement('button'); copy.textContent = 'Copy link';
      copy.onclick = async () => {
        try { await copyText(link.href, dialog); message('Reference link copied.'); }
        catch { link.textContent = link.href; link.focus(); message('Use this reference page’s link to copy its address.'); }
      };
      const withdraw = document.createElement('button'); withdraw.textContent = 'Withdraw'; withdraw.disabled = !workspace.canEdit;
      withdraw.onclick = async () => {
        withdraw.disabled = true;
        try {
          await workspace.withdrawHandoff(receipt.id);
          receipt.revokedAt = Date.now();
          if (receipt.id === displayedLink?.id || receipt.id === publication?.id) clearPublication();
          shared(); update(); message('Reference link withdrawn.');
        } catch (error) { withdraw.disabled = false; message((error as Error).message); }
      };
      row.append(link, copy, withdraw); return row;
    }));
  };
  find('[data-cancel]').onclick = () => { controller?.abort(); message('Cancelling…'); };
  find('[data-generate-board]').onclick = () => { if (board) void runBoard(signal => board!.generate(signal)); };
  const settingsChanged = () => { clearPublication(); message(brief && !currentBrief() ? 'Settings changed. Generate a new prompt to use them.' : ''); drawAI(); update(); };
  direction.oninput = () => { workspace.setLookSettings(doc.id, { direction: direction.value }); settingsChanged(); };
  preset.onchange = () => { workspace.setLookSettings(doc.id, { stylePreset: stylePreset() }); settingsChanged(); };
  dialog.querySelectorAll<HTMLButtonElement>('[data-board-mode]').forEach(button => button.onclick = async () => {
    if (busy || uploading || loading || button.dataset.boardMode === mode) return;
    mode = button.dataset.boardMode as typeof mode;
    message('');
    clearPublication(); update();
    if (mode === 'ai' && !board) await runBoard(async () => {
      board = new AIStoryboard(shot, doc.fps ?? 24, doc.id, workspace, capturePanel, () => ({ direction: direction.value, style, stylePreset: stylePreset(), appearance }), () => { drawAI(); update(); }, message, renderer.sourceState, async signal => {
        const { prompt, beats } = await ensureBrief(signal);
        return { prompt, beats };
      });
      try { await board.load(); } catch (error) { board = undefined; throw error; }
    });
    drawAI(); update();
  });
  find('.board-modes').onkeydown = event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = find<HTMLButtonElement>(`[data-board-mode="${mode === 'ai' ? 'proxy' : 'ai'}"]`); next.click(); next.focus(); }
  };
  find('[data-prepare]').onclick = async () => {
    if (busy || loading) return;
    busy = true; controller = new AbortController(); update();
    try { if (!pages.length) { await capture(controller.signal); drawPages(); } await loadReferences(); message(`${frames.length} frames · ${pages.length} storyboard pages ready.`); }
    catch (error) { message(controller.signal.aborted ? 'Preparation cancelled. Try again when ready.' : (error as Error).message); }
    finally { busy = false; update(); }
  };
  prompt.oninput = () => {
    brief ??= { prompt: prompt.value.trim().slice(0,4000) || 'Creator prompt', camera: '', beats: [], negative: '', model: 'creator' };
    brief.promptText = prompt.value; clearPublication(); clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void savePrompt().catch(error => message(`Prompt is available here, but could not be saved. ${error.message}`)); }, 600);
    update();
  };
  find('[data-copy-h3]').onclick = () => { if (brief) copyText(h3Prompt(facts, brief), dialog).then(() => message('H3 prompt copied. Use it with this shot\'s depth pass.'), () => { find<HTMLTextAreaElement>('[data-h3]').select(); message('Select and copy the prompt.'); }); };
  find('[data-copy]').onclick = () => { if (brief) copyText(videoPrompt(shot,brief,direction.value), dialog).then(() => message('Full prompt copied. Attach the reference images in Muse.'), () => { prompt.select(); message('Select and copy the prompt.'); }); };
  const ensureBrief = async (signal: AbortSignal, regenerate = false): Promise<VideoBrief> => {
    if (brief && currentBrief() && !regenerate) return brief;
    if (!briefAvailable) throw new Error('Muse prompt generation is unavailable. You can download storyboard pages from the preview.');
    signal.throwIfAborted();
    message('Muse is reading the shot and writing the actions…');
    const sent: BriefFrame[] = [];
    const illustrated = mode === 'ai' && board?.complete;
    const details = illustrated ? (await board!.frames(signal)).slice(0, 1) :
      styleFrames().filter(frame => frame === frames[0] || frame.result).map(frame => ({ at: Math.max(0, frame.time - shot.start), look: frame.result, previs: frame.previs }));
    for (const frame of details) {
      const image = await loadImage(frame.look ?? frame.previs);
      sent.push({ at: frame.at, image: referenceJPEG(image, image.naturalWidth, image.naturalHeight, 1280), kind: frame.look ? 'look' : 'previs' });
    }
    for (const page of illustrated ? board!.pages() : pages) {
      const image = await loadImage(page.image);
      sent.push({ at: page.frames[0].at, image: referenceJPEG(image, image.naturalWidth, image.naturalHeight), kind: 'storyboard', tiles: page.frames });
    }
    const body = JSON.stringify({ ...briefInput(doc, shot, direction.value, sent, appearance, facts), stylePreset: stylePreset(), moments: moments() });
    if (new Blob([body]).size > BRIEF_LIMITS.maxBodyBytes) throw new Error('These references are too large for prompt generation.');
    signal.throwIfAborted();
    const response = await projectFetch('/api/brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message ?? 'Muse could not write the prompt.');
    signal.throwIfAborted();
    brief = data as VideoBrief; briefContext = context(); clearPublication();
    brief.promptText = [videoPrompt(shot, brief, direction.value), appearanceInstructions(appearance)].filter(Boolean).join('\n\n');
    showBrief(); update(); await savePrompt();
    return brief;
  };
  find('[data-brief]').onclick = async () => {
    if (busy || loading || uploading) return;
    busy = true; controller = new AbortController(); update();
    try {
      await ensureBrief(controller.signal, true);
      find<HTMLDetailsElement>('.look-brief').open = true;
      message('Prompt ready.');
    } catch (error) { message(controller.signal.aborted ? 'Cancelled.' : (error as Error).message); }
    finally { busy = false; update(); }
  };
  const makePackage = async () => {
    const signal = controller!.signal;
    const instruction = await ensureBrief(signal);
    return videoPackage(doc, shot, instruction, direction.value, await sourceFrames(signal), activePages(),
      style ? [{ image: style, role: 'style', label: 'Style reference' }] : [], appearance, mode, h3Prompt(facts, instruction));
  };
  find('[data-publish]').onclick = async () => {
    if (busy || uploading || loading) return;
    busy = publishing = true; controller = new AbortController();
    const { signal } = controller;
    update(); message('Preparing shot references…');
    try {
      if (mode === 'ai' && board && !board.complete) await board.generate(signal);
      if (!publication) publication = { id: newId(), archive: await makePackage() };
      signal.throwIfAborted();
      message('Creating the reference link…');
      const receipt = publication.receipt ?? await workspace.publishHandoff(publication.archive, publication.id, room, signal);
      signal.throwIfAborted();
      publication.receipt = receipt;
      receipts = [receipt, ...receipts.filter(item => item.id !== receipt.id)];
      showLink(receipt); shared(); message('');
      if (workspace.canShareWithMuse) await copyRequest();
      else linkStatus('Only this workspace can open this preview. Use the hosted project for a link Muse can open.');
    } catch (error) {
      message(signal.aborted ? 'Cancelled.' : (error as Error).message);
    } finally { busy = publishing = false; update(); }
  };
  find('[data-package]').onclick = async () => {
    if (busy) return;
    busy = true; controller = new AbortController(); update();
    try {
      const blob = await makePackage();
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = (shot.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'shot') + (mode === 'ai' ? '-ai-storyboard.zip' : '-video-package.zip'); link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      message(`Package ready · ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
    } catch (error) { message(controller.signal.aborted ? 'Cancelled. No package was saved.' : (error as Error).message); }
    finally { busy = false; update(); }
  };
  find('[data-page]').textContent = 'Download image';
  find('[data-page]').onclick = () => {
    if (busy || !board?.complete) return;
    activePages().forEach((page, index) => downloadStoryboardImage(page.image, `ai-storyboard-${index + 1}.${page.image.slice(11, page.image.indexOf(';')).replace('jpeg', 'jpg')}`));
    message('Original storyboard image downloaded.');
  };
  find<HTMLInputElement>('.look-settings input[type=file]').onchange = async event => {
    const file = (event.target as HTMLInputElement).files?.[0]; clearPublication();
    if (!file) return;
    uploading = true; update(); message('Saving the style reference…');
    try { const bitmap = await createImageBitmap(file); const nextStyle = toJPEG(bitmap, bitmap.width, bitmap.height, 1024); bitmap.close(); const saved = await workspace.putOutput({ id: newId(), kind: 'style-reference', sceneId: doc.id, shotId: '', name: 'Style reference', mime: 'image/jpeg' }, await (await fetch(nextStyle)).blob(), room); style = nextStyle; workspace.setLookSettings(doc.id, { styleId: saved.id }); find('[data-style-status]').textContent = file.name; message('Style reference saved with this project.'); }
    catch (error) { message((error as Error).message); }
    finally { uploading = false; drawAI(); update(); }
  };
  shared(); update();
  const connection = new AbortController();
  void Promise.allSettled([
    room && workspace.previousHandoffs(room).then(previous => {
      if (disposed) return;
      const known = new Set(receipts.map(receipt => receipt.id));
      receipts.push(...previous.filter(receipt => !known.has(receipt.id))); shared();
    }).catch(() => {}),
    projectFetch('/api/look', { signal: connection.signal }).then(response => response.json()).then(data => { imageAvailable = Boolean(data.available); drawAI(); update(); }),
    projectFetch('/api/brief', { signal: connection.signal }).then(response => response.json()).then(data => { briefAvailable = Boolean(data.available); if (!briefAvailable && !currentBrief()) message('Prompt generation is unavailable. You can still download storyboard pages.'); update(); })
      .catch(() => { briefAvailable = false; if (!currentBrief()) message('Prompt generation could not be reached. You can still download storyboard pages.'); update(); }),
  ]);
  void (async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      // Cancelling image capture must still leave the creator's saved prompt available.
      const savedBrief = room?.outputs.find(output => output.kind === 'video-brief' && output.sceneId === doc.id && output.shotId === shot.id);
      let legacyPrompt = false;
      if (savedBrief) {
        const value = JSON.parse(await (await workspace.output(savedBrief.id, room)).text());
        brief = value.brief; briefId = savedBrief.id;
        briefContext = value.source === renderer.sourceState ? value.context ?? null : null;
        legacyPrompt = value.source === undefined && (value.direction ?? '') === direction.value && stylePreset() === 'scene';
        if (brief) brief.promptText ??= videoPrompt(shot,brief,value.direction ?? direction.value);
      }
      await capture(controller!.signal); drawPages(); await loadReferences();
      const settings = workspace.lookSettings(doc.id);
      if (settings.styleId) style = await new Promise<string>((resolve, reject) => { void workspace.output(settings.styleId!).then(blob => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); }, reject); });
      find('[data-style-status]').textContent = style ? 'Project style reference loaded' : '';
      const savedFrames = room?.outputs.filter(output => output.kind === 'look-frame' && output.sceneId === doc.id && output.shotId === shot.id) ?? [];
      const loaded = new Set<number>();
      for (const output of savedFrames) { const value = JSON.parse(await (await workspace.output(output.id)).text()), frame = frames.find(frame => Math.abs(frame.time - value.time) < .001); if (frame && value.previs === frame.previs && !loaded.has(frame.time)) { frame.result = value.image; frame.savedId = output.id; loaded.add(frame.time); } }
      if (legacyPrompt) briefContext = context();
      message(briefAvailable === false && !currentBrief() ? 'Prompt generation is unavailable. You can still download storyboard pages.' :
        brief && !currentBrief() ? 'A previous prompt is available. Generate a new one for this shot.' : '');
    } catch (error) { message(controller!.signal.aborted ? 'Preparation cancelled. Try again when ready.' : (error as Error).message); }
    finally { loading = false; busy = false; if (!disposed) { showBrief(); update(); } }
  })();
  return {
    get busy() { return busy || uploading; },
    cancel() { controller?.abort(); },
    dispose() { if (saveTimer) void savePrompt().catch(() => {}); disposed = true; connection.abort(); controller?.abort(); },
  };
}
