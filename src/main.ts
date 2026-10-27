import './style.css';
import { Stage } from './stage';
import { createDocument, createObject, cloneDocument, evaluateTransform, parseDocument, serializeDocument, History } from './model';
import type { Axis, MotionTrack, PrimitiveKind, SceneDocument, SceneEntity, ToolMode, Transform } from './types';
import { ReferenceDialog } from './reference/dialog';

const STORAGE_KEY = 'littletake.scene.v1';
const icons: Record<string, string> = {
  move: '<path d="M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  rotate: '<path d="M20 10a8 8 0 1 0-2 8M20 3v7h-7"/>',
  scale: '<rect x="4" y="12" width="8" height="8" rx="1"/><path d="M14 4h6v6M20 4l-9 9"/>',
  cube: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9"/>',
  sphere: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  cylinder: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  cone: '<path d="m4 19 8-16 8 16c0 4-16 4-16 0Z"/><path d="M4 19c2-3 14-3 16 0"/>',
  plane: '<path d="m12 5 10 7-10 7-10-7 10-7Z"/>',
  human: '<circle cx="12" cy="5" r="3"/><path d="M12 8v8M5 12l7-3 7 3M8 22l4-6 4 6"/>',
  camera: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>', pause: '<path d="M8 4v16M16 4v16"/>',
  rewind: '<path d="M5 4v16M19 4 7 12l12 8Z"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  undo: '<path d="m8 4-5 5 5 5M3 9h11a7 7 0 0 1 7 7v4"/>',
  redo: '<path d="m16 4 5 5-5 5M21 9H10a7 7 0 0 0-7 7v4"/>',
  folder: '<path d="M3 6h7l2 3h9v12H3Z"/>',
  save: '<path d="M4 3h13l4 4v14H4ZM8 3v7h8V3M8 21v-7h9v7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  focus: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  key: '<path d="m12 3 9 9-9 9-9-9 9-9Z"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 0 1 6 1c0 2-3 2-3 4M12 17h.01"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
  timeline: '<path d="M4 5v14M4 8h16M4 16h16"/><rect x="8" y="6" width="7" height="4" rx="1"/><rect x="12" y="14" width="7" height="4" rx="1"/>',
};
const icon = (name: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.cube}</svg>`;
const esc = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const app = $('#app');
app.innerHTML = `
<header class="app-header">
  <a class="brand" href="/" aria-label="LittleTake Studio"><span class="brand-mark">L<span></span></span><span>LittleTake</span></a>
  <div class="project-title"><input id="projectName" aria-label="Scene name" maxlength="120"/><span id="saveStatus" class="save-status">Local draft</span></div>
  <div class="history-actions"><button class="icon-button" data-action="undo" aria-label="Undo" title="Undo · Ctrl Z">${icon('undo')}</button><button class="icon-button" data-action="redo" aria-label="Redo" title="Redo · Ctrl Shift Z">${icon('redo')}</button></div>
  <div class="header-actions"><button data-action="reference">${icon('camera')}<span>Reference video</span></button><button class="primary-button" data-action="export">${icon('download')}<span>Export scene</span></button><details class="studio-menu" id="sceneMenu"><summary aria-label="Scene menu" title="Scene menu">${icon('more')}</summary><div class="menu-content"><button data-action="open">${icon('folder')}Open scene</button><button data-action="save">${icon('save')}Save locally<kbd>⌘ / Ctrl S</kbd></button><button data-action="shortcuts">${icon('help')}Keyboard shortcuts</button></div></details></div>
