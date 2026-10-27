import * as THREE from 'three';
import { createAssetGroup,disposeAssetGroup,evaluateAsset,validateAsset,type AssetDefinition } from './model';
import { availableAssets } from './library';
import type { Stage } from '../stage';
import type { Transform } from '../types';
import './panel.css';

const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export class AssetPanel {
  private open=false;
  private filter='all';
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
  constructor(private root:HTMLElement,private stage:Stage,private insert:(asset:AssetDefinition,pose:Transform)=>void,private enabled:()=>boolean,private edit?:(asset:AssetDefinition)=>void){
    this.blank.width=this.blank.height=1;
    try{const s=localStorage.getItem('littletake.assets.shortcut');if(s&&['KeyB','KeyG','none'].includes(s))this.shortcut=s;}catch{}
    root.innerHTML=`<section class="asset-drawer" aria-label="项目资产库" aria-hidden="true" inert><header><strong>项目资产 <small id="assetCount"></small></strong><span>拖入片场 · 双击快速放置</span><input type="search" aria-label="搜索资产" placeholder="搜索人物、车辆、道具…"/><button data-assets-close aria-label="收起资产库">收起 ⌄</button></header><div class="asset-body"><nav aria-label="资产分类">${[['all','全部资产'],['人物','人物'],['车辆','车辆'],['道具','道具'],['基础几何','基础几何'],['saved','我的资产']].map(([key,name])=>`<button data-filter="${key}">${name}</button>`).join('')}</nav><div class="asset-grid"></div></div></section><div class="asset-footer"><button aria-label="资产抽屉" aria-expanded="false" data-assets-toggle>▧ 资产库 <kbd></kbd> ⌃</button><details class="asset-shortcut-settings"><summary aria-label="快捷键设置">⌨</summary><label>资产抽屉快捷键<select aria-label="资产抽屉快捷键"><option value="KeyB">B（默认）</option><option value="KeyG">G（替代移动工具快捷键）</option><option value="none">关闭快捷键</option></select><small>输入文字时不会触发。也可点击资产库按钮。</small></label></details></div>`;
    this.drawer=root.querySelector('.asset-drawer')!;this.toggle=root.querySelector('[data-assets-toggle]')!;this.grid=root.querySelector('.asset-grid')!;
    this.drawer.querySelector('header > span')!.setAttribute('data-asset-status','');
    const refresh=document.createElement('button');refresh.textContent='刷新';refresh.setAttribute('aria-label','刷新资产库');refresh.onclick=()=>void this.refresh();this.drawer.querySelector('header')!.insertBefore(refresh,this.drawer.querySelector('input'));
    this.drawer.insertAdjacentHTML('afterbegin','<div class="panel-resize-handle asset-resize-handle" role="separator" aria-label="调整资产库高度" aria-orientation="horizontal" aria-controls="assetPanel" tabindex="0" title="拖动调整高度 · 双击恢复最小高度"></div>');
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
    this.grid.ondblclick=event=>{const card=(event.target as HTMLElement).closest<HTMLElement>('[data-asset]'),asset=this.assets.find(a=>`${a.id}@${a.version}`===card?.dataset.asset);if(asset&&this.enabled()){const pose=this.stage.placement(asset);if(pose)this.insert(asset,pose);}};
    this.grid.onclick=event=>{const button=(event.target as HTMLElement).closest<HTMLElement>('[data-asset-edit]');if(!button)return;event.stopPropagation();const asset=this.assets.find(a=>`${a.id}@${a.version}`===button.dataset.assetEdit);if(asset&&this.enabled())this.edit?.(asset);};
    this.grid.ondragstart=event=>{const card=(event.target as HTMLElement).closest<HTMLElement>('[data-asset]');this.dragged=this.assets.find(a=>`${a.id}@${a.version}`===card?.dataset.asset)??null;if(!this.dragged||!this.enabled()){event.preventDefault();return;}event.dataTransfer!.effectAllowed='copy';event.dataTransfer!.setData('text/plain',this.dragged.id);event.dataTransfer!.setDragImage(this.blank,0,0);};
    this.grid.ondragend=()=>{this.dragged=null;this.stage.previewAsset(null);};
    const viewport=document.querySelector<HTMLElement>('#viewport')!;
    viewport.ondragover=event=>{if(!this.dragged||!this.enabled())return;event.preventDefault();event.dataTransfer!.dropEffect='copy';const pose=this.stage.placement(this.dragged,event.clientX,event.clientY);this.stage.previewAsset(pose?this.dragged:null,pose??undefined);};
    viewport.ondragleave=event=>{if(!viewport.contains(event.relatedTarget as Node))this.stage.previewAsset(null);};
    viewport.ondrop=event=>{if(!this.dragged||!this.enabled())return;event.preventDefault();const asset=this.dragged,pose=this.stage.placement(asset,event.clientX,event.clientY);this.dragged=null;this.stage.previewAsset(null);if(pose)this.insert(asset,pose);};
    void this.refresh();
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
  update(saved:AssetDefinition[] = []):void {this.saved=saved;const assets=availableAssets([...saved,...this.remote.filter(a=>!saved.some(b=>a.id===b.id&&a.version===b.version))]),key=JSON.stringify(assets);if(this.listKey!==key){this.listKey=key;this.assets=assets;this.render();}this.toggle.disabled=!this.enabled();this.drawer.classList.toggle('assets-locked',!this.enabled());}
  async refresh():Promise<void> {
    const id=++this.refreshId;
    try{const response=await fetch('/api/assets');if(!response.ok)throw new Error('资产服务暂不可用，仍可使用项目资产');const data=await response.json(),assets:AssetDefinition[]=data.assets.map(validateAsset);if(id!==this.refreshId)return;this.remote=assets;this.update(this.saved);this.root.querySelector('[data-asset-status]')!.textContent=data.temporary?'云端库临时保存 · 请导出项目保留已使用的资产':'拖入片场 · 双击快速放置';}
    catch(error){if(id===this.refreshId)this.root.querySelector('[data-asset-status]')!.textContent=error instanceof Error?error.message:'资产库加载失败';}
  }
  private thumbnail(asset:AssetDefinition):string {
    const key=JSON.stringify(asset);const cached=this.thumbnails.get(key);if(cached)return cached;
    this.renderer??=new THREE.WebGLRenderer({antialias:true,alpha:false});const r=this.renderer;r.setSize(240,150);r.setPixelRatio(1);r.toneMapping=THREE.ACESFilmicToneMapping;r.toneMappingExposure=1.2;
    const scene=new THREE.Scene();scene.background=new THREE.Color('#eef0e5');scene.add(new THREE.HemisphereLight('#fffcee','#9da98f',3));const light=new THREE.DirectionalLight('#ffffff',3);light.position.set(-3,7,5);scene.add(light);
    const group=createAssetGroup(asset);if(asset.template?.transform){group.scale.fromArray(asset.template.transform.scale);group.rotation.set(...asset.template.transform.rotation.map(THREE.MathUtils.degToRad) as [number,number,number]);}scene.add(group);const box=new THREE.Box3().setFromObject(group),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()).length();
    const camera=new THREE.PerspectiveCamera(35,240/150,.01,2000);camera.position.copy(center).add(new THREE.Vector3(1,.65,1.3).normalize().multiplyScalar(size*1.75));camera.lookAt(center);r.render(scene,camera);const url=r.domElement.toDataURL('image/png');disposeAssetGroup(group);this.thumbnails.set(key,url);return url;
  }
  private render():void {
    this.root.querySelector('#assetCount')!.textContent=`${this.assets.length} 项`;
    this.root.querySelectorAll<HTMLElement>('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===this.filter)));
    const list=this.assets.filter(a=>(this.filter==='all'||a.tags.includes(this.filter))&&[a.name,a.description,...a.tags].join(' ').toLowerCase().includes(this.query));
    this.grid.innerHTML=list.map(a=>`<div class="asset-card-entry"><button class="asset-card" draggable="true" data-asset="${esc(a.id)}@${a.version}" aria-label="资产 ${esc(a.name)} v${a.version}，双击放入片场"><img draggable="false" src="${this.thumbnail(a)}" alt="${esc(a.name)}的三维缩略图"/><strong>${esc(a.name)} <span>v${a.version}</span></strong><small>${a.template?.track?'含录制动作 · ':''}${esc(a.tags[0])} · ${evaluateAsset(a).parts.filter(p=>p.kind!=='group').length} 个部件</small></button>${this.edit?`<button class="asset-card-edit" data-asset-edit="${esc(a.id)}@${a.version}" aria-label="编辑资产 ${esc(a.name)} v${a.version}">编辑资产</button>`:''}</div>`).join('')||'<p class="asset-empty">没有匹配的资产。选中场景物体后，可以保存为自己的资产。</p>';
  }
}
