import { XR_PANEL } from './palette';
import * as THREE from 'three';
import { XR_ASSETS, XR_ASSET_ACTIONS, XR_ASSET_PLACE, XR_ASSET_DELETE } from './assets';
import { icon } from '../icons';
import { MenuTexture } from './texture';
import { keyframeAtTimeline, xrTimelineSvg, type XRTimelineState } from './timeline';
import type { XRRecordingState } from './recording';

export const XR_HANDHELD = 14;
export interface XRMenuState { assetsOpen?: boolean; assetLabel?: string; assetCount?: number; canPlaceAsset?: boolean; canDeleteAsset?: boolean; deleteLabel?: string; handheld?: boolean; canHandheld?: boolean; playing: boolean; canUndo: boolean; following: boolean; hasCamera: boolean; scale: number; timeline?: boolean; dragging?: boolean; timelineDragging?: boolean }
export const XR_MENU_TOGGLE = 4;
export const XR_MENU_DRAG = 6;
export const XR_TIMELINE_DRAG = 7;
export const XR_ADD_KEY = 8;
export const XR_DELETE_KEY = 9;
export const XR_RECORD = 10, XR_RECORD_PREVIEW = 11, XR_RECORD_APPLY = 12, XR_RECORD_DISCARD = 13;
export function xrRecordingSvg(state: XRRecordingState, hovered: ReadonlySet<number> = new Set()): string {
  const review = state.mode === 'review', active = state.mode !== 'idle';
  const status = state.handheld ? state.mode === 'recording' ? 'Handheld camera ? Trigger or release Grip to stop' : state.mode === 'armed' ? 'Hold Grip to frame ? Trigger to start recording' : `Camera take ? ${state.samples} samples ? ${state.keys} pose keys ? Preview, Apply or Discard` : state.mode === 'recording' ? 'Recording · Release to smooth and review' : state.mode === 'armed' ? 'Ready · Hold trigger or grip on the selected object or camera' : review ? `Smoothed take · ${state.samples} samples → ${state.keys} pose keys · Apply replaces this time range` : 'Single-hand recording · Select an object or camera, then Record';
  const labels = [state.mode === 'recording' ? 'Recording' : state.mode === 'armed' ? 'Armed' : 'Record', state.previewing ? 'Pause preview' : 'Preview', 'Apply', 'Discard'];
  const enabled = [!active && state.canRecord, review, review, active && state.mode !== 'recording'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="180" viewBox="0 0 1440 180"><rect x="4" y="4" width="1432" height="172" rx="20" fill="${XR_PANEL.paper}" stroke="${active ? XR_PANEL.warning : XR_PANEL.line}" stroke-width="3"/>
    <g font-family="Segoe UI, Arial, sans-serif"><circle cx="36" cy="36" r="8" fill="${state.mode === 'recording' ? XR_PANEL.record : active ? XR_PANEL.warning : XR_PANEL.lineStrong}"/><text x="58" y="45" fill="${XR_PANEL.ink}" font-size="26">${status}</text>
    ${labels.map((label,i)=>{const x=24+i*352,hover=enabled[i]&&hovered.has(XR_RECORD+i);return `<rect x="${x}" y="68" width="336" height="88" rx="12" fill="${hover?XR_PANEL.accent:XR_PANEL.raised}" stroke="${enabled[i]?XR_PANEL.accent:XR_PANEL.line}" stroke-width="${hover?5:2}"/><text x="${x+168}" y="123" text-anchor="middle" fill="${hover?XR_PANEL.primaryInk:enabled[i]?XR_PANEL.ink:XR_PANEL.muted}" font-size="32">${label}</text>`;}).join('')}</g></svg>`;
}

/** Shared SVG source for browser textures and offline visual verification. */
export function xrMenuSvg(state: XRMenuState, hovered: ReadonlySet<number> = new Set()): string {
  const actions = state.assetsOpen ? XR_ASSET_ACTIONS : [3, 5, XR_HANDHELD, 2];
  const labels = state.assetsOpen ? ['Previous asset', 'Place in front', 'Next asset', state.deleteLabel || 'Select an object to delete'] : [state.hasCamera ? state.following ? 'Free view' : 'Follow camera' : 'No camera', state.timeline ? 'Exit timeline' : 'Timeline', state.handheld ? 'Leave camera' : 'Handheld camera', 'Exit VR'];
  const symbols = state.assetsOpen ? ['rewind', 'plus', 'forward', 'trash'] as const : [state.following ? 'focus' : 'camera', 'timeline', 'film', 'exit'] as const;
  const cells = actions.map((action, i) => {
    const disabled = state.assetsOpen ? action === XR_ASSET_DELETE ? !state.canDeleteAsset : action === XR_ASSET_PLACE ? !state.canPlaceAsset : (state.assetCount ?? 0) < 2 : action === 3 && !state.hasCamera || action === XR_HANDHELD && !state.canHandheld && !state.handheld;
    const hover = !disabled && hovered.has(action), active = action === 5 && state.timeline || action === 3 && state.following || action === XR_HANDHELD && state.handheld;
    const fill = disabled ? XR_PANEL.field : hover ? XR_PANEL.accent : active ? XR_PANEL.selection : XR_PANEL.paper;
    const ink = disabled ? XR_PANEL.lineStrong : hover ? XR_PANEL.primaryInk : action === 2 ? XR_PANEL.error : XR_PANEL.ink;
    const x = 120 + i * 240;
    return `<g><circle cx="${x}" cy="160" r="90" fill="${fill}" stroke="${hover ? XR_PANEL.ink : active ? XR_PANEL.accent : XR_PANEL.line}" stroke-width="${hover || active ? 6 : 3}"/>
      ${icon(symbols[i],{x:x-38,y:122,width:76,height:76,color:ink})}
      ${active ? `<circle cx="${x + 65}" cy="95" r="16" fill="${XR_PANEL.accent}"/>${icon('check',{x:x+53,y:83,width:24,height:24,color:XR_PANEL.primaryInk,'stroke-width':3})}` : ''}</g>`;
  }).join('');
  const titleActive = state.dragging || hovered.has(XR_MENU_DRAG);
  const hoveredIndex = actions.findIndex(action => hovered.has(action));
  const rawHint = state.dragging ? 'Release to place' : titleActive ? 'Hold grip to move' : hoveredIndex >= 0 ? labels[hoveredIndex] : state.assetsOpen ? state.assetLabel || 'No assets available' : '';
  const hint = rawHint.slice(0, 48).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="320" viewBox="0 0 960 320">
    <rect x="360" y="10" width="240" height="40" rx="20" fill="${state.dragging ? XR_PANEL.warning : titleActive ? XR_PANEL.accent : XR_PANEL.paper}" stroke="${XR_PANEL.line}" stroke-width="2"/>
    ${icon('grip-horizontal',{x:446,y:14,width:68,height:32,color:titleActive?XR_PANEL.primaryInk:XR_PANEL.secondary})}
    ${cells}${hint ? `<rect x="20" y="268" width="920" height="48" rx="12" fill="${XR_PANEL.paper}"/><text x="480" y="301" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" fill="${XR_PANEL.ink}" font-size="28">${hint}</text>` : ''}</svg>`;
}
export function xrMenuHandleSvg(expanded: boolean, hovered = false): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
    <circle cx="100" cy="100" r="90" fill="${hovered ? XR_PANEL.accent : XR_PANEL.paper}" stroke="${hovered ? XR_PANEL.ink : XR_PANEL.accent}" stroke-width="${hovered ? 6 : 3}"/>
    ${icon(expanded?'close':'menu',{x:60,y:60,width:80,height:80,color:hovered?XR_PANEL.primaryInk:XR_PANEL.ink})}
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
  private panelTexture = new MenuTexture(960, 320);
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
  private assetTexture = new MenuTexture(200, 200);
  private assetButton: THREE.Mesh;
  constructor() {
    this.panel = this.plane(.48, .16, this.panelTexture.texture);
    this.panel.position.set(.30, 0, 0);
    this.panel.userData.xrAction = -1;
    this.handle = this.plane(.1, .1, this.handleTexture.texture);
    this.handle.position.set(0, 0, 0); this.handle.userData.xrAction = XR_MENU_TOGGLE;
    this.assetButton = this.plane(.1, .1, this.assetTexture.texture);
    this.assetButton.position.set(-.12, 0, 0); this.assetButton.userData.xrAction = XR_ASSETS;
    this.title = this.plane(.12, .02);
    this.title.position.set(.30, .065, .002);
    this.title.userData.xrAction = XR_MENU_DRAG;
    [3, 5, XR_HANDHELD, 2].forEach((action, index) => {
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
  targets(): THREE.Mesh[] { return [...(this.root.visible ? this.expanded ? [this.handle, this.assetButton, this.title, ...this.buttons, this.panel] : [this.handle] : []), ...(this.timelineRoot.visible && this.timelinePanel.visible ? [this.timelineTitle, this.addKey, this.deleteKey, this.timelinePanel, ...(this.recordingPanel.visible ? [...this.recordingButtons,this.recordingPanel] : [])] : [])]; }
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
    if (action === XR_ASSETS) return this.expanded && !active;
    if (XR_ASSET_ACTIONS.includes(action)) return this.expanded && !!this.state.assetsOpen && !active && (action === XR_ASSET_PLACE ? !!this.state.canPlaceAsset : action === XR_ASSET_DELETE ? !!this.state.canDeleteAsset : (this.state.assetCount ?? 0) > 1);
    if(action===XR_HANDHELD)return this.expanded&&(this.state.handheld?recording?.mode==='armed':!active&&!!this.state.canHandheld);
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
    this.assetButton.visible = this.expanded;
    this.title.visible = this.expanded;
    this.panel.visible = this.expanded; this.buttons.forEach(button => button.visible = this.expanded); this.repaint();
  }
  setState(state: XRMenuState): void {
    const key = JSON.stringify({ ...state, scale: Number(state.scale.toFixed(2)) });
    if (key === this.stateKey) return;
    this.stateKey = key; this.state = state;
    this.buttons.forEach((button, i) => button.userData.xrAction = (state.assetsOpen ? XR_ASSET_ACTIONS : [3, 5, XR_HANDHELD, 2])[i]);
    this.repaint();
  }
  hover(actions: number[]): void {
    const key = [...new Set(actions)].sort().join(','); if (key === this.hoverKey) return;
    this.hoverKey = key; this.hovered = new Set(actions); this.repaint();
  }
  private repaint(): void {
    const active = this.state.assetsOpen || this.hovered.has(XR_ASSETS);
    this.assetTexture.draw(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="90" fill="${active ? XR_PANEL.accent : XR_PANEL.paper}" stroke="${XR_PANEL.line}" stroke-width="3"/>${icon('cube', {x:60,y:60,width:80,height:80,color:active?XR_PANEL.primaryInk:XR_PANEL.ink})}<title>Assets</title></svg>`);
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
    this.assetTexture.dispose();
    this.root.removeFromParent(); this.panelTexture.dispose(); this.handleTexture.dispose(); this.timelineTexture.dispose();this.recordingTexture.dispose();
    this.timelineRoot.removeFromParent();
    for (const child of [...this.root.children, ...this.timelineRoot.children]) { const mesh = child as THREE.Mesh; mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
  }
}