</header>
<main class="workspace">
  <aside class="library-panel">
    <div class="library-tabs" role="tablist" aria-label="Library"><button id="objectsTab" role="tab" aria-controls="objectsPanel" aria-selected="true" data-library="objects">Objects<span id="objectCount"></span></button><button id="assetsTab" role="tab" aria-controls="assetsPanel" aria-selected="false" data-library="assets">${icon('plus')}Add</button></div>
    <div id="objectsPanel" class="library-page" role="tabpanel" aria-labelledby="objectsTab"><div id="outliner" class="outliner" aria-label="Scene objects"></div></div>
    <div id="assetsPanel" class="library-page" role="tabpanel" aria-labelledby="assetsTab" hidden><p class="library-caption">Add to your scene</p><div class="primitive-grid">${(['cube','sphere','cylinder','cone','plane','human'] as PrimitiveKind[]).map(kind=>`<button data-add="${kind}" aria-label="Add ${kind}">${icon(kind)}<span>${kind[0].toUpperCase()+kind.slice(1)}</span></button>`).join('')}</div></div>
  </aside>
  <section class="stage-panel" aria-label="3D stage">
    <div class="viewport-heading"><div class="transform-tools" role="toolbar" aria-label="Transform tools"><button data-tool="translate" aria-label="Move tool" title="Move · G">${icon('move')}<span>Move</span></button><button data-tool="rotate" aria-label="Rotate tool" title="Rotate · R">${icon('rotate')}<span>Rotate</span></button><button data-tool="scale" aria-label="Scale tool" title="Scale · S">${icon('scale')}<span>Scale</span></button></div><div><button data-action="focus" title="Focus selection · F">${icon('focus')}Focus</button><button data-action="reset-view" aria-label="Reset scene view">Reset view</button></div></div>
    <div id="viewport" class="viewport"></div>
    <section class="shot-panel" aria-label="Shot preview"><div class="shot-heading"><h2>${icon('camera')}Shot preview</h2><button class="icon-button" data-action="expand-preview" aria-label="Expand shot preview" aria-expanded="false" title="Expand preview">${icon('expand')}</button></div><div id="previewDock"><div class="preview-frame" id="previewFrame"><div id="preview" class="preview"></div></div></div><div class="shot-footer"><span><span class="live-dot"></span>Live · 16:9</span><button data-select="camera" id="lensLabel">Edit camera</button></div></section>
    <div class="viewport-caption"><span id="viewHint">Drag to orbit · Scroll to zoom</span></div>
  </section>
  <aside class="properties-drawer" id="propertiesDrawer" aria-label="Inspector">
    <div class="drawer-heading"><h2>Inspector</h2></div>
    <section class="inspector-panel" id="inspector" aria-label="Object properties"></section>
  </aside>
</main>
<section class="timeline-panel" id="timelinePanel" aria-label="Animation timeline">
  <div class="timeline-toolbar"><div class="transport"><button data-action="rewind" class="icon-button" aria-label="Go to start">${icon('rewind')}</button><button data-action="play" id="playButton" class="play-button" aria-label="Play">${icon('play')}</button><span class="timecode" id="timecode" data-current-time>00:00.00</span><span class="timecode-separator">/</span><span class="timecode" id="endTimecode" data-end-time>00:05.00</span></div><input id="playbackSeek" class="playback-seek" type="range" min="0" max="5" step="0.01" value="0" aria-label="Playback position"/><button id="timelineToggle" data-action="timeline" aria-expanded="false" aria-controls="timelineContent">${icon('timeline')}Timeline<span class="timeline-chevron">⌃</span></button></div>
  <div class="timeline-content" id="timelineContent" hidden><div class="expanded-timeline-heading"><span>Animation</span><label class="duration-control">Duration <input type="number" id="duration" aria-label="Scene duration" min="1" max="60" step="1"/> s</label></div><div class="timeline-ruler-row"><div class="track-heading">OBJECT / CAMERA</div><div id="timeRuler" class="time-ruler" role="slider" tabindex="0" aria-label="Timeline playhead" aria-valuemin="0" aria-valuemax="5" aria-valuenow="0"></div></div><div id="timelineRows" class="timeline-rows"></div></div>
