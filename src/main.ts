import './style.css';
import { Stage } from './stage';
import { EditorSelection, type SelectionMode } from './placement/selection';
import { transformSelection, type PoseUpdate, type TransformPhase } from './placement/transforms';
import { PlacementPanel } from './placement/panel';
import { openShotExport } from './shot-export/dialog';
import { openLookFrames } from './look/dialog';
import { AssetPanel } from './assets/panel';
import { AssetEditor } from './assets/editor';
import { updateAssetInstances } from './assets/edit';
import { instantiateAsset, saveObjectAsset, linkObjectAsset } from './assets/library';
import { createPrefabDialog } from './assets/dialog';
import { bindHierarchyAssets, type HierarchyAssetSource } from './assets/hierarchy';
import type { AssetDefinition } from './assets/model';
import { bindComponents, componentInspector } from './components/inspector';
import { inputController } from './components/model';
import { applyTransformModifiers } from './components/transform';
import { PerformanceSession } from './performance/session';
import { trackPoses, transformSchema } from './performance/motion';
import { createObject, cloneDocument, evaluateComponents, evaluateFov, evaluateTransform, animationFor, ensureAnimation, parseDocument, serializeDocument, History, createEmptyScene, createCamera, createShot, addIndependentShot, shotCamera, MAX_CAMERAS, sceneEntity, validateDocument } from './model';
import { emptyAnimation, evaluateProperty, frameAtTime, keepRecordedTake, movePropertyKeys, duplicatePropertyKeys, propertyPaths, putKey, putTransformKeys, putVectorKeys, removePropertyKeys, retimeTake, setKeyInterpolation, timeAtFrame, type PropertyPath, type VectorProperty } from './animation/model';
import { groupPaths, keyButton, keyState, renderPropertyRows, type PropertyGroup, type SelectedPropertyKey } from './animation/panel';
import './animation/panel.css';
import type { Axis, MotionTrack, PrimitiveKind, SceneDocument, SceneEntity, SceneObject, ProjectContent, Shot, ToolMode, Transform } from './types';
import { ReferenceDialog } from './reference/dialog';
import { SceneEditPanel } from './scene-edit/panel';
import { projectContent, serializeContent, validateProjectContent } from './project/model';
import { applyProjectOperations } from './scene-edit/operations';
import './project/panel.css';
import type { SceneSnapshot } from './scene-edit/operations';
import { type ProjectDocument, ProjectStorage, createProject, parseProject, serializeProject, PROJECT_STORAGE_KEY, MAX_PROJECT_SIZE } from './project/storage';

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
  hidden: '<path d="m3 3 18 18M10 5a11 11 0 0 1 12 7 17 17 0 0 1-4 5M6 6a16 16 0 0 0-4 6s4 7 10 7a12 12 0 0 0 5-1"/>',
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
  <div class="project-title"><input id="projectName" aria-label="Project name" maxlength="120"/><span id="saveStatus" class="save-status">Local draft</span></div>
  <div class="history-actions"><button class="icon-button" data-action="undo" aria-label="Undo" title="Undo · Ctrl Z">${icon('undo')}</button><button class="icon-button" data-action="redo" aria-label="Redo" title="Redo · Ctrl Shift Z">${icon('redo')}</button></div>
  <div class="header-actions"><button data-action="reference">${icon('camera')}<span>Reference video</span></button><button class="primary-button" data-action="export">${icon('download')}<span>Export project</span></button><details class="studio-menu" id="sceneMenu"><summary aria-label="Scene menu" title="Scene menu">${icon('more')}</summary><div class="menu-content"><button data-action="open">${icon('folder')}Open scene / project</button><button data-action="export-scene">${icon('download')}Export current scene</button><button data-action="top-view">${icon('eye')}Layout snapshot</button><button data-action="new-project">${icon('plus')}New empty project</button><button data-action="save">${icon('save')}Save locally<kbd>⌘ / Ctrl S</kbd></button><button data-action="shortcuts">${icon('help')}Keyboard shortcuts</button></div></details></div>
</header>
<div class="storage-warning" id="storageWarning" role="alert" hidden><span></span><button data-action="export-project">Download your changes</button><button data-action="recover-storage" hidden>Download saved data</button><button data-action="open">Open project</button><button data-action="reload">Reload</button></div>
<main class="workspace">
  <aside class="library-panel">
    <div class="scene-switcher"><label for="sceneSelect">SCENES</label><div><select id="sceneSelect" aria-label="Active scene"></select><button data-action="add-scene" aria-label="New scene" title="New empty scene">＋</button></div><input id="sceneName" aria-label="Scene name" maxlength="120" placeholder="No scene yet"/></div>
    <div class="library-tabs" role="tablist" aria-label="Library"><button id="objectsTab" role="tab" aria-controls="objectsPanel" aria-selected="true" data-library="objects">Objects<span id="objectCount"></span></button><button id="assetsTab" role="tab" aria-controls="assetPanel" aria-selected="false" data-library="assets">${icon('plus')}Add</button></div>
    <div id="objectsPanel" class="library-page" role="tabpanel" aria-labelledby="objectsTab"><input id="hierarchySearch" class="hierarchy-search" type="search" aria-label="Search objects" placeholder="Search objects…"/><div class="hierarchy-tools"><span id="selectionCount">0 selected</span><button data-action="hide-selection" title="Hide selected objects · H" aria-label="Hide selected objects">${icon('hidden')}</button><button data-action="show-selection" title="Show selected objects" aria-label="Show selected objects">${icon('eye')}</button></div><div id="outliner" class="outliner" aria-label="Scene objects"></div><button class="hierarchy-footer" id="visibilitySummary" data-action="show-all">All objects visible</button></div>
  </aside>
  <section class="stage-panel" aria-label="3D stage">
    <div class="viewport-heading"><div class="transform-tools" role="toolbar" aria-label="Transform tools"><button data-tool="translate" aria-label="Move tool" title="Move · G">${icon('move')}<span>Move</span></button><button data-tool="rotate" aria-label="Rotate tool" title="Rotate · R">${icon('rotate')}<span>Rotate</span></button><button data-tool="scale" aria-label="Scale tool" title="Scale · S">${icon('scale')}<span>Scale</span></button></div><div><button data-action="ground" title="Drop to the floor or surface below · double-click the green Y handle">↓ Drop to surface</button><button data-action="focus" title="Focus selection · F">${icon('focus')}Focus</button><button data-action="reset-view" aria-label="Reset scene view">Reset view</button></div></div>
    <div id="viewport" class="viewport"></div><div id="performanceBar" hidden></div><div id="emptyStage" class="empty-stage" hidden><h2>A place for your next story.</h2><p>Describe a set to Muse, or add your first scene.</p><button data-action="build-with-muse" class="primary-button">Build with Muse ↗</button></div>
    <section class="shot-panel" aria-label="Shot preview"><div class="shot-switcher"><select id="shotSelect" aria-label="Active shot"></select><button data-action="add-shot" aria-label="New shot" title="New shot">＋</button></div><div class="shot-heading"><h2>${icon('camera')}Shot preview</h2><button class="icon-button" data-action="expand-preview" aria-label="Expand shot preview" aria-expanded="false" title="Expand preview">${icon('expand')}</button></div><div id="previewDock"><div class="preview-frame" id="previewFrame"><div id="preview" class="preview"></div></div></div><div class="shot-footer"><span id="shotFrameStatus"><span class="live-dot"></span>Live · 16:9</span><button data-action="edit-shot" id="lensLabel">Edit shot</button></div></section>
    <div class="viewport-caption"><span id="viewHint">Drag to orbit · Scroll to zoom</span></div>
    <div class="ai-preview-badge" id="aiPreviewBadge" role="status" hidden>Previewing Muse changes</div>
  </section>
  <aside class="properties-drawer" id="propertiesDrawer" aria-label="Scene assistant and inspector">
    <div class="panel-tabs" role="tablist" aria-label="Scene tools"><button id="museTab" role="tab" data-panel="muse" aria-selected="true" aria-controls="sceneAI">✧ Muse</button><button id="inspectorTab" role="tab" data-panel="inspector" aria-selected="false" aria-controls="inspector">Inspector</button><span class="model-pill" id="museModel">Muse</span></div>
    <section class="ai-edit-panel" id="sceneAI" role="tabpanel" aria-labelledby="museTab"></section>
    <section class="inspector-panel" id="inspector" role="tabpanel" aria-labelledby="inspectorTab" hidden></section>
  </aside>
</main>
<section class="timeline-panel" id="timelinePanel" aria-label="Animation timeline">
  <div class="panel-resize-handle" id="timelineResizeHandle" role="separator" aria-label="Resize timeline" aria-orientation="horizontal" aria-controls="timelinePanel" tabindex="0" title="Drag to resize · Double-click to reset"></div>
  <div class="timeline-toolbar"><button id="timelineToggle" data-action="timeline" aria-expanded="false" aria-controls="timelineRows" title="Show or hide tracks">${icon('timeline')}Timeline<span class="timeline-chevron">⌃</span></button><div class="transport"><button data-action="rewind" class="icon-button" aria-label="Go to start">${icon('rewind')}</button><button data-action="play" id="playButton" class="play-button" aria-label="Play">${icon('play')}</button><span class="timecode" id="timecode" data-current-time>00:00.00</span><span class="timecode-separator">/</span><span class="timecode" id="endTimecode" data-end-time>00:05.00</span></div><div class="animation-toolbar"><button data-action="auto-key" id="autoKey" aria-pressed="false">● Auto Key Off</button><label>Frame <input type="number" id="animationFrame" aria-label="Current frame" min="0" step="1"/></label><select id="animationFps" aria-label="Timeline frame rate"><option value="24">24 fps</option><option value="30">30 fps</option></select><select id="animationInterpolation" aria-label="Keyframe interpolation" disabled><option value="linear">Linear</option><option value="constant">Hold</option><option value="smooth">Smooth</option><option value="quaternion">Quaternion</option></select><button data-action="duplicate-key" id="duplicateKey" disabled>Duplicate</button><button data-action="delete-key" id="deleteKey" disabled>Delete</button><button data-action="samples" id="samplesToggle" hidden>Show all samples</button></div><label class="duration-control">Duration <input type="number" id="duration" aria-label="Scene duration" min="1" max="60" step="1"/> s</label></div>
  <div class="timeline-content" id="timelineContent"><div class="timeline-ruler-row"><div class="track-heading">SHOT / PROPERTY</div><div class="animation-ruler-window"><div id="timeRuler" class="time-ruler" role="slider" tabindex="0" aria-label="Timeline playhead" aria-valuemin="0" aria-valuemax="5" aria-valuenow="0"></div></div></div><div id="timelineRows" class="timeline-rows"></div></div>
