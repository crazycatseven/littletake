import type { AIStoryboard } from './ai-storyboard';

/** A whole-sheet preview and one generation action, with optional controls for its four moments. */
export function drawBoardPanel(root: HTMLElement, board: AIStoryboard, disabled: boolean, available: boolean,
  run: (operation: (signal: AbortSignal) => Promise<void>) => void) {
  const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
  const expanded = root.querySelector<HTMLDetailsElement>('.board-moments')?.open ?? false;
  const scroll = root.querySelector('.board-content')?.scrollTop ?? 0;
  const compare = root.dataset.compare === 'true';
  root.replaceChildren();
  const toolbar = document.createElement('div'); toolbar.className = 'board-toolbar';
  if (board.result) {
    const toggle = document.createElement('button'); toggle.textContent = 'Compare proxy'; toggle.disabled = disabled; toggle.setAttribute('aria-pressed', String(compare));
    toggle.onclick = () => { root.dataset.compare = String(!compare); drawBoardPanel(root, board, disabled, available, run); }; toolbar.append(toggle);
  }
  const help = document.createElement('p'); help.className = 'board-help';
  help.textContent = !available ? 'Muse Image is unavailable.'
    : board.result && !board.current ? 'Previous storyboard. Regenerate to apply your changes.' : '';
  if (help.textContent) root.append(help);
  if (board.saveError) {
    const error = document.createElement('p'); error.className = 'board-error'; error.textContent = `Saving could not finish. Your work is kept in this tab. ${board.saveError}`; error.setAttribute('role', 'alert');
    const retry = document.createElement('button'); retry.textContent = 'Retry save'; retry.disabled = disabled; retry.onclick = () => run(() => board.retrySave()); root.append(error, retry);
  }
  const content = document.createElement('div'); content.className = 'board-content'; root.append(content);
  const figure = document.createElement('figure'); figure.className = 'board-sheet';
  const caption = document.createElement('figcaption');
  const timing = (board.result?.panels ?? board.panels.map(panel => panel.data)).map(panel => panel.at.toFixed(2) + ' s').join(' · ');
  if (board.result && !compare) {
    const image = new Image(); image.src = board.result.image; image.alt = 'Generated 2 by 2 storyboard';
    image.onload = () => { caption.textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${timing}`; };
    figure.append(image); caption.textContent = timing;
  } else {
    const grid = document.createElement('div'); grid.className = 'board-proxy-grid';
    const frames = board.result?.panels.map(panel => panel.previs) ?? board.panels.map(panel => panel.source.previs);
    frames.forEach((source, i) => { const image = new Image(); image.src = source; image.alt = `Proxy panel ${i + 1}`; grid.append(image); });
    figure.append(grid); caption.textContent = `Proxy · ${timing}`;
  }
  figure.append(caption); content.append(figure);
  if (toolbar.childElementCount) content.append(toolbar);
  const details = document.createElement('details'); details.className = 'board-moments'; details.open = expanded;
  const summary = document.createElement('summary'); summary.textContent = 'Edit moments & actions'; details.append(summary);
  const grid = document.createElement('div'); grid.className = 'board-grid'; details.append(grid); content.append(details);
  for (const [index, panel] of board.panels.entries()) {
    const card = document.createElement('article'); card.className = 'board-card';
    const image = new Image(); image.src = panel.source.previs; image.alt = `Selected moment ${index + 1}`; image.className = 'board-moment-image'; card.append(image);
    const heading = document.createElement('div'); heading.className = 'board-card-heading';
    const title = document.createElement('strong'); title.textContent = `Panel ${index + 1}`;
    const label = document.createElement('label'); label.textContent = 's';
    const time = document.createElement('input'); time.type = 'number'; time.step = String(1 / board.fps); time.min = '0'; time.max = String(Math.max(0, (Math.ceil(board.shot.duration * board.fps - 1e-7) - 1) / board.fps)); time.value = panel.data.at.toFixed(3); time.disabled = disabled || index === 0; time.setAttribute('aria-label', `Panel ${index + 1} time`);
    time.onchange = () => run(() => board.setTime(panel, Number(time.value))); label.prepend(time); heading.append(title, label); card.append(heading);
    const note = document.createElement('textarea'); note.rows = 2; note.maxLength = 600; note.placeholder = 'Action at this moment, e.g. ducks the swipe, weight on the back foot…'; note.value = panel.data.note; note.disabled = disabled; note.setAttribute('aria-label', `Panel ${index + 1} direction`);
    note.oninput = () => { panel.data.note = note.value; };
    // Preserve normal typing/undo. Generation also snapshots unsaved text on an immediate click.
    note.onchange = () => { setTimeout(() => { if (!board.busy) run(() => board.setNote(panel, note.value)); }, 0); };
    card.append(note); grid.append(card);
  }
  content.scrollTop = scroll;
  if (focused && !disabled) root.querySelector<HTMLElement>(`[aria-label="${focused}"]`)?.focus({ preventScroll: true });
}
