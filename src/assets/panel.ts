import { icon } from '../icons';
import * as THREE from 'three';
import { createAssetGroup,disposeAssetGroup,poseAssetJoints,evaluateAsset,validateAsset,type AssetDefinition } from './model';
import { availableAssets } from './library';
import { assetCatalogSchema, emptyCatalog, folderLabel, SCENE_OBJECT_DRAG, LIBRARY_ASSET_DRAG, REFERENCE_IMAGE_DRAG, type AssetCatalog } from './folders';
import { assetRequest, editFolderDialog } from './dialog';
import type { Stage } from '../stage';
import type { SceneDocument, Transform } from '../types';
import type { Workspace } from '../project/workspace';
import { appearanceImage, uploadAppearance } from '../appearance/images';
import './panel.css';

const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const categories:Record<string,{label:string;tags:string[]}>= {
  person:{label:'Characters',tags:['person','character','人物']},
  vehicle:{label:'Vehicles',tags:['vehicle','车辆']},
  prop:{label:'Props',tags:['prop','furniture','道具']},
  primitive:{label:'Primitives',tags:['primitive','基础几何']},
};
const categoryLabel=(tag:string|undefined)=>tag==='saved'||tag==='我的资产'?'My Assets':Object.values(categories).find(c=>c.tags.includes(tag??''))?.label??tag??'Asset';
interface ProjectScenes { list(): SceneDocument[]; active(): string | null; open(id: string): void; create(): void; remove(id: string): void }
export class AssetPanel {
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
  private dragged:AssetDefinition|null=null;
  private blank=document.createElement('canvas');
  private grid:HTMLElement;
  private listKey='';
  private sceneKey='';
  private referenceKey='';
  private importing=false;
  constructor(private root:HTMLElement,private stage:Stage,private insert:(asset:AssetDefinition,pose:Transform)=>void,private enabled:()=>boolean,private edit?:(asset:AssetDefinition)=>void,private onLoaded?:(assets:AssetDefinition[])=>void,private createFromObject?:(source:{projectId:string;sceneId:string;objectId:string},folder:string)=>void,private scenes?:ProjectScenes,private workspace?:()=>Workspace|undefined){
    this.blank.width=this.blank.height=1;
    root.innerHTML=`<header class="asset-header"><strong>Assets <small id="assetCount"></small></strong><span data-asset-status>Drag into the scene · Double-click to place</span><input type="search" aria-label="Search assets" placeholder="Search characters, vehicles, props…"/></header><div class="asset-body"><nav aria-label="Asset categories">${[['all','All Assets'],...Object.entries(categories).map(([key,category])=>[key,category.label]),['saved','My Assets']].map(([key,name])=>`<button data-filter="${key}">${name}</button>`).join('')}</nav><div class="asset-grid"></div></div>`;
    this.grid=root.querySelector('.asset-grid')!;
    root.querySelector('[data-filter="saved"]')!.remove();
    root.querySelector('nav')!.insertAdjacentHTML('afterbegin','<div class="asset-folder-tree" role="tree" aria-label="My Assets folders"></div>');
    if(scenes)root.querySelector('nav')!.insertAdjacentHTML('afterbegin',`<button data-filter="scenes" aria-label="Scenes folder">${icon('folder')} Scenes</button>`);
    if(workspace)root.querySelector('nav')!.insertAdjacentHTML('afterbegin',`<button data-filter="references" aria-label="References folder">${icon('folder')} References</button>`);
    const content=document.createElement('div');content.className='asset-content';this.grid.replaceWith(content);
    content.innerHTML=`<div class="asset-folder-toolbar"><span data-folder-path></span><button data-new-folder>${icon('plus')} New Folder</button><button data-rename-folder hidden>Rename Folder</button></div>`;content.append(this.grid);
    if(scenes){content.querySelector('.asset-folder-toolbar')!.insertAdjacentHTML('beforeend',`<button data-new-scene hidden>${icon('plus')} New Scene</button>`);content.querySelector<HTMLButtonElement>('[data-new-scene]')!.onclick=()=>{if(this.enabled())scenes.create();};}
    if(workspace){
      content.querySelector('.asset-folder-toolbar')!.insertAdjacentHTML('beforeend',`<button data-import-images>${icon('upload')} Import images</button><input data-reference-files type="file" accept="image/png,image/jpeg,image/webp" multiple hidden/>`);
      const input=content.querySelector<HTMLInputElement>('[data-reference-files]')!;
      content.querySelector<HTMLButtonElement>('[data-import-images]')!.onclick=()=>input.click();
      input.onchange=()=>{const files=[...input.files??[]];input.value='';void this.importReferences(files);};
    }
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
    root.ondragenter=root.ondragover=event=>{
      if(workspace&&event.dataTransfer?.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=this.enabled()&&!this.importing?'copy':'none';if(this.enabled())content.classList.add('asset-drop-target');return;}
      const folder=dropFolder(event),types=event.dataTransfer?.types??[];
      if(folder===undefined||!this.enabled()||(!types.includes(SCENE_OBJECT_DRAG)&&!types.includes(LIBRARY_ASSET_DRAG)))return;
      if(types.includes(LIBRARY_ASSET_DRAG)&&this.dragged?.source==='builtin')return;
      event.preventDefault();event.dataTransfer!.dropEffect=types.includes(SCENE_OBJECT_DRAG)?'copy':'move';
      this.clearDrop();const target=(event.target as HTMLElement).closest<HTMLElement>('[data-folder]')??content;target.classList.add('asset-drop-target');
    };
    root.ondragleave=event=>{if(!root.contains(event.relatedTarget as Node))this.clearDrop();};
    root.ondrop=event=>{
      if(workspace&&event.dataTransfer?.types.includes('Files')){event.preventDefault();this.clearDrop();void this.importReferences([...event.dataTransfer.files]);return;}
      this.clearDrop();const folder=dropFolder(event);if(folder===undefined||!this.enabled())return;
      const source=event.dataTransfer?.getData(SCENE_OBJECT_DRAG),assetId=event.dataTransfer?.getData(LIBRARY_ASSET_DRAG);
      if(!source&&!assetId)return;event.preventDefault();
      if(source){try{this.createFromObject?.(JSON.parse(source),folder);}catch{this.feedback('Could not read the dragged object. Please try again.');}}
      else if(assetId)void this.moveAsset(assetId,folder);
    };
    const refresh=document.createElement('button');refresh.textContent='Refresh';refresh.setAttribute('aria-label','Refresh assets');refresh.onclick=()=>void this.refresh();root.querySelector('header')!.insertBefore(refresh,root.querySelector('input'));
    root.querySelector<HTMLInputElement>('input[type="search"]')!.oninput=e=>{this.query=(e.target as HTMLInputElement).value.toLowerCase();this.render();};
    root.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(b=>b.onclick=()=>{this.filter=b.dataset.filter!;this.render();});
    this.grid.ondblclick=event=>{const card=(event.target as HTMLElement).closest<HTMLElement>('[data-asset]'),asset=this.assets.find(a=>a.id===card?.dataset.asset);if(asset&&this.enabled()){const pose=this.stage.placement(asset);if(pose)this.insert(asset,pose);}};
    this.grid.onclick=event=>{const target=event.target as HTMLElement;
      const retry=target.closest<HTMLElement>('[data-reference-retry]');if(retry){void this.workspace?.()?.retryOutput(retry.dataset.referenceRetry!).catch(error=>this.feedback((error as Error).message));return;}
      if(this.enabled()){const open=target.closest<HTMLElement>('[data-scene-open]'),remove=target.closest<HTMLElement>('[data-scene-delete]');if(open){this.scenes?.open(open.dataset.sceneOpen!);return;}if(remove){this.scenes?.remove(remove.dataset.sceneDelete!);return;}}
      const button=target.closest<HTMLElement>('[data-asset-edit]');if(!button)return;event.stopPropagation();const asset=this.assets.find(a=>a.id===button.dataset.assetEdit);if(asset&&this.enabled())this.edit?.(asset);};
    this.grid.ondragstart=event=>{
      const reference=(event.target as HTMLElement).closest<HTMLElement>('[data-reference-image]'),room=this.workspace?.()?.room;
      if(reference&&room&&this.enabled()){if(this.workspace?.()?.outputTransfer(reference.dataset.referenceImage!)){event.preventDefault();return;}this.dragged=null;event.dataTransfer!.effectAllowed='copy';event.dataTransfer!.setData(REFERENCE_IMAGE_DRAG,JSON.stringify({project:room.id,id:reference.dataset.referenceImage}));return;}
      const card=(event.target as HTMLElement).closest<HTMLElement>('[data-asset]');this.dragged=this.assets.find(a=>a.id===card?.dataset.asset)??null;if(!this.dragged||!this.enabled()){event.preventDefault();return;}event.dataTransfer!.effectAllowed='copyMove';event.dataTransfer!.setData(LIBRARY_ASSET_DRAG,this.dragged.id);event.dataTransfer!.setData('text/plain',this.dragged.id);event.dataTransfer!.setDragImage(this.blank,0,0);
    };
    this.grid.ondragend=()=>{this.dragged=null;this.stage.previewAsset(null);this.clearDrop();};
    const viewport=document.querySelector<HTMLElement>('#viewport')!;
    viewport.ondragover=event=>{if(!this.dragged||!this.enabled())return;event.preventDefault();event.dataTransfer!.dropEffect='copy';const pose=this.stage.placement(this.dragged,event.clientX,event.clientY);this.stage.previewAsset(pose?this.dragged:null,pose??undefined);};
    viewport.ondragleave=event=>{if(!viewport.contains(event.relatedTarget as Node))this.stage.previewAsset(null);};
    viewport.ondrop=event=>{if(!this.dragged||!this.enabled())return;event.preventDefault();const asset=this.dragged,pose=this.stage.placement(asset,event.clientX,event.clientY);this.dragged=null;this.stage.previewAsset(null);if(pose)this.insert(asset,pose);};
    void this.refresh();
  }
  get currentFolder():string{return this.filter==='saved'?this.folder:'';}
  showScenes():void{this.filter='scenes';this.query='';this.root.querySelector<HTMLInputElement>('input[type="search"]')!.value='';this.render();}
  showFolder(folder:string):void{this.filter='saved';this.folder=folder;this.query='';this.root.querySelector<HTMLInputElement>('input[type="search"]')!.value='';this.collapsed.delete('');for(const path of this.catalog.folders)if(folder.startsWith(path+'/'))this.collapsed.delete(path);this.render();}
  private clearDrop():void{this.root.querySelectorAll('.asset-drop-target').forEach(node=>node.classList.remove('asset-drop-target'));}
  private feedback(message:string):void{this.root.querySelector('[data-asset-status]')!.textContent=message;}
  private async importReferences(files:File[]):Promise<void>{
    const workspace=this.workspace?.(),room=workspace?.room;
    if(!workspace||!room||!files.length||!this.enabled()||this.importing)return;
    this.importing=true;this.render();this.feedback('Importing reference images…');
    try{
      await uploadAppearance(workspace,files,this.scenes?.active()??'',room);
      if(workspace.room!==room)return;
      this.filter='references';this.query='';this.root.querySelector<HTMLInputElement>('input[type="search"]')!.value='';
      this.update(this.saved);this.render();this.feedback('Images added to Assets / References · Drag onto an object or its component');
    }catch(error){this.feedback((error as Error).message);}
    finally{this.importing=false;const button=this.root.querySelector<HTMLButtonElement>('[data-import-images]');if(button)button.disabled=!this.enabled();}
  }
  private async editFolder(rename=false):Promise<void>{
    if(!this.enabled())return;const result=await editFolderDialog(this.currentFolder,rename?this.folder:undefined);
    if(result){++this.refreshId;this.catalog=result.catalog;this.showFolder(result.folder);}
  }
  private async moveAsset(assetId:string,folder:string):Promise<void>{
    try{const data=await assetRequest({action:'move_asset',assetId,folder});++this.refreshId;this.catalog=assetCatalogSchema.parse(data.catalog);this.showFolder(folder);this.feedback('Asset moved · Scene references retained');}
    catch(error){this.feedback((error as Error).message);}
  }
  update(saved:AssetDefinition[] = []):void {this.saved=saved;const assets=availableAssets([...this.remote,...saved.filter(a=>!this.remote.some(b=>a.id===b.id))]),key=JSON.stringify(assets),sceneKey=JSON.stringify([this.scenes?.list(),this.scenes?.active(),this.enabled()]),room=this.workspace?.()?.room,referenceKey=JSON.stringify([room?.id,room?.outputs.filter(output=>output.kind==='appearance-reference')]);if(this.listKey!==key||this.sceneKey!==sceneKey||this.referenceKey!==referenceKey){this.listKey=key;this.sceneKey=sceneKey;this.referenceKey=referenceKey;this.assets=assets;this.render();}this.updateTransfers();this.root.classList.toggle('assets-locked',!this.enabled());}
  private updateTransfers():void {
    const workspace=this.workspace?.();
    for(const entry of this.grid.querySelectorAll<HTMLElement>('[data-reference-entry]')){
      const card=entry.querySelector<HTMLButtonElement>('.reference-card')!,state=workspace?.outputTransfer(entry.dataset.referenceEntry!),status=entry.querySelector<HTMLElement>('.reference-transfer')!,progress=status.querySelector<HTMLProgressElement>('progress')!,label=status.querySelector<HTMLElement>('span')!,retry=status.querySelector<HTMLButtonElement>('button')!;
      status.hidden=!state&&!card.dataset.imageError;card.draggable=!state&&!card.dataset.imageError;card.classList.toggle('reference-failed',state?.phase==='failed'||!!card.dataset.imageError);
      progress.hidden=!state||state.phase==='failed';retry.hidden=state?.phase!=='failed';retry.disabled=!this.enabled();
      if(state){const percent=Math.min(100,Math.round(state.loaded/Math.max(1,state.total)*100));progress.value=percent;progress.setAttribute('aria-label',`Uploading ${card.title}`);label.textContent=state.phase==='failed'?'Upload failed':state.phase==='saving'?'Waiting for server…':`Uploading ${percent}%`;status.title=state.error??'';status.setAttribute('aria-label',state.phase==='failed'?`Upload failed. ${state.error??''}`:label.textContent);status.setAttribute('role',state.phase==='failed'?'alert':'status');}
      else if(card.dataset.imageError){label.textContent='Image unavailable';status.title='Refresh assets to try again.';status.setAttribute('role','alert');}
    }
  }
  async refresh():Promise<void> {
    const id=++this.refreshId;
    try{const response=await fetch('/api/assets');if(!response.ok)throw new Error('Asset service unavailable; project assets remain available');const data=await response.json(),assets:AssetDefinition[]=data.assets.map(validateAsset);if(id!==this.refreshId)return;this.remote=assets;this.catalog=assetCatalogSchema.parse(data.catalog??emptyCatalog());if(this.folder&&!this.catalog.folders.includes(this.folder))this.folder='';this.onLoaded?.(assets);this.update(this.saved);this.render();if(!['scenes','references'].includes(this.filter))this.feedback(data.temporary?'Temporary cloud library · Export your project to keep used assets':'Hierarchy → folder creates a prefab · Asset → scene places it');}
    catch(error){if(id===this.refreshId)this.root.querySelector('[data-asset-status]')!.textContent=error instanceof Error?error.message:'Could not load asset library';}
  }
  private thumbnail(asset:AssetDefinition):string {
    const key=JSON.stringify(asset);const cached=this.thumbnails.get(key);if(cached)return cached;
    this.renderer??=new THREE.WebGLRenderer({antialias:true,alpha:false});const r=this.renderer;r.setSize(240,150);r.setPixelRatio(1);r.toneMapping=THREE.ACESFilmicToneMapping;r.toneMappingExposure=1.2;
    const scene=new THREE.Scene();scene.background=new THREE.Color('#eef0e5');scene.add(new THREE.HemisphereLight('#fffcee','#9da98f',3));const light=new THREE.DirectionalLight('#ffffff',3);light.position.set(-3,7,5);scene.add(light);
    const group=createAssetGroup(asset);poseAssetJoints(group,asset,asset.template?.jointAngles??{});if(asset.template?.transform){group.scale.fromArray(asset.template.transform.scale);group.rotation.set(...asset.template.transform.rotation.map(THREE.MathUtils.degToRad) as [number,number,number]);}scene.add(group);const box=new THREE.Box3().setFromObject(group),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()).length();
    const camera=new THREE.PerspectiveCamera(35,240/150,.01,2000);camera.position.copy(center).add(new THREE.Vector3(1,.65,1.3).normalize().multiplyScalar(size*1.75));camera.lookAt(center);r.render(scene,camera);const url=r.domElement.toDataURL('image/png');disposeAssetGroup(group);this.thumbnails.set(key,url);return url;
  }
  private render():void {
    const scenes=this.filter==='scenes',references=this.filter==='references',workspace=this.workspace?.(),room=workspace?.room,images=room?.outputs.filter(output=>output.kind==='appearance-reference')??[];
    const count=this.scenes?.list().length??0;
    this.root.querySelector('#assetCount')!.textContent=scenes?`${count} scene${count===1?'':'s'}`:references?`${images.length} image${images.length===1?'':'s'}`:`${this.assets.length+images.length} assets`;
    this.root.querySelector<HTMLInputElement>('input[type="search"]')!.placeholder=scenes?'Search scenes…':references?'Search reference images…':'Search assets…';
    this.feedback(scenes?'Click to open a scene · Undo restores a deleted scene':references?'Drag images onto an object or its Appearance Reference component':'Drag into the scene · Double-click to place');
    this.root.querySelectorAll<HTMLElement>('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===this.filter)));
    const paths=['',...this.catalog.folders];
    this.root.querySelector('.asset-folder-tree')!.innerHTML=paths.filter(path=>path===''||![...this.collapsed].some(parent=>parent===''||path.startsWith(parent+'/'))).map(path=>{
      const children=this.catalog.folders.some(other=>path===''||other.startsWith(path+'/'));
      return `<button role="treeitem" data-folder="${esc(path)}" aria-label="Folder ${esc(folderLabel(path))}" aria-level="${path?path.split('/').length+1:1}" aria-selected="${this.filter==='saved'&&this.folder===path}" ${children?`aria-expanded="${!this.collapsed.has(path)}"`:''} style="padding-left:${8+(path?path.split('/').length:0)*14}px"><span data-folder-toggle>${children?(this.collapsed.has(path)?`${icon('chevron-right')}`:`${icon('chevron-down')}`):'·'}</span><span>${icon('folder')} ${esc(path.split('/').at(-1)||'My Assets')}</span></button>`;
    }).join('');
    this.root.querySelector('[data-folder-path]')!.textContent=references?'Assets / References · This project':this.filter==='saved'?folderLabel(this.folder):this.filter==='all'?'All Assets':categories[this.filter]?.label??'Assets';
    this.root.querySelector<HTMLElement>('[data-rename-folder]')!.hidden=this.filter!=='saved'||!this.folder;
    this.root.querySelectorAll<HTMLButtonElement>('[data-new-folder],[data-rename-folder]').forEach(button=>button.disabled=!this.enabled());
    this.root.querySelector<HTMLElement>('[data-new-folder]')!.hidden=scenes||references;
    const importImages=this.root.querySelector<HTMLButtonElement>('[data-import-images]');if(importImages){importImages.hidden=this.filter!=='all'&&!references;importImages.disabled=!this.enabled()||this.importing;}
    const newScene=this.root.querySelector<HTMLButtonElement>('[data-new-scene]');if(newScene){newScene.hidden=!scenes;newScene.disabled=!this.enabled()||(this.scenes?.list().length??0)>=24;}
    if(scenes){
      this.root.querySelector('[data-folder-path]')!.textContent='Assets / Scenes · This project';
      this.grid.innerHTML=this.scenes!.list().filter(scene=>scene.name.toLowerCase().includes(this.query)).map(scene=>`<div class="asset-card-entry scene-card-entry"><button class="asset-card scene-card" data-scene-open="${esc(scene.id)}" aria-label="Open scene ${esc(scene.name)}" aria-pressed="${scene.id===this.scenes!.active()}"><span class="scene-card-icon">${icon('image')}</span><strong>${esc(scene.name)}</strong><small>${scene.shots.length} shots · ${scene.objects.length} objects · ${scene.duration.toFixed(1)}s</small><small>${scene.id===this.scenes!.active()?'Open in editor':'Click to open'}</small></button><button class="asset-card-edit" data-scene-delete="${esc(scene.id)}" aria-label="Delete scene ${esc(scene.name)}">Delete Scene…</button></div>`).join('')||'<p class="asset-empty">No scenes here yet. Create a new scene or import a reference clip.</p>';
      return;
    }
    const list=this.assets.filter(a=>(this.filter==='all'||(this.filter==='saved'?a.source!=='builtin'&&(this.query?(!this.folder||(this.catalog.locations[a.id]??'')===this.folder||(this.catalog.locations[a.id]??'').startsWith(this.folder+'/')):(this.catalog.locations[a.id]??'')===this.folder):categories[this.filter]?.tags.some(tag=>a.tags.includes(tag))))&&[a.name,a.description,...a.tags,...a.tags.map(categoryLabel)].join(' ').toLowerCase().includes(this.query));
    const referenceCards=(references||this.filter==='all'?images:[]).filter(image=>image.name.toLowerCase().includes(this.query)).map(image=>`<div class="asset-card-entry" data-reference-entry="${image.id}"><button class="asset-card reference-card" draggable="true" data-reference-image="${image.id}" title="${esc(image.name)}" aria-label="Reference ${esc(image.name)}, drag to an object"><img draggable="false" alt="${esc(image.name)} reference"/><strong>${esc(image.name)}</strong></button><div class="reference-transfer" hidden><progress max="100" value="0"></progress><span></span><button data-reference-retry="${image.id}" aria-label="Retry uploading ${esc(image.name)}" hidden>Retry</button></div></div>`).join('');
    this.grid.innerHTML=referenceCards+list.map(a=>{const count=evaluateAsset(a).parts.filter(p=>p.kind!=='group').length;return `<div class="asset-card-entry"><button class="asset-card" draggable="true" data-asset="${esc(a.id)}" aria-label="Asset ${esc(a.name)}, double-click to place"><img draggable="false" src="${this.thumbnail(a)}" alt="${esc(a.name)} preview"/><strong>${esc(a.name)}</strong><small>${a.template?.track?'Recorded motion · ':''}${esc(categoryLabel(a.tags[0]))} · ${count} part${count===1?'':'s'}</small></button>${this.edit?`<button class="asset-card-edit" data-asset-edit="${esc(a.id)}" aria-label="Edit Prefab ${esc(a.name)}">Edit Prefab</button>`:''}</div>`;}).join('')||(references?'<p class="asset-empty">Import images or drop files here, then drag a reference onto an object.</p>':'<p class="asset-empty">Drag a Hierarchy object into this folder, or right-click an object and choose Create Independent Prefab.</p>');
    this.updateTransfers();
    if(workspace)for(const card of this.grid.querySelectorAll<HTMLElement>('[data-reference-image]'))void appearanceImage(workspace,card.dataset.referenceImage!,room).then(src=>{if(card.isConnected)card.querySelector('img')!.src=src;},()=>{if(card.isConnected){card.dataset.imageError='true';this.updateTransfers();}});
  }
}