</section>
<footer class="status-bar"><span id="statusText" role="status">Ready</span><button data-action="shortcuts">${icon('help')}Shortcuts</button></footer>
<input id="openFile" type="file" accept=".json,application/json" hidden/>
<dialog id="previewDialog" aria-labelledby="previewTitle"><div class="dialog-heading"><h2 id="previewTitle">Shot preview</h2><button data-action="close-preview" aria-label="Close shot preview">✕</button></div><div id="expandedPreview"></div><div class="preview-transport"><button class="play-button" data-action="play" aria-label="Play">${icon('play')}</button><span class="timecode" data-current-time></span><span class="timecode-separator">/</span><span class="timecode" data-end-time></span></div></dialog>
<dialog id="shortcutsDialog"><div class="dialog-heading"><h2>Make yourself at home.</h2><button data-action="close-shortcuts" aria-label="Close shortcuts">✕</button></div><p class="muted">A few controls for your little stage.</p><dl class="shortcut-list"><dt>Orbit / pan / zoom</dt><dd>Left drag / Middle drag / Scroll</dd><dt>Fly around the scene</dt><dd>Hold right mouse + W A S D · Q / E up & down</dd><dt>Move / rotate / scale</dt><dd>G / R / S</dd><dt>Constrain an axis</dt><dd>X / Y / Z</dd><dt>Focus selection</dt><dd>F</dd><dt>Play / pause</dt><dd>Space</dd><dt>Duplicate / delete</dt><dd>Ctrl D / Delete</dd><dt>Undo / redo</dt><dd>Ctrl Z / Ctrl Shift Z</dd><dt>Save locally</dt><dd>Ctrl S</dd></dl><p class="dialog-note">Animate with Start and End poses. The camera has its own track.</p></dialog>
`;

let doc: SceneDocument = createDocument();
let recovered = false;
try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) { doc = parseDocument(saved); recovered = true; } } catch { /* Invalid local drafts never prevent opening the studio. */ }
const history = new History(doc);
let selectedId: string | null = doc.objects.find(item=>!item.track)?.id ?? doc.objects[0]?.id ?? 'camera';
let tool: ToolMode = 'translate';
let axis: Axis | null = null;
let time = 0;
let playing = false;
let lastFrame = performance.now();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let stage: Stage;
let storageAvailable = true;
let timelineOpen = false;
let libraryTab: 'objects'|'assets' = 'objects';
let liveFieldEdit=false; let pendingFieldDoc:SceneDocument|null=null; let fieldCommitTimer:ReturnType<typeof setTimeout>|undefined;
function flushFieldEdit(){clearTimeout(fieldCommitTimer);if(pendingFieldDoc){history.commit(pendingFieldDoc);pendingFieldDoc=null;renderSelection();}}
const entity = (id = selectedId): SceneEntity | undefined => id === 'camera' ? doc.camera : doc.objects.find(object=>object.id===id);
const copyPose = (pose: Transform): Transform => structuredClone(pose);
const num = (value: number) => Number(value.toFixed(3));
const timecode = (value: number) => `${Math.floor(value / 60).toString().padStart(2,'0')}:${Math.floor(value % 60).toString().padStart(2,'0')}.${Math.floor((value % 1)*100).toString().padStart(2,'0')}`;
function status(message: string) { $('#statusText').textContent = message; clearTimeout(statusTimer); statusTimer=setTimeout(()=>$('#statusText').textContent='Ready',5000); }
function persist() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(STORAGE_KEY,serializeDocument(doc)); $('#saveStatus').textContent='Saved on this device'; storageAvailable=true; }
  catch { $('#saveStatus').textContent='Export to keep your scene'; storageAvailable=false; }
}
function changed(message?: string) { if(liveFieldEdit){pendingFieldDoc=cloneDocument(doc);clearTimeout(fieldCommitTimer);fieldCommitTimer=setTimeout(flushFieldEdit,450);}else{flushFieldEdit();history.commit(doc);} renderAll(); $('#saveStatus').textContent='Saving…'; clearTimeout(saveTimer); saveTimer=setTimeout(persist,350); if(message)status(message); }
function pause() { const wasPlaying=playing; playing=false; renderTransport(); if(wasPlaying){renderInspector();syncStage();} }
function select(id: string | null) { flushFieldEdit(); selectedId=id; if(id)setLibraryTab('objects'); renderInspector(); renderSelection(); syncStage(); }
function clamp(value: number,min: number,max: number) { return Math.max(min,Math.min(max,value)); }
function atEndpoint(item: SceneEntity) { return !item.track || Math.abs(time-item.track.start)<0.025 || Math.abs(time-(item.track.start+item.track.duration))<0.025; }
function endpoint(item: SceneEntity): 'from'|'to' { return item.track && Math.abs(time-(item.track.start+item.track.duration)) < Math.abs(time-item.track.start) ? 'to':'from'; }
function setPose(item: SceneEntity, pose: Transform) { const safe=copyPose(pose); safe.position=safe.position.map((v,i)=>clamp(Number.isFinite(v)?v:item.transform.position[i],-1000,1000)) as Transform['position']; safe.rotation=safe.rotation.map((v,i)=>clamp(Number.isFinite(v)?v:item.transform.rotation[i],-360000,360000)) as Transform['rotation']; safe.scale=safe.scale.map((v,i)=>clamp(Number.isFinite(v)?v:item.transform.scale[i],0.01,100)) as Transform['scale']; if(item.track) item.track[endpoint(item)]=safe; else item.transform=safe; }
function syncStage() { const item=entity(); stage?.update(doc,time,selectedId,playing || Boolean(item && !atEndpoint(item))); }
function seek(value: number) { time=clamp(value,0,doc.duration); renderTime(); syncStage(); if(!playing)renderInspector(); }
function renderTransport() { document.querySelectorAll<HTMLButtonElement>('[data-action="play"]').forEach(button=>{button.innerHTML=icon(playing?'pause':'play');button.setAttribute('aria-label',playing?'Pause':'Play');button.classList.toggle('is-playing',playing);}); }
function renderTime() {
  document.querySelectorAll<HTMLElement>('[data-current-time]').forEach(node=>node.textContent=timecode(time)); document.querySelectorAll<HTMLElement>('[data-end-time]').forEach(node=>node.textContent=timecode(doc.duration));
  $<HTMLInputElement>('#playbackSeek').max=String(doc.duration); $<HTMLInputElement>('#playbackSeek').value=String(time);
  const fraction=time/doc.duration*100;
  document.querySelectorAll<HTMLElement>('.lane-playhead').forEach(node=>node.style.left=`${fraction}%`);
  $('#timeRuler').setAttribute('aria-valuenow',String(num(time))); $('#timeRuler').setAttribute('aria-valuemax',String(doc.duration));
}
function renderSelection() {
  document.querySelectorAll<HTMLElement>('[data-select]').forEach(node=>{ node.classList.toggle('selected',node.dataset.select===selectedId); node.setAttribute('aria-pressed',String(node.dataset.select===selectedId)); });
  document.querySelectorAll<HTMLElement>('[data-tool]').forEach(node=>{node.classList.toggle('active',node.dataset.tool===tool);node.setAttribute('aria-pressed',String(node.dataset.tool===tool));});
  document.querySelectorAll<HTMLElement>('[data-axis]').forEach(node=>{node.classList.toggle('active',node.dataset.axis===axis);node.setAttribute('aria-pressed',String(node.dataset.axis===axis));});
  ($('[data-action="undo"]') as HTMLButtonElement).disabled=!history.canUndo;
  ($('[data-action="redo"]') as HTMLButtonElement).disabled=!history.canRedo;
}
function setLibraryTab(tab: 'objects'|'assets') {
  libraryTab=tab; $('#objectsPanel').hidden=tab!=='objects'; $('#assetsPanel').hidden=tab!=='assets';
  document.querySelectorAll<HTMLButtonElement>('[data-library]').forEach(button=>{const active=button.dataset.library===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
}
function setTimelineOpen(open: boolean) {
  timelineOpen=open; $('#timelinePanel').classList.toggle('expanded',open); $('#timelineContent').hidden=!open; $('#timelineToggle').setAttribute('aria-expanded',String(open));
}
function renderOutliner() {
  $('#objectCount').textContent=String(doc.objects.length+1);
  $('#outliner').innerHTML=[...doc.objects,doc.camera].map(item=>`<button class="object-row" data-select="${esc(item.id)}" aria-label="Select ${esc(item.name)}">${icon('kind' in item?item.kind:'camera')}<span>${esc(item.name)}</span>${item.track?'<span class="motion-dot" title="Animated"></span>':''}</button>`).join('');
}
function poseFields(label: string,group: keyof Transform,values: number[],disabled: boolean) {
  return `<div class="property-group"><label class="property-label">${label}</label><div class="vector-inputs">${['X','Y','Z'].map((a,i)=>`<label class="vector-field axis-${a.toLowerCase()}"><span>${a}</span><input type="number" aria-label="${label} ${a}" data-pose="${group}" data-component="${i}" step="${group==='rotation'?5:0.1}" value="${num(values[i])}" ${group==='scale'?'min="0.01" max="100"':''} ${disabled?'disabled':''}/></label>`).join('')}</div></div>`;
}
function renderInspector() {
  if(document.activeElement instanceof HTMLInputElement && $('#inspector').contains(document.activeElement)) return;
  const item=entity();
  if(!item) { $('#inspector').innerHTML=`<div class="empty-inspector">${icon('move')}<h3>Nothing selected</h3><p>Select an object to edit its properties.</p></div>`;return; }
  const pose=evaluateTransform(item,time), locked=playing || !atEndpoint(item), isCamera=item.id==='camera';
  const colors=['#b8ccce','#e8a28e','#f0d48d','#aebfa1','#9faed0','#e5d9c3','#b2a4bc','#555f66'];
  $('#inspector').innerHTML=`<div class="inspector-title"><span class="entity-type">${icon(isCamera?'camera':('kind' in item?item.kind:'cube'))}${isCamera?'CAMERA':('kind' in item?item.kind.toUpperCase():'OBJECT')}</span><div><button data-action="duplicate" class="icon-button" aria-label="Duplicate selection" ${isCamera?'disabled':''}>${icon('duplicate')}</button><button data-action="delete" class="icon-button" aria-label="Delete selection" ${isCamera?'disabled':''}>${icon('trash')}</button></div></div>
  <input class="entity-name" aria-label="Object name" id="entityName" maxlength="120" value="${esc(item.name)}"/>
  <div class="inspector-section"><div class="section-label">Transform${item.track?`<span class="pose-badge">${locked?'PREVIEW':endpoint(item)==='from'?'START POSE':'END POSE'}</span>`:''}</div>${poseFields('Position','position',pose.position,locked)}${poseFields('Rotation','rotation',pose.rotation,locked)}${!isCamera?poseFields('Scale','scale',pose.scale,locked):`<label class="property-label">Field of view <span class="input-unit">degrees</span><input type="number" id="cameraFov" aria-label="Camera field of view" min="10" max="120" step="1" value="${doc.camera.fov}"/></label>`}<div class="axis-constraint-row"><span>Constrain axis</span><div class="axis-tools" aria-label="Axis constraint"><button data-axis="X" class="axis-x" aria-label="Constrain X axis">X</button><button data-axis="Y" class="axis-y" aria-label="Constrain Y axis">Y</button><button data-axis="Z" class="axis-z" aria-label="Constrain Z axis">Z</button></div></div></div>
  ${isCamera?`<button class="add-motion camera-align" data-action="use-view">${icon('eye')}Use current scene view</button>`:''}
  ${!isCamera?`<div class="inspector-section"><div class="section-label">MATERIAL</div><div class="color-palette">${colors.map(color=>`<button class="color-swatch ${'color' in item&&item.color===color?'active':''}" style="--swatch:${color}" data-color="${color}" aria-label="Set color ${color}"></button>`).join('')}<label class="custom-color" title="Custom color"><input type="color" aria-label="Custom object color" id="objectColor" value="${'color' in item?item.color:'#ffffff'}"/></label></div></div>`:''}
  <div class="inspector-section animation-section"><div class="section-label">ANIMATION${item.track?`<button class="icon-button" data-action="remove-motion" aria-label="Remove motion">${icon('trash')}</button>`:''}</div>${item.track?`<div class="keyframe-switch"><button data-endpoint="from" class="${!locked&&endpoint(item)==='from'?'active':''}">${icon('key')}Start<span>${num(item.track.start)}s</span></button><button data-endpoint="to" class="${!locked&&endpoint(item)==='to'?'active':''}">${icon('key')}End<span>${num(item.track.start+item.track.duration)}s</span></button></div><div class="timing-fields"><label>Starts at<input id="trackStart" aria-label="Motion start time" type="number" min="0" max="${doc.duration-item.track.duration}" step="0.1" value="${num(item.track.start)}"/></label><label>Duration<input id="trackDuration" aria-label="Motion duration" type="number" min="0.1" max="${doc.duration-item.track.start}" step="0.1" value="${num(item.track.duration)}"/></label></div><p class="property-note">${locked?'Choose Start or End to edit a pose.':'Adjust this pose in the scene or with the fields above.'}</p>`:`<button class="add-motion" data-action="add-motion">${icon('plus')}Add motion</button><p class="property-note">Set a start and end pose. LittleTake fills the space between.</p>`}</div>`;
}
function renderTimeline() {
  const tickCount=Math.min(10,Math.ceil(doc.duration));
  $('#timeRuler').innerHTML=Array.from({length:tickCount+1},(_,i)=>`<span class="time-tick" style="left:${i/tickCount*100}%">${num(i/tickCount*doc.duration)}s</span>`).join('')+'<span class="lane-playhead ruler-playhead"></span>';
  $('#timelineRows').innerHTML=[...doc.objects,doc.camera].map(item=>`<div class="timeline-row"><button class="track-label" data-select="${esc(item.id)}">${icon(item.id==='camera'?'camera':('kind' in item?item.kind:'cube'))}<span>${esc(item.name)}</span></button><div class="track-lane" data-lane="${esc(item.id)}">${item.track?`<div class="motion-clip ${item.id==='camera'?'camera-clip':''}" data-clip="${esc(item.id)}" style="left:${item.track.start/doc.duration*100}%;width:${item.track.duration/doc.duration*100}%" title="Drag to move; drag edges to trim"><span class="clip-edge" data-trim="left"></span><span class="clip-diamond">◆</span><span class="clip-title">${item.id==='camera'?'Camera move':'Motion'}</span><span class="clip-diamond end-diamond">◆</span><span class="clip-edge" data-trim="right"></span></div>`:`<button class="empty-track" data-motion-for="${esc(item.id)}">+ Add motion</button>`}<span class="lane-playhead"></span></div></div>`).join('');
}
function renderAll() {
  if(document.activeElement!==$('#projectName')) ($<HTMLInputElement>('#projectName')).value=doc.name;
  ($<HTMLInputElement>('#duration')).value=String(doc.duration);
  renderOutliner();renderTimeline();renderInspector();renderSelection();renderTransport();renderTime();syncStage();
}
function addMotion(id=selectedId) {
  const item=entity(id);if(!item || item.track)return;
  pause();selectedId=item.id;const from=copyPose(item.transform),to=copyPose(from);
  if(item.id==='camera')to.position[2]-=1.5;else to.position[0]+=2;
  item.track={start:0,duration:doc.duration,from,to};time=doc.duration;setTimelineOpen(true);changed('Motion added · edit Start and End poses');
}
function duplicate() {
  const item=entity();if(!item || !('kind' in item))return;
  if(doc.objects.length>=100){status('This scene supports up to 100 objects');return;}
  const next=structuredClone(item);next.id=nextObjectId();next.name=`${item.name.slice(0,110)} copy`;
  next.transform.position[0]=clamp(next.transform.position[0]+1,-1000,1000);
  if(next.track){next.track.from.position[0]=clamp(next.track.from.position[0]+1,-1000,1000);next.track.to.position[0]=clamp(next.track.to.position[0]+1,-1000,1000);}
  doc.objects.push(next);selectedId=next.id;changed('Object duplicated');
}
function nextObjectIndex(){for(let index=1;index<=101;index++)if(!doc.objects.some(item=>item.id===`object-${index}`))return index;throw new Error('Scene object limit reached.');}
function nextObjectId(){return `object-${nextObjectIndex()}`;}
function remove(){if(!selectedId || selectedId==='camera')return;doc.objects=doc.objects.filter(item=>item.id!==selectedId);selectedId=doc.objects[0]?.id??'camera';changed('Object deleted');}
function chooseTool(next:ToolMode){tool=next;stage?.setTool(tool);renderSelection();}
function chooseAxis(next:Axis|null){axis=next;stage?.setAxis(axis);renderSelection();}
function togglePlay(){if(playing)pause();else{if(time>=doc.duration-0.001)time=0;playing=true;lastFrame=performance.now();renderTransport();syncStage();}}
function restore(next:SceneDocument|null){if(!next)return;pause();doc=next;time=clamp(time,0,doc.duration);if(!entity())selectedId=doc.objects[0]?.id??'camera';renderAll();persist();}
function exportScene(){const blob=new Blob([serializeDocument(doc)],{type:'application/json'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=`${doc.name.replace(/[^a-z0-9-_ ]/gi,'').trim()||'LittleTake'}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('Scene exported');}

