import {Stage} from '../../stage';
import {createEmptyScene} from '../../model';
import {reconstructReference,type ReferenceRun} from '../workflow';
import type {ReferenceDraft,ReferenceJobSubmission} from '../types';

declare global {interface Window{
  referenceCheckpoint(run:ReferenceRun):Promise<void>;
  referenceProgress(message:string):Promise<void>;
  executeReferenceJob(input:ReferenceJobSubmission['input'],run:ReferenceRun):Promise<ReferenceDraft>;
}}
window.executeReferenceJob=async(input,run)=>{
  const stage=new Stage({viewport:document.querySelector('#stage')!,preview:document.querySelector('#preview')!,onSelect(){},onTransform(){return false},onStatus(){}}),controller=new AbortController();
  stage.update(createEmptyScene('reference-worker','Background reconstruction'),0,[],false,null,[]);
  try{return await reconstructReference(input,(scene,time,shotId,assets,measureVisible,view='shot',frameBounds)=>stage.captureSnapshot(scene,time,view,shotId,assets,measureVisible,frameBounds),controller.signal,message=>{void window.referenceProgress(message);},run,value=>window.referenceCheckpoint(value));}
  finally{stage.dispose();}
};