</section>
<footer class="status-bar"><section id="assetPanel" aria-label="Asset manager"></section><span id="statusText" role="status">Ready</span><button data-action="shortcuts">${icon('help')}Shortcuts</button></footer>
<dialog id="newProjectDialog"><div class="dialog-heading"><h2>Start an empty project?</h2></div><p>Your current project and chats will be downloaded first.</p><div class="change-actions"><button data-action="cancel-new-project">Cancel</button><button data-action="confirm-new-project" class="primary-button">Download &amp; start empty</button></div></dialog>
<input id="openFile" type="file" accept=".json,application/json" hidden/>
<dialog id="sceneSnapshotDialog" aria-labelledby="sceneSnapshotTitle"><div class="dialog-heading"><h2 id="sceneSnapshotTitle">Top view</h2><button data-action="close-snapshot" aria-label="Close top view">✕</button></div><img id="sceneSnapshotImage" class="scene-snapshot-image" alt="Top-down scene layout with object IDs"/><div class="snapshot-footer"><span id="sceneSnapshotInfo"></span><div><button data-action="refresh-snapshot">Refresh</button><button data-action="download-snapshot" class="primary-button">Download PNG</button></div></div></dialog>
<dialog id="previewDialog" aria-labelledby="previewTitle"><div class="dialog-heading"><h2 id="previewTitle">Shot preview</h2><button data-action="close-preview" aria-label="Close shot preview">✕</button></div><div id="expandedPreview"></div><div class="preview-transport"><button class="play-button" data-action="play" aria-label="Play">${icon('play')}</button><span class="timecode" data-current-time></span><span class="timecode-separator">/</span><span class="timecode" data-end-time></span></div></dialog>
<dialog id="shortcutsDialog"><div class="dialog-heading"><h2>Make yourself at home.</h2><button data-action="close-shortcuts" aria-label="Close shortcuts">✕</button></div><p class="muted">A few controls for your little stage.</p><dl class="shortcut-list"><dt>Orbit / pan / zoom</dt><dd>Left drag / Middle drag / Scroll</dd><dt>Fly around the scene</dt><dd>Hold right mouse + W A S D · Q / E up & down</dd><dt>Asset drawer</dt><dd>B · configurable in the bottom bar</dd><dt>Object controls</dt><dd>W/S forward/back · A/D turn · R record · Esc exit</dd><dt>Move / rotate / scale</dt><dd>G / R / S</dd><dt>Constrain an axis</dt><dd>X / Y / Z</dd><dt>Box select / add to selection</dt><dd>Shift drag empty space / Ctrl Shift drag</dd><dt>Multi-select in Hierarchy</dt><dd>Ctrl click / Shift click a range</dd><dt>Drop to surface</dt><dd>Double-click the green Y move handle</dd><dt>View orientation</dt><dd>Click an axis / drag the upper-right gizmo</dd><dt>Focus selection</dt><dd>F</dd><dt>Insert property key</dt><dd>Hover or focus a property · I</dd><dt>Play / pause</dt><dd>Space</dd><dt>Duplicate / delete</dt><dd>Ctrl D / Delete</dd><dt>Undo / redo</dt><dd>Ctrl Z / Ctrl Shift Z</dd><dt>Save locally</dt><dd>Ctrl S</dd></dl><p class="dialog-note">Use Key Transform for a whole pose, or key an individual property and expand its axes in the timeline.</p></dialog>
`;

const projectStorage = new ProjectStorage({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) });
let project = createProject(), recovered = false, storageError = '';
try { const loaded = projectStorage.load(); project = loaded.project; recovered = loaded.recovered; }
catch { storageError = 'The saved project could not be opened. Download saved data before opening a replacement.'; }
const emptyView = createEmptyScene('empty-view', 'No scene');
let doc: SceneDocument = project.scenes.find(scene => scene.id === project.activeSceneId) ?? emptyView;
let history = new History<ProjectContent>(projectContent(project));
const selection = new EditorSelection(doc.objects.find(item=>!item.track)?.id ?? doc.objects[0]?.id ?? null);
let transformEdit: { before: SceneEntity[]; time: number; wholeMotion: boolean; changed: boolean; drafts: Map<string,{time:number;value:number}> } | null = null;
let tool: ToolMode = 'translate';
let axis: Axis | null = null;
let time = 0;
let playing = false;
let lastFrame = performance.now();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let stage: Stage;
let placementPanel: PlacementPanel | undefined;
let assetsPanel: AssetPanel | undefined;
let libraryAssets: AssetDefinition[] = [];
let assetSaveBusy = false;
let assetProjectToken = crypto.randomUUID();
let assetEditor: AssetEditor | null = null;
let performanceSession: PerformanceSession | null = null;
let storageAvailable = true;
let timelineOpen = false;
let timelineHeight = window.innerHeight <= 720 ? 180 : 220;
let autoKey = false, showAxisKeys = false, showAllSamples = false, animationZoom=1;
let openProperties = new Set<PropertyGroup>(), selectedPropertyKey: SelectedPropertyKey | null = null;
let hoveredProperty: PropertyGroup | null = null;
const unkeyed = new Map<string, {time:number;value:number}>();
$('#animationFps').insertAdjacentHTML('afterend','<select id="animationZoom" aria-label="Timeline zoom"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option></select>');
function applyTimelineZoom(){const width=$('.animation-ruler-window').clientWidth;if(width)$('#timelinePanel').style.setProperty('--animation-lane-width',`${Math.round(width*animationZoom)}px`);$('#timeRuler').style.transform=`translateX(-${$('#timelineRows').scrollLeft}px)`;}
new ResizeObserver(applyTimelineZoom).observe($('.animation-ruler-window'));
$('#timelineRows').addEventListener('scroll',()=>{$('#timeRuler').style.transform=`translateX(-${$('#timelineRows').scrollLeft}px)`;});
try { const saved=Number(localStorage.getItem('littletake.timeline.height')); if(Number.isFinite(saved)&&saved>0)timelineHeight=saved; } catch {}
let libraryTab: 'objects'|'assets' = 'objects';
let editPreview: ProjectContent | null = null;
let previewSceneId: string | null = null, previewShotId: string | null = null;
let sceneEditor: SceneEditPanel | undefined;
let sceneSnapshot: SceneSnapshot | null = null;
let liveFieldEdit=false; let pendingFieldDoc:ProjectContent|null=null; let fieldCommitTimer:ReturnType<typeof setTimeout>|undefined;
function flushFieldEdit(){clearTimeout(fieldCommitTimer);if(pendingFieldDoc){history.commit(pendingFieldDoc);pendingFieldDoc=null;renderSelection();}}
const entity = (id = selection.active): SceneEntity | undefined => sceneEntity(doc, id);
const copyPose = (pose: Transform): Transform => structuredClone(pose);
const num = (value: number) => Number(value.toFixed(3));
const timecode = (value: number) => `${Math.floor(value / 60).toString().padStart(2,'0')}:${Math.floor(value % 60).toString().padStart(2,'0')}.${Math.floor((value % 1)*100).toString().padStart(2,'0')}`;
function nextId(prefix:string,items:{id:string}[]){let n=1;while(items.some(item=>item.id===prefix+'-'+n))n++;return prefix+'-'+n;}
function visibleScene(){return editPreview?.scenes.find(scene=>scene.id===previewSceneId)??(editPreview?emptyView:doc);}
function activeShot(){return visibleScene().shots.find(shot=>shot.id===(editPreview?previewShotId:project.activeShotId));}
function syncDocument(){
  if(!project.scenes.some(scene=>scene.id===project.activeSceneId))project.activeSceneId=project.scenes[0]?.id??null;
  doc=project.scenes.find(scene=>scene.id===project.activeSceneId)??emptyView;
  if(project.activeShotId!==null&&!doc.shots.some(shot=>shot.id===project.activeShotId))project.activeShotId=doc.shots[0]?.id??null;
  const selectedShot=doc.shots.find(shot=>shot.id===selection.active);
  if(selectedShot)selection.active=selectedShot.cameraId;
  selection.retain([...doc.objects,...doc.cameras].map(item=>item.id));
  time=clamp(time,0,doc.duration);
}
function replaceContent(next:ProjectContent,focus?:{sceneId:string|null;shotId:string|null}){
  const content=updateAssetInstances(validateProjectContent(next),libraryAssets).project; if(!content.assets)delete project.assets;Object.assign(project,content);
  for(const key of unkeyed.keys()){const [sceneId,id]=key.split('|'),scene=project.scenes.find(item=>item.id===sceneId);if(!scene||!sceneEntity(scene,id))unkeyed.delete(key);}
  if(focus){project.activeSceneId=focus.sceneId;project.activeShotId=focus.shotId;}
  syncDocument();
}
function openProject(next:ProjectDocument){
  pause();flushFieldEdit();sceneEditor?.session.cancel();projectStorage.acceptImport();
  storageError='';$('#storageWarning').hidden=true;$('.workspace').inert=false;$('#timelinePanel').inert=false;$('.app-header').inert=false;
  project=next;assetProjectToken=crypto.randomUUID();selection.active=null;time=0;syncDocument();history=new History(projectContent(project));
  sceneEditor?.session.replaceBook(next.conversations);if(sceneEditor)project.conversations=sceneEditor.session.book;
  renderAll();persist();
  synchronizeAssets(libraryAssets);void assetsPanel?.refresh();
}
function synchronizeAssets(assets:AssetDefinition[]):number {
  libraryAssets=assets;
  if(storageError||performanceSession)return 0;
  const result=updateAssetInstances(projectContent(project),assets);
  if(JSON.stringify(result.project.assets)===JSON.stringify(project.assets))return 0;
  pause();flushFieldEdit();project.assets=result.project.assets;project.revision++;sceneEditor?.sceneChanged();
  syncDocument();renderAll();persist();return result.count;
}
function switchScene(id:string){
  pause();flushFieldEdit();
  if(editPreview){previewSceneId=id;previewShotId=visibleScene().shots[0]?.id??null;selection.active=null;time=0;renderAll();return;}
  sceneEditor?.session.contextChanged();project.activeSceneId=id;project.activeShotId=project.scenes.find(scene=>scene.id===id)?.shots[0]?.id??null;selection.active=null;time=0;syncDocument();renderAll();persist();
}
function switchShot(id:string){
  const shot=visibleScene().shots.find(item=>item.id===id);if(!shot)return;
  pause();flushFieldEdit();
  if(editPreview)previewShotId=id;
  else{sceneEditor?.session.contextChanged();project.activeShotId=id;}
  selection.active=shot.cameraId;time=shot.start;setTimelineOpen(true);setSidePanel('inspector');
  renderNavigation();renderInspector();renderSelection();renderTime();syncStage();if(!editPreview)persist();
}
function addScene(){
  if(project.scenes.length>=24){status('This project supports up to 24 scenes');return;}
  const scene=createEmptyScene(nextId('scene',project.scenes),'Scene '+(project.scenes.length+1));
  project.scenes.push(scene);project.activeSceneId=scene.id;project.activeShotId=null;selection.active=null;time=0;syncDocument();changed('Empty scene added');
}
function ensureScene(){if(!project.activeSceneId)addScene();}
function addCamera(){ensureScene();pause();if(doc.cameras.length>=MAX_CAMERAS){status('Scene camera limit reached');return;}const camera=createCamera(nextId('camera',[...doc.objects,...doc.cameras,...doc.shots]),'Camera '+(doc.cameras.length+1));doc.cameras.push(camera);selection.active=camera.id;project.activeShotId=null;changed('Camera added');setSidePanel('inspector');}
function addShot(){
  ensureScene();pause();
  try{
    if(doc.shots.length>=100)throw new Error('This scene supports up to 100 shots');
    const camera=doc.cameras.find(item=>item.id===selection.active)??shotCamera(doc,project.activeShotId)??doc.cameras[0];
    const shot=camera?createShot(camera,nextId('shot',[...doc.objects,...doc.cameras,...doc.shots]),doc.duration,'Shot '+(doc.shots.length+1)):addIndependentShot(doc);
    if(camera)doc.shots.push(shot);
    project.activeShotId=shot.id;selection.active=shot.cameraId;time=shot.start;setTimelineOpen(true);setSidePanel('inspector');changed('Shot and camera linked · shared scene time');
  }catch(error){status((error as Error).message);}
}
function duplicateShot(){
  const source=activeShot();if(!source)return;pause();
  try{const shot=addIndependentShot(doc,source);project.activeShotId=shot.id;selection.active=shot.cameraId;time=shot.start;changed('Shot duplicated with its own camera');}catch(error){status((error as Error).message);}
}
function removeShot(){
  const shot=activeShot();if(!shot)return;pause();
  replaceContent(applyProjectOperations(projectContent(project),[{type:'remove_shot',sceneId:doc.id,id:shot.id}],time));
  project.activeShotId=doc.shots.find(item=>item.cameraId===selection.active)?.id??null;changed('Shot removed · camera kept in the scene');
}
function shotFields(shot:Shot,scene:SceneDocument){
  return '<div class="inspector-section shot-properties"><div class="section-label">SHOT · SCENE TIME<div class="shot-actions"><button data-action="duplicate-shot" class="icon-button" aria-label="Duplicate shot and camera" title="Duplicate shot and camera">'+icon('duplicate')+'</button><button data-action="remove-shot" class="icon-button" aria-label="Remove shot, keep camera" title="Remove shot, keep camera">'+icon('trash')+'</button></div></div><label>Shot name<input id="shotName" aria-label="Shot name" maxlength="120" value="'+esc(shot.name)+'"/></label><label>Camera<select id="shotCameraSelect" aria-label="Shot camera">'+scene.cameras.map(camera=>'<option value="'+esc(camera.id)+'" '+(camera.id===shot.cameraId?'selected':'')+'>'+esc(camera.name)+'</option>').join('')+'</select></label><div class="timing-fields"><label>Starts at<input id="shotStart" aria-label="Shot start time" type="number" min="0" max="'+(scene.duration-shot.duration)+'" step="0.1" value="'+num(shot.start)+'"/></label><label>Duration<input id="shotDuration" aria-label="Shot duration" type="number" min="0.1" max="'+(scene.duration-shot.start)+'" step="0.1" value="'+num(shot.duration)+'"/></label></div><p class="property-note">This range selects scene time. Camera and actor motion keep their timing.</p></div>';
}
function renderNavigation(){
  const content=editPreview??project,scene=visibleScene(),shot=activeShot();
  $('#sceneSelect').innerHTML=content.scenes.length?content.scenes.map(item=>'<option value="'+esc(item.id)+'" '+(item.id===scene.id?'selected':'')+'>'+esc(item.name)+'</option>').join(''):'<option value="">No scenes yet</option>';
  if(document.activeElement!==$('#sceneName'))$<HTMLInputElement>('#sceneName').value=scene===emptyView?'':scene.name;
  $<HTMLInputElement>('#sceneName').disabled=scene===emptyView||!!editPreview;
  $('#shotSelect').innerHTML=(!shot?'<option value="">Camera preview</option>':'')+scene.shots.map(item=>'<option value="'+esc(item.id)+'" '+(item.id===shot?.id?'selected':'')+'>'+esc(item.name)+'</option>').join('');
  $('#lensLabel').textContent=shot?'Edit '+shot.name:'Add a shot';
  $('#emptyStage').hidden=content.scenes.length>0||!!editPreview;
  $('[data-action="add-scene"]').toggleAttribute('disabled',!!editPreview);
  $('[data-action="add-shot"]').toggleAttribute('disabled',!!editPreview);
  $('#duration').toggleAttribute('disabled',!!editPreview||scene===emptyView);
  document.querySelectorAll<HTMLButtonElement>('[data-action="add-camera"],[data-action="add-shot"],[data-add]').forEach(button=>button.disabled=!!editPreview);
  document.querySelectorAll<HTMLButtonElement>('[data-action="play"],[data-action="rewind"],[data-action="top-view"]').forEach(button=>button.disabled=scene===emptyView);
  sceneEditor?.refreshContext();
}
function status(message: string) { $('#statusText').textContent = message; clearTimeout(statusTimer); statusTimer=setTimeout(()=>$('#statusText').textContent='Ready',5000); }
function persist() {
  clearTimeout(saveTimer);
  if (!storageError) {
    try { projectStorage.save(project); $('#saveStatus').textContent='Saved on this device'; storageAvailable=true; }
    catch (error) { storageError=error instanceof Error?error.message:'Local storage is unavailable. Download your project to keep your changes.'; storageAvailable=false;sceneEditor?.session.cancel('Saving is unavailable. Download your changes or reload before continuing.'); }
  }
  if (storageError) {
    storageAvailable=false;$('#saveStatus').textContent='Project not saved';$('#storageWarning').hidden=false;$('#storageWarning > span').textContent=storageError;
    $('[data-action="recover-storage"]').hidden=!projectStorage.savedText();
    $('.workspace').inert=true;$('#timelinePanel').inert=true;$('.app-header').inert=true;
  }
}
function changed(message?: string) { project.revision++;sceneEditor?.sceneChanged(); if(liveFieldEdit){pendingFieldDoc=structuredClone(projectContent(project));clearTimeout(fieldCommitTimer);fieldCommitTimer=setTimeout(flushFieldEdit,450);}else{flushFieldEdit();history.commit(projectContent(project));} renderAll(); if(!storageError)$('#saveStatus').textContent='Saving…'; clearTimeout(saveTimer); saveTimer=setTimeout(persist,350); if(message)status(message); }
function pause() { const wasPlaying=playing; playing=false; renderTransport(); if(wasPlaying){renderInspector();syncStage();} }
function select(id: string | null) { selectIds(id ? [id] : [], 'replace'); }
function selectIds(ids: string[], mode: SelectionMode, range = false) {
  if(performanceSession)return;flushFieldEdit();
  const previous=selection.active;
  const objects=visibleScene().objects.map(item=>item.id),cameraId=ids.find(id=>visibleScene().cameras.some(camera=>camera.id===id));
  if(cameraId)selection.active=cameraId;
  else {
    selection.retain(objects);
    if(range&&ids.length===1)selection.range(ids[0],objects,mode==='append');
    else selection.set(ids.filter(id=>objects.includes(id)),mode);
  }
  const id=selection.active;if(id)setLibraryTab('objects');
  if(previous!==id){selectedPropertyKey=null;openProperties.clear();renderTimeline();}
  if(selection.ids.length>1)pause();
  const scene=visibleScene(),camera=scene.cameras.find(item=>item.id===id);
  if(camera&&activeShot()?.cameraId!==camera.id){
    const shot=scene.shots.find(item=>item.cameraId===camera.id);pause();
    if(editPreview)previewShotId=shot?.id??null;else{sceneEditor?.session.contextChanged();project.activeShotId=shot?.id??null;}
    if(shot)time=shot.start;
    renderNavigation();renderTime();if(!editPreview)persist();
  }
  syncStage();renderInspector();renderSelection();sceneEditor?.refreshContext();
}
function setSidePanel(panel: 'muse'|'inspector') { $('#sceneAI').hidden=panel!=='muse';$('#inspector').hidden=panel!=='inspector';document.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(button=>{const active=button.dataset.panel===panel;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;}); }
function clamp(value: number,min: number,max: number) { return Math.max(min,Math.min(max,value)); }
const fps = () => doc.fps ?? 24;
const snapFrame = (value:number) => clamp(timeAtFrame(frameAtTime(value,fps()),fps()),0,doc.duration);
const draftId = (item:SceneEntity,path:PropertyPath) => `${doc.id}|${item.id}|${path}`;
function currentDraft(item:SceneEntity,path:PropertyPath) {
  const draft=unkeyed.get(draftId(item,path)); return draft && Math.abs(draft.time-time)<1e-6 ? draft : undefined;
}
function propertyValue(item:SceneEntity,path:PropertyPath):number {
  const draft=currentDraft(item,path);if(draft)return draft.value;
  if(path==='fov')return 'fov' in item?evaluateFov(item,time):45;
  const [group,axis]=path.split('.') as [VectorProperty,'x'|'y'|'z'],index='xyz'.indexOf(axis);
  if(group==='pivot') {
    const pivot='kind' in item?evaluateComponents(item,time)?.find(component=>component.type==='pivot'):undefined;
    return pivot?.type==='pivot'?pivot.offset[index]:0;
  }
  return evaluateTransform(item,time)[group][index];
}
function displayedPose(item:SceneEntity):Transform {
  const pose=evaluateTransform(item,time);
  for(const group of ['position','rotation','scale'] as const) for(const [index,axis] of ['x','y','z'].entries()){
    const draft=currentDraft(item,`${group}.${axis}` as PropertyPath);if(draft)pose[group][index]=draft.value;
  }
  return pose;
}
function sceneWithDrafts(scene:SceneDocument):SceneDocument {
  const overlay=(item:SceneEntity):SceneEntity=>{
    const paths=['position','rotation','scale','pivot'].flatMap(group=>propertyPaths(group as VectorProperty)).concat('fov');
    if(!paths.some(path=>currentDraft(item,path)))return item;
    const copy=structuredClone(item);copy.transform=displayedPose(item);copy.track=null;delete copy.animation;
    if('fov' in copy && 'fov' in item)copy.fov=propertyValue(item,'fov');
    if('kind' in copy && 'kind' in item){copy.components=structuredClone(evaluateComponents(item,time));const pivot=copy.components?.find(component=>component.type==='pivot');if(pivot?.type==='pivot')pivot.offset=['x','y','z'].map(axis=>propertyValue(item,`pivot.${axis}` as PropertyPath)) as Transform['position'];}
    return copy;
  };
  return {...scene,objects:scene.objects.map(item=>overlay(item) as SceneObject),cameras:scene.cameras.map(item=>overlay(item) as typeof item)};
}
function propertyValues(item:SceneEntity,group:PropertyGroup):number[] {
  return groupPaths(group).map(path=>propertyValue(item,path));
}
function editProperty(item:SceneEntity,path:PropertyPath,value:number):boolean {
  const animation=animationFor(item),keys=animation?.curves[path]??[],existing=keys.some(key=>Math.abs(key.time-time)<1e-6);
  const [group,axis]=path.split('.') as [VectorProperty,'x'|'y'|'z'];const index='xyz'.indexOf(axis);
  if(autoKey||existing) {
    const next=ensureAnimation(item);
    if(autoKey && path!=='fov'){
      const values=propertyValues(item,group) as Transform['position'];values[index]=value;putVectorKeys(next,group,time,values);
      groupPaths(group).forEach(key=>{if(currentDraft(item,key))unkeyed.delete(draftId(item,key));});
    }else{
      const orientation=group==='rotation'?displayedPose(item).rotation:undefined;if(orientation)orientation[index]=value;
      putKey(next,path,time,value,orientation);if(currentDraft(item,path))unkeyed.delete(draftId(item,path));
    }
    return true;
  }
  if(!keys.length){
    if(path==='fov'&&'fov' in item)item.fov=value;
    else if(group==='pivot'&&'kind' in item){const pivot=item.components?.find(component=>component.type==='pivot');if(pivot?.type==='pivot')pivot.offset[index]=value;}
    else if(group!=='pivot')item.transform[group][index]=value;
    return true;
  }
  const pending=unkeyed.get(draftId(item,path));
  if(pending&&Math.abs(pending.time-time)>1e-6){status('An unkeyed change is waiting at another time · Review it first');return false;}
  unkeyed.set(draftId(item,path),{time,value});status('Unkeyed change · Insert a key to keep it');return false;
}
function keyProperty(item:SceneEntity,group:PropertyGroup,toggle:boolean):void {
  const paths=groupPaths(group),animation=animationFor(item),remove=toggle&&keyState(animation,group,time)==='on-key'&&!paths.some(path=>currentDraft(item,path)),values=propertyValues(item,group);
  const target=ensureAnimation(item);
  if(remove)removePropertyKeys(target,paths,time);
  else if(group==='fov')putKey(target,'fov',time,values[0]);
  else putVectorKeys(target,group,time,values as Transform['position']);
  paths.forEach(path=>{if(currentDraft(item,path))unkeyed.delete(draftId(item,path));});
  selectedPropertyKey=remove?null:{group,time};changed(remove?'Property key removed':'Property key added');
}
function keyTransform(item:SceneEntity):void {
  const pose=displayedPose(item),target=ensureAnimation(item);
  if('fov' in item){putVectorKeys(target,'position',time,pose.position);putVectorKeys(target,'rotation',time,pose.rotation);}
  else putTransformKeys(target,time,pose);
  for(const group of ['position','rotation','scale'] as const)for(const path of propertyPaths(group))if(currentDraft(item,path))unkeyed.delete(draftId(item,path));
  selectedPropertyKey=null;changed('Transform keyed');
}
function syncStage() { const item=entity(), visibleDoc=sceneWithDrafts(visibleScene()),session=performanceSession;
  const component=inputController(session?.before.components);stage?.setControlled(session?{id:session.before.id,pose:session.preview(time),world:component?.type==='movement'&&component.space==='world'}:null);
  stage?.update(visibleDoc,Math.min(time,visibleDoc.duration),selection.ids,Boolean(editPreview) || !!session || playing, editPreview ? previewShotId : project.activeShotId,(editPreview??project).assets??[]); }
function seek(value: number) { time=clamp(value,0,visibleScene().duration); renderTime(); syncStage(); if(!playing)renderInspector(); }
function renderTransport() { document.querySelectorAll<HTMLButtonElement>('[data-action="play"]').forEach(button=>{button.innerHTML=icon(playing?'pause':'play');button.setAttribute('aria-label',playing?'Pause':'Play');button.classList.toggle('is-playing',playing);}); }
function renderTime() {
  const doc=visibleScene(), shot=activeShot();
  const camera=shotCamera(doc,shot?.id??null)??doc.cameras.find(item=>item.id===selection.active)??doc.cameras[0];
  $('#shotFrameStatus').textContent=shot?(time<shot.start||time>shot.start+shot.duration?'Outside shot range':camera?.name+' · 16:9'):camera?camera.name+' · Preview':'No camera';
  $<HTMLButtonElement>('[data-action="export-shot"]').disabled=!shot||!!editPreview||!!performanceSession||[...unkeyed.keys()].some(key=>key.startsWith(`${doc.id}|`));
  document.querySelectorAll<HTMLElement>('[data-current-time]').forEach(node=>node.textContent=timecode(time)); document.querySelectorAll<HTMLElement>('[data-end-time]').forEach(node=>node.textContent=timecode(doc.duration));
  const fraction=time/doc.duration*100;
  document.querySelectorAll<HTMLElement>('.lane-playhead').forEach(node=>node.style.left=`${fraction}%`);
  const label=$<HTMLElement>('[data-playhead-time]');label.textContent=time.toFixed(2);label.style.transform=`translateX(${fraction<4?0:fraction>96?-100:-50}%)`;
  $('#timeRuler').setAttribute('aria-valuenow',String(num(time))); $('#timeRuler').setAttribute('aria-valuemax',String(doc.duration));
  $('#timeRuler').setAttribute('aria-valuetext',`${time.toFixed(2)} seconds`);
  const frame=$<HTMLInputElement>('#animationFrame');if(document.activeElement!==frame)frame.value=String(frameAtTime(time,fps()));frame.max=String(frameAtTime(doc.duration,fps()));
  $<HTMLSelectElement>('#animationFps').value=String(fps());$('#autoKey').textContent=`● Auto Key ${autoKey?'On':'Off'}`;$('#autoKey').setAttribute('aria-pressed',String(autoKey));
}
function renderSelection() {
  document.querySelectorAll<HTMLElement>('[data-select]').forEach(node=>{ const selected=selection.ids.includes(node.dataset.select!);node.classList.toggle('selected',selected);node.classList.toggle('active-selection',node.dataset.select===selection.active);node.setAttribute('aria-pressed',String(selected)); });
  const selected=selectedObjects(),visible=selected.filter(item=>!item.hidden),disabled=!!editPreview||!!performanceSession||!!storageError;
  $('#selectionCount').textContent=selected.length+' selected';
  $<HTMLButtonElement>('[data-action="hide-selection"]').disabled=disabled||!visible.length;
  $<HTMLButtonElement>('[data-action="show-selection"]').disabled=disabled||!selected.some(item=>item.hidden);
  $<HTMLButtonElement>('[data-action="ground"]').disabled=disabled||playing||!visible.length;
  placementPanel?.update(visible.map(item=>item.name),disabled||playing);
  document.querySelectorAll<HTMLElement>('[data-shot]').forEach(node=>{const active=node.dataset.shot===activeShot()?.id;node.classList.toggle('selected',active);node.setAttribute('aria-pressed',String(active));});
  document.querySelectorAll<HTMLElement>('[data-tool]').forEach(node=>{node.classList.toggle('active',node.dataset.tool===tool);node.setAttribute('aria-pressed',String(node.dataset.tool===tool));});
  document.querySelectorAll<HTMLElement>('[data-axis]').forEach(node=>{node.classList.toggle('active',node.dataset.axis===axis);node.setAttribute('aria-pressed',String(node.dataset.axis===axis));});
  ($('[data-action="undo"]') as HTMLButtonElement).disabled=!!editPreview||!history.canUndo;
  ($('[data-action="redo"]') as HTMLButtonElement).disabled=!!editPreview||!history.canRedo;
}
function setLibraryTab(tab: 'objects'|'assets') {
  libraryTab=tab; $('#objectsPanel').hidden=false; assetsPanel?.setOpen(tab==='assets');
  document.querySelectorAll<HTMLButtonElement>('[data-library]').forEach(button=>{const active=button.dataset.library===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
}
function setTimelineOpen(open: boolean) {
  if(open&&timelineHeight<=62)setTimelineHeight(window.innerHeight<=720?180:220);
  timelineOpen=open; $('#timelinePanel').classList.toggle('expanded',open); $('#timelineRows').hidden=!open; $('#timelineToggle').setAttribute('aria-expanded',String(open));
  $('#timelineResizeHandle').setAttribute('aria-valuenow',String(open?timelineHeight:62));
}
function setTimelineHeight(value: number) {
  const max=Math.max(62,Math.floor(window.innerHeight*.7)),handle=$('#timelineResizeHandle');
  timelineHeight=Math.round(clamp(value,62,max));$('#timelinePanel').style.setProperty('--timeline-height',`${timelineHeight}px`);
  handle.setAttribute('aria-valuemin','62');handle.setAttribute('aria-valuemax',String(max));handle.setAttribute('aria-valuenow',String(timelineOpen?timelineHeight:62));
}
function saveTimelineHeight() {try{localStorage.setItem('littletake.timeline.height',String(timelineHeight));}catch{}}
function renderOutliner() {
  const scene=visibleScene();$('#objectCount').textContent=String(scene.objects.length);
  const query=$<HTMLInputElement>('#hierarchySearch').value.trim().toLowerCase();
  const rows=(items:SceneEntity[])=>items.filter(item=>item.name.toLowerCase().includes(query)).map(item=>{
    const object='kind' in item,hidden=object&&item.hidden;
    const row='<button class="object-row" data-select="'+esc(item.id)+'" '+(object?'draggable="true" data-prefab-object="'+esc(item.id)+'" ':'')+'aria-label="Select '+esc(item.name)+'">'+icon(object?item.kind:'camera')+'<span>'+esc(item.name)+'</span>'+(item.track?'<span class="motion-dot" title="Animated"></span>':'')+'</button>';
    return object?'<div class="hierarchy-object '+(hidden?'is-hidden':'')+'">'+row+'<button class="visibility-toggle" draggable="false" data-visibility-id="'+esc(item.id)+'" aria-label="'+(hidden?'Show ':'Hide ')+esc(item.name)+'" title="'+(hidden?'Show':'Hide')+' object; applies to selected objects when selected">'+icon(hidden?'hidden':'eye')+'</button></div>':row;
  }).join('');
  $('#outliner').innerHTML=rows(scene.objects)+'<div class="outliner-heading">CAMERAS <button data-action="add-camera" aria-label="New camera">＋</button></div>'+rows(scene.cameras);
  const hidden=scene.objects.filter(item=>item.hidden).length;
  $('#visibilitySummary').textContent=hidden?'Show all · '+hidden+' hidden':'All objects visible';
  $<HTMLButtonElement>('#visibilitySummary').disabled=!hidden||!!editPreview||!!performanceSession;
  $('#hiddenCount').hidden=!hidden;$('#hiddenCount').textContent=hidden+' hidden · Excluded from export';
}
function selectedObjects(): SceneObject[] { const scene=visibleScene();return selection.ids.flatMap(id=>{const item=scene.objects.find(item=>item.id===id);return item?[item]:[];}); }
function setHidden(ids: string[], hidden: boolean): void {
  if(editPreview||performanceSession||storageError)return;
  const items=doc.objects.filter(item=>ids.includes(item.id)&&!!item.hidden!==hidden);if(!items.length)return;
  pause();flushFieldEdit();(document.activeElement as HTMLElement)?.blur();
  for(const item of items){if(hidden)item.hidden=true;else delete item.hidden;}
  changed(`${items.length} object${items.length===1?'':'s'} ${hidden?'hidden':'shown'}`);
}
function visibilityCard(items: SceneObject[]): string {
  const hidden=items.filter(item=>item.hidden).length,all=hidden===items.length;
  return '<div class="visibility-card"><div>'+(all?'Hidden':hidden?'Mixed visibility':'Visible')+'<small>'+(hidden?hidden+' hidden · excluded from preview and export':'Shown in scene, preview and export')+'</small></div><button data-action="'+(all?'show-selection':'hide-selection')+'">'+(all?'Show':'Hide')+'</button></div>';
}
function poseFields(label: string,group: keyof Transform,values: number[],disabled: boolean,item:SceneEntity) {
  const animation=animationFor(item);
  return `<div class="property-group"><div class="property-label property-label-key"><span>${label}</span>${keyButton(animation,group,time,disabled)}</div><div class="vector-inputs">${['X','Y','Z'].map((a,i)=>{const path=`${group}.${a.toLowerCase()}` as PropertyPath,key=animation?.curves[path]?.some(k=>Math.abs(k.time-time)<1e-6);return `<label class="vector-field axis-${a.toLowerCase()}"><span>${a}</span><input type="number" aria-label="${label} ${a}" data-pose="${group}" data-component="${i}" step="${group==='rotation'?5:0.1}" value="${num(values[i])}" ${group==='scale'?'min="0.01" max="100"':''} ${disabled?'disabled':''}/>${showAxisKeys?`<button type="button" class="property-key ${key?'on-key':''}" data-key-path="${path}" aria-label="${key?'Remove':'Insert'} ${label} ${a} keyframe" ${disabled?'disabled':''}>${key?'◆':'◇'}</button>`:''}</label>`;}).join('')}</div></div>`;
}
function componentAxisKey(item:SceneEntity,group:'pivot',index:number,disabled:boolean):string {
  if(!showAxisKeys)return '';const axis='xyz'[index],path=`${group}.${axis}` as PropertyPath,key=animationFor(item)?.curves[path]?.some(value=>Math.abs(value.time-time)<1e-6);
  return `<button type="button" class="property-key ${key?'on-key':''}" data-key-path="${path}" aria-label="${key?'Remove':'Insert'} Pivot Offset ${axis.toUpperCase()} keyframe" ${disabled?'disabled':''}>${key?'◆':'◇'}</button>`;
}
function renderInspector() {
  if(!performanceSession && !editPreview && document.activeElement instanceof HTMLInputElement && $('#inspector').contains(document.activeElement)) return;
  const inspectedDoc=visibleScene(),item=sceneEntity(inspectedDoc,selection.active);
  $('#inspector').inert=Boolean(editPreview);
  if(selection.ids.length>1) {
    const items=inspectedDoc.objects.filter(item=>selection.ids.includes(item.id)),center=stage?.selectionCenter()??[0,0,0];
    const fields=(label:string,group:string,values:number[])=>'<div class="property-group"><label class="property-label">'+label+'</label><div class="vector-inputs">'+values.map((value,i)=>'<label class="vector-field"><span>'+['X','Y','Z'][i]+'</span><input type="number" aria-label="'+label+' '+['X','Y','Z'][i]+'" data-placement="'+group+'" data-index="'+i+'" step="'+(group==='rotation'?5:.1)+'" value="'+num(value)+'" '+(playing?'disabled':'')+'/></label>').join('')+'</div></div>';
    $('#inspector').innerHTML='<div class="inspector-title"><span class="entity-type">'+icon('move')+items.length+' OBJECTS SELECTED</span><div><button data-action="duplicate" class="icon-button" aria-label="Duplicate selection">'+icon('duplicate')+'</button><button data-action="delete" class="icon-button" aria-label="Delete selection">'+icon('trash')+'</button></div></div><div class="selection-members">'+items.map(item=>'<span>'+esc(item.name)+'</span>').join('')+'</div><div class="inspector-section"><div class="section-label">Shared transform</div>'+fields('Selection center','position',center)+fields('Rotate by','rotation',[0,0,0])+'<label class="property-label">Uniform scale ×<input type="number" aria-label="Selection scale factor" data-placement="scale" data-index="0" min="0.01" max="100" step="0.1" value="1" '+(playing?'disabled':'')+'/></label><p class="property-note">Move and rotate around the shared center. Existing motion paths move with the selection.</p><button class="add-motion" data-action="ground">↓ Drop each object to surface</button></div><p class="property-note">Ctrl click toggles an object. Shift click selects a range in the Hierarchy.</p>';
    $('#inspector').querySelector('.selection-members')!.insertAdjacentHTML('afterend',visibilityCard(items));
    const visible=items.filter(item=>!item.hidden).length;
    if(visible<items.length)$('#inspector').querySelector('.property-note')!.textContent='Transforms affect '+visible+' visible objects. Hidden objects keep their positions and motion.';
    if(!visible)$('#inspector').querySelectorAll<HTMLInputElement|HTMLButtonElement>('[data-placement],[data-action="ground"]').forEach(node=>node.disabled=true);
    return;
  }
  if(!item){$('#inspector').innerHTML='<div class="empty-inspector">'+icon('move')+'<h3>Nothing selected</h3><p>Select an object or camera to edit its properties.</p></div>';return;}
  const pose=performanceSession?.preview(time)??displayedPose(item),locked=Boolean(editPreview)||!!performanceSession||playing||('kind' in item&&!!item.hidden),isCamera='fov' in item;
  const shot=isCamera&&activeShot()?.cameraId===item.id?activeShot():undefined,linked=inspectedDoc.shots.filter(shot=>shot.cameraId===item.id);
  const colors=['#b8ccce','#e8a28e','#f0d48d','#aebfa1','#9faed0','#e5d9c3','#b2a4bc','#555f66'];
  const title='<div class="inspector-title"><span class="entity-type">'+icon(isCamera?'camera':item.kind)+(isCamera?'CAMERA':item.kind.toUpperCase())+'</span><div><button data-action="duplicate" class="icon-button" aria-label="Duplicate selection">'+icon('duplicate')+'</button><button data-action="delete" class="icon-button" aria-label="Delete selection">'+icon('trash')+'</button></div></div><input class="entity-name" aria-label="Object name" id="entityName" maxlength="120" value="'+esc(item.name)+'"/>';
  const transform='<div class="inspector-section"><div class="section-label">Transform <div class="transform-key-actions"><button data-action="axis-keys" aria-pressed="'+showAxisKeys+'">'+(showAxisKeys?'Hide axis keys':'Axis keys')+'</button><button data-action="key-transform" '+(locked?'disabled':'')+'>◇ Key Transform</button></div></div>'+poseFields('Position','position',pose.position,locked,item)+poseFields('Rotation','rotation',pose.rotation,locked,item)+(isCamera?'<div class="property-label-key"><label class="property-label" for="cameraFov">Field of view <span class="input-unit">degrees</span></label>'+keyButton(animationFor(item),'fov',time,locked)+'</div><input type="number" id="cameraFov" aria-label="Camera field of view" min="10" max="120" step="1" value="'+num(propertyValue(item,'fov'))+'" '+(locked?'disabled':'')+'/>' :poseFields('Scale','scale',pose.scale,locked,item))+'<div class="axis-constraint-row"><span>Constrain axis</span><div class="axis-tools" aria-label="Axis constraint"><button data-axis="X" class="axis-x" aria-label="Constrain X axis">X</button><button data-axis="Y" class="axis-y" aria-label="Constrain Y axis">Y</button><button data-axis="Z" class="axis-z" aria-label="Constrain Z axis">Z</button></div></div></div>';
  const links=isCamera?'<div class="camera-shot-links">'+(linked.length?linked.map(shot=>'<button data-shot="'+esc(shot.id)+'">'+icon('camera')+esc(shot.name)+'</button>').join(''):'<button data-action="camera-shot">'+icon('plus')+'Create shot with this camera</button>')+'</div>'+(linked.length>1?'<p class="property-note">These '+linked.length+' shots share this camera’s framing and motion. Duplicate a shot for independent framing.</p>':''):'';
  const material='kind' in item?'<div class="inspector-section"><div class="section-label">MATERIAL</div><div class="color-palette">'+colors.map(color=>'<button class="color-swatch '+(item.color===color?'active':'')+'" style="--swatch:'+color+'" data-color="'+color+'" aria-label="Set color '+color+'"></button>').join('')+'<label class="custom-color" title="Custom color"><input type="color" aria-label="Custom object color" id="objectColor" value="'+item.color+'"/></label></div></div>':'';
  $('#inspector').innerHTML=title+links+('kind' in item?visibilityCard([item]):'')+transform+
    ('kind' in item?componentInspector({...item,components:evaluateComponents(item,time)?.map(component=>component.type==='pivot'?{...component,offset:['x','y','z'].map(axis=>propertyValue(item,`pivot.${axis}` as PropertyPath)) as Transform['position']}:component)},Boolean(editPreview)||playing||!!performanceSession||!!item.hidden,performanceSession?.mode==='control',false,group=>keyButton(animationFor(item),group,time,locked),(group,index)=>componentAxisKey(item,group,index,locked)):'')+
    (isCamera?'<button class="add-motion camera-align" data-action="use-view">'+icon('eye')+'Use current scene view</button>':'')+
    material+(shot?shotFields(shot,inspectedDoc):'');
  const pending=[...unkeyed.entries()].filter(([key,draft])=>key.startsWith(`${doc.id}|${item.id}|`)&&Math.abs(draft.time-time)<1e-6);
  if(pending.length)$('#inspector').insertAdjacentHTML('beforeend',pending.map(([key])=>`<div class="pending-animation">Unkeyed ${esc(key.split('|')[2])} · <button data-discard-draft="${esc(key)}">Discard</button></div>`).join(''));
  if('kind' in item){$('#inspector').insertAdjacentHTML('beforeend','<button class="asset-save-button" data-action="save-asset">☆ Create Independent Prefab…</button>');bindComponents($('#inspector'),item,()=>{(document.activeElement as HTMLElement)?.blur();if(item.animation&&!item.components?.some(component=>component.type==='pivot'))for(const path of propertyPaths('pivot'))delete item.animation.curves[path];changed('Component settings saved');},()=>performanceSession?exitPerformance():beginPerformance(),true);}
  if('asset' in item&&item.asset)$('#entityName').insertAdjacentHTML('afterend',`<button class="asset-instance-edit" data-action="edit-asset">◇ Edit Prefab</button>`);
  if(performanceSession){const button=$('#inspector').querySelector<HTMLElement>('[data-component-action]');if(button&&performanceSession.mode!=='control')button.textContent=performanceSession.mode==='record'?'Recording…':'Review Recording';}
  if(performanceSession)$('#inspector').querySelectorAll<HTMLInputElement|HTMLButtonElement>('.entity-name,[data-action],[data-color],#objectColor').forEach(node=>node.disabled=true);
}
function renderTimeline() {
  const doc=visibleScene(),tickCount=Math.min(10,Math.ceil(doc.duration));
  $('#timeRuler').innerHTML=Array.from({length:tickCount+1},(_,i)=>'<span class="time-tick" style="left:'+(i/tickCount*100)+'%">'+Math.round(i/tickCount*doc.duration*fps())+'f</span>').join('')+'<span class="lane-playhead ruler-playhead"><span data-playhead-time class="playhead-time"></span></span>';
  const shots=doc.shots.map(shot=>{
    const camera=shotCamera(doc,shot.id)!;
    return '<div class="timeline-row shot-row"><button class="track-label" data-shot="'+esc(shot.id)+'" aria-label="Select shot '+esc(shot.name)+'">'+icon('camera')+'<span>'+esc(shot.name)+'<small>→ '+esc(camera.name)+'</small></span></button><div class="track-lane"><button class="shot-range" data-shot="'+esc(shot.id)+'" data-shot-clip="'+esc(shot.id)+'" aria-label="Select '+esc(shot.name)+' range" title="Select scene time · drag to move or trim" style="left:'+(shot.start/doc.duration*100)+'%;width:'+(shot.duration/doc.duration*100)+'%"><span class="clip-edge" data-trim="left"></span><span>'+esc(shot.name)+' · '+num(shot.start)+'–'+num(shot.start+shot.duration)+'s</span><span class="clip-edge" data-trim="right"></span></button><span class="lane-playhead"></span></div></div>';
  }).join('');
  const item=sceneEntity(doc,selection.active),animation=item?animationFor(item):undefined;
  const groups:PropertyGroup[]=item?('fov' in item?['position','rotation','fov']:['position','rotation','scale',...(item.components?.some(component=>component.type==='pivot')?['pivot' as const]:[])]):[];
  const pending=[...unkeyed.entries()].filter(([key])=>key.startsWith(`${doc.id}|`));
  const summary=item?esc(item.name):'Select an object or camera';
  $('#timelineRows').innerHTML='<div class="timeline-group">SHOTS <span>One camera · a range of scene time</span><button data-action="add-shot" aria-label="Add shot">'+icon('plus')+'New shot</button></div>'+shots+'<div class="timeline-group">PROPERTIES <span>'+summary+'</span>'+(pending.length?'<button data-action="review-draft">'+pending.length+' unkeyed change · Review</button>':'')+'</div>'+renderPropertyRows(animation,groups,openProperties,selectedPropertyKey,doc.duration,fps(),showAllSamples);
  const selected=selectedPropertyKey,paths=selected?(selected.path?[selected.path]:groupPaths(selected.group)):[],key=selected?paths.flatMap(path=>animation?.curves[path]??[]).find(key=>Math.abs(key.time-selected.time)<1e-6):undefined;
  $<HTMLButtonElement>('#duplicateKey').disabled=!key;$<HTMLButtonElement>('#deleteKey').disabled=!key;
  const interpolation=$<HTMLSelectElement>('#animationInterpolation');interpolation.disabled=!key;if(key)interpolation.value=key.interpolation;
  const samples=$<HTMLButtonElement>('#samplesToggle');samples.hidden=!animation?.takes.length;samples.textContent=showAllSamples?'Show fewer samples':'Show all samples';
  applyTimelineZoom();
}
function renderAll() {
  renderNavigation();
  if(document.activeElement!==$('#projectName')) ($<HTMLInputElement>('#projectName')).value=project.name;
  ($<HTMLInputElement>('#duration')).value=String(visibleScene().duration);
  renderOutliner();renderTimeline();syncStage();renderInspector();renderSelection();renderTransport();renderTime();assetsPanel?.update(project.assets);renderPerformance();
}
function duplicate() {
  if(selection.ids.length>1){
    const items=doc.objects.filter(item=>selection.ids.includes(item.id));
    if(doc.objects.length+items.length>100){status('This scene supports up to 100 objects');return;}
    pause();const copies:SceneObject[]=[];
    for(const item of items){const copy=structuredClone(item);copy.id=nextId('object',[...doc.objects,...doc.cameras,...copies]);copy.name=item.name.slice(0,110)+' copy';copy.transform.position[0]=clamp(copy.transform.position[0]+1,-1000,1000);if(copy.track)for(const pose of trackPoses(copy.track))pose.position[0]=clamp(pose.position[0]+1,-1000,1000);if(copy.animation)for(const key of copy.animation.curves['position.x']??[])key.value=clamp(key.value+1,-1000,1000);copies.push(copy);}
    doc.objects.push(...copies);selection.set(copies.map(item=>item.id));changed(`${copies.length} objects duplicated`);return;
  }
  const item=entity();if(!item)return;pause();if(!('kind' in item)){if(doc.cameras.length>=MAX_CAMERAS){status('Scene camera limit reached');return;}const copy=structuredClone(item);copy.id=nextId('camera',[...doc.objects,...doc.cameras,...doc.shots]);copy.name=item.name.slice(0,110)+' copy';doc.cameras.push(copy);project.activeShotId=null;selection.active=copy.id;changed('Camera duplicated');return;}
  if(doc.objects.length>=100){status('This scene supports up to 100 objects');return;}
  const next=structuredClone(item);next.id=nextObjectId();next.name=`${item.name.slice(0,110)} copy`;
  next.transform.position[0]=clamp(next.transform.position[0]+1,-1000,1000);
  if(next.track)for(const pose of trackPoses(next.track))pose.position[0]=clamp(pose.position[0]+1,-1000,1000);
  if(next.animation)for(const key of next.animation.curves['position.x']??[])key.value=clamp(key.value+1,-1000,1000);
  doc.objects.push(next);selection.active=next.id;changed('Object duplicated');
}
function nextObjectIndex(){for(let index=1;;index++)if(!sceneEntity(doc,`object-${index}`))return index;}
function nextObjectId(){return `object-${nextObjectIndex()}`;}
function insertAsset(asset:AssetDefinition,pose:Transform){
  if(editPreview||performanceSession||storageError)return;
  ensureScene();if(doc.objects.length>=100){status('This scene supports up to 100 objects');return;}
  pause();flushFieldEdit();
  let item:SceneObject;try{item=instantiateAsset(asset,nextObjectId(),pose.position,doc.duration);}catch(error){status((error as Error).message);return;}
  project.assets??=[];project.assets=[...project.assets.filter(a=>a.id!==asset.id),structuredClone(asset)];item.transform=copyPose(pose);
  const count=doc.objects.filter(o=>o.asset?.id===asset.id).length;if(count)item.name=`${asset.name.slice(0,110)} ${count+1}`;
  doc.objects.push(item);selection.active=item.id;time=0;setSidePanel('inspector');changed(`${item.name} placed in scene · Independent instance`);
}
function saveSelectionAsset(){
  const item=entity();if(!item||!('kind' in item))return;
  const source=hierarchyAssetSource(item.id);if(source)void createObjectPrefab(source,assetsPanel?.currentFolder??'');
}
function hierarchyAssetSource(objectId:string):HierarchyAssetSource|null{
  if(storageError||editPreview||performanceSession||assetEditor||assetSaveBusy||!project.activeSceneId||!doc.objects.some(item=>item.id===objectId))return null;
  return {projectId:assetProjectToken,sceneId:project.activeSceneId,objectId};
}
async function createObjectPrefab(source:HierarchyAssetSource,folder:string){
  if(source.projectId!==assetProjectToken||source.sceneId!==project.activeSceneId||!hierarchyAssetSource(source.objectId))return;
  pause();flushFieldEdit();const item=doc.objects.find(item=>item.id===source.objectId)!;
  const original=JSON.stringify(item);assetSaveBusy=true;
  try{
    const saved=await createPrefabDialog(saveObjectAsset(item,project.assets??[],`saved-${crypto.randomUUID()}`),folder);if(!saved)return;
    const current=project.scenes.find(scene=>scene.id===source.sceneId)?.objects.find(item=>item.id===source.objectId);
    if(storageError||assetProjectToken!==source.projectId||JSON.stringify(current)!==original)throw new Error('Prefab created in My Assets. The original object changed during saving, so it was not relinked.');
    replaceContent(linkObjectAsset(projectContent(project),source.sceneId,source.objectId,saved.asset));selection.active=source.objectId;
    changed('Prefab created · Current object linked · Placement and motion retained');
    await assetsPanel?.refresh();assetsPanel?.showFolder(saved.folder);assetsPanel?.setOpen(true);
  }catch(error){status((error as Error).message);}
  finally{assetSaveBusy=false;}
}
function beginPerformance(){
  const item=entity();if(performanceSession||editPreview||!item||!('kind' in item)||item.hidden||!inputController(item.components))return;
  pause();flushFieldEdit();sceneEditor?.sceneChanged();performanceSession=new PerformanceSession(item,time);assetsPanel?.setOpen(false);setSidePanel('inspector');renderAll();stage?.focusCanvas();status('Control active · R records · Esc keeps position and exits');
}
function applyPlacement():boolean{
  if(!performanceSession)return false;
  const item=entity(performanceSession.before.id);if(!item||!('kind' in item))return false;
  try{const next=performanceSession.placement();if(JSON.stringify(next)!==JSON.stringify(item)){Object.assign(item,next);changed('Placement saved · Entire motion path moved');}return true;}
  catch(error){status(`${error instanceof Error?error.message:'Placement could not be saved'} Use Discard Position to exit.`);return false;}
}
function exitPerformance(){if(!performanceSession)return;if(performanceSession.mode==='record'){stopPerformanceRecord();return;}if(performanceSession.mode==='review')return;if(!applyPlacement())return;performanceSession=null;pause();renderAll();persist();synchronizeAssets(libraryAssets);}
function discardPosition(){if(!performanceSession||performanceSession.mode!=='control')return;performanceSession=null;pause();renderAll();persist();synchronizeAssets(libraryAssets);status('Positioning discarded');}
function startPerformanceRecord(){
  if(!performanceSession||performanceSession.mode!=='control')return;
  if(!applyPlacement())return;performanceSession.start(doc.duration);time=performanceSession.time;playing=false;setTimelineOpen(true);renderAll();stage?.focusCanvas();
}
function stopPerformanceRecord(){if(!performanceSession)return;performanceSession.stop();playing=false;time=performanceSession.time;renderAll();stage?.focusCanvas();}
function discardPerformance(retry=false){if(!performanceSession)return;playing=false;performanceSession.discard();time=performanceSession.time;renderAll();if(retry)startPerformanceRecord();else stage?.focusCanvas();}
function keepPerformance(){
  const session=performanceSession,item=session?entity(session.before.id):null;if(!session?.draft||!item)return;
  try{
    const track=session.draft,frames=[{time:track.start,transform:track.from},...(track.samples??[]).map(sample=>({time:track.start+sample.at*track.duration,transform:sample.transform})),{time:track.start+track.duration,transform:track.to}];
    const current=animationFor(item)??emptyAnimation();let n=1;while(current.takes.some(take=>take.id===`take-${n}`))n++;
    item.animation=keepRecordedTake(current,`take-${n}`,frames,doc.duration);item.track=null;
    performanceSession=null;playing=false;openProperties.clear();changed('Recording kept · Shared across shots · Undo available');persist();synchronizeAssets(libraryAssets);
  }catch(error){status((error as Error).message);}
}
function renderPerformance(){
  const session=performanceSession,active=!!session,bar=$('#performanceBar');bar.hidden=!active;
  $('.stage-panel').classList.toggle('performance-active',active);
  $('#sceneAI').inert=active;$('#timelineContent').inert=active;$('.library-panel').inert=active;$('.app-header').inert=active;
  $<HTMLInputElement>('#duration').disabled=active||!!editPreview||doc===emptyView;$<HTMLSelectElement>('#shotSelect').disabled=active;
  $<HTMLInputElement>('#animationFrame').disabled=active||!!editPreview;$<HTMLSelectElement>('#animationFps').disabled=active||!!editPreview;$<HTMLButtonElement>('#autoKey').disabled=active||!!editPreview;
  document.querySelectorAll<HTMLButtonElement>('[data-action="add-shot"],[data-action="rewind"],[data-action="top-view"]').forEach(b=>b.disabled=active||doc===emptyView);
  document.querySelectorAll<HTMLButtonElement>('[data-action="play"]').forEach(b=>b.disabled=!!session&&session.mode!=='review');
  if(!session)return;
  bar.dataset.mode=session.mode;
  const header=`<div><strong>${session.mode==='record'?'● Recording':session.mode==='review'?'Review Take':'Positioning'} · ${esc(session.before.name)}</strong><small>${session.mode==='review'?session.draft!.duration.toFixed(1)+' s · Awaiting review':inputController(session.before.components)?.type==='hinge'?'W/S open/close · Camera stays fixed':'W/S move · A/D turn · Camera stays fixed'}</small></div>`;
  bar.innerHTML=header+(session.mode==='control'?'<button data-performance="record" class="primary-button">● Record <kbd>R</kbd></button><button data-performance="exit">Stop Control <kbd>Esc</kbd></button><button data-performance="discard-position">Discard Position</button>':session.mode==='record'?`<span id="performanceClock">${timecode(time)}</span><button data-performance="stop" class="record-button">■ Stop Recording</button>`:'<button data-performance="preview">▷ Play Take</button><button data-performance="retry">↻ Record Again</button><button data-performance="discard">Discard</button><button data-performance="keep" class="primary-button">✓ Keep Take</button>');
  bar.querySelectorAll<HTMLButtonElement>('[data-performance]').forEach(button=>button.onclick=()=>{
    switch(button.dataset.performance){case 'record':startPerformanceRecord();break;case 'exit':exitPerformance();break;case 'discard-position':discardPosition();break;case 'stop':stopPerformanceRecord();break;case 'preview':togglePlay();button.textContent=playing?'Ⅱ Pause':'▷ Play Take';break;case 'retry':discardPerformance(true);break;case 'discard':discardPerformance();break;case 'keep':keepPerformance();break;}
  });
}
function remove(){if(!selection.ids.length)return;try{const operations=selection.ids.map(id=>({type:doc.objects.some(item=>item.id===id)?'remove_object' as const:'remove_camera' as const,sceneId:doc.id,id}));replaceContent(applyProjectOperations(projectContent(project),operations,time));changed('Selection removed');}catch(error){status((error as Error).message);}}
function chooseTool(next:ToolMode){tool=next;stage?.setTool(tool);renderSelection();}
function chooseAxis(next:Axis|null){axis=next;stage?.setAxis(axis);renderSelection();}
function togglePlay(){if(playing)pause();else{const shot=activeShot(),take=performanceSession?.draft,start=take?.start??shot?.start??0,end=take?take.start+take.duration:shot?shot.start+shot.duration:doc.duration;if(time>=end-0.001||time<start)time=start;playing=true;lastFrame=performance.now();renderTransport();syncStage();}}
function restore(next:ProjectContent|null){if(!next)return;pause();replaceContent(next);project.revision++;sceneEditor?.sceneChanged();renderAll();persist();}
function exportScene(){if(!project.activeSceneId){status('Add a scene before exporting it');return;}const portable=doc.objects.some(o=>o.asset)?{...createProject(doc),assets:project.assets?.filter(a=>doc.objects.some(o=>o.asset?.id===a.id))}:null;const blob=new Blob([portable?serializeProject(portable):serializeDocument(doc)],{type:'application/json'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=`${doc.name.replace(/[^a-z0-9-_ ]/gi,'').trim()||'LittleTake'}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('Scene exported');}
function downloadProject(saved=false){const text=saved?projectStorage.savedText():serializeProject(project);if(!text)return;const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),anchor=document.createElement('a');anchor.href=url;anchor.download=saved?'LittleTake-recovery.json':`${project.name.replace(/[^a-z0-9-_ ]/gi,'').trim()||'LittleTake'}.project.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

syncDocument();
const referenceDialog = new ReferenceDialog(next => {
  pause(); flushFieldEdit(); const imported=cloneDocument(next);imported.id=nextId('scene',project.scenes);project.scenes.push(imported);project.activeSceneId=imported.id;project.activeShotId=imported.shots[0]?.id??null;selection.active=null;time=0;syncDocument();
  changed('Reference scene loaded · every object and camera is editable'); persist(); stage?.resetView();
});

function editSelection(updates:PoseUpdate[],phase:TransformPhase,wholeMotion:boolean):boolean {
  if(editPreview||performanceSession||storageError)return false;
  if(phase==='start'){
    flushFieldEdit();pause();
    const items=updates.map(update=>entity(update.id));if(items.some(item=>!item))return false;
    if(wholeMotion&&items.some(item=>item&&[...unkeyed.keys()].some(key=>key.startsWith(`${doc.id}|${item.id}|`)))){status('Insert or discard unkeyed changes before moving the whole selection');return false;}
    transformEdit={before:structuredClone(items as SceneEntity[]),time,wholeMotion,changed:false,drafts:new Map(unkeyed)};return true;
  }
  const edit=transformEdit;if(!edit)return false;
  if(phase==='cancel'){
    for(const before of edit.before){const item=entity(before.id);if(item){delete item.animation;Object.assign(item,before);}}
    unkeyed.clear();for(const [key,value] of edit.drafts)unkeyed.set(key,value);
    transformEdit=null;renderAll();return true;
  }
  if(phase==='end'){
    transformEdit=null;if(edit.changed)changed('Selection transform updated');else{renderTimeline();renderInspector();syncStage();}return true;
  }
  const beforeStep=updates.map(update=>entity(update.id)).filter((item):item is SceneEntity=>!!item).map(item=>structuredClone(item)),draftsBeforeStep=new Map(unkeyed);
  try {
    updates.forEach(update=>transformSchema.parse(update.transform));
    if(edit.wholeMotion){const replacements=transformSelection(edit.before,updates,edit.time,true);for(const replacement of replacements){const item=entity(replacement.id);if(!item)throw new Error('An object was removed during this edit.');delete item.animation;Object.assign(item,replacement);}edit.changed=JSON.stringify(replacements)!==JSON.stringify(edit.before);syncStage();renderInspector();return true;}
    for(const update of updates){const item=entity(update.id);if(!item)throw new Error('An object was removed during this edit.');const before=displayedPose(item);
      for(const group of ['position','rotation','scale'] as const)for(const [index,axis] of ['x','y','z'].entries()){
        const value=update.transform[group][index];if(Math.abs(before[group][index]-value)>1e-8)editProperty(item,`${group}.${axis}` as PropertyPath,value);
      }
    }
    edit.changed=JSON.stringify(updates.map(update=>entity(update.id)))!==JSON.stringify(edit.before);
    syncStage();renderInspector();return true;
  } catch(error) {for(const before of beforeStep){const item=entity(before.id);if(item){delete item.animation;Object.assign(item,before);}}unkeyed.clear();for(const [key,value] of draftsBeforeStep)unkeyed.set(key,value);status(error instanceof Error?error.message:'The transform was cancelled.');return false; }
}

try {
  $('.viewport-heading .transform-tools').insertAdjacentHTML('afterend','<div id="placementTools"></div>');
  $('.stage-panel').insertAdjacentHTML('beforeend','<div id="hiddenCount" class="hidden-count" hidden></div>');
  $('.shot-heading h2').insertAdjacentHTML('afterend','<button class="shot-export-button" data-action="export-shot" title="Export the current shot as an image or video">'+icon('download')+'Export</button><button class="shot-export-button" data-action="look-frames" title="Render finished film stills of this shot with Muse Image">'+icon('camera')+'Look</button>');
  stage=new Stage({viewport:$('#viewport'),preview:$('#preview'),onSelect:selectIds,onStatus:message=>$('#viewHint').textContent=message,onTransform:editSelection});
  stage.setTool(tool);
  placementPanel=new PlacementPanel($('#placementTools'),settings=>stage.setPrecision(settings),(axis,edge)=>stage.alignSelection(axis,edge));
  assetsPanel=new AssetPanel($('#assetPanel'),stage,insertAsset,()=>!storageError&&!editPreview&&!performanceSession&&!assetEditor,asset=>openAssetEditor(asset),synchronizeAssets,(source,folder)=>void createObjectPrefab(source,folder));assetsPanel.update(project.assets);
  bindHierarchyAssets($('#outliner'),hierarchyAssetSource,source=>void createObjectPrefab(source,assetsPanel?.currentFolder??''),()=>{assetsPanel?.showFolder(assetsPanel.currentFolder);assetsPanel?.setOpen(true);});
} catch(error) { $('#viewport').innerHTML=`<div class="webgl-error"><h2>This stage needs WebGL.</h2><p>Enable hardware acceleration in your browser, then reload.</p><small>${esc(error instanceof Error?error.message:'Renderer could not start.')}</small></div>`; }

sceneEditor=new SceneEditPanel({
  root:$('#sceneAI'), book:project.conversations, context:()=>({project:projectContent(project),sceneId:project.activeSceneId,shotId:project.activeShotId,revision:project.revision,time,selectedId:selection.active}), prepare:()=>{pause();flushFieldEdit();},
  changed:()=>persist(),clearSelection:()=>select(null),
  focus:context=>{const scene=project.scenes.find(scene=>scene.id===context.sceneId);if((context.sceneId!==null&&!scene)||(context.shotId!==null&&!scene?.shots.some(shot=>shot.id===context.shotId))){status('The original scene or shot no longer exists. Choose a context and send a new message.');return false;}pause();flushFieldEdit();project.activeSceneId=context.sceneId;project.activeShotId=context.shotId;selection.active=context.selectedId??null;syncDocument();time=clamp(context.time??0,0,doc.duration);renderAll();return true;},
  capture:(content,sceneId,shotId,frame,view)=>{const scene=content.scenes.find(item=>item.id===sceneId);if(!stage||!scene)throw new Error('Choose an existing scene before capturing a view.');return stage.captureSnapshot(scene,frame,view,shotId,content.assets??[]);},
  preview:(next,focus)=>{if(!next&&!editPreview)return;editPreview=next;previewSceneId=focus?.sceneId??next?.scenes[0]?.id??null;const scene=next?.scenes.find(item=>item.id===previewSceneId);previewShotId=scene?.shots.find(item=>item.id===focus?.shotId)?.id??scene?.shots[0]?.id??null;$('#aiPreviewBadge').hidden=!next;if(!next&&!entity())selection.active=null;time=clamp(time,0,visibleScene().duration);pause();renderAll();},
  apply:(next,base,focus)=>{if(serializeContent(projectContent(project))!==base)return false;replaceContent(next,focus);changed('Muse changes applied · Undo to restore');return true;},
});

function captureTopView() {
  pause();flushFieldEdit();
  if(!stage){status('The 3D stage is unavailable.');return;}
  try {
    const scene=visibleScene();sceneSnapshot=stage.captureSnapshot(scene,Math.min(time,scene.duration),'top_down',editPreview?previewShotId:project.activeShotId);
    $<HTMLImageElement>('#sceneSnapshotImage').src=sceneSnapshot.dataUrl;
    $('#sceneSnapshotInfo').textContent=`${sceneSnapshot.width} × ${sceneSnapshot.height} · ${sceneSnapshot.time.toFixed(2)}s`;
    if(!$<HTMLDialogElement>('#sceneSnapshotDialog').open)$<HTMLDialogElement>('#sceneSnapshotDialog').showModal();
  } catch(error){status((error as Error).message);}
}

app.addEventListener('click',event=>{
  if(assetEditor)return;
  const target=(event.target as HTMLElement).closest<HTMLElement>('button');if(!target || target.hasAttribute('disabled'))return;
  if(target.dataset.discardDraft){unkeyed.delete(target.dataset.discardDraft);renderAll();status('Unkeyed change discarded');return;}
  if(target.dataset.keyGroup){const item=entity();if(item&&!editPreview&&!performanceSession){event.preventDefault();pause();try{keyProperty(item,target.dataset.keyGroup as PropertyGroup,true);}catch(error){status((error as Error).message);}}return;}
  if(target.dataset.keyPath){const item=entity(),path=target.dataset.keyPath as PropertyPath;if(item&&!editPreview&&!performanceSession){event.preventDefault();pause();try{const value=propertyValue(item,path),animation=ensureAnimation(item),existing=animation.curves[path]?.some(key=>Math.abs(key.time-time)<1e-6);if(existing&&!currentDraft(item,path))removePropertyKeys(animation,[path],time);else{const orientation=path.startsWith('rotation.')?displayedPose(item).rotation:undefined;putKey(animation,path,time,value,orientation);unkeyed.delete(draftId(item,path));}selectedPropertyKey=existing?null:{group:path.split('.')[0] as PropertyGroup,path,time};changed('Axis key updated');}catch(error){status((error as Error).message);}}return;}
  if(target.dataset.animationToggle){const group=target.dataset.animationToggle as PropertyGroup;if(group!=='fov'){openProperties.has(group)?openProperties.delete(group):openProperties.add(group);renderTimeline();renderTime();}return;}
  if(performanceSession && !target.closest('#performanceBar,.control-component') && !['play','timeline'].includes(target.dataset.action??''))return;
  target.closest<HTMLDetailsElement>('details.studio-menu')?.removeAttribute('open');
  if(target.dataset.library){setLibraryTab(target.dataset.library as 'objects'|'assets');return;}
  if(target.dataset.panel){setSidePanel(target.dataset.panel as 'muse'|'inspector');return;}
  if(target.dataset.shot){switchShot(target.dataset.shot);return;}
  if(target.dataset.select){const range=event.shiftKey&&!!target.closest('#outliner');selectIds([target.dataset.select],range?(event.ctrlKey||event.metaKey?'append':'replace'):(event.ctrlKey||event.metaKey||event.shiftKey?'toggle':'replace'),range);setSidePanel('inspector');return;}
  if(editPreview && !['focus','reset-view','play','rewind','top-view','refresh-snapshot','timeline','expand-preview','close-preview','close-snapshot','download-snapshot'].includes(target.dataset.action??''))return;
  if(target.dataset.visibilityId){const item=doc.objects.find(item=>item.id===target.dataset.visibilityId);if(item)setHidden(selection.ids.includes(item.id)?selection.ids:[item.id],!item.hidden);return;}
  if(target.dataset.tool){chooseTool(target.dataset.tool as ToolMode);return;}
  if(target.dataset.axis){chooseAxis(axis===target.dataset.axis?null:target.dataset.axis as Axis);return;}
  if(target.dataset.add){ensureScene();if(doc.objects.length>=100){status('This scene supports up to 100 objects');return;}pause();const item=createObject(target.dataset.add as Exclude<PrimitiveKind,'asset'>,nextObjectIndex());doc.objects.push(item);selection.active=item.id;time=0;setLibraryTab('objects');changed(`${item.name} added`);return;}
  if(target.dataset.color){const item=entity();if(item && 'color' in item){item.color=target.dataset.color;changed();}return;}
  switch(target.dataset.action){
    case 'axis-keys':showAxisKeys=!showAxisKeys;renderInspector();break;
    case 'key-transform':{const item=entity();if(item){pause();try{keyTransform(item);}catch(error){status((error as Error).message);}}break;}
    case 'auto-key':autoKey=!autoKey;renderTime();break;
    case 'samples':showAllSamples=!showAllSamples;if(showAllSamples&&animationZoom<4){animationZoom=4;$<HTMLSelectElement>('#animationZoom').value='4';}renderTimeline();renderTime();break;
    case 'review-draft':{const entry=[...unkeyed.entries()].find(([key])=>key.startsWith(`${doc.id}|`));if(entry){const [,id,path]=entry[0].split('|');select(id);openProperties.add(path.split('.')[0] as PropertyGroup);pause();seek(entry[1].time);renderTimeline();renderTime();}break;}
    case 'duplicate-key':case 'delete-key':{const item=entity(),key=selectedPropertyKey;if(item&&key){try{const animation=structuredClone(animationFor(item)??emptyAnimation()),paths=key.path?[key.path]:groupPaths(key.group);if(target.dataset.action==='delete-key'){removePropertyKeys(animation,paths,key.time);selectedPropertyKey=null;}else{const next=timeAtFrame(frameAtTime(key.time,fps())+1,fps());if(next>doc.duration)throw new Error('No next frame in the scene.');duplicatePropertyKeys(animation,paths,key.time,next);selectedPropertyKey={...key,time:next};time=next;}item.animation=animation;item.track=null;changed('Keyframe updated');}catch(error){status((error as Error).message);}}break;}
    case 'hide-selection':setHidden(selection.ids,true);break;
    case 'show-selection':setHidden(selection.ids,false);break;
    case 'show-all':setHidden(doc.objects.map(item=>item.id),false);break;
    case 'export-shot':{const shot=activeShot();if(shot){pause();flushFieldEdit();try{openShotExport(stage.createShotRenderer(shot.cameraId),shot,time);}catch(error){status((error as Error).message);}}break;}
    case 'look-frames':{const shot=activeShot();if(shot){pause();flushFieldEdit();try{openLookFrames(stage.createShotRenderer(shot.cameraId),shot,time);}catch(error){status((error as Error).message);}}break;}
    case 'edit-asset':{const item=entity();if(item&&'asset' in item&&item.asset){const asset=project.assets?.find(a=>a.id===item.asset!.id);if(asset)openAssetEditor(asset);}break;}
    case 'save-asset':saveSelectionAsset();break;
    case 'record-performance':beginPerformance();startPerformanceRecord();break;
    case 'focus':stage?.focusSelection();break;
    case 'ground':pause();stage?.dropSelection();break;
    case 'reset-view':stage?.resetView();break;
    case 'use-view':{const view=stage?.captureView(),item=entity();if(!view||!item||!('fov' in item))break;pause();let saved=false;for(const group of ['position','rotation'] as const)for(const [i,axis] of ['x','y','z'].entries())saved=editProperty(item,`${group}.${axis}` as PropertyPath,view.transform[group][i])||saved;saved=editProperty(item,'fov',clamp(view.fov,10,120))||saved;if(saved)changed('Framing aligned to scene view');else{renderAll();status('Framing previewed · Insert keys to keep it');}break;}
    case 'undo':flushFieldEdit();restore(history.undo());status('Undo');break;
    case 'redo':flushFieldEdit();restore(history.redo());status('Redo');break;
    case 'duplicate':duplicate();break;
    case 'delete':remove();break;
    case 'play':togglePlay();break;
    case 'rewind':pause();seek(activeShot()?.start??0);break;
    case 'save':persist();status(storageAvailable?'Scene saved on this device':'Local storage unavailable · export the scene to keep it');break;
    case 'export':downloadProject();break;
    case 'export-scene':exportScene();break;
    case 'add-scene':addScene();break;
    case 'add-camera':addCamera();break;
    case 'add-shot':addShot();break;
    case 'camera-shot':addShot();break;
    case 'duplicate-shot':duplicateShot();break;
    case 'remove-shot':removeShot();break;
    case 'edit-shot':{const shot=activeShot();if(shot)switchShot(shot.id);else addShot();break;}
    case 'build-with-muse':setSidePanel('muse');$<HTMLTextAreaElement>('#sceneInstruction').focus();break;
    case 'new-project':if(unkeyed.size)status('Insert or discard unkeyed changes before starting another project');else $<HTMLDialogElement>('#newProjectDialog').showModal();break;
    case 'cancel-new-project':$<HTMLDialogElement>('#newProjectDialog').close();break;
    case 'confirm-new-project':downloadProject();openProject(createProject(null));$<HTMLDialogElement>('#newProjectDialog').close();break;
    case 'export-project':downloadProject();break;
    case 'recover-storage':downloadProject(true);break;
    case 'reload':location.reload();break;
    case 'open':if(unkeyed.size)status('Insert or discard unkeyed changes before opening another project');else $<HTMLInputElement>('#openFile').click();break;
    case 'reference':if(project.scenes.length>=24){status('This project supports up to 24 scenes');break;}pause();flushFieldEdit();referenceDialog.open();break;
    case 'top-view':case 'refresh-snapshot':captureTopView();break;
    case 'close-snapshot':$<HTMLDialogElement>('#sceneSnapshotDialog').close();break;
    case 'download-snapshot':if(sceneSnapshot){const anchor=document.createElement('a');anchor.href=sceneSnapshot.dataUrl;anchor.download='littletake-top-view.png';anchor.click();}break;
    case 'timeline':setTimelineOpen(!timelineOpen);break;
    case 'expand-preview':$('#expandedPreview').appendChild($('#previewFrame'));$<HTMLDialogElement>('#previewDialog').showModal();target.setAttribute('aria-expanded','true');break;
    case 'close-preview':$<HTMLDialogElement>('#previewDialog').close();break;
    case 'shortcuts':$<HTMLDialogElement>('#shortcutsDialog').showModal();break;
    case 'close-shortcuts':$<HTMLDialogElement>('#shortcutsDialog').close();break;
  }
});
$<HTMLDialogElement>('#previewDialog').addEventListener('close',()=>{$('#previewDock').appendChild($('#previewFrame'));$('[data-action="expand-preview"]').setAttribute('aria-expanded','false');});
$('#previewDialog').addEventListener('keydown',event=>{if(event.code==='Space'){event.preventDefault();if(!event.repeat)togglePlay();}});
$('#hierarchySearch').addEventListener('input',()=>{renderOutliner();renderSelection();});
document.addEventListener('pointerdown',event=>{document.querySelectorAll<HTMLDetailsElement>('details.studio-menu[open]').forEach(menu=>{if(!menu.contains(event.target as Node))menu.open=false;});});
$('.library-tabs').addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();setLibraryTab(libraryTab==='objects'?'assets':'objects');$<HTMLButtonElement>(`[data-library="${libraryTab}"]`).focus();}});
$('.panel-tabs').addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const next=$('#sceneAI').hidden?'muse':'inspector';setSidePanel(next);$<HTMLButtonElement>(`[data-panel="${next}"]`).focus();}});
const onPropertyInput = (event: Event)=>{
  if(assetEditor)return;
  if((event.target as HTMLElement).id==='hierarchySearch')return;
  const input=event.target as HTMLInputElement;if(!(input instanceof HTMLInputElement)||input.type==='file'||editPreview||performanceSession)return;
  if(input.dataset.componentField==='offset'&&input.closest('#inspector')){
    if(event.type==='input'&&input.value!==''){const item=entity(),value=Number(input.value),index=Number(input.dataset.componentAxis);if(item&&'kind' in item&&Number.isFinite(value)){if(editProperty(item,`pivot.${'xyz'[index]}` as PropertyPath,clamp(value,-1000,1000)))changed('Component value updated');else{renderTimeline();syncStage();renderTime();}}}
    return;
  }
  if(input.hasAttribute('data-component-field')||input.hasAttribute('data-component-enabled'))return;
  const value=Number(input.value),item=entity();
  if(input.id==='animationFrame'){if(input.value!==''&&Number.isFinite(value)){pause();seek(timeAtFrame(value,fps()));}return;}
  if(input.dataset.placement){if(event.type!=='change'||!Number.isFinite(value))return;pause();input.blur();stage?.transformGroup(input.dataset.placement as 'position'|'rotation'|'scale',Number(input.dataset.index),value);return;}
  if(input.id==='projectName'){project.name=input.value.trim().slice(0,120)||'Untitled take';changed();return;}
  if(input.id==='sceneName'&&project.activeSceneId){doc.name=input.value.trim().slice(0,120)||'Untitled scene';changed();return;}
  if(input.id==='entityName' && item){item.name=input.value.trim().slice(0,120)||'Untitled';changed();return;}
  if(input.id==='shotName'&&activeShot()){activeShot()!.name=input.value.trim().slice(0,120)||'Untitled shot';changed();return;}
  if(input.id==='objectColor' && item && 'color' in item){item.color=input.value;changed();return;}
  if(!Number.isFinite(value)){renderAll();return;}
  if(input.dataset.pose && item && !playing){const before=displayedPose(item),pose=copyPose(before),group=input.dataset.pose as keyof Transform,index=Number(input.dataset.component);pose[group][index]=group==='scale'?clamp(value,0.01,100):group==='position'?clamp(value,-1000,1000):clamp(value,-360000,360000);if('kind' in item)applyTransformModifiers(before,pose,evaluateComponents(item,time));let saved=false;for(const g of ['position','rotation','scale'] as const)for(const [i,axis] of ['x','y','z'].entries())if(Math.abs(before[g][i]-pose[g][i])>1e-8)saved=editProperty(item,`${g}.${axis}` as PropertyPath,pose[g][i])||saved;if(saved)changed();else{renderTimeline();renderTime();syncStage();}}
  if(input.id==='cameraFov'&&item&&'fov' in item){if(editProperty(item,'fov',clamp(value,10,120)))changed();else{renderTimeline();renderTime();syncStage();}}
  if(input.id==='duration'){pause();try{replaceContent(applyProjectOperations(projectContent(project),[{type:'set_duration',sceneId:doc.id,duration:clamp(value,1,60)}],time));changed('Scene duration updated · motion timing kept');}catch(error){status('Shorten existing shots and motion first. '+(error as Error).message);}return;}
  if((input.id==='shotStart'||input.id==='shotDuration')&&activeShot()){pause();const shot=activeShot()!;try{const next=applyProjectOperations(projectContent(project),[{type:'set_shot_range',sceneId:doc.id,id:shot.id,cameraId:shot.cameraId,start:input.id==='shotStart'?value:shot.start,duration:input.id==='shotDuration'?value:shot.duration}],time);replaceContent(next);changed('Shot range updated · scene motion unchanged');}catch(error){status((error as Error).message);}return;}
};
app.addEventListener('change',event=>{
  const select=event.target;if(!(select instanceof HTMLSelectElement))return;
  if(performanceSession)return;
  if(select.id==='sceneSelect'){switchScene(select.value);return;}
  if(select.id==='shotSelect'){switchShot(select.value);return;}
  if(select.id==='animationFps'){doc.fps=Number(select.value)===30?30:24;$<HTMLInputElement>('#animationFrame').value=String(frameAtTime(time,fps()));changed('Frame rate updated · Key times unchanged');return;}
  if(select.id==='animationZoom'){animationZoom=Number(select.value);applyTimelineZoom();return;}
  if(select.id==='animationInterpolation'&&selectedPropertyKey&&entity()){const item=entity()!,key=selectedPropertyKey,mode=select.value;if(mode!=='quaternion'){setKeyInterpolation(ensureAnimation(item),key.path?[key.path]:groupPaths(key.group),key.time,mode as 'linear'|'constant'|'smooth');changed('Interpolation updated');}return;}
  if(select.id==='shotCameraSelect'&&!editPreview){const shot=activeShot();if(shot){pause();shot.cameraId=select.value;selection.active=shot.cameraId;changed('Shot now uses the selected camera’s framing and motion');}}
});
app.addEventListener('change',onPropertyInput);
app.addEventListener('input',event=>{liveFieldEdit=true;try{onPropertyInput(event);}finally{liveFieldEdit=false;}});
$<HTMLInputElement>('#openFile').addEventListener('change',async event=>{
  const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;
  try{
    if(file.size>MAX_PROJECT_SIZE)throw new Error('Scene / project files must be smaller than 20 MB.');
    const text=await file.text(),value=JSON.parse(text),imported=value?.format==='LittleTake.project'?parseProject(text):null;
    if(imported){openProject(imported);status('Project and conversations opened');}
    else{const next=parseDocument(text);next.id=nextId('scene',project.scenes);project.scenes.push(next);project.activeSceneId=next.id;project.activeShotId=next.shots[0]?.id??null;syncDocument();changed('Scene added to this project');persist();}
  }catch(error){status(error instanceof Error?error.message:'Unable to open this scene or project.');}finally{input.value='';}
});

const timelineResizeHandle=$('#timelineResizeHandle');
let timelineResize:{y:number;height:number;savedHeight:number;open:boolean}|null=null;
timelineResizeHandle.onpointerdown=event=>{
  if(event.button!==0)return;
  timelineResize={y:event.clientY,height:$('#timelinePanel').getBoundingClientRect().height,savedHeight:timelineHeight,open:timelineOpen};
  timelineResizeHandle.focus({preventScroll:true});timelineResizeHandle.setPointerCapture(event.pointerId);$('#timelinePanel').classList.add('resizing');event.preventDefault();
};
timelineResizeHandle.onpointermove=event=>{
  if(!timelineResize||Math.abs(event.clientY-timelineResize.y)<2)return;
  setTimelineHeight(timelineResize.height+timelineResize.y-event.clientY);setTimelineOpen(timelineHeight>62);
};
timelineResizeHandle.onpointerup=()=>{if(!timelineResize)return;timelineResize=null;$('#timelinePanel').classList.remove('resizing');saveTimelineHeight();};
timelineResizeHandle.onlostpointercapture=timelineResizeHandle.onpointercancel=()=>{
  if(timelineResize){setTimelineHeight(timelineResize.savedHeight);setTimelineOpen(timelineResize.open);}
  timelineResize=null;$('#timelinePanel').classList.remove('resizing');
};
timelineResizeHandle.ondblclick=()=>{setTimelineHeight(window.innerHeight<=720?180:220);setTimelineOpen(true);saveTimelineHeight();};
timelineResizeHandle.onkeydown=event=>{
  if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  event.preventDefault();const height=$('#timelinePanel').getBoundingClientRect().height;
  setTimelineHeight(event.key==='Home'?62:event.key==='End'?window.innerHeight:height+(event.key==='ArrowUp'?20:-20));setTimelineOpen(timelineHeight>62);saveTimelineHeight();
};
window.addEventListener('resize',()=>setTimelineHeight(timelineHeight));

let timelineDrag: {element:HTMLElement;id:string;kind:'shot'|'motion';mode:string;initialX:number;laneWidth:number;initialRange:{start:number;duration:number};before:ProjectContent;moved:boolean}|null=null;
let propertyDrag: {element:HTMLElement;group:PropertyGroup;path?:PropertyPath;from:number;to:number;initialX:number;laneWidth:number;moved:boolean;take?:string;mode?:string;start?:number;end?:number}|null=null;
let scrubbing=false;
function scrubAt(clientX:number){const rect=$('#timeRuler').getBoundingClientRect();pause();seek(snapFrame((clientX-rect.left)/rect.width*doc.duration));}
$('#timelineContent').addEventListener('pointerdown',event=>{
  if(event.button!==0||performanceSession)return;const target=event.target as HTMLElement;
  if(target.closest('#timeRuler')){scrubbing=true;$('#timeRuler').focus({preventScroll:true});$('#timeRuler').setPointerCapture(event.pointerId);scrubAt(event.clientX);event.preventDefault();return;}
  if(editPreview)return;
  const marker=target.closest<HTMLElement>('[data-animation-group]'),band=target.closest<HTMLElement>('[data-take]');
  if(marker||band){
    const item=entity();if(!item)return;pause();
    if(marker){const group=marker.dataset.animationGroup as PropertyGroup,path=marker.dataset.animationPath as PropertyPath|undefined,from=Number(marker.dataset.animationTime);selectedPropertyKey={group,path,time:from};time=from;propertyDrag={element:marker,group,path,from,to:from,initialX:event.clientX,laneWidth:marker.parentElement!.getBoundingClientRect().width,moved:false};}
    else if(band){const take=animationFor(item)?.takes.find(take=>take.id===band.dataset.take);if(!take)return;propertyDrag={element:band,group:'position',from:take.start,to:take.start,initialX:event.clientX,laneWidth:band.parentElement!.getBoundingClientRect().width,moved:false,take:take.id,mode:target.dataset.takeEdge??'move',start:take.start,end:take.end};}
    const active=propertyDrag!;active.element.setPointerCapture(event.pointerId);renderInspector();renderTime();syncStage();event.preventDefault();return;
  }
  const clip=target.closest<HTMLElement>('[data-clip],[data-shot-clip]');if(!clip)return;
  const shot=doc.shots.find(item=>item.id===clip.dataset.shotClip),item=entity(clip.dataset.clip),range=shot??item?.track;if(!range)return;
  sceneEditor?.sceneChanged();pause();if(shot)switchShot(shot.id);else select(item!.id);
  timelineDrag={element:clip,id:shot?.id??item!.id,kind:shot?'shot':'motion',mode:target.dataset.trim||'move',initialX:event.clientX,laneWidth:clip.parentElement!.getBoundingClientRect().width,initialRange:{start:range.start,duration:range.duration},before:structuredClone(projectContent(project)),moved:false};clip.setPointerCapture(event.pointerId);clip.classList.add('dragging');event.preventDefault();
});
$('#timelineContent').addEventListener('pointermove',event=>{
  if(scrubbing){scrubAt(event.clientX);return;}
  if(propertyDrag){const drag=propertyDrag,delta=(event.clientX-drag.initialX)/drag.laneWidth*doc.duration;if(Math.abs(event.clientX-drag.initialX)>3)drag.moved=true;if(!drag.moved)return;if(drag.take){const start=drag.start!,end=drag.end!,length=end-start;if(drag.mode==='left'){drag.from=Math.min(end-.1,snapFrame(start+delta));drag.to=end;}else if(drag.mode==='right'){drag.from=start;drag.to=Math.max(start+.1,snapFrame(end+delta));}else{drag.from=clamp(snapFrame(start+delta),0,doc.duration-length);drag.to=drag.from+length;}drag.element.style.left=`${drag.from/doc.duration*100}%`;drag.element.style.width=`${(drag.to-drag.from)/doc.duration*100}%`;}else{drag.to=snapFrame(drag.from+delta);drag.element.style.left=`${drag.to/doc.duration*100}%`;}return;}
  if(!timelineDrag)return;
  const drag=timelineDrag,range=drag.kind==='shot'?doc.shots.find(item=>item.id===drag.id):entity(drag.id)?.track;if(!range)return;
  const delta=(event.clientX-drag.initialX)/drag.laneWidth*doc.duration,initial=drag.initialRange;
  if(Math.abs(event.clientX-drag.initialX)>2)drag.moved=true; if(!drag.moved)return;
  if(drag.mode==='left'){const end=initial.start+initial.duration;range.start=clamp(initial.start+delta,0,end-0.1);range.duration=end-range.start;}
  else if(drag.mode==='right')range.duration=clamp(initial.duration+delta,0.1,doc.duration-initial.start);
  else range.start=clamp(initial.start+delta,0,doc.duration-initial.duration);
  drag.element.style.left=`${range.start/doc.duration*100}%`;drag.element.style.width=`${range.duration/doc.duration*100}%`;time=range.start;renderTime();renderInspector();syncStage();
});
function finishTimelineDrag(cancel=false){
  scrubbing=false;
  if(propertyDrag){const drag=propertyDrag;propertyDrag=null;const item=entity();if(!cancel&&drag.moved&&item){try{const next=structuredClone(animationFor(item)??emptyAnimation());if(drag.take)retimeTake(next,drag.take,drag.from,drag.to,doc.duration);else{movePropertyKeys(next,drag.path?[drag.path]:groupPaths(drag.group),drag.from,drag.to);selectedPropertyKey={group:drag.group,path:drag.path,time:drag.to};time=drag.to;}item.animation=next;item.track=null;changed(drag.take?'Recording timing updated':'Keyframe moved');}catch(error){status((error as Error).message);renderAll();}}else renderAll();return;}
  if(!timelineDrag)return;const drag=timelineDrag;timelineDrag=null;if(cancel){replaceContent(drag.before);renderAll();}else if(drag.moved)changed(drag.kind==='shot'?'Shot range updated · scene motion unchanged':'Motion timing updated');else{renderAll();}
}
$('#timelineContent').addEventListener('pointerup',()=>finishTimelineDrag());
$('#timelineContent').addEventListener('pointercancel',()=>finishTimelineDrag(true));
$('#timeRuler').addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();pause();seek(snapFrame(time+(event.key==='ArrowRight'?1/fps():-1/fps())));}else if(event.key==='Home'){event.preventDefault();pause();seek(0);}else if(event.key==='End'){event.preventDefault();pause();seek(doc.duration);}});
$('#inspector').addEventListener('pointerover',event=>{const target=event.target as HTMLElement,input=target.closest<HTMLInputElement>('[data-pose],#cameraFov,[data-component-field="offset"]'),button=target.closest<HTMLElement>('[data-key-group]');hoveredProperty=input?(input.id==='cameraFov'?'fov':input.dataset.pose as PropertyGroup||'pivot'):button?.dataset.keyGroup as PropertyGroup??null;});
$('#inspector').addEventListener('pointerleave',()=>{hoveredProperty=null;});
window.addEventListener('keydown',event=>{
  if(assetEditor)return;
  if(event.defaultPrevented||storageError||editPreview||event.isComposing)return;
  const target=event.target as HTMLElement;
  if(event.code==='KeyI'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!performanceSession&&!document.querySelector('dialog[open]')){
    const input=target instanceof HTMLInputElement?target:null,group=input?(input.id==='cameraFov'?'fov':input.dataset.pose?input.dataset.pose as PropertyGroup:input.dataset.componentField==='offset'?'pivot':null):hoveredProperty,item=entity();
    if(group&&item){event.preventDefault();pause();try{
      if(input&&showAxisKeys&&group!=='fov'){const index=Number(input.dataset.component??input.dataset.componentAxis),path=`${group}.${'xyz'[index]}` as PropertyPath,value=propertyValue(item,path),orientation=group==='rotation'?displayedPose(item).rotation:undefined;putKey(ensureAnimation(item),path,time,value,orientation);if(currentDraft(item,path))unkeyed.delete(draftId(item,path));selectedPropertyKey={group,path,time};changed('Axis key added');}
      else keyProperty(item,group,false);
    }catch(error){status((error as Error).message);}return;}
  }
  if(target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || document.querySelector('dialog[open]'))return;
  if(!performanceSession&&assetsPanel?.key(event))return;
  const key=event.code.startsWith('Key')?event.code.slice(3).toLowerCase():event.code==='Space'?' ':event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey;
  if(performanceSession){if(mod||event.altKey)return;event.preventDefault();if(key==='escape'&&!event.repeat){performanceSession.mode==='record'?stopPerformanceRecord():performanceSession.mode==='control'?exitPerformance():discardPerformance();return;}if(key==='r'&&!event.repeat){performanceSession.mode==='record'?stopPerformanceRecord():performanceSession.mode==='control'?startPerformanceRecord():undefined;return;}if(performanceSession.mode==='review'){if(key===' '&&!event.repeat)togglePlay();return;}if(['w','a','s','d','f','v','shift',' '].includes(key))performanceSession.keys.add(key);return;}
  if(mod&&key==='z'){event.preventDefault();flushFieldEdit();restore(event.shiftKey?history.redo():history.undo());return;}
  if(mod&&key==='y'){event.preventDefault();flushFieldEdit();restore(history.redo());return;}
  if(mod&&key==='s'){event.preventDefault();persist();status('Scene saved on this device');return;}
  if(mod&&key==='d'){event.preventDefault();if(selectedPropertyKey&&!$<HTMLButtonElement>('#duplicateKey').disabled)$<HTMLButtonElement>('#duplicateKey').click();else duplicate();return;}
  if(key==='h'&&!mod&&!event.repeat){event.preventDefault();setHidden(event.altKey?doc.objects.map(item=>item.id):selection.ids,!event.altKey);return;}
  if(mod&&key==='a'&&target.closest('#viewport,#outliner')){event.preventDefault();selectIds(doc.objects.map(item=>item.id),'replace');setSidePanel('inspector');return;}
  if(mod||event.altKey)return;
  if(event.code==='Space'){event.preventDefault();if(!event.repeat)togglePlay();return;}
  if(key==='g'||key==='r'||key==='s'){event.preventDefault();chooseTool(key==='g'?'translate':key==='r'?'rotate':'scale');}
  if(key==='x'||key==='y'||key==='z')chooseAxis(axis===key.toUpperCase()?null:key.toUpperCase() as Axis);
  if(key==='f'){event.preventDefault();stage?.focusSelection();}
  if(key==='delete'||key==='backspace'){event.preventDefault();if(selectedPropertyKey&&!$<HTMLButtonElement>('#deleteKey').disabled)$<HTMLButtonElement>('#deleteKey').click();else remove();}
  if(key==='escape'){chooseAxis(null);pause();document.querySelectorAll<HTMLDetailsElement>('details.studio-menu[open]').forEach(menu=>menu.open=false);}
});
window.addEventListener('keyup',event=>performanceSession?.keys.delete(event.code.startsWith('Key')?event.code.slice(3).toLowerCase():event.code==='Space'?' ':event.key.toLowerCase()));
window.addEventListener('blur',()=>{performanceSession?.keys.clear();if(performanceSession?.mode==='record')stopPerformanceRecord();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){performanceSession?.keys.clear();if(performanceSession?.mode==='record')stopPerformanceRecord();}});
function tick(now:number){const delta=Math.min((now-lastFrame)/1000,0.05);lastFrame=now;if(performanceSession&&performanceSession.mode!=='review'){const stopped=performanceSession.update(delta,doc.duration);time=performanceSession.time;renderTime();syncStage();$('#inspector').querySelectorAll<HTMLInputElement>('[data-pose]').forEach(input=>input.value=String(num(performanceSession!.pose[input.dataset.pose as keyof Transform][Number(input.dataset.component)])));if(stopped)renderAll();else if(performanceSession.mode==='record')$('#performanceClock').textContent=timecode(time);}
if(playing){const shot=activeShot(),take=performanceSession?.draft,end=take?take.start+take.duration:shot?shot.start+shot.duration:doc.duration;time=Math.min(time+delta,end);if(time>=end){pause();renderInspector();if(performanceSession?.mode==='review')renderPerformance();}renderTime();syncStage();}requestAnimationFrame(tick);}
window.addEventListener('storage',event=>{if(event.key===PROJECT_STORAGE_KEY)persist();});
window.addEventListener('pagehide',()=>{sceneEditor?.session.cancel('This response was interrupted. Retry when you are ready.');persist();});
window.addEventListener('beforeunload',event=>{if(!storageAvailable||performanceSession||unkeyed.size){event.preventDefault();event.returnValue='';}});
function openAssetEditor(asset:AssetDefinition) {
  if(assetEditor||editPreview||storageError||performanceSession)return;
  pause();flushFieldEdit();assetsPanel?.setOpen(false);sceneEditor?.session.cancel('Asset editing opened. The scene conversation is retained.');
  try{assetEditor=new AssetEditor({host:app,asset,onClose(){assetEditor=null;renderAll();void assetsPanel?.refresh();},onSaved(nextAsset){
    const count=synchronizeAssets([...libraryAssets.filter(a=>a.id!==nextAsset.id),nextAsset]);
    void assetsPanel?.refresh();return count?`Updated ${count} linked instances in this project; transforms and motion retained.`:'Available in the asset library across projects.';
  }});}catch(error){status(error instanceof Error?error.message:'Could not open asset editor');}
}
window.addEventListener('focus',()=>{void assetsPanel?.refresh();});
setTimelineHeight(timelineHeight);setTimelineOpen(timelineHeight>62);renderAll();persist();void assetsPanel?.refresh();status(recovered?'Local project restored':'Your first take · select a shape and make it move');requestAnimationFrame(tick);
