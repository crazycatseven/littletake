import { icon } from '../icons';
import type { ProjectContent } from '../types';
import { scriptDefinitionSchema, starterScript, type ScriptDefinition } from './model';
import { checkProjectScript } from './check';
import { SCRIPT_CONTRACT } from './contract';
import './editor.css';

const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
/** The ordinary component workflow stays in Inspector; source authoring lives in this explicit editor. */
export function openScriptEditor(options:{project:()=>ProjectContent;sceneId:string;selectedId?:string;scriptId?:string;save:(script:ScriptDefinition,expectedRevision:number)=>void}) {
  const dialog=document.createElement('dialog');dialog.className='script-editor';
  let selected=options.scriptId??options.project().scripts?.[0]?.id,baseRevision=0,draft:ScriptDefinition,busy=false,dirty=false;
  const read=()=>selected?options.project().scripts?.find(s=>s.id===selected):undefined;
  const load=()=>{const current=read();baseRevision=current?.revision??0;draft=current?structuredClone(current):starterScript('script-'+crypto.randomUUID());dirty=false;};load();
  const q=<T extends HTMLElement>(s:string)=>dialog.querySelector<T>(s)!;
  const render=()=>{
    dialog.innerHTML=`<header><div><strong>Project Scripts</strong><small>Reusable controllers · saved with this project</small></div><button data-script-close aria-label="Close script editor">${icon('close')}</button></header>
    <div class="script-editor-body"><aside>${(options.project().scripts??[]).map(s=>`<button data-script-select="${esc(s.id)}" aria-current="${s.id===selected}">${esc(s.name)}<small>Revision ${s.revision}</small></button>`).join('')}<button data-script-new>${icon('plus')} New Script</button></aside>
    <section><div class="script-meta"><label>Name<input aria-label="Script name" data-script-name value="${esc(draft.name)}"/></label><label>State version<input aria-label="Script state version" data-script-version type="number" min="1" value="${draft.stateVersion}"/></label></div>
    <label>Controls<input aria-label="Script controls" data-script-controls value="${esc(draft.controls)}"/></label>
    <p class="muted">${baseRevision?'Revision '+baseRevision:'New project script'} · ${(options.project().scenes.flatMap(s=>s.objects).filter(o=>o.components?.some(c=>c.type==='script'&&c.scriptId===draft.id))).length} attached objects. Recording keeps its active version.</p>
    <label>Source · ${esc(draft.id)}.js<textarea data-script-source aria-label="Script source" spellcheck="false">${esc(draft.source)}</textarea></label>
    <details><summary>Public parameters</summary><textarea data-script-fields aria-label="Script public parameters" spellcheck="false">${esc(JSON.stringify(draft.fields,null,2))}</textarea></details>
    <details><summary>Script API</summary><pre>${esc(SCRIPT_CONTRACT)}</pre></details></section></div>
    <footer><span role="status" data-script-status>Edits stay in this draft until checked and saved.</span><button data-script-check>Check Script</button><button data-script-save class="primary-button">Check & Save</button></footer>`;
    const collect=()=>scriptDefinitionSchema.parse({...draft,name:q<HTMLInputElement>('[data-script-name]').value,controls:q<HTMLInputElement>('[data-script-controls]').value,stateVersion:Number(q<HTMLInputElement>('[data-script-version]').value),source:q<HTMLTextAreaElement>('[data-script-source]').value,fields:JSON.parse(q<HTMLTextAreaElement>('[data-script-fields]').value),revision:baseRevision+1});
    const feedback=(message:string)=>q('[data-script-status]').textContent=message;
    dialog.oninput=()=>{dirty=true;};
    const check=async(save:boolean)=>{if(busy)return;busy=true;dialog.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=true);feedback('Checking in the isolated runtime…');
      try{const candidate=collect(),report=await checkProjectScript(candidate,options.project(),options.selectedId?{sceneId:options.sceneId,id:options.selectedId}:undefined);if(!dialog.isConnected)return;
        if(save){if((read()?.revision??0)!==baseRevision)throw new Error('This script changed elsewhere. Reopen it before saving.');options.save(candidate,baseRevision);selected=candidate.id;load();render();feedback('Saved · active controls reload at the next update; recordings keep their current version.');}
        else feedback(`Passed ${report.frames} synthetic input steps. Try the controls in the scene to judge the feel.`);
      }catch(error){feedback((error as Error).message);}finally{busy=false;dialog.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=false);}
    };
    q('[data-script-check]').onclick=()=>void check(false);q('[data-script-save]').onclick=()=>void check(true);
    q('[data-script-close]').onclick=()=>dialog.close();
    q('[data-script-new]').onclick=()=>{if(dirty){feedback('Save this draft before creating another script.');return;}selected=undefined;load();render();};
    dialog.querySelectorAll<HTMLButtonElement>('[data-script-select]').forEach(b=>b.onclick=()=>{if(dirty){feedback('Save this draft before switching scripts.');return;}selected=b.dataset.scriptSelect;load();render();});
  };
  dialog.addEventListener('close',()=>dialog.remove());render();document.body.append(dialog);dialog.showModal();
}
