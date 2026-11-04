import { newId } from "../id.ts";
import type { AgentProgress } from './progress.ts';
/** Request data and model output only. Never include HTTP headers or provider configuration. */
export interface SceneEditDiagnostic {
  format: 'LittleTake.scene-edit-diagnostic' | 'LittleTake.reference-diagnostic'; version: 1; id: string; startedAt: string;
  input?: unknown; provider?: string; model?: string;
  attempts: {
    request: { instructions: string; content: unknown; history: unknown; schema: unknown; schemaName: string; format?: 'json_object' | 'json_schema';reasoningEffort?:'low'|'medium'|'high';maxOutputTokens?:number };
    rawOutput?: string; rawProposal?: unknown; error?: { code: string; message: string };
  }[];
  outcome?: 'ready' | 'needs_views' | 'needs_reference_frames' | 'needs_motion_review' | 'failed'; error?: { code: string; message: string };
  toolCalls?: { name: string; arguments: string; startedAt: string; finishedAt?: string; result?: unknown; error?: string }[];
  toolTurns?: { input: unknown; output: unknown;error?:{code:string;message:string} }[];
  measurements?:{model:string;concept:string;media:string;frames:unknown}[];
  media?:{ref:string;dataUrl:string}[];
  derivations?:unknown[];
  progress?: AgentProgress[];
  sceneReviews?: SceneEditDiagnostic['attempts'];
  sceneObservations?:SceneEditDiagnostic['attempts'];
  sceneDesigns?: unknown[];
  assetHandles?:Record<string,string>;
  referenceCalls?: unknown[];
}

export function newDiagnostic(kind:'scene-edit'|'reference'='scene-edit'): SceneEditDiagnostic {
  return { format: kind==='reference'?'LittleTake.reference-diagnostic':'LittleTake.scene-edit-diagnostic', version: 1, id: newId(), startedAt: new Date().toISOString(), attempts: [] };
}

/** Inputs already own their pixels; derived images keep their crop/overlay recipe.
 * Tool history can otherwise multiply a small set of images beyond a serverless response limit. */
export function compactDiagnosticMedia(diagnostic:SceneEditDiagnostic,known:Iterable<[string,string]>=[]):SceneEditDiagnostic{
  const refs=new Map(known),media:NonNullable<SceneEditDiagnostic['media']>=[],derivations:unknown[]=[];
  const visit=(value:unknown):unknown=>{
    if(typeof value==='string'&&/^data:(image|video)\//.test(value)){let ref=refs.get(value);if(!ref){ref='media['+media.length+']';refs.set(value,ref);media.push({ref,dataUrl:value});}return {dataRef:ref};}
    if(Array.isArray(value))return value.map(visit);
    if(value&&typeof value==='object'){
      const part=value as {dataUrl?:unknown;provenance?:unknown};
      if(typeof part.dataUrl==='string'&&part.provenance&&!refs.has(part.dataUrl)){const ref='derivations['+derivations.length+']';refs.set(part.dataUrl,ref);derivations.push({ref,...part.provenance as object});}
      return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
    }
    return value;
  };
  return {...visit(diagnostic) as SceneEditDiagnostic,...(media.length?{media}:{}),...(derivations.length?{derivations}:{})};
}
