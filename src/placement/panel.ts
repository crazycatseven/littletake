import './panel.css';

export interface PrecisionSettings { space: 'world' | 'local'; snap: boolean; move: number; rotate: number }
export type AlignmentEdge = 'min' | 'center' | 'max';

/** Viewport settings are editor preferences, not scene content. */
export class PlacementPanel {
  readonly settings: PrecisionSettings = {space: 'world', snap: false, move: .25, rotate: 15};
  constructor(private root: HTMLElement, change: (settings: PrecisionSettings) => void, align: (axis: number, edge: AlignmentEdge) => void) {
    root.className = 'placement-tools';
    root.innerHTML = `<button data-space title="Move and rotate axes · Scaling uses local axes" aria-label="Transform space">World</button>
      <div class="snap-control"><button data-snap aria-pressed="false" title="Snap viewport movement and rotation">Snap</button><details><summary aria-label="Snap settings">⌄</summary><div class="placement-popover"><strong>Snap increments</strong><label>Move · meters<input data-step="move" aria-label="Move snap increment" type="number" min="0.01" max="100" step="0.01" value="0.25"></label><label>Rotate · degrees<input data-step="rotate" aria-label="Rotation snap increment" type="number" min="1" max="180" step="1" value="15"></label><p>Applied while dragging the transform handles.</p></div></details></div>
      <details class="alignment-menu"><summary>Align</summary><div class="placement-popover"><strong>Align in world space</strong><p data-reference>Select two visible objects.</p>${[['X','Left','Center','Right'],['Y','Bottom','Center','Top'],['Z','Back','Center','Front']].map(([axis,...labels],i)=>`<div class="alignment-row"><span>${axis}</span>${labels.map((label,j)=>`<button data-align="${i}" data-edge="${['min','center','max'][j]}" aria-label="Align ${axis} ${label}">${label}</button>`).join('')}</div>`).join('')}<p>The reference stays in place. Motion paths move with each object.</p></div></details>`;
    root.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button) return;
      if (button.hasAttribute('data-space')) { this.settings.space = this.settings.space === 'world' ? 'local' : 'world'; button.textContent = this.settings.space === 'world' ? 'World' : 'Local'; change(this.settings); }
      if (button.hasAttribute('data-snap')) { this.settings.snap = !this.settings.snap; button.setAttribute('aria-pressed', String(this.settings.snap)); change(this.settings); }
      if (button.dataset.align !== undefined) align(Number(button.dataset.align), button.dataset.edge as AlignmentEdge);
    });
    const updateStep = (event: Event) => {
      event.stopPropagation();
      const input = event.target as HTMLInputElement, key = input.dataset.step as 'move' | 'rotate';
      if (!key) return;
      if (input.validity.valid && Number.isFinite(input.valueAsNumber)) { this.settings[key] = input.valueAsNumber; change(this.settings); }
      if (event.type === 'change') input.value = String(this.settings[key]);
    };
    root.addEventListener('input', updateStep);
    root.addEventListener('change', updateStep);
    root.querySelectorAll('details').forEach(details => details.addEventListener('toggle', () => {
      if (details.open) root.querySelectorAll('details').forEach(other => { if (other !== details) other.open = false; });
    }));
    document.addEventListener('pointerdown', event => { if (!root.contains(event.target as Node)) root.querySelectorAll('details').forEach(node => node.open = false); });
    root.addEventListener('keydown', event => { if (event.key === 'Escape') { root.querySelectorAll('details').forEach(node => node.open = false); event.stopPropagation(); } });
  }
  update(names: string[], disabled: boolean): void {
    this.root.querySelector<HTMLElement>('[data-reference]')!.textContent = names.length > 1 ? 'Reference: ' + names.at(-1) + ' · last selected' : 'Select two visible objects.';
    this.root.querySelectorAll<HTMLButtonElement>('[data-align]').forEach(button => button.disabled = disabled || names.length < 2);
    this.root.querySelectorAll<HTMLButtonElement>('[data-space],[data-snap]').forEach(button => button.disabled = disabled);
  }
}
