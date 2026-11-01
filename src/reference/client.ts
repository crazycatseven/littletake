import { newId } from "../id.ts";
import { projectFetch, projectDiagnosticId } from '../project/client';
import { validateDocument } from '../model';
import { MAX_REFERENCE_BODY_BYTES } from './types';
import type { ReferenceConnection, ReferenceDraft, ReferenceInput, VideoReferenceInput, ImageReferenceInput, ReferenceObservation, ReferencePreparation, ReferenceResult,ReferenceJobSummary,ReferenceJobSubmission } from './types';
import { analysisSchema, qualitySchema } from './analysis';
import { detectedRegionSchema } from './analysis';
import { validateProjectContent } from '../project/model';
import { validateAsset } from '../assets/model';
import { readTracks, measuredTracks } from './tracks';
import { saveDiagnostic,type RequestDiagnostic } from '../scene-edit/diagnostic-store';


export async function referenceConnection(signal?: AbortSignal): Promise<ReferenceConnection> {
  const response = await projectFetch('/api/reference', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('The analysis server is unavailable. You can keep editing your scene.');
  const data = await response.json();
  if (typeof data.available !== 'boolean' || typeof data.provider !== 'string' || typeof data.model !== 'string') throw new Error('The analysis server is unavailable on this deployment.');
  return data;
}

export function requestReferenceDraft(input:VideoReferenceInput&{source:NonNullable<VideoReferenceInput['source']>;analysis:NonNullable<VideoReferenceInput['analysis']>;sourceReview:true},signal:AbortSignal,runId?:string):Promise<ReferenceObservation>;
export function requestReferenceDraft(input:VideoReferenceInput&{analysis:NonNullable<VideoReferenceInput['analysis']>;review:NonNullable<VideoReferenceInput['review']>},signal:AbortSignal,runId?:string):Promise<ReferenceDraft>;
export function requestReferenceDraft(input:VideoReferenceInput&{analysis:NonNullable<VideoReferenceInput['analysis']>},signal:AbortSignal,runId?:string):Promise<ReferenceDraft|ReferencePreparation>;
export function requestReferenceDraft(input:VideoReferenceInput&{source:NonNullable<VideoReferenceInput['source']>;analysis?:undefined;review?:undefined},signal:AbortSignal,runId?:string):Promise<ReferenceObservation>;
export function requestReferenceDraft(input:ImageReferenceInput,signal:AbortSignal,runId?:string):Promise<ReferenceDraft>;
export async function requestReferenceDraft(input: ReferenceInput, signal: AbortSignal,runId='reference'): Promise<ReferenceResult> {
  const id=newId(),record:RequestDiagnostic<ReferenceInput>={id,turnId:runId,conversationId:projectDiagnosticId('reference:'+runId),messageId:id,startedAt:new Date().toISOString(),input:structuredClone(input),status:'pending'};
  await saveDiagnostic(record);
  try{
  const body=JSON.stringify(input);if(new TextEncoder().encode(body).length>MAX_REFERENCE_BODY_BYTES)throw new Error('The clip and review frames exceed the request limit. Use a smaller video.');
  const response = await projectFetch('/api/reference', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-littletake-run-id': runId }, body, signal });
  let data;
  try { data = await response.json(); } catch { throw new Error('Analysis did not finish. Please try a shorter clip.'); }
  if(data.diagnostic)record.server=data.diagnostic;
  if (!response.ok) throw new Error(typeof data.error?.message === 'string' ? data.error.message.slice(0, 300) : 'The clip could not be analyzed. Please try again.');
  if(typeof data.provider!=='string'||typeof data.model!=='string')throw new Error('The analysis response was incomplete. Please try again.');
  if('video' in input&&(!input.analysis||input.sourceReview)&&!input.review&&input.source){if(!Array.isArray(data.regions)||data.regions.some((frame:{frameIndex:number})=>!Number.isInteger(frame.frameIndex)))throw new Error('The source measurements were incomplete.');const result={analysis:analysisSchema.parse(data.analysis),regions:data.regions.map((frame:{frameIndex:number;detections:unknown})=>({frameIndex:frame.frameIndex,detections:detectedRegionSchema.array().parse(frame.detections)})),provider:data.provider,model:data.model};record.result=structuredClone(result);record.status='ready';record.finishedAt=new Date().toISOString();await saveDiagnostic(record);return result;}
  if(data.preparation===true){const result:ReferencePreparation={preparation:true,assets:data.assets.map(validateAsset),analysis:analysisSchema.parse(data.analysis),summary:data.summary,provider:data.provider,model:data.model};record.result=structuredClone(result);record.status='ready';record.finishedAt=new Date().toISOString();await saveDiagnostic(record);return result;}
  const result=parseReferenceDraft(data);
  record.result=structuredClone(result);record.status='ready';record.finishedAt=new Date().toISOString();await saveDiagnostic(record);return result;
  }catch(error){record.status=signal.aborted?'cancelled':'failed';record.error=(error as Error).message;record.finishedAt=new Date().toISOString();await saveDiagnostic(record);throw error;}
}

export function parseReferenceDraft(data:any):ReferenceDraft{
  if(typeof data.provider!=='string'||typeof data.model!=='string'||typeof data.summary!=='string'||!Array.isArray(data.assumptions)||data.assumptions.some((item:unknown)=>typeof item!=='string'))throw new Error('The analysis response was incomplete.');
  const assets=(data.assets??[]).map(validateAsset),scene=validateProjectContent({name:'Reference',scenes:[data.scene],assets}).scenes[0];
  const analysis=data.analysis?analysisSchema.parse(data.analysis):undefined;
  const tracks=readTracks(data.tracks)??(analysis?measuredTracks(analysis,data.bindings):undefined);
  return {scene,assets,summary:data.summary,assumptions:data.assumptions,provider:data.provider,model:data.model,...(tracks?.length?{tracks}:{}),...(data.bindings?{bindings:data.bindings}:{}),...(analysis?{analysis}:{}),...(data.quality?{quality:qualitySchema.parse(data.quality)}:{})};
}
async function jobRequest(query='',body?:unknown,signal?:AbortSignal){
  const response=await projectFetch('/api/reference-jobs'+query,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal,cache:'no-store'});
  const data=await response.json();if(!response.ok)throw new Error(typeof data.error?.message==='string'?data.error.message:'The background service could not finish this request.');return data;
}
export async function referenceJobs(signal?:AbortSignal):Promise<ReferenceConnection&{jobs:ReferenceJobSummary[]}>{return jobRequest('',undefined,signal);}
export async function submitReferenceJob(value:ReferenceJobSubmission):Promise<ReferenceJobSummary>{return jobRequest('',value);}
export async function readReferenceJob(id:string,signal?:AbortSignal):Promise<ReferenceJobSummary>{return jobRequest('?id='+encodeURIComponent(id),undefined,signal);}
export async function referenceJobAction(id:string,action:'cancel'|'resume'):Promise<ReferenceJobSummary>{return jobRequest('?id='+encodeURIComponent(id)+'&action='+action,{});}
export async function readReferenceJobInput(id:string,signal?:AbortSignal):Promise<ReferenceJobSubmission['input']>{return jobRequest('?id='+encodeURIComponent(id)+'&action=input',undefined,signal);}
export async function readReferenceJobResult(id:string,signal?:AbortSignal):Promise<ReferenceDraft>{const draft=parseReferenceDraft(await jobRequest('?id='+encodeURIComponent(id)+'&action=result',undefined,signal));if(!draft.quality?.approved||draft.quality.issues.length)throw new Error('This scene has not passed visual review.');return draft;}
export async function downloadReferenceJob(id:string):Promise<void>{
  const response=await projectFetch('/api/reference-jobs?id='+encodeURIComponent(id)+'&action=diagnostics');if(!response.ok)throw new Error('The saved analysis could not be downloaded.');
  const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');anchor.href=url;anchor.download='LittleTake-reference-analysis.json.gz';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);

}
