import * as THREE from 'three';
import { MenuTexture } from './texture';
import { keyframeAtTimeline, xrTimelineSvg, type XRTimelineState } from './timeline';
import type { XRRecordingState } from './recording';

export interface XRMenuState { playing: boolean; canUndo: boolean; following: boolean; hasCamera: boolean; scale: number; timeline?: boolean; dragging?: boolean; timelineDragging?: boolean }
export const XR_MENU_TOGGLE = 4;
export const XR_MENU_DRAG = 6;
export const XR_TIMELINE_DRAG = 7;
export const XR_ADD_KEY = 8;
export const XR_DELETE_KEY = 9;
export const XR_RECORD = 10, XR_RECORD_PREVIEW = 11, XR_RECORD_APPLY = 12, XR_RECORD_DISCARD = 13;
export function xrRecordingSvg(state: XRRecordingState, hovered: ReadonlySet<number> = new Set()): string {
  const review = state.mode === 'review', active = state.mode !== 'idle';
  const status = state.mode === 'recording' ? 'Recording · Release to smooth and review' : state.mode === 'armed' ? 'Ready · Hold trigger or grip on the selected object' : review ? `Smoothed take · ${state.samples} samples → ${state.keys} pose keys · Apply replaces this time range` : 'Single-hand recording · Select an object, then Record';
  const labels = [state.mode === 'recording' ? 'Recording' : state.mode === 'armed' ? 'Armed' : 'Record', state.previewing ? 'Pause preview' : 'Preview', 'Apply', 'Discard'];
  const enabled = [!active && state.canRecord, review, review, active && state.mode !== 'recording'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="180" viewBox="0 0 1440 180"><rect x="4" y="4" width="1432" height="172" rx="20" fill="#182b26" stroke="${active ? '#ffbd66' : '#587167'}" stroke-width="3"/>
    <g font-family="Segoe UI, Arial, sans-serif"><circle cx="36" cy="36" r="8" fill="${state.mode === 'recording' ? '#ff837a' : active ? '#ffbd66' : '#789084'}"/><text x="58" y="45" fill="#f6f3e9" font-size="26">${status}</text>
    ${labels.map((label,i)=>{const x=24+i*352,hover=enabled[i]&&hovered.has(XR_RECORD+i);return `<rect x="${x}" y="68" width="336" height="88" rx="12" fill="${hover?'#c9f86b':'#2b403b'}" stroke="${enabled[i]?'#c9f86b':'#587167'}" stroke-width="${hover?5:2}"/><text x="${x+168}" y="123" text-anchor="middle" fill="${hover?'#10231e':enabled[i]?'#f6f3e9':'#a4b5ae'}" font-size="32">${label}</text>`;}).join('')}</g></svg>`;
}
const icons = {
  camera: '<rect x="-24" y="-16" width="33" height="32" rx="5"/><path d="m9-8 16-9v34L9 8"/>',
  free: '<path d="M-24-9v-14h14M10-23h14v14M24 9v14H10M-10 23h-14V9"/><circle r="8"/>',
  timeline: '<path d="M-24 0h48M-14-12v24M0-20v40M14-12v24"/>',
  exit: '<path d="M-3-23h-17v46H-3M-4 0h29m-10-11L26 0 15 11"/>',
};

/** Shared SVG source for browser textures and offline visual verification. */
export function xrMenuSvg(state: XRMenuState, hovered: ReadonlySet<number> = new Set()): string {
  const actions = [3, 5, 2];
  const labels = [state.hasCamera ? state.following ? 'Free view' : 'Follow camera' : 'No camera', state.timeline ? 'Exit timeline' : 'Timeline', 'Exit VR'];
  const symbols = [state.following ? icons.free : icons.camera, icons.timeline, icons.exit];
  const cells = actions.map((action, i) => {
    const disabled = action === 3 && !state.hasCamera;
    const hover = !disabled && hovered.has(action), active = action === 5 && state.timeline || action === 3 && state.following;
    const fill = disabled ? '#253432' : hover ? '#c9f86b' : active ? '#35554d' : '#182b26';
    const ink = disabled ? '#789084' : hover ? '#10231e' : action === 2 ? '#efc9b4' : '#f6f3e9';
    const x = 120 + i * 240;
    return `<g><circle cx="${x}" cy="160" r="90" fill="${fill}" stroke="${hover ? '#f6f3e9' : active ? '#c9f86b' : '#587167'}" stroke-width="${hover || active ? 6 : 3}"/>
      <g transform="translate(${x} 160) scale(1.3)" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${symbols[i]}</g>
      ${active ? `<circle cx="${x + 65}" cy="95" r="16" fill="#c9f86b"/><path d="m${x + 57} 95 6 6 11-13" fill="none" stroke="#10231e" stroke-width="4"/>` : ''}</g>`;
  }).join('');
  const titleActive = state.dragging || hovered.has(XR_MENU_DRAG);
  const hoveredIndex = actions.findIndex(action => hovered.has(action));
  const hint = state.dragging ? 'Release to place' : titleActive ? 'Hold grip to move' : hoveredIndex >= 0 ? labels[hoveredIndex] : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="320" viewBox="0 0 720 320">
    <rect x="240" y="10" width="240" height="40" rx="20" fill="${state.dragging ? '#ffbd66' : titleActive ? '#c9f86b' : '#182b26'}" stroke="#587167" stroke-width="2"/>
    <path d="M300 26h120m-120 8h120" stroke="${titleActive ? '#10231e' : '#c7d6ce'}" stroke-width="4" stroke-linecap="round"/>
    ${cells}${hint ? `<rect x="200" y="268" width="320" height="48" rx="12" fill="#182b26"/><text x="360" y="301" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" fill="#f6f3e9" font-size="28">${hint}</text>` : ''}</svg>`;
}
export function xrMenuHandleSvg(expanded: boolean, hovered = false): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
    <circle cx="100" cy="100" r="90" fill="${hovered ? '#c9f86b' : '#182b26'}" stroke="${hovered ? '#f6f3e9' : '#c9f86b'}" stroke-width="${hovered ? 6 : 3}"/>
    <path d="${expanded ? 'm80 80 40 40m0-40-40 40' : 'M70 78h60M70 100h60M70 122h60'}" fill="none" stroke="${hovered ? '#10231e' : '#f6f3e9'}" stroke-width="5.2" stroke-linecap="round"/>
    <title>${expanded ? 'Close menu' : 'Open menu'}</title></svg>`;
}

/** One visual panel, separate hit targets, and a persistent collapse handle. */
export class XRMenu {
  readonly root = new THREE.Group();
  readonly timelineRoot = new THREE.Group();
  expanded = true;
  private state: XRMenuState = { playing: false, canUndo: false, following: false, hasCamera: false, scale: 1 };
  private hovered = new Set<number>();
  private stateKey = '';
  private hoverKey = '';
  private panelTexture = new MenuTexture(720, 320);
  private handleTexture = new MenuTexture(200, 200);
  private timelineTexture = new MenuTexture(1440, 400);
  private recordingTexture = new MenuTexture(1440, 180);
  private recordingPanel: THREE.Mesh;
  private recordingButtons: THREE.Mesh[] = [];
  private timelineState: XRTimelineState | null = null;
  private hoveredKey?: number;
  private timelinePanel: THREE.Mesh;
  private timelineTitle: THREE.Mesh;
  private addKey: THREE.Mesh;
  private deleteKey: THREE.Mesh;
  private panel: THREE.Mesh;
  private handle: THREE.Mesh;
  private title: THREE.Mesh;
  private buttons: THREE.Mesh[] = [];
  constructor() {
    this.panel = this.plane(.36, .16, this.panelTexture.texture);
    this.panel.position.set(.24, 0, 0);
    this.panel.userData.xrAction = -1;
    this.handle = this.plane(.1, .1, this.handleTexture.texture);
    this.handle.position.set(0, 0, 0); this.handle.userData.xrAction = XR_MENU_TOGGLE;
    this.title = this.plane(.12, .02);
    this.title.position.set(.24, .065, .002);
    this.title.userData.xrAction = XR_MENU_DRAG;
    [3, 5, 2].forEach((action, index) => {
      const button = this.plane(.09, .09);
      button.position.set(.12 + index * .12, 0, .001);
      button.userData.xrAction = action; this.buttons.push(button);
    });
    this.timelinePanel = this.plane(.96, .96 * 400 / 1440, this.timelineTexture.texture);
    this.timelineRoot.add(this.timelinePanel); this.timelineRoot.visible = false;
    this.timelinePanel.userData.xrAction = -1; this.timelinePanel.visible = false;
    this.timelinePanel.userData.xrTimeline = true;
    this.timelineTitle = this.plane(.96 * 1392 / 1440, .96 * 80 / 1440);
    this.timelineTitle.position.set(0, .96 * (200 - 56) / 1440, .002); this.timelineTitle.userData.xrAction = XR_TIMELINE_DRAG;
    this.addKey = this.plane(.96 * 376 / 1440, .96 * 80 / 1440);
    this.addKey.position.set(.96 * (1188 - 720) / 1440, .96 * (200 - 330) / 1440, .002);
    this.addKey.userData.xrAction = XR_ADD_KEY;
    this.deleteKey = this.plane(.96 * 376 / 1440, .96 * 80 / 1440);
    this.deleteKey.position.set(.96 * (788 - 720) / 1440, .96 * (200 - 330) / 1440, .002);
    this.deleteKey.userData.xrAction = XR_DELETE_KEY;
    this.timelineRoot.add(this.timelineTitle, this.addKey, this.deleteKey);
    this.recordingPanel = this.plane(.96, .12, this.recordingTexture.texture);
    this.recordingPanel.position.set(0, -.21, 0); this.recordingPanel.userData.xrAction = -1;
    this.timelineRoot.add(this.recordingPanel);
    [XR_RECORD, XR_RECORD_PREVIEW, XR_RECORD_APPLY, XR_RECORD_DISCARD].forEach((action,index)=>{
      const button=this.plane(.96*336/1440,.96*88/1440);
      button.position.set(.96*(192+index*352-720)/1440,-.21+.96*(90-112)/1440,.002);
      button.userData.xrAction=action;this.recordingButtons.push(button);this.timelineRoot.add(button);
    });
    this.repaint();
  }
  private plane(width: number, height: number, map?: THREE.Texture): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: map ?? null, transparent: true, opacity: map ? 1 : 0, depthTest: false, depthWrite: false, toneMapped: false }));
    mesh.renderOrder = 100; mesh.frustumCulled = false; this.root.add(mesh); return mesh;
  }
  targets(): THREE.Mesh[] { return [...(this.expanded ? [this.handle, this.title, ...this.buttons, this.panel] : [this.handle]), ...(this.timelineRoot.visible && this.timelinePanel.visible ? [this.timelineTitle, this.addKey, this.deleteKey, this.timelinePanel, ...(this.recordingPanel.visible ? [...this.recordingButtons,this.recordingPanel] : [])] : [])]; }
  nearTitle(point: THREE.Vector3, radius: number, timeline = false): THREE.Vector3 | undefined {
    if (timeline ? !this.timelineRoot.visible : !this.expanded || !this.root.visible) return;
    const title = timeline ? this.timelineTitle : this.title;
    title.updateWorldMatrix(true, false);
    const local = title.worldToLocal(point.clone());
    const { width, height } = (title.geometry as THREE.PlaneGeometry).parameters;
    local.set(THREE.MathUtils.clamp(local.x, -width / 2, width / 2), THREE.MathUtils.clamp(local.y, -height / 2, height / 2), 0);
    const closest = title.localToWorld(local);
    if (closest.distanceTo(point) <= radius) return closest;
  }
  enabled(action: number): boolean {
    const recording=this.timelineState?.recording,active=!!recording&&recording.mode!=='idle';
    if(active && [3,5,XR_ADD_KEY,XR_DELETE_KEY].includes(action))return false;
    if(action>=XR_RECORD&&action<=XR_RECORD_DISCARD){
      if(!this.timelineRoot.visible||!recording)return false;
      if(action===XR_RECORD)return !active&&!!recording.canRecord;
      if(action===XR_RECORD_DISCARD)return active&&recording.mode!=='recording';
      return recording.mode==='review';
    }
    if (action === XR_TIMELINE_DRAG) return this.timelineRoot.visible;
    if (action === XR_ADD_KEY) return this.timelineRoot.visible && !!this.timelineState?.canAddKey;
    if (action === XR_DELETE_KEY) return this.timelineRoot.visible && !!this.timelineState?.canDeleteKey;
    return action === XR_MENU_TOGGLE || this.expanded && (action === XR_MENU_DRAG || action === 5 || action === 2 || action === 3 && this.state.hasCamera);
  }
  setTimeline(state: XRTimelineState | null): void {
    this.timelineState = state;
    this.timelineRoot.visible = !!state; this.timelinePanel.visible = !!state;
    this.recordingPanel.visible=!!state?.recording;this.recordingButtons.forEach(button=>button.visible=!!state?.recording);
    this.repaintTimeline();
  }
  keyframeTime(hit: THREE.Intersection): number | undefined {
    if (hit.object !== this.timelinePanel || !this.timelineState || !this.timelinePanel.visible || !hit.uv) return;
    return keyframeAtTimeline(this.timelineState, hit.uv.x, hit.uv.y);
  }
  hoverKeyframe(time: number | undefined): void {
    if (time === this.hoveredKey) return;
    this.hoveredKey = time;
    this.repaintTimeline();
  }
  toggle(): void {
    this.expanded = !this.expanded; this.hovered.clear(); this.hoverKey = '';
    this.title.visible = this.expanded;
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
    this.repaintTimeline();
    if (this.expanded) this.panelTexture.draw(xrMenuSvg(this.state, this.hovered));
    this.handleTexture.draw(xrMenuHandleSvg(this.expanded, this.hovered.has(XR_MENU_TOGGLE)));
  }
  private repaintTimeline(): void {
    if(this.timelineState?.recording)this.recordingTexture.draw(xrRecordingSvg(this.timelineState.recording,this.hovered));
    if (this.timelineState) this.timelineTexture.draw(xrTimelineSvg(this.timelineState, this.hoveredKey, {
      titleHover: this.hovered.has(XR_TIMELINE_DRAG), dragging: this.state.timelineDragging,
      addHover: this.hovered.has(XR_ADD_KEY),
      deleteHover: this.hovered.has(XR_DELETE_KEY),
    }));
  }
  dispose(): void {
    this.root.removeFromParent(); this.panelTexture.dispose(); this.handleTexture.dispose(); this.timelineTexture.dispose();this.recordingTexture.dispose();
    this.timelineRoot.removeFromParent();
    for (const child of [...this.root.children, ...this.timelineRoot.children]) { const mesh = child as THREE.Mesh; mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
  }
}
