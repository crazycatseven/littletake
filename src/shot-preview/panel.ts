import './panel.css';

type Position = { x: number; y: number };

/** Layout preferences belong to this browser, never to the shared scene. */
export function bindShotPreview(panel: HTMLElement): void {
  const host = panel.parentElement!;
  const header = panel.querySelector<HTMLElement>('[data-preview-header]')!;
  const handle = panel.querySelector<HTMLButtonElement>('[data-preview-drag]')!;
  const toggle = panel.querySelector<HTMLButtonElement>('[data-preview-collapse]')!;
  const body = panel.querySelector<HTMLElement>('#shotPreviewBody')!;
  const storageKey = 'littletake.shot-preview.layout';
  let position: Position | null = null, collapsed = false;
  let drag: { pointer: number; x: number; y: number; start: Position; before: Position | null } | null = null;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Number.isFinite(saved?.position?.x) && Number.isFinite(saved?.position?.y)) position = saved.position;
    collapsed = saved?.collapsed === true;
  } catch {}

  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify({ position, collapsed })); } catch {}
  }

  function layout() {
    if (!panel.offsetWidth || !host.clientWidth || !host.clientHeight) return;
    position ??= { x: panel.offsetLeft, y: panel.offsetTop };
    const maxX = Math.max(8, host.clientWidth - panel.offsetWidth - 8);
    const maxY = Math.max(8, host.clientHeight - panel.offsetHeight - 8);
    panel.style.left = `${Math.max(8, Math.min(maxX, position.x))}px`;
    panel.style.top = `${Math.max(8, Math.min(maxY, position.y))}px`;
    panel.style.right = 'auto';
  }

  function setCollapsed(value: boolean) {
    if (value && body.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    collapsed = value;
    body.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} shot preview`);
    toggle.title = `${collapsed ? 'Expand' : 'Collapse'} shot preview`;
    toggle.firstElementChild!.textContent = collapsed ? '⌃' : '⌄';
    layout();
  }

  function reset() {
    position = null;
    panel.style.removeProperty('left'); panel.style.removeProperty('top'); panel.style.removeProperty('right');
    layout(); save();
  }

  panel.addEventListener('pointerdown', event => {
    const target = event.target as Element;
    if (!target.closest('.shot-preview-header,.shot-heading') || event.button !== 0 || drag || (target.closest('button,select,input') && !handle.contains(target))) return;
    layout();
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, start: { x: panel.offsetLeft, y: panel.offsetTop }, before: position && { ...position } };
    header.setPointerCapture(event.pointerId); handle.focus({ preventScroll: true });
    panel.classList.add('is-dragging'); event.preventDefault(); event.stopPropagation();
  });
  header.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    position = { x: drag.start.x + event.clientX - drag.x, y: drag.start.y + event.clientY - drag.y };
    layout(); event.preventDefault(); event.stopPropagation();
  });
  function finish(commit: boolean) {
    if (!drag) return;
    const pointer = drag.pointer;
    position = commit ? { x: panel.offsetLeft, y: panel.offsetTop } : drag.before;
    drag = null; panel.classList.remove('is-dragging');
    if (header.hasPointerCapture(pointer)) header.releasePointerCapture(pointer);
    layout(); if (commit) save();
  }
  header.addEventListener('pointerup', event => { if (event.pointerId === drag?.pointer) finish(true); });
  header.addEventListener('pointercancel', () => finish(false));
  header.addEventListener('lostpointercapture', () => finish(false));
  header.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { finish(false); event.preventDefault(); event.stopPropagation(); }
  });
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Home') { reset(); return; }
    const step = event.shiftKey ? 32 : 8;
    position = { x: panel.offsetLeft + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), y: panel.offsetTop + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) };
    layout(); position = { x: panel.offsetLeft, y: panel.offsetTop }; save();
  });
  toggle.addEventListener('click', () => { setCollapsed(!collapsed); save(); });
  const observer = new ResizeObserver(layout); observer.observe(host); observer.observe(panel);
  setCollapsed(collapsed);
}
