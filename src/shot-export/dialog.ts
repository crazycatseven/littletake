import { icon } from '../icons';
import './dialog.css';
import type { Shot } from '../types';
import { exportPNG, exportVideo, videoExportIssue } from './export';
import type { ShotRenderer } from './renderer';
import type { Workspace } from '../project/workspace';
import { MAX_OUTPUT_BYTES } from '../project/room';
import { newId } from '../id';
import { mountMusePreparation } from '../look/dialog';
import { shotAtTime } from '../model';
import { mountRenderTimeline } from './timeline';

/** A dialog owns one frozen scene snapshot and releases it on close. */
export function openShotExport(renderer: ShotRenderer, shot: Shot, time: number, workspace: Workspace): void {
  shot = structuredClone(shot);
  const scene = renderer.document;
  const dialog = document.createElement('dialog'); dialog.className = 'shot-export-dialog';
  dialog.setAttribute('aria-label', 'Render');
  dialog.innerHTML = `<div class="export-heading"><h2>Render</h2><button data-close aria-label="Close render">${icon('close')}</button></div>
    <p data-shot class="export-subtitle"></p><div class="export-tabs" role="tablist" aria-label="Render output"><button id="renderImageTab" role="tab" data-format="image" aria-controls="renderOutputPanel" aria-selected="true">Still image</button><button id="renderVideoTab" role="tab" data-format="video" aria-controls="renderOutputPanel" aria-selected="false">Video</button><button id="renderMuseTab" role="tab" data-format="muse" aria-controls="renderMusePanel" aria-selected="false">${icon('sparkles')} Storyboards</button></div>
    <div id="renderOutputPanel" role="tabpanel" class="export-layout"><div class="export-monitor"><div class="export-preview"></div><section class="render-timeline" aria-label="Scene timeline"></section></div>
    <div><fieldset class="export-settings">
    <label>Resolution<select aria-label="Export resolution"><option value="1920">1920 × 1080</option><option value="1280">1280 × 720</option></select></label>
    <label data-video hidden>Frame rate<select aria-label="Export frame rate"><option value="24">24 fps</option><option value="30">30 fps</option></select></label>
    <p class="export-range"></p></fieldset>
    <div class="export-progress" hidden><progress max="1" value="0"></progress><span role="status"></span></div><p class="export-message" role="status" aria-live="polite"></p>
    <div class="export-actions"><button data-cancel hidden>Cancel render</button><button data-render class="primary-button">Render still</button><a data-download class="primary-button" hidden>Download PNG</a></div></div></div><div id="renderMusePanel" role="tabpanel" aria-labelledby="renderMuseTab" hidden></div>`;
  const room = workspace.room;
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const preview = find('.export-preview'), settings = find<HTMLFieldSetElement>('.export-settings');
  preview.append(renderer.canvas);
  let format: 'image' | 'video' | 'muse' = 'image', busy = false, url: string | null = null, controller: AbortController | null = null, closing = false, cleaned = false;
  let preparation: ReturnType<typeof mountMusePreparation> | undefined;
  const clearResult = () => { if (url) URL.revokeObjectURL(url); url = null; find('[data-download]').hidden = true; };
  const sceneRenderer = { canvas: renderer.canvas, render: (at: number) => renderer.render(at, shotAtTime(scene, at)?.cameraId ?? scene.cameras[0].id) };
  let pendingFrame = 0;
  const timeline = mountRenderTimeline(find('.render-timeline'), scene, time, () => {
    clearResult(); find('.export-message').textContent = '';
    if (!pendingFrame) pendingFrame = requestAnimationFrame(() => { pendingFrame = 0; if (!busy && dialog.open && format !== 'muse') { showFrame(); update(); } });
  });
  find<HTMLSelectElement>('[aria-label="Export frame rate"]').value = String(scene.fps ?? 24);
  const showFrame = () => {
    renderer.resize(720, 405); sceneRenderer.render(timeline.time);
    if (preview.firstElementChild !== renderer.canvas) preview.replaceChildren(renderer.canvas);
  };
  const update = () => {
    find('#renderOutputPanel').hidden = format === 'muse'; find('#renderMusePanel').hidden = format !== 'muse';
    find('#renderOutputPanel').setAttribute('aria-labelledby', format === 'image' ? 'renderImageTab' : 'renderVideoTab');
    settings.disabled = busy;
    timeline.setLocked(busy);
    const previewShot = format === 'muse' ? shot : shotAtTime(scene, timeline.time);
    find('[data-shot]').textContent = previewShot ? [previewShot.name, scene.cameras.find(c => c.id === previewShot.cameraId)?.name].filter(Boolean).join(' · ') : scene.cameras[0].name;
    find('[data-video]').hidden = format !== 'video';
    find('.export-range').textContent = format === 'image' ? 'PNG image' : 'WebM video · No audio';
    const issue = format === 'video' ? videoExportIssue() : null;
    const render = find<HTMLButtonElement>('[data-render]'); render.textContent = busy ? 'Rendering…' : format === 'image' ? 'Render still' : 'Render video'; render.disabled = busy || !!issue;
    find('[data-cancel]').hidden = !busy;
    if (issue) find('.export-message').textContent = issue;
    dialog.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(button => { const active = button.dataset.format === format; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; button.disabled = busy || !!preparation?.busy; });
  };
  const cleanup = () => { if (cleaned || busy || preparation?.busy) return; cleaned = true; cancelAnimationFrame(pendingFrame); preparation?.dispose(); clearResult(); renderer.dispose(); dialog.remove(); };
  dialog.addEventListener('close', () => { closing = true; controller?.abort(); preparation?.cancel(); cleanup(); });
  find('[data-close]').onclick = () => dialog.close();
  find('[data-cancel]').onclick = () => { controller?.abort(); find('.export-message').textContent = 'Cancelling…'; };
  dialog.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(button => button.onclick = () => {
    if (busy || preparation?.busy) return;
    format = button.dataset.format as typeof format; clearResult(); find('.export-message').textContent = '';
    if (format === 'muse') {
      try { preparation ??= mountMusePreparation(find('#renderMusePanel'),renderer,shot,workspace,()=>{ if(closing) cleanup(); else update(); }); }
      catch (error) { find('#renderMusePanel').textContent = `References could not be prepared. ${(error as Error).message}`; }
    } else { timeline.setVideo(format === 'video'); showFrame(); }
    update();
  });
  find('.export-tabs').addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const modes = ['image','video','muse'], next = find<HTMLButtonElement>(`[data-format="${modes[(modes.indexOf(format)+(event.key==='ArrowRight'?1:2))%3]}"]`); next.click(); next.focus(); }
  });
  settings.addEventListener('change', () => { clearResult(); timeline.setExportFps(Number(find<HTMLSelectElement>('[aria-label="Export frame rate"]').value)); find('.export-message').textContent = ''; showFrame(); update(); });
  find('[data-render]').onclick = async () => {
    if (busy) return;
    busy = true; controller = new AbortController(); clearResult(); update();
    find('.export-message').textContent = 'Preparing render…'; find('.export-progress').hidden = false;
    find<HTMLProgressElement>('progress').value = 0; find('.export-progress span').textContent = 'Preparing…';
    const width = Number(find<HTMLSelectElement>('[aria-label="Export resolution"]').value);
    const fps = Number(find<HTMLSelectElement>('[aria-label="Export frame rate"]').value);
    const at = timeline.time, range = timeline.range;
    const overlap = scene.shots.filter(s => s.start < range.start + range.duration - 1e-8 && s.start + s.duration > range.start + 1e-8);
    const outputShot = format === 'image' ? shotAtTime(scene, at) : overlap.length === 1 && overlap[0].start <= range.start && overlap[0].start + overlap[0].duration >= range.start + range.duration - 1e-8 ? overlap[0] : undefined;
    const title = outputShot?.name ?? scene.name;
    try {
      renderer.resize(width, width * 9 / 16); preview.replaceChildren(renderer.canvas);
      const blob = format === 'image' ? await exportPNG(sceneRenderer, at) : await exportVideo(sceneRenderer, range, fps, controller.signal, (done, total) => {
        find('.export-message').textContent = done === total ? 'Finalizing video…' : 'Rendering camera motion…';
        find<HTMLProgressElement>('progress').value = done / total;
        find('.export-progress span').textContent = `${done} / ${total} frames · ${Math.round(done / total * 100)}%`;
      });
      controller.signal.throwIfAborted();
      url = URL.createObjectURL(blob);
      const fileBase = title.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-|-$/g, '') || 'render';
      const filename = fileBase + (format === 'image' ? `-${at.toFixed(2)}s.png` : `-${range.start.toFixed(2)}-${(range.start + range.duration).toFixed(2)}s.webm`);
      const download = find<HTMLAnchorElement>('[data-download]'); download.href = url; download.download = filename; download.hidden = false; download.textContent = format === 'image' ? 'Download PNG' : 'Download video';
      const result = document.createElement(format === 'image' ? 'img' : 'video'); result.src = url;
      if (result instanceof HTMLVideoElement) { result.controls = true; result.preload = 'metadata'; } else result.alt = 'Rendered shot frame';
      preview.replaceChildren(result);
      find('[data-cancel]').hidden = true; find('.export-progress').hidden = true;
      find('.export-message').textContent = 'Adding to Renders…';
      try {
        if (blob.size > MAX_OUTPUT_BYTES) throw new Error('This render exceeds the 64 MB project limit. Download it to keep a copy.');
        await workspace.putOutput({ id: newId(), kind: 'shot-render', sceneId: scene.id, shotId: outputShot?.id ?? '', name: `${title} · ${format === 'image' ? at.toFixed(2) + 's still' : range.start.toFixed(2) + '–' + (range.start + range.duration).toFixed(2) + 's video'}`.slice(0,160), mime: format === 'image' ? 'image/png' : 'video/webm' }, blob, room);
        find('.export-message').textContent = `${filename} · ${(blob.size / 1024 / 1024).toFixed(2)} MB · Added to Renders`;
      } catch (error) {
        find('.export-message').textContent = `Rendered, but could not save to Renders. ${(error as Error).message} Your download is still available.`;
      }
    } catch (error) {
      find('.export-message').textContent = controller.signal.aborted ? 'Render cancelled. No partial file was saved.' : (error as Error).message;
      if (dialog.open) { try { showFrame(); } catch {} }
    } finally {
      busy = false; find('.export-progress').hidden = true;
      if (dialog.open) update(); else cleanup();
    }
  };
  document.body.append(dialog);
  try { showFrame(); update(); dialog.showModal(); } catch (error) { cleanup(); throw error; }
}