const referenceDialog = new ReferenceDialog(next => {
  pause(); flushFieldEdit(); doc = cloneDocument(next); time = 0; selectedId = doc.objects[0]?.id ?? 'camera';
  changed('Reference scene loaded · every object and camera is editable'); persist(); stage?.resetView();
});

try {
  stage=new Stage({viewport:$('#viewport'),preview:$('#preview'),onSelect:select,onStatus:message=>$('#viewHint').textContent=message,onTransform:(id,pose,phase)=>{
    const item=entity(id);if(!item)return;
    if(phase==='start'){pause();return;}
    setPose(item,pose);
    if(phase==='end')changed('Transform updated');else{renderInspector();syncStage();}
  }});
  stage.setTool(tool);
} catch(error) { $('#viewport').innerHTML=`<div class="webgl-error"><h2>This stage needs WebGL.</h2><p>Enable hardware acceleration in your browser, then reload.</p><small>${esc(error instanceof Error?error.message:'Renderer could not start.')}</small></div>`; }

app.addEventListener('click',event=>{
  const target=(event.target as HTMLElement).closest<HTMLElement>('button');if(!target || target.hasAttribute('disabled'))return;
  target.closest<HTMLDetailsElement>('details.studio-menu')?.removeAttribute('open');
  if(target.dataset.library){setLibraryTab(target.dataset.library as 'objects'|'assets');return;}
  if(target.dataset.select){select(target.dataset.select);return;}
  if(target.dataset.tool){chooseTool(target.dataset.tool as ToolMode);return;}
  if(target.dataset.axis){chooseAxis(axis===target.dataset.axis?null:target.dataset.axis as Axis);return;}
  if(target.dataset.add){if(doc.objects.length>=100){status('This scene supports up to 100 objects');return;}pause();const item=createObject(target.dataset.add as PrimitiveKind,nextObjectIndex());doc.objects.push(item);selectedId=item.id;time=0;setLibraryTab('objects');changed(`${item.name} added`);return;}
  if(target.dataset.color){const item=entity();if(item && 'color' in item){item.color=target.dataset.color;changed();}return;}
  if(target.dataset.endpoint){const item=entity();if(item?.track){pause();seek(target.dataset.endpoint==='from'?item.track.start:item.track.start+item.track.duration);}return;}
  if(target.dataset.motionFor){addMotion(target.dataset.motionFor);return;}
  switch(target.dataset.action){
    case 'focus':stage?.focusSelection();break;
    case 'reset-view':stage?.resetView();break;
    case 'use-view':{const view=stage?.captureView();if(!view)break;pause();selectedId='camera';if(doc.camera.track){time=doc.camera.track.start+doc.camera.track.duration;doc.camera.track.to=copyPose(view.transform);}else doc.camera.transform=copyPose(view.transform);doc.camera.fov=clamp(view.fov,10,120);changed('Camera aligned to scene view');break;}
    case 'undo':flushFieldEdit();restore(history.undo());status('Undo');break;
    case 'redo':flushFieldEdit();restore(history.redo());status('Redo');break;
    case 'duplicate':duplicate();break;
    case 'delete':remove();break;
    case 'play':togglePlay();break;
    case 'rewind':pause();seek(0);break;
    case 'add-motion':addMotion();break;
    case 'remove-motion':{const item=entity();if(item){item.transform=evaluateTransform(item,time);item.track=null;changed('Motion removed');}break;}
    case 'save':persist();status(storageAvailable?'Scene saved on this device':'Local storage unavailable · export the scene to keep it');break;
    case 'export':exportScene();break;
    case 'open':$<HTMLInputElement>('#openFile').click();break;
    case 'reference':pause();flushFieldEdit();referenceDialog.open();break;
    case 'timeline':setTimelineOpen(!timelineOpen);break;
    case 'expand-preview':$('#expandedPreview').appendChild($('#previewFrame'));$<HTMLDialogElement>('#previewDialog').showModal();target.setAttribute('aria-expanded','true');break;
    case 'close-preview':$<HTMLDialogElement>('#previewDialog').close();break;
    case 'shortcuts':$<HTMLDialogElement>('#shortcutsDialog').showModal();break;
    case 'close-shortcuts':$<HTMLDialogElement>('#shortcutsDialog').close();break;
  }
});
$<HTMLDialogElement>('#previewDialog').addEventListener('close',()=>{$('#previewDock').appendChild($('#previewFrame'));$('[data-action="expand-preview"]').setAttribute('aria-expanded','false');});
$('#previewDialog').addEventListener('keydown',event=>{if(event.code==='Space'){event.preventDefault();if(!event.repeat)togglePlay();}});
document.addEventListener('pointerdown',event=>{document.querySelectorAll<HTMLDetailsElement>('details.studio-menu[open]').forEach(menu=>{if(!menu.contains(event.target as Node))menu.open=false;});});
$('.library-tabs').addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();setLibraryTab(libraryTab==='objects'?'assets':'objects');$<HTMLButtonElement>(`[data-library="${libraryTab}"]`).focus();}});
const onPropertyInput = (event: Event)=>{
  const input=event.target as HTMLInputElement;if(!(input instanceof HTMLInputElement)||input.type==='file')return;
  const value=Number(input.value),item=entity();
  if(input.id==='playbackSeek'){pause();seek(value);return;}
  if(input.id==='projectName'){doc.name=input.value.trim().slice(0,120)||'Untitled take';changed();return;}
  if(input.id==='entityName' && item){item.name=input.value.trim().slice(0,120)||'Untitled';changed();return;}
  if(input.id==='objectColor' && item && 'color' in item){item.color=input.value;changed();return;}
  if(!Number.isFinite(value)){renderAll();return;}
  if(input.dataset.pose && item && atEndpoint(item) && !playing){const pose=copyPose(evaluateTransform(item,time)),group=input.dataset.pose as keyof Transform,index=Number(input.dataset.component);pose[group][index]=group==='scale'?clamp(value,0.01,100):group==='position'?clamp(value,-1000,1000):clamp(value,-360000,360000);setPose(item,pose);changed();}
  if(input.id==='cameraFov'){doc.camera.fov=clamp(value,10,120);changed();}
  if(input.id==='duration'){pause();const next=clamp(value,1,60),ratio=next/doc.duration;for(const target of [...doc.objects,doc.camera])if(target.track){target.track.start*=ratio;target.track.duration=Math.max(0.1,target.track.duration*ratio);target.track.start=Math.min(target.track.start,next-target.track.duration);}doc.duration=next;time=clamp(time,0,next);changed('Scene duration updated');}
  if((input.id==='trackStart'||input.id==='trackDuration') && item?.track){pause();if(input.id==='trackStart')item.track.start=clamp(value,0,doc.duration-item.track.duration);else item.track.duration=clamp(value,0.1,doc.duration-item.track.start);time=item.track.start;changed('Motion timing updated');}
};
app.addEventListener('change',onPropertyInput);
app.addEventListener('input',event=>{liveFieldEdit=true;try{onPropertyInput(event);}finally{liveFieldEdit=false;}});
$<HTMLInputElement>('#openFile').addEventListener('change',async event=>{
  const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;
  try{if(file.size>2_000_000)throw new Error('Scene files must be smaller than 2 MB.');const imported=parseDocument(await file.text());pause();doc=imported;time=0;selectedId=doc.objects[0]?.id??'camera';changed('Scene opened');persist();}catch(error){status(error instanceof Error?error.message:'Unable to open this scene.');}finally{input.value='';}
});

