import './dialog.css';
import type { Shot } from '../types';
import { exportPNG, exportVideo, videoExportIssue } from './export';
import type { ShotRenderer } from './renderer';

/** A dialog owns one frozen scene snapshot and releases it on close. */
export function openShotExport(renderer: ShotRenderer, shot: Shot, time: number): void {
  shot = structuredClone(shot);
  const camera = renderer.document.cameras.find(item => item.id === shot.cameraId)!;
  const hidden = renderer.document.objects.filter(item => item.hidden).length;
  const dialog = document.createElement('dialog'); dialog.className = 'shot-export-dialog';
  dialog.setAttribute('aria-label', 'Export shot');
  dialog.innerHTML = `<div class="export-heading"><div><small>SHOT OUTPUT</small><h2>Export shot</h2></div><button data-close aria-label="Close export">✕</button></div>
    <p data-shot class="export-subtitle"></p><div class="export-layout"><div><div class="export-preview"></div><p class="export-frame-caption"></p></div>
    <div><fieldset class="export-settings"><div class="export-tabs" role="tablist" aria-label="Output format"><button role="tab" data-format="image" aria-selected="true">Still image</button><button role="tab" data-format="video" aria-selected="false">Video</button></div>
    <label>Resolution<select aria-label="Export resolution"><option value="1920">1920 × 1080</option><option value="1280">1280 × 720</option></select></label>
    <label data-video hidden>Frame rate<select aria-label="Export frame rate"><option value="24">24 fps</option><option value="30">30 fps</option></select></label>
    <p class="export-range"></p><p class="export-exclusions">${hidden} hidden object${hidden === 1 ? '' : 's'} excluded<br>Clean camera view · no editor overlays</p></fieldset>
    <div class="export-progress" hidden><progress max="1" value="0"></progress><span role="status"></span></div><p class="export-message" role="status" aria-live="polite"></p>
    <div class="export-actions"><button data-cancel hidden>Cancel export</button><button data-render class="primary-button">Export PNG</button><a data-download class="primary-button" hidden>Download PNG</a></div></div></div>`;
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  find('[data-shot]').textContent = shot.name + ' · ' + camera.name;
  const preview = find('.export-preview'), settings = find<HTMLFieldSetElement>('.export-settings');
  preview.append(renderer.canvas);
  let format: 'image' | 'video' = 'image', busy = false, url: string | null = null, controller: AbortController | null = null;
  const clearResult = () => { if (url) URL.revokeObjectURL(url); url = null; find('[data-download]').hidden = true; };
  const showFrame = () => {
    renderer.resize(720, 405); preview.replaceChildren(renderer.render(format === 'image' ? time : shot.start));
    find('.export-frame-caption').textContent = format === 'image' ? `Scene time ${time.toFixed(2)}s · current frame` : `Scene time ${shot.start.toFixed(2)}–${(shot.start + shot.duration).toFixed(2)}s`;
  };
  const update = () => {
    settings.disabled = busy;
    find('[data-video]').hidden = format !== 'video';
    find('.export-range').textContent = format === 'image' ? `PNG · Frame at ${time.toFixed(2)}s` : `WebM · ${shot.duration.toFixed(2)} seconds · silent video`;
    const issue = format === 'video' ? videoExportIssue() : null;
    const render = find<HTMLButtonElement>('[data-render]'); render.textContent = busy ? 'Rendering…' : format === 'image' ? 'Export PNG' : 'Export video'; render.disabled = busy || !!issue;
    find('[data-cancel]').hidden = !busy;
    if (issue) find('.export-message').textContent = issue;
    dialog.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(button => { const active = button.dataset.format === format; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  };
  const cleanup = () => { clearResult(); renderer.dispose(); dialog.remove(); };
  dialog.addEventListener('close', () => { controller?.abort(); if (!busy) cleanup(); });
  find('[data-close]').onclick = () => dialog.close();
  find('[data-cancel]').onclick = () => { controller?.abort(); find('.export-message').textContent = 'Cancelling…'; };
  dialog.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(button => button.onclick = () => {
    format = button.dataset.format as typeof format; clearResult(); find('.export-message').textContent = ''; showFrame(); update();
  });
  find('.export-tabs').addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = find<HTMLButtonElement>(`[data-format="${format === 'image' ? 'video' : 'image'}"]`); next.click(); next.focus(); }
  });
  settings.addEventListener('change', () => { clearResult(); find('.export-message').textContent = ''; showFrame(); update(); });
  find('[data-render]').onclick = async () => {
    if (busy) return;
    busy = true; controller = new AbortController(); clearResult(); update();
    find('.export-message').textContent = 'Preparing export…'; find('.export-progress').hidden = false;
    find<HTMLProgressElement>('progress').value = 0; find('.export-progress span').textContent = 'Preparing…';
    const width = Number(find<HTMLSelectElement>('[aria-label="Export resolution"]').value);
    const fps = Number(find<HTMLSelectElement>('[aria-label="Export frame rate"]').value);
    try {
      renderer.resize(width, width * 9 / 16); preview.replaceChildren(renderer.canvas);
      const blob = format === 'image' ? await exportPNG(renderer, time) : await exportVideo(renderer, shot, fps, controller.signal, (done, total) => {
        find('.export-message').textContent = done === total ? 'Finalizing video…' : 'Rendering camera motion…';
        find<HTMLProgressElement>('progress').value = done / total;
        find('.export-progress span').textContent = `${done} / ${total} frames · ${Math.round(done / total * 100)}%`;
      });
      controller.signal.throwIfAborted();
      url = URL.createObjectURL(blob);
      const filename = (shot.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'shot') + (format === 'image' ? `-${time.toFixed(2)}s.png` : '.webm');
      const download = find<HTMLAnchorElement>('[data-download]'); download.href = url; download.download = filename; download.hidden = false; download.textContent = format === 'image' ? 'Download PNG' : 'Download video';
      const result = document.createElement(format === 'image' ? 'img' : 'video'); result.src = url;
      if (result instanceof HTMLVideoElement) { result.controls = true; result.preload = 'metadata'; } else result.alt = 'Exported shot frame';
      preview.replaceChildren(result);
      find('.export-message').textContent = `${filename} · ${(blob.size / 1024 / 1024).toFixed(2)} MB · ready to download`;
    } catch (error) {
      find('.export-message').textContent = controller.signal.aborted ? 'Export cancelled. No partial file was saved.' : (error as Error).message;
      if (dialog.open) { try { showFrame(); } catch {} }
    } finally {
      busy = false; find('.export-progress').hidden = true;
      if (dialog.open) update(); else cleanup();
    }
  };
  document.body.append(dialog);
  try { showFrame(); update(); dialog.showModal(); } catch (error) { cleanup(); throw error; }
}
