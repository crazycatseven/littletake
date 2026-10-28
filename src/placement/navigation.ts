import { Camera, Vector3 } from 'three';

const axes = [
  { name: 'Right', label: 'X', color: '#b97563', direction: [1, 0, 0] },
  { name: 'Left', label: '−X', color: '#b97563', direction: [-1, 0, 0] },
  { name: 'Top', label: 'Y', color: '#81945d', direction: [0, 1, 0] },
  { name: 'Bottom', label: '−Y', color: '#81945d', direction: [0, -1, 0] },
  { name: 'Front', label: 'Z', color: '#7796a8', direction: [0, 0, 1] },
  { name: 'Back', label: '−Z', color: '#7796a8', direction: [0, 0, -1] },
];
const NS = 'http://www.w3.org/2000/svg';

/** Clickable directions and a single captured drag surface, independent of SVG depth order. */
export class ViewNavigation {
  readonly root = document.createElement('div');
  private readonly svg = document.createElementNS(NS, 'svg');
  private readonly projection = document.createElement('button');
  private readonly nodes = axes.map(axis => {
    const group = document.createElementNS(NS, 'g'), line = document.createElementNS(NS, 'line'), circle = document.createElementNS(NS, 'circle'), text = document.createElementNS(NS, 'text');
    group.dataset.view = axis.name;
    group.setAttribute('role', 'button'); group.setAttribute('tabindex', '0'); group.setAttribute('aria-label', `${axis.name} view`);
    line.setAttribute('stroke', axis.color); line.setAttribute('stroke-width', '2');
    circle.setAttribute('r', '11'); circle.setAttribute('fill', axis.color);
    text.textContent = axis.label; text.setAttribute('text-anchor', 'middle'); text.setAttribute('dy', '.35em');
    group.append(line, circle, text); this.svg.append(group);
    return { axis, group, line, circle, text };
  });
  private drag: { id: number; x: number; y: number; lastX: number; lastY: number; moved: boolean; view?: string } | null = null;
  private enabled = true;
  constructor(host: HTMLElement, private readonly actions: { snap(direction: Vector3): void; orbit(dx: number, dy: number): void; projection(): void; begin(): void; end(): void }) {
    this.root.className = 'view-navigation';
    this.svg.setAttribute('viewBox', '0 0 112 100'); this.svg.setAttribute('aria-label', 'View orientation — drag to orbit');
    this.projection.type = 'button'; this.projection.title = 'Switch perspective / orthographic';
    this.projection.addEventListener('click', () => { if (this.enabled) actions.projection(); });
    this.root.append(this.svg, this.projection); host.append(this.root);
    this.svg.addEventListener('keydown', event => {
      if (!this.enabled || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault(); this.snap((event.target as Element).closest<SVGGElement>('[data-view]')?.dataset.view);
    });
    this.svg.addEventListener('pointerdown', event => {
      if (!this.enabled || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, view: (event.target as Element).closest<SVGGElement>('[data-view]')?.dataset.view };
      this.svg.setPointerCapture(event.pointerId); this.root.classList.add('dragging'); actions.begin();
    });
    this.svg.addEventListener('pointermove', event => {
      const drag = this.drag; if (!drag || drag.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) drag.moved = true;
      if (drag.moved) actions.orbit(event.clientX - drag.lastX, event.clientY - drag.lastY);
      drag.lastX = event.clientX; drag.lastY = event.clientY;
    });
    this.svg.addEventListener('pointerup', event => {
      const drag = this.drag; if (!drag || drag.id !== event.pointerId) return;
      this.finish(); if (!drag.moved) this.snap(drag.view);
    });
    this.svg.addEventListener('pointercancel', () => this.finish());
    this.svg.addEventListener('lostpointercapture', () => this.finish());
  }
  private snap(name?: string): void {
    const axis = axes.find(axis => axis.name === name);
    if (axis) this.actions.snap(new Vector3(...axis.direction as [number, number, number]));
  }
  private finish(): void {
    const drag = this.drag; this.drag = null; this.root.classList.remove('dragging');
    if (drag && this.svg.hasPointerCapture(drag.id)) this.svg.releasePointerCapture(drag.id);
    if (drag) this.actions.end();
  }
  update(camera: Camera, orthographic: boolean, enabled: boolean): void {
    this.enabled = enabled; this.root.inert = !enabled;
    this.projection.textContent = orthographic ? 'Orthographic' : 'Perspective';
    this.projection.setAttribute('aria-label', `${orthographic ? 'Orthographic' : 'Perspective'} view — switch projection`);
    const inverse = camera.quaternion.clone().invert();
    const ordered = this.nodes.map(node => ({ node, v: new Vector3(...node.axis.direction as [number, number, number]).applyQuaternion(inverse) })).sort((a, b) => a.v.z - b.v.z);
    for (const { node, v } of ordered) {
      const x = 56 + v.x * 32, y = 48 - v.y * 32;
      node.line.setAttribute('x1', '56'); node.line.setAttribute('y1', '48'); node.line.setAttribute('x2', String(x)); node.line.setAttribute('y2', String(y));
      node.circle.setAttribute('cx', String(x)); node.circle.setAttribute('cy', String(y)); node.text.setAttribute('x', String(x)); node.text.setAttribute('y', String(y));
      node.group.style.opacity = v.z < -.2 ? '.48' : '1';
    }
    if (ordered.some(({ node }, i) => this.svg.children[i] !== node.group)) ordered.forEach(({ node }) => this.svg.append(node.group));
  }
  dispose(): void { this.finish(); this.root.remove(); }
}
