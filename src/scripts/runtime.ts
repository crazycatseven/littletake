import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import { z } from 'zod';
import type { Transform } from '../types.ts';
import { transformSchema } from '../performance/motion.ts';
import { scriptDefinitionSchema, scriptParameters, type ScriptDefinition, type ScriptParameters } from './model.ts';

let module:QuickJSWASMModule|undefined,loading:Promise<QuickJSWASMModule>|undefined;
export const prepareScripts = () => loading??=newQuickJSWASMModuleFromVariant(RELEASE_SYNC).then(value=>module=value).catch(error=>{loading=undefined;throw error;});
const stateSchema = z.record(z.string().max(64), z.union([z.number().finite(),z.boolean(),z.string().max(256),z.array(z.number().finite()).max(16)])).refine(v => Object.keys(v).length <= 64);
const jointsSchema = z.record(z.string().max(2048),z.number().min(-360).max(360)).refine(v => Object.keys(v).length <= 128);
const outputSchema = z.strictObject({ pose:transformSchema, state:stateSchema, joints:jointsSchema });
export type ScriptState = z.infer<typeof stateSchema>;
export interface ScriptInput { keys:Record<string,boolean>; mouse:{dx:number;dy:number;buttons:number} }
export interface ScriptFrame { dt:number; time:number; input:ScriptInput; pose:Transform; joints:Record<string,number>; params:ScriptParameters; state:ScriptState }
export const idleScriptInput = ():ScriptInput => ({keys:{w:false,a:false,s:false,d:false,f:false,v:false,shift:false,space:false},mouse:{dx:0,dy:0,buttons:0}});
export function validateScriptJoints(joints:Record<string,number>, limits:Map<string,{min:number;max:number}>){
  for(const [id,angle] of Object.entries(joints)){const limit=limits.get(id);if(!limit||angle<limit.min||angle>limit.max)throw new Error(`Script exceeded joint limits: ${id}`);}
}

/** Guest code receives JSON only. No browser, filesystem, network or host function is exposed. */
export class ScriptVM {
  private vm:QuickJSContext;
  private bridge!:QuickJSHandle;
  private deadline=0;
  private disposed=false;
  constructor(readonly definition:ScriptDefinition) {
    scriptDefinitionSchema.parse(definition);
    if(!module)throw new Error('Prepare the scripting runtime first.');
    const runtime=module.newRuntime(); runtime.setMemoryLimit(8*1024*1024);runtime.setMaxStackSize(256*1024);
    runtime.setInterruptHandler(()=>performance.now()>this.deadline);
    this.vm=runtime.newContext();
    try {
      this.deadline=performance.now()+50;
      // Capture the bridge's JSON builtins before loading guest code. Every call remains interruptible.
      this.bridge=this.unwrap(this.vm.evalCode(`(() => { const parse=JSON.parse, stringify=JSON.stringify;
        return (kind, text) => { const ctx=parse(text); let output;
          if(kind==='init') { ctx.state=typeof init==='function' ? init(ctx) : {}; output=ctx; }
          else { output=update(ctx) || ctx; }
          if(output && typeof output.then==='function') throw new Error('Controllers must be synchronous.');
          return stringify({pose:output.pose,state:output.state,joints:output.joints});
        }; })()`));
      this.unwrap(this.vm.evalCode(`globalThis.Date=undefined; Math.random=()=>{throw new Error('Use ctx.time and explicit state.');};\n${definition.source}\nif(typeof update!=='function') throw new Error('Define function update(ctx).');`,`${definition.id}.js`)).dispose();
    } catch(error) {this.dispose();throw error;}
  }
  private unwrap(result:ReturnType<QuickJSContext['evalCode']>):QuickJSHandle {
    if(result.error){let message='Script failed or exceeded its execution budget.';
      // Normal interpreter errors contain plain message/stack properties. Still bound inspection time.
      this.deadline=performance.now()+3;
      try {const error=this.vm.dump(result.error);if(error&&typeof error==='object'&&typeof error.message==='string')message=error.message.slice(0,1000);}
      catch {} finally {result.error.dispose();}
      throw new Error(message);
    }
    return result.value;
  }
  call(kind:'init'|'update', frame:ScriptFrame):z.infer<typeof outputSchema> {
    if(this.disposed)throw new Error('Script instance is stopped.');
    if(!Number.isFinite(frame.dt)||frame.dt<0||frame.dt>.1||!Number.isFinite(frame.time))throw new Error('Invalid script clock.');
    const text=JSON.stringify(frame);if(text.length>100_000)throw new Error('Script input exceeds its budget.');
    const input=this.vm.newString(text), action=this.vm.newString(kind);
    this.deadline=performance.now()+8;
    try {
      const result=this.unwrap(this.vm.callFunction(this.bridge,this.vm.undefined,action,input));
      try { const json=this.vm.getString(result);if(json.length>100_000)throw new Error('Script output exceeds its budget.');return outputSchema.parse(JSON.parse(json)); }
      finally {result.dispose();}
    } finally {input.dispose();action.dispose();}
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.bridge?.dispose();const runtime=this.vm.runtime;this.vm.dispose();runtime.dispose();}
}

