import { SCENE_OBJECT_DRAG } from './folders';

export interface HierarchyAssetSource { projectId:string; sceneId:string; objectId:string }
export function bindHierarchyAssets(root:HTMLElement,source:(id:string)=>HierarchyAssetSource|null,create:(source:HierarchyAssetSource)=>void,dragStarted:()=>void):void {
  let menu:HTMLElement|undefined;
  const close=()=>{menu?.remove();menu=undefined;};
  const objectAt=(target:EventTarget|null)=> (target as HTMLElement|null)?.closest<HTMLElement>('[data-prefab-object]');
  root.addEventListener('dragstart',event=>{
    const row=objectAt(event.target),value=row&&source(row.dataset.prefabObject!);
    if(!value||!event.dataTransfer){event.preventDefault();return;}
    close();event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData(SCENE_OBJECT_DRAG,JSON.stringify(value));event.dataTransfer.setData('text/plain',row!.textContent??'Scene object');dragStarted();
  });
  const show=(row:HTMLElement,x:number,y:number)=>{
    const value=source(row.dataset.prefabObject!);if(!value)return;
    close();menu=document.createElement('div');menu.className='hierarchy-context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','Object actions');
    menu.innerHTML='<button role="menuitem">Create Independent Prefab…</button>';document.body.append(menu);
    menu.style.left=Math.max(8,Math.min(x,window.innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(y,window.innerHeight-menu.offsetHeight-8))+'px';
    const button=menu.querySelector('button')!;button.onclick=()=>{close();create(value);};button.focus();
  };
  root.addEventListener('contextmenu',event=>{const row=objectAt(event.target);if(!row||!source(row.dataset.prefabObject!))return;event.preventDefault();show(row,event.clientX,event.clientY);});
  root.addEventListener('keydown',event=>{if(event.key!=='ContextMenu'&&!(event.shiftKey&&event.key==='F10'))return;const row=objectAt(event.target);if(!row)return;event.preventDefault();const rect=row.getBoundingClientRect();show(row,rect.right,rect.bottom);});
  document.addEventListener('pointerdown',event=>{if(menu&&!menu.contains(event.target as Node))close();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu){event.stopPropagation();close();root.querySelector<HTMLElement>('[data-prefab-object]')?.focus();}},true);
  window.addEventListener('blur',close);
}
