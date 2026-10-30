import * as THREE from 'three';
import { createAssetGroup,disposeAssetGroup,evaluateAsset,validateAsset,type AssetDefinition } from './model';
import { availableAssets } from './library';
import { assetCatalogSchema, emptyCatalog, folderLabel, SCENE_OBJECT_DRAG, LIBRARY_ASSET_DRAG, type AssetCatalog } from './folders';
import { assetRequest, editFolderDialog } from './dialog';
import type { Stage } from '../stage';
import type { Transform } from '../types';
import './panel.css';

const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const categories:Record<string,{label:string;tags:string[]}>= {
  person:{label:'Characters',tags:['person','character','人物']},
  vehicle:{label:'Vehicles',tags:['vehicle','车辆']},
  prop:{label:'Props',tags:['prop','furniture','道具']},
  primitive:{label:'Primitives',tags:['primitive','基础几何']},
};
const categoryLabel=(tag:string|undefined)=>tag==='saved'||tag==='我的资产'?'My Assets':Object.values(categories).find(c=>c.tags.includes(tag??''))?.label??tag??'Asset';
export class AssetPanel {
  private open=false;
  private filter='all';
  private folder='';
  private catalog:AssetCatalog=emptyCatalog();
  private collapsed=new Set<string>();
  private query='';
  private assets:AssetDefinition[]=[];
  private saved:AssetDefinition[]=[];
  private remote:AssetDefinition[]=[];
  private refreshId=0;
  private thumbnails=new Map<string,string>();
  private renderer:THREE.WebGLRenderer|null=null;
  private shortcut='KeyB';
  private dragged:AssetDefinition|null=null;
  private blank=document.createElement('canvas');
  private drawer:HTMLElement;
  private toggle:HTMLButtonElement;
  private grid:HTMLElement;
  private resizeHandle:HTMLElement;
  private height=0;
  private resizeStart:{y:number;height:number}|null=null;
  private listKey='';
  constructor(private root:HTMLElement,private stage:Stage,private insert:(asset:AssetDefinition,pose:Transform)=>void,private enabled:()=>boolean,private edit?:(asset:AssetDefinition)=>void,private onLoaded?:(assets:AssetDefinition[])=>void,private createFromObject?:(source:{projectId:string;sceneId:string;objectId:string},folder:string)=>void){
    this.blank.width=this.blank.height=1;
    try{const s=localStorage.getItem('littletake.assets.shortcut');if(s&&['KeyB','KeyG','none'].includes(s))this.shortcut=s;}catch{}
    root.innerHTML=`<section class="asset-drawer" aria-label="Assets" aria-hidden="true" inert><header><strong>Assets <small id="assetCount"></small></strong><span>Drag into the scene · Double-click to place</span><input type="search" aria-label="Search assets" placeholder="Search characters, vehicles, props…"/><button data-assets-close aria-label="Collapse asset library">Collapse ⌄</button></header><div class="asset-body"><nav aria-label="Asset categories">${[['all','All Assets'],...Object.entries(categories).map(([key,category])=>[key,category.label]),['saved','My Assets']].map(([key,name])=>`<button data-filter="${key}">${name}</button>`).join('')}</nav><div class="asset-grid"></div></div></section><div class="asset-footer"><button aria-label="Asset drawer" aria-expanded="false" data-assets-toggle>▧ Assets <kbd></kbd> ⌃</button><details class="asset-shortcut-settings"><summary aria-label="Shortcut settings">⌨</summary><label>Asset drawer shortcut<select aria-label="Asset drawer shortcut"><option value="KeyB">B (default)</option><option value="KeyG">G (replaces Move shortcut)</option><option value="none">Disabled</option></select><small>Disabled while typing. You can also click Assets.</small></label></details></div>`;
    this.drawer=root.querySelector('.asset-drawer')!;this.toggle=root.querySelector('[data-assets-toggle]')!;this.grid=root.querySelector('.asset-grid')!;
    root.querySelector('[data-filter="saved"]')!.remove();
    root.querySelector('nav')!.insertAdjacentHTML('afterbegin','<div class="asset-folder-tree" role="tree" aria-label="My Assets folders"></div>');
    const content=document.createElement('div');content.className='asset-content';this.grid.replaceWith(content);
    content.innerHTML='<div class="asset-folder-toolbar"><span data-folder-path></span><button data-new-folder>＋ New Folder</button><button data-rename-folder hidden>Rename Folder</button></div>';content.append(this.grid);
    root.querySelector<HTMLButtonElement>('[data-new-folder]')!.onclick=()=>void this.editFolder();
    root.querySelector<HTMLButtonElement>('[data-rename-folder]')!.onclick=()=>void this.editFolder(true);
    root.querySelector<HTMLElement>('.asset-folder-tree')!.onclick=event=>{
      const button=(event.target as HTMLElement).closest<HTMLElement>('[data-folder]');if(!button)return;
      const folder=button.dataset.folder!;
      if((event.target as HTMLElement).closest('[data-folder-toggle]')){if(this.collapsed.has(folder))this.collapsed.delete(folder);else this.collapsed.add(folder);this.render();}
      else this.showFolder(folder);
    };
    const dropFolder=(event:DragEvent):string|undefined=>{
      const target=event.target as HTMLElement,folder=target.closest<HTMLElement>('[data-folder]')?.dataset.folder;
      return folder??(target.closest('.asset-content')&&this.filter==='saved'?this.folder:undefined);
    };
    this.drawer.ondragover=event=>{
      const folder=dropFolder(event),types=event.dataTransfer?.types??[];
      if(folder===undefined||!this.enabled()||(!types.includes(SCENE_OBJECT_DRAG)&&!types.includes(LIBRARY_ASSET_DRAG)))return;
      if(types.includes(LIBRARY_ASSET_DRAG)&&this.dragged?.source==='builtin')return;
      event.preventDefault();event.dataTransfer!.dropEffect=types.includes(SCENE_OBJECT_DRAG)?'copy':'move';
      this.clearDrop();const target=(event.target as HTMLElement).closest<HTMLElement>('[data-folder]')??content;target.classList.add('asset-drop-target');
    };
    this.drawer.ondragleave=event=>{if(!this.drawer.contains(event.relatedTarget as Node))this.clearDrop();};
    this.drawer.ondrop=event=>{
      this.clearDrop();const folder=dropFolder(event);if(folder===undefined||!this.enabled())return;
      const source=event.dataTransfer?.getData(SCENE_OBJECT_DRAG),assetId=event.dataTransfer?.getData(LIBRARY_ASSET_DRAG);
      if(!source&&!assetId)return;event.preventDefault();
      if(source){try{this.createFromObject?.(JSON.parse(source),folder);}catch{this.feedback('Could not read the dragged object. Please try again.');}}
      else if(assetId)void this.moveAsset(assetId,folder);
    };
    this.drawer.querySelector('header > span')!.setAttribute('data-asset-status','');
    const refresh=document.createElement('button');refresh.textContent='Refresh';refresh.setAttribute('aria-label','Refresh assets');refresh.onclick=()=>void this.refresh();this.drawer.querySelector('header')!.insertBefore(refresh,this.drawer.querySelector('input'));
    this.drawer.insertAdjacentHTML('afterbegin','<div class="panel-resize-handle asset-resize-handle" role="separator" aria-label="Resize asset library" aria-orientation="horizontal" aria-controls="assetPanel" tabindex="0" title="Drag to resize · Double-click to reset"></div>');
    this.resizeHandle=this.drawer.querySelector('.asset-resize-handle')!;
    try{this.height=Number(localStorage.getItem('littletake.assets.height'))||0;}catch{}
    this.setHeight(this.height);
    this.resizeHandle.onpointerdown=event=>{if(event.button!==0)return;this.resizeStart={y:event.clientY,height:this.drawer.getBoundingClientRect().height};this.resizeHandle.focus({preventScroll:true});this.resizeHandle.setPointerCapture(event.pointerId);this.root.classList.add('resizing');event.preventDefault();};
    this.resizeHandle.onpointermove=event=>{if(this.resizeStart)this.setHeight(this.resizeStart.height+this.resizeStart.y-event.clientY);};
    this.resizeHandle.onpointerup=()=>{if(!this.resizeStart)return;this.resizeStart=null;this.root.classList.remove('resizing');this.saveHeight();};
    this.resizeHandle.onlostpointercapture=this.resizeHandle.onpointercancel=()=>{if(this.resizeStart)this.setHeight(this.resizeStart.height);this.resizeStart=null;this.root.classList.remove('resizing');};
    this.resizeHandle.ondblclick=()=>{this.setHeight(0);this.saveHeight();};
    this.resizeHandle.onkeydown=event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();this.setHeight(event.key==='Home'?0:event.key==='End'?window.innerHeight:this.height+(event.key==='ArrowUp'?20:-20));this.saveHeight();};
    window.addEventListener('resize',()=>this.setHeight(this.height));
    this.toggle.onclick=()=>this.setOpen(!this.open);root.querySelector<HTMLButtonElement>('[data-assets-close]')!.onclick=()=>this.setOpen(false);
    root.querySelector<HTMLInputElement>('input')!.oninput=e=>{this.query=(e.target as HTMLInputElement).value.toLowerCase();this.render();};
    root.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(b=>b.onclick=()=>{this.filter=b.dataset.filter!;this.render();});
    const select=root.querySelector<HTMLSelectElement>('select')!;select.value=this.shortcut;this.toggle.querySelector('kbd')!.textContent=this.shortcut==='none'?'':this.shortcut.slice(-1);
    select.onchange=()=>{this.shortcut=select.value;this.toggle.querySelector('kbd')!.textContent=this.shortcut==='none'?'':this.shortcut.slice(-1);try{localStorage.setItem('littletake.assets.shortcut',this.shortcut);}catch{}root.querySelector('details')!.open=false;this.toggle.focus();};
    this.grid.ondblclick=event=>{const card=(event.target as HTMLElement).closest<HTMLElement>('[data-asset]'),asset=this.assets.find(a=>a.id===card?.dataset.asset);if(asset&&this.enabled()){const pose=this.stage.placement(asset);if(pose)this.insert(asset,pose);}};
    this.grid.onclick=event=>{const button=(event.target as HTMLElement).closest<HTMLElement>('[data-asset-edit]');if(!button)return;event.stopPropagation();const asset=this.assets.find(a=>a.id===button.dataset.assetEdit);if(asset&&this.enabled())this.edit?.(asset);};
    this.grid.ondragstart=event=>{const card=(event.target as HTMLElement).closest<HTMLElement>('[data-asset]');this.dragged=this.assets.find(a=>a.id===card?.dataset.asset)??null;if(!this.dragged||!this.enabled()){event.preventDefault();return;}event.dataTransfer!.effectAllowed='copyMove';event.dataTransfer!.setData(LIBRARY_ASSET_DRAG,this.dragged.id);event.dataTransfer!.setData('text/plain',this.dragged.id);event.dataTransfer!.setDragImage(this.blank,0,0);};
    this.grid.ondragend=()=>{this.dragged=null;this.stage.previewAsset(null);this.clearDrop();};
    const viewport=document.querySelector<HTMLElement>('#viewport')!;
    viewport.ondragover=event=>{if(!this.dragged||!this.enabled())return;event.preventDefault();event.dataTransfer!.dropEffect='copy';const pose=this.stage.placement(this.dragged,event.clientX,event.clientY);this.stage.previewAsset(pose?this.dragged:null,pose??undefined);};
    viewport.ondragleave=event=>{if(!viewport.contains(event.relatedTarget as Node))this.stage.previewAsset(null);};
    viewport.ondrop=event=>{if(!this.dragged||!this.enabled())return;event.preventDefault();const asset=this.dragged,pose=this.stage.placement(asset,event.clientX,event.clientY);this.dragged=null;this.stage.previewAsset(null);if(pose)this.insert(asset,pose);};
    void this.refresh();
  }
  get currentFolder():string{return this.filter==='saved'?this.folder:'';}
  showFolder(folder:string):void{this.filter='saved';this.folder=folder;this.query='';this.root.querySelector<HTMLInputElement>('input[type="search"]')!.value='';this.collapsed.delete('');for(const path of this.catalog.folders)if(folder.startsWith(path+'/'))this.collapsed.delete(path);this.render();}
  private clearDrop():void{this.root.querySelectorAll('.asset-drop-target').forEach(node=>node.classList.remove('asset-drop-target'));}
  private feedback(message:string):void{this.root.querySelector('[data-asset-status]')!.textContent=message;}
  private async editFolder(rename=false):Promise<void>{
    if(!this.enabled())return;const result=await editFolderDialog(this.currentFolder,rename?this.folder:undefined);
    if(result){++this.refreshId;this.catalog=result.catalog;this.showFolder(result.folder);}
  }
  private async moveAsset(assetId:string,folder:string):Promise<void>{
    try{const data=await assetRequest({action:'move_asset',assetId,folder});++this.refreshId;this.catalog=assetCatalogSchema.parse(data.catalog);this.showFolder(folder);this.feedback('Asset moved · Scene references retained');}
    catch(error){this.feedback((error as Error).message);}
  }
  private setHeight(value:number):void {
    const min=Number.parseFloat(getComputedStyle(this.drawer).minHeight);
    const max=Math.max(min,Math.floor(window.innerHeight*.7));
    this.height=Math.round(Math.min(max,Math.max(min,value)));this.root.style.setProperty('--asset-drawer-height',`${this.height}px`);
    this.resizeHandle.setAttribute('aria-valuemin',String(min));this.resizeHandle.setAttribute('aria-valuemax',String(max));this.resizeHandle.setAttribute('aria-valuenow',String(this.height));
  }
  private saveHeight():void {try{localStorage.setItem('littletake.assets.height',String(this.height));}catch{}}
  setOpen(open:boolean):void {this.open=open;this.drawer.classList.toggle('is-open',open);this.drawer.inert=!open;this.drawer.setAttribute('aria-hidden',String(!open));this.toggle.setAttribute('aria-expanded',String(open));if(!open&&this.drawer.contains(document.activeElement))this.toggle.focus();if(open){this.render();void this.refresh();}}
  key(event:KeyboardEvent):boolean {if(event.code===this.shortcut&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();if(!event.repeat)this.setOpen(!this.open);return true;}if(event.key==='Escape'&&this.open){this.setOpen(false);return true;}return false;}
  update(saved:AssetDefinition[] = []):void {this.saved=saved;const assets=availableAssets([...this.remote,...saved.filter(a=>!this.remote.some(b=>a.id===b.id))]),key=JSON.stringify(assets);if(this.listKey!==key){this.listKey=key;this.assets=assets;this.render();}this.toggle.disabled=!this.enabled();this.drawer.classList.toggle('assets-locked',!this.enabled());}
  async refresh():Promise<void> {
    const id=++this.refreshId;
    try{const response=await fetch('/api/assets');if(!response.ok)throw new Error('Asset service unavailable; project assets remain available');const data=await response.json(),assets:AssetDefinition[]=data.assets.map(validateAsset);if(id!==this.refreshId)return;this.remote=assets;this.catalog=assetCatalogSchema.parse(data.catalog??emptyCatalog());if(this.folder&&!this.catalog.folders.includes(this.folder))this.folder='';this.onLoaded?.(assets);this.update(this.saved);this.render();this.root.querySelector('[data-asset-status]')!.textContent=data.temporary?'Temporary cloud library · Export your project to keep used assets':'Hierarchy → folder creates a prefab · Asset → scene places it';}
    catch(error){if(id===this.refreshId)this.root.querySelector('[data-asset-status]')!.textContent=error instanceof Error?error.message:'Could not load asset library';}
  }
  private thumbnail(asset:AssetDefinition):string {
    const key=JSON.stringify(asset);const cached=this.thumbnails.get(key);if(cached)return cached;
    this.renderer??=new THREE.WebGLRenderer({antialias:true,alpha:false});const r=this.renderer;r.setSize(240,150);r.setPixelRatio(1);r.toneMapping=THREE.ACESFilmicToneMapping;r.toneMappingExposure=1.2;
    const scene=new THREE.Scene();scene.background=new THREE.Color('#eef0e5');scene.add(new THREE.HemisphereLight('#fffcee','#9da98f',3));const light=new THREE.DirectionalLight('#ffffff',3);light.position.set(-3,7,5);scene.add(light);
    const group=createAssetGroup(asset);if(asset.template?.transform){group.scale.fromArray(asset.template.transform.scale);group.rotation.set(...asset.template.transform.rotation.map(THREE.MathUtils.degToRad) as [number,number,number]);}scene.add(group);const box=new THREE.Box3().setFromObject(group),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()).length();
    const camera=new THREE.PerspectiveCamera(35,240/150,.01,2000);camera.position.copy(center).add(new THREE.Vector3(1,.65,1.3).normalize().multiplyScalar(size*1.75));camera.lookAt(center);r.render(scene,camera);const url=r.domElement.toDataURL('image/png');disposeAssetGroup(group);this.thumbnails.set(key,url);return url;
  }
  private render():void {
    this.root.querySelector('#assetCount')!.textContent=`${this.assets.length} assets`;
    this.root.querySelectorAll<HTMLElement>('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===this.filter)));
    const paths=['',...this.catalog.folders];
    this.root.querySelector('.asset-folder-tree')!.innerHTML=paths.filter(path=>path===''||![...this.collapsed].some(parent=>parent===''||path.startsWith(parent+'/'))).map(path=>{
      const children=this.catalog.folders.some(other=>path===''||other.startsWith(path+'/'));
      return `<button role="treeitem" data-folder="${esc(path)}" aria-label="Folder ${esc(folderLabel(path))}" aria-level="${path?path.split('/').length+1:1}" aria-selected="${this.filter==='saved'&&this.folder===path}" ${children?`aria-expanded="${!this.collapsed.has(path)}"`:''} style="padding-left:${8+(path?path.split('/').length:0)*14}px"><span data-folder-toggle>${children?(this.collapsed.has(path)?'▸':'▾'):'·'}</span><span>▱ ${esc(path.split('/').at(-1)||'My Assets')}</span></button>`;
    }).join('');
    this.root.querySelector('[data-folder-path]')!.textContent=this.filter==='saved'?folderLabel(this.folder):this.filter==='all'?'All Assets':categories[this.filter]?.label??'Assets';
    this.root.querySelector<HTMLElement>('[data-rename-folder]')!.hidden=this.filter!=='saved'||!this.folder;
    this.root.querySelectorAll<HTMLButtonElement>('[data-new-folder],[data-rename-folder]').forEach(button=>button.disabled=!this.enabled());
    const list=this.assets.filter(a=>(this.filter==='all'||(this.filter==='saved'?a.source!=='builtin'&&(this.query?(!this.folder||(this.catalog.locations[a.id]??'')===this.folder||(this.catalog.locations[a.id]??'').startsWith(this.folder+'/')):(this.catalog.locations[a.id]??'')===this.folder):categories[this.filter]?.tags.some(tag=>a.tags.includes(tag))))&&[a.name,a.description,...a.tags,...a.tags.map(categoryLabel)].join(' ').toLowerCase().includes(this.query));
    this.grid.innerHTML=list.map(a=>{const count=evaluateAsset(a).parts.filter(p=>p.kind!=='group').length;return `<div class="asset-card-entry"><button class="asset-card" draggable="true" data-asset="${esc(a.id)}" aria-label="Asset ${esc(a.name)}, double-click to place"><img draggable="false" src="${this.thumbnail(a)}" alt="${esc(a.name)} preview"/><strong>${esc(a.name)}</strong><small>${a.template?.track?'Recorded motion · ':''}${esc(categoryLabel(a.tags[0]))} · ${count} part${count===1?'':'s'}</small></button>${this.edit?`<button class="asset-card-edit" data-asset-edit="${esc(a.id)}" aria-label="Edit Prefab ${esc(a.name)}">Edit Prefab</button>`:''}</div>`;}).join('')||'<p class="asset-empty">Drag a Hierarchy object into this folder, or right-click an object and choose Create Independent Prefab.</p>';
  }
}