let timelineDrag: {element:HTMLElement;id:string;mode:string;initialX:number;laneWidth:number;initialTrack:MotionTrack;before:SceneDocument;moved:boolean}|null=null;
let scrubbing=false;
function scrubAt(clientX:number){const rect=$('#timeRuler').getBoundingClientRect();pause();seek((clientX-rect.left)/rect.width*doc.duration);}
$('#timelineContent').addEventListener('pointerdown',event=>{
  if(event.button!==0)return;const target=event.target as HTMLElement;
  if(target.closest('#timeRuler')){scrubbing=true;$('#timeRuler').setPointerCapture(event.pointerId);scrubAt(event.clientX);event.preventDefault();return;}
  const clip=target.closest<HTMLElement>('[data-clip]');if(!clip)return;
  const item=entity(clip.dataset.clip);if(!item?.track)return;
  pause();select(item.id);timelineDrag={element:clip,id:item.id,mode:target.dataset.trim||'move',initialX:event.clientX,laneWidth:clip.parentElement!.getBoundingClientRect().width,initialTrack:structuredClone(item.track),before:cloneDocument(doc),moved:false};clip.setPointerCapture(event.pointerId);clip.classList.add('dragging');event.preventDefault();
});
$('#timelineContent').addEventListener('pointermove',event=>{
  if(scrubbing){scrubAt(event.clientX);return;}if(!timelineDrag)return;
  const drag=timelineDrag,item=entity(drag.id);if(!item?.track)return;
  const delta=(event.clientX-drag.initialX)/drag.laneWidth*doc.duration,initial=drag.initialTrack;
  if(Math.abs(event.clientX-drag.initialX)>2)drag.moved=true; if(!drag.moved)return;
  if(drag.mode==='left'){const end=initial.start+initial.duration;item.track.start=clamp(initial.start+delta,0,end-0.1);item.track.duration=end-item.track.start;}
  else if(drag.mode==='right')item.track.duration=clamp(initial.duration+delta,0.1,doc.duration-initial.start);
  else item.track.start=clamp(initial.start+delta,0,doc.duration-initial.duration);
  drag.element.style.left=`${item.track.start/doc.duration*100}%`;drag.element.style.width=`${item.track.duration/doc.duration*100}%`;time=item.track.start;renderTime();renderInspector();syncStage();
});
function finishTimelineDrag(cancel=false){scrubbing=false;if(!timelineDrag)return;const drag=timelineDrag;timelineDrag=null;if(cancel){doc=drag.before;renderAll();}else if(drag.moved)changed('Motion timing updated');else{renderAll();}}
$('#timelineContent').addEventListener('pointerup',()=>finishTimelineDrag());
$('#timelineContent').addEventListener('pointercancel',()=>finishTimelineDrag(true));
$('#timeRuler').addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();pause();seek(time+(event.key==='ArrowRight'?0.1:-0.1));}else if(event.key==='Home'){event.preventDefault();pause();seek(0);}else if(event.key==='End'){event.preventDefault();pause();seek(doc.duration);}});
window.addEventListener('keydown',event=>{
  const target=event.target as HTMLElement;if(target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || document.querySelector('dialog[open]'))return;
  const key=event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey;
  if(mod&&key==='z'){event.preventDefault();flushFieldEdit();restore(event.shiftKey?history.redo():history.undo());return;}
  if(mod&&key==='y'){event.preventDefault();flushFieldEdit();restore(history.redo());return;}
  if(mod&&key==='s'){event.preventDefault();persist();status('Scene saved on this device');return;}
  if(mod&&key==='d'){event.preventDefault();duplicate();return;}
  if(mod||event.altKey)return;
  if(event.code==='Space'){event.preventDefault();if(!event.repeat)togglePlay();return;}
  if(key==='g'||key==='r'||key==='s'){event.preventDefault();chooseTool(key==='g'?'translate':key==='r'?'rotate':'scale');}
  if(key==='x'||key==='y'||key==='z')chooseAxis(axis===key.toUpperCase()?null:key.toUpperCase() as Axis);
  if(key==='f'){event.preventDefault();stage?.focusSelection();}
  if(key==='delete'||key==='backspace'){event.preventDefault();remove();}
  if(key==='escape'){chooseAxis(null);pause();document.querySelectorAll<HTMLDetailsElement>('details.studio-menu[open]').forEach(menu=>menu.open=false);}
});
function tick(now:number){const delta=Math.min((now-lastFrame)/1000,0.1);lastFrame=now;if(playing){time=Math.min(time+delta,doc.duration);if(time>=doc.duration){pause();renderInspector();}renderTime();syncStage();}requestAnimationFrame(tick);}
renderAll();persist();status(recovered?'Local scene restored':'Your first take · select a shape and make it move');requestAnimationFrame(tick);
