import { frameAtTime, timeAtFrame } from '../animation/model';
import { shotAtTime } from '../model';
import type { SceneDocument } from '../types';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const seconds = (value: number) => value.toFixed(2) + ' s';
type TrimPart = 'start' | 'end' | 'range';

/** The right trim edge is exclusive. Shot boundaries can fall between scene frames. */
export function trimRange(part: TrimPart, time: number, initial: { start: number; end: number }, duration: number, fps: number, cuts: number[], tolerance: number) {
  const step = 1 / fps;
  const length = initial.end - initial.start;
  const candidates = part === 'range' ? [...cuts, ...cuts.map(cut => cut - length)] : cuts;
  const min = part === 'end' ? initial.start + step : 0;
  const max = part === 'start' ? initial.end - step : part === 'range' ? duration - length : duration;
  const nearest = candidates.filter(cut => cut >= min && cut <= max && Math.abs(cut - time) <= tolerance)
    .sort((a, b) => Math.abs(a - time) - Math.abs(b - time))[0];
  const value = clamp(nearest ?? timeAtFrame(frameAtTime(time, fps), fps), min, max);
  if (part === 'range') return { start: value, end: Math.min(duration, value + length) };
  return { ...initial, [part]: value };
}

export function mountRenderTimeline(root: HTMLElement, scene: SceneDocument, openingTime: number, changed: () => void) {
  const fps = scene.fps ?? 24, duration = scene.duration;
  const lastFrame = Math.max(0, Math.ceil(duration * fps - 1e-8) - 1);
  const shots = [...scene.shots].sort((a, b) => a.start - b.start);
  const cuts = [...new Set([0, duration, ...shots.flatMap(shot => [shot.start, shot.start + shot.duration])])];
  let stillFrame = clamp(frameAtTime(openingTime, fps), 0, lastFrame);
  const fullRange = { start: 0, end: duration };
  let range = fullRange;
  let videoTime = range.start, video = false, locked = false;
  let exportFps: number = fps;
  root.innerHTML = `<div class="render-time-header"><strong data-title></strong>
    <div data-still-input><label>Frame <input type="number" min="0" step="1" aria-label="Still frame number"></label></div>
    <button type="button" data-full hidden>Full scene</button></div>
    <div class="render-scrub"><div class="render-ticks" aria-hidden="true"></div><input type="range" min="0" step="1" aria-label="Preview frame" title="Scrub the scene"></div>
    <div class="render-shot-strip" role="group" aria-label="Scene shots"></div>
    <div class="render-trim" role="group" aria-label="Video trim"><div class="render-trim-band" data-part="range" title="Drag to move the selected range"></div>
      <button data-part="start" role="slider" aria-label="Trim start"></button><button data-part="end" role="slider" aria-label="Trim end"></button></div>
    <div class="render-time-footer"><span data-readout></span><span data-length></span></div>`;
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const frameInput = find<HTMLInputElement>('input[type=number]'), scrub = find<HTMLInputElement>('input[type=range]');
  const fullScene = find<HTMLButtonElement>('[data-full]'), rail = find('.render-trim');
  const start = find<HTMLButtonElement>('[data-part=start]'), end = find<HTMLButtonElement>('[data-part=end]');
  frameInput.max = scrub.max = String(lastFrame);
  for (let i = 0; i <= 4; i++) {
    const tick = document.createElement('span');
    tick.textContent = Number((i * duration / 4).toFixed(2)) + 's'; find('.render-ticks').append(tick);
  }
  const ratio = (t: number) => (100 * t / duration) + '%';
  const time = () => video ? videoTime : timeAtFrame(stillFrame, fps);
  const draw = () => {
    const at = time(), frame = clamp(frameAtTime(at, fps), 0, lastFrame);
    find('[data-title]').textContent = video ? 'Clip range' : 'Choose a frame';
    find('[data-still-input]').hidden = video;
    rail.hidden = !video;
    fullScene.hidden = !video || (range.start === 0 && Math.abs(duration - range.end) < 1e-7);
    frameInput.value = scrub.value = String(frame);
    root.style.setProperty('--render-cursor', ratio(at));
    scrub.setAttribute('aria-valuetext', `Frame ${frame}, ${seconds(at)}`);
    root.style.setProperty('--trim-start', ratio(range.start)); root.style.setProperty('--trim-end', ratio(range.end));
    for (const [handle, value, min, max] of [[start, range.start, 0, range.end - 1/fps], [end, range.end, range.start + 1/fps, duration]] as const) {
      handle.setAttribute('aria-valuenow', value.toFixed(4)); handle.setAttribute('aria-valuetext', seconds(value));
      handle.setAttribute('aria-valuemin', String(min)); handle.setAttribute('aria-valuemax', String(max));
      handle.title = handle.getAttribute('aria-label') + ' · ' + seconds(value);
    }
    const active = shotAtTime(scene, at);
    for (const chip of root.querySelectorAll<HTMLButtonElement>('[data-shot-id]')) {
      const selected = video ? shots.some(s => s.id === chip.dataset.shotId && s.start === range.start && Math.abs(s.start + s.duration - range.end) < 1e-7) : active?.id === chip.dataset.shotId;
      chip.setAttribute('aria-pressed', String(selected));
    }
    find('[data-readout]').textContent = video ? `${seconds(range.start)} – ${seconds(range.end)}` : seconds(at);
    find('[data-length]').textContent = video ? seconds(range.end - range.start) + ' selected' : `${fps} fps · ${seconds(duration)}`;
  };
  const refresh = () => { draw(); changed(); };
  const seekFrame = (frame: number) => {
    if (!Number.isFinite(frame) || locked) return;
    frame = clamp(Math.round(frame), 0, lastFrame);
    if (video) videoTime = timeAtFrame(frame, fps); else stillFrame = frame;
    refresh();
  };
  frameInput.onchange = () => { seekFrame(frameInput.valueAsNumber); draw(); };
  scrub.oninput = () => seekFrame(scrub.valueAsNumber);
  // Native range controls reserve space for a thumb. Align pointer scrubbing to
  // the same full-width time scale as the shot blocks and trim handles.
  const scrubPointer = (event: PointerEvent) => {
    const bounds = scrub.getBoundingClientRect();
    seekFrame(frameAtTime((event.clientX - bounds.left) / bounds.width * duration, fps));
  };
  scrub.onpointerdown = event => {
    if (locked || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); scrub.focus({ preventScroll: true }); scrub.setPointerCapture(event.pointerId); scrubPointer(event);
  };
  scrub.onpointermove = event => { if (scrub.hasPointerCapture(event.pointerId)) scrubPointer(event); };
  for (const shot of shots) {
    const chip = document.createElement('button'); chip.type = 'button'; chip.dataset.shotId = shot.id;
    chip.style.left = ratio(shot.start); chip.style.width = ratio(Math.min(shot.duration, duration - shot.start));
    chip.textContent = shot.name; chip.title = `${shot.name} · ${seconds(shot.start)} – ${seconds(shot.start + shot.duration)}`;
    chip.onclick = () => {
      if (video) { range = { start: shot.start, end: Math.min(duration, shot.start + shot.duration) }; videoTime = range.start; }
      else stillFrame = clamp(Math.ceil(shot.start * fps - 1e-8), 0, lastFrame);
      refresh();
    };
    find('.render-shot-strip').append(chip);
  }
  fullScene.onclick = () => { range = fullRange; videoTime = fullRange.start; refresh(); };
  const move = (part: TrimPart, to: number, initial: typeof range, tolerance: number) => {
    range = trimRange(part, to, initial, duration, fps, cuts, tolerance);
    const last = Math.max(0, Math.ceil((range.end - range.start) * exportFps - 1e-8) - 1);
    videoTime = part === 'end' ? range.start + last / exportFps : range.start;
    refresh();
  };
  let drag: { id: number; part: TrimPart; x: number; initial: typeof range; width: number } | undefined;
  rail.onpointerdown = event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-part]');
    if (!target || locked || event.button !== 0 || drag) return;
    const part = target.dataset.part as TrimPart;
    drag = { id: event.pointerId, part, x: event.clientX, initial: { ...range }, width: rail.getBoundingClientRect().width };
    if (part !== 'range') target.focus({ preventScroll: true });
    rail.setPointerCapture(event.pointerId); event.preventDefault();
  };
  rail.onpointermove = event => {
    if (!drag || drag.id !== event.pointerId || locked) return;
    const from = drag.part === 'end' ? drag.initial.end : drag.initial.start;
    move(drag.part, from + (event.clientX - drag.x) / drag.width * duration, drag.initial, 8 / drag.width * duration);
  };
  rail.onlostpointercapture = () => { drag = undefined; };
  for (const [handle, part] of [[start,'start'], [end,'end']] as const) {
    handle.onkeydown = event => {
      const value = range[part], step = (event.shiftKey ? 10 : 1) / fps;
      const to = ({ ArrowLeft: value - step, ArrowRight: value + step, Home: 0, End: duration } as Record<string,number>)[event.key];
      if (to === undefined || locked) return;
      event.preventDefault(); move(part, to, range, 0);
    };
  }
  draw();
  return {
    get time() { return time(); }, get range() { return { start: range.start, duration: range.end - range.start }; },
    setVideo(value: boolean) { video = value; draw(); },
    setExportFps(value: number) { exportFps = value; },
    setLocked(value: boolean) { locked = value; root.inert = value; }
  };
}
