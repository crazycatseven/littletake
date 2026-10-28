import * as THREE from 'three';

export interface XRMenuState { playing: boolean; canUndo: boolean; following: boolean; hasCamera: boolean; scale: number }
export const XR_MENU_TOGGLE = 4;
const icons = {
  play: '<path d="m-11-17 29 17-29 17Z"/>',
  pause: '<path d="M-10-17v34M10-17v34"/>',
  undo: '<path d="m-9-17-13 12 13 12M-21-5H3a17 17 0 0 1 17 17v7"/>',
  camera: '<rect x="-24" y="-16" width="33" height="32" rx="5"/><path d="m9-8 16-9v34L9 8"/>',
  free: '<path d="M-24-9v-14h14M10-23h14v14M24 9v14H10M-10 23h-14V9"/><circle r="8"/>',
  exit: '<path d="M-3-23h-17v46H-3M-4 0h29m-10-11L26 0 15 11"/>',
};

/** Shared SVG source for browser textures and offline visual verification. */
export function xrMenuSvg(state: XRMenuState, hovered: ReadonlySet<number> = new Set()): string {
  const mode = state.following ? 'Camera view' : 'Free view';
  const scale = Number.isFinite(state.scale) && state.scale > 0 ? Math.min(20, Math.max(.05, state.scale)) : 1;
  const labels = [state.playing ? 'Pause' : 'Play', 'Undo', state.following ? 'Free view' : 'Follow camera', 'Exit VR'];
  const actions = [0, 1, 3, 2];
  const symbols = [state.playing ? icons.pause : icons.play, icons.undo, state.following ? icons.free : icons.camera, icons.exit];
  const cells = actions.map((action, i) => {
    const disabled = action === 1 && !state.canUndo || action === 3 && !state.hasCamera;
    const hover = !disabled && hovered.has(action), active = action === 0 && state.playing || action === 3 && state.following;
    const fill = disabled ? '#253432' : hover ? '#44655d' : active ? '#35554d' : '#2b403b';
    const ink = disabled ? '#a4b5ae' : action === 2 ? '#efc9b4' : '#f6f3e9';
    const x = 40 + i * 344;
    return `<g><rect x="${x}" y="108" width="328" height="216" rx="16" fill="${fill}"/>
      <g transform="translate(${x + 164} 171)" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${symbols[i]}</g>
      <text x="${x + 164}" y="262" text-anchor="middle" fill="${ink}" font-size="36" font-weight="600">${action === 3 && !state.hasCamera ? 'No camera' : labels[i]}</text>
      ${active ? `<rect x="${x + 146}" y="297" width="36" height="4" rx="2" fill="#d7e9b2"/>` : ''}</g>`;
  }).join('');
  const hint = state.following ? 'Follow the shot. Turn your head to look around.' : 'Grip empty space to move · Two grips to turn &amp; scale';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="400" viewBox="0 0 1440 400">
    <rect x="4" y="4" width="1432" height="392" rx="28" fill="#182b26" stroke="#587167" stroke-width="2"/>
    <g font-family="Segoe UI, Arial, sans-serif"><text x="48" y="68" fill="#f6f3e9" font-size="36" font-weight="600">LittleTake</text>
    <circle cx="1030" cy="56" r="6" fill="#d7e9b2"/><text x="1388" y="68" text-anchor="end" fill="#c7d6ce" font-size="30">${mode} · ${scale.toFixed(2).replace(/\.?0+$/, '')}×</text>
    ${cells}<text x="720" y="368" text-anchor="middle" fill="#c7d6ce" font-size="27">${hint}</text></g></svg>`;
}

export function xrMenuHandleSvg(expanded: boolean, hovered = false): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120" viewBox="0 0 480 120">
    <rect x="3" y="3" width="474" height="114" rx="56" fill="${hovered ? '#44655d' : '#182b26'}" stroke="#789084" stroke-width="2"/>
    <path d="${expanded ? 'm77 69 13-13 13 13' : 'm77 49 13 13 13-13'}" fill="none" stroke="#d7e9b2" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="276" y="73" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="38" font-weight="600" fill="#f6f3e9">${expanded ? 'Hide menu' : 'Menu'}</text></svg>`;
}