export async function checkScript(script:ScriptDefinition, frames?:Omit<ScriptFrame,'params'|'state'>[], values:ScriptParameters = {}, limits?:Map<string,{min:number;max:number}>) {
  const params=scriptParameters(script,values);await prepareScripts(); const vm=new ScriptVM(script);
  const sample=frames?.[0]??{dt:1/60,time:0,input:idleScriptInput(),pose:{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]} as Transform,joints:{}};
  try {
    let result=vm.call('init',{...sample,params,state:{}});
    const sequence=frames??Array.from({length:30},(_,i)=>({...sample,time:i/60,input:{...idleScriptInput(),keys:{...idleScriptInput().keys,[i<15?'w':'d']:true}}}));
    if(sequence.length>120)throw new Error('Script checks support at most 120 frames.');
    const started=performance.now(), samples=[];
    for(const frame of sequence){if(performance.now()-started>500)throw new Error('Script check exceeded its total budget.');result=vm.call('update',{...frame,pose:result.pose,joints:result.joints,params,state:result.state});if(limits)validateScriptJoints(result.joints,limits);samples.push({time:frame.time,pose:result.pose,joints:result.joints});}
    return {ok:true as const,frames:samples.length,last:result,samples,elapsedMs:performance.now()-started};
  } finally {vm.dispose();}
}

/** One active controller instance. Swap only after the new module has accepted a copied frame. */
export class ScriptInstance {
  private vm:ScriptVM;
  private state:ScriptState={};
  private pending?:ScriptDefinition;
  private fallback?:{vm:ScriptVM;state:ScriptState};
  error='';
  constructor(definition:ScriptDefinition, frame:Omit<ScriptFrame,'state'>) {this.vm=new ScriptVM(definition);try{this.state=this.vm.call('init',{...frame,state:{}}).state;}catch(error){this.vm.dispose();throw error;}}
  get definition(){return this.vm.definition;}
  reset(frame:Omit<ScriptFrame,'state'>){this.state=this.vm.call('init',{...frame,state:{}}).state;this.fallback?.vm.dispose();this.fallback=undefined;}
  queue(definition:ScriptDefinition){this.pending=JSON.stringify(definition)!==JSON.stringify(this.definition)?structuredClone(definition):undefined;}
  step(frame:Omit<ScriptFrame,'state'>,recording=false) {
    if(this.pending&&!recording){const next=this.pending;this.pending=undefined;let candidate:ScriptVM|undefined;
      try {candidate=new ScriptVM(next);const params=scriptParameters(next,frame.params,true),state=next.stateVersion===this.definition.stateVersion?structuredClone(this.state):candidate.call('init',{...frame,params,state:{}}).state;
        candidate.call('update',{...frame,dt:0,input:idleScriptInput(),params,state});
        this.fallback?.vm.dispose();this.fallback={vm:this.vm,state:structuredClone(this.state)};this.vm=candidate;this.state=state;this.error='';
      } catch(error){candidate?.dispose();this.error=(error as Error).message;}
    }
    const params=scriptParameters(this.definition,frame.params,true);
    try {const result=this.vm.call('update',{...frame,params,state:this.state});this.state=result.state;return result;}
    catch(error){if(recording||!this.fallback)throw error;this.vm.dispose();this.vm=this.fallback.vm;this.state=this.fallback.state;this.fallback=undefined;this.error='New script failed. Previous version restored.';const result=this.vm.call('update',{...frame,params:scriptParameters(this.definition,frame.params,true),state:this.state});this.state=result.state;return result;}
  }
  dispose(){this.vm.dispose();this.fallback?.vm.dispose();this.fallback=undefined;}
}