class MenuTexture {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  private image?: HTMLImageElement;
  private source = '';
  private disposed = false;
  constructor(width: number, height: number) {
    this.canvas.width = width; this.canvas.height = height;
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
  }
  draw(svg: string): void {
    if (this.disposed || svg === this.source) return;
    this.source = svg;
    if (this.image) this.image.onload = null;
    const image = document.createElement('img'); this.image = image;
    image.onload = () => {
      if (this.disposed || this.image !== image) return;
      const ctx = this.canvas.getContext('2d')!;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); ctx.drawImage(image, 0, 0);
      this.texture.needsUpdate = true;
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  dispose(): void { this.disposed = true; if (this.image) this.image.onload = null; this.texture.dispose(); }
}

/** One visual panel, separate hit targets, and a persistent collapse handle. */
export class XRMenu {
  readonly root = new THREE.Group();
  expanded = true;
  private state: XRMenuState = { playing: false, canUndo: false, following: false, hasCamera: false, scale: 1 };
  private hovered = new Set<number>();
  private stateKey = '';
  private hoverKey = '';
  private panelTexture = new MenuTexture(1440, 400);
  private handleTexture = new MenuTexture(480, 120);
  private panel: THREE.Mesh;
  private handle: THREE.Mesh;
  private buttons: THREE.Mesh[] = [];
  constructor() {
    this.panel = this.plane(.96, .96 * 400 / 1440, this.panelTexture.texture);
    this.panel.position.set(0, -.45, -1.25); this.panel.userData.xrAction = -1;
    this.handle = this.plane(.28, .07, this.handleTexture.texture);
    this.handle.position.set(0, -.26, -1.25); this.handle.userData.xrAction = XR_MENU_TOGGLE;
    [0, 1, 3, 2].forEach((action, index) => {
      const button = this.plane(.96 * 328 / 1440, .96 * 216 / 1440);
      button.position.set(.96 * ((204 + index * 344) / 1440 - .5), -.45 + .96 * (200 - 216) / 1440, -1.249);
      button.userData.xrAction = action; this.buttons.push(button);
    });
    this.repaint();
  }
  private plane(width: number, height: number, map?: THREE.Texture): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: map ?? null, transparent: true, opacity: map ? 1 : 0, depthTest: false, depthWrite: false, toneMapped: false }));
    mesh.renderOrder = 100; this.root.add(mesh); return mesh;
  }
  targets(): THREE.Mesh[] { return this.expanded ? [this.handle, ...this.buttons, this.panel] : [this.handle]; }
  enabled(action: number): boolean {
    return action === XR_MENU_TOGGLE || this.expanded && (action === 0 || action === 2 || action === 1 && this.state.canUndo || action === 3 && this.state.hasCamera);
  }
  toggle(): void {
    this.expanded = !this.expanded; this.hovered.clear(); this.hoverKey = '';
    this.panel.visible = this.expanded; this.buttons.forEach(button => button.visible = this.expanded); this.repaint();
  }
  setState(state: XRMenuState): void {
    const key = JSON.stringify({ ...state, scale: Number(state.scale.toFixed(2)) });
    if (key === this.stateKey) return;
    this.stateKey = key; this.state = state; this.repaint();
  }
  hover(actions: number[]): void {
    const key = [...new Set(actions)].sort().join(','); if (key === this.hoverKey) return;
    this.hoverKey = key; this.hovered = new Set(actions); this.repaint();
  }
  private repaint(): void {
    if (this.expanded) this.panelTexture.draw(xrMenuSvg(this.state, this.hovered));
    this.handleTexture.draw(xrMenuHandleSvg(this.expanded, this.hovered.has(XR_MENU_TOGGLE)));
  }
  dispose(): void {
    this.root.removeFromParent(); this.panelTexture.dispose(); this.handleTexture.dispose();
    for (const child of this.root.children) { const mesh = child as THREE.Mesh; mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
  }
}
