import { validateDocument } from '../model';
import type { SceneDocument } from '../types';
import { MAX_REFERENCE_REVIEWS, MIN_REFERENCE_SCORE } from './analysis';
import { requestReferenceDraft } from './client';
import { measureReferenceFraming } from './framing';
import { referenceReview,referenceFramingMatches } from './review';
import { collectReferenceDetails,collectReferenceSource, verifyBoundaryFrames,measureReferenceFrameBounds } from './video';
import type { ReferenceDraft, VideoReferenceInput,ReferenceCapture } from './types';
import type { AssetDefinition } from '../assets/model';

export interface ReferenceRun {id:string;phase?:'source'|'observed'|'assets'|'initial'|'rendered'|'reviewed'|'passed'|'failed';source?:VideoReferenceInput['source'];sourceReviewed?:boolean;analysis?:VideoReferenceInput['analysis'];preparedAssets?:AssetDefinition[];preparations?:number;initial?:ReferenceDraft;next?:ReferenceDraft;attempts:{scene:SceneDocument;assets?:AssetDefinition[];analysis?:ReferenceDraft['analysis'];bindings?:ReferenceDraft['bindings'];quality?:ReferenceDraft['quality'];result?:ReferenceDraft;measurements:ReturnType<typeof measureReferenceFraming>;contactSheet:string;layoutSheet?:string;video?:string;frames?:NonNullable<VideoReferenceInput['review']>['frames'];continuity?:unknown[];sourceRegions?:NonNullable<VideoReferenceInput['review']>['sourceRegions']}[];result?:ReferenceDraft;error?:string}
export async function reconstructReference(input:VideoReferenceInput,capture:ReferenceCapture,signal:AbortSignal,progress:(message:string)=>void,run:ReferenceRun,checkpoint?:(run:ReferenceRun)=>Promise<void>):Promise<ReferenceDraft>{
  try{
    delete run.error;
    const last=run.attempts.at(-1),reviewed=last?.result;
    if(reviewed?.quality?.approved){
      if(!last!.video||!referenceFramingMatches(last!.measurements)||reviewed.quality.issues.length||Object.values(reviewed.quality.scores).some(value=>value<MIN_REFERENCE_SCORE))throw new Error('The saved review did not pass motion and framing verification.');
      run.result=reviewed;delete run.next;run.phase='passed';await checkpoint?.(run);return reviewed;
    }
    if(run.phase==='passed'&&run.result)return run.result;
    delete run.result;
    progress('Reading source frames and camera cuts');let source=run.source??await collectReferenceSource(input.video,signal,progress);source.frameBounds??=await measureReferenceFrameBounds(source,signal);run.source=source;if(run.analysis)run.analysis.frameBounds=source.frameBounds;run.phase='source';await checkpoint?.(run);
    if(!run.initial&&!run.analysis){progress('Measuring visible subjects, then identifying the shared set');const observed=await requestReferenceDraft({...input,source,analysis:undefined,review:undefined},signal,run.id);run.analysis=observed.analysis;for(const frame of source.frames)frame.detections=observed.regions.find(region=>region.frameIndex===frame.frameIndex)?.detections??[];run.phase='observed';await checkpoint?.(run);}
    if(!run.initial&&!run.sourceReviewed){progress('Checking original-resolution face/body direction and shared set identities');source.detailSheet??=await collectReferenceDetails(input.video,source,run.analysis!,signal);const checked=await requestReferenceDraft({...input,source,analysis:run.analysis!,sourceReview:true},signal,run.id);run.analysis=checked.analysis;run.sourceReviewed=true;run.phase='observed';await checkpoint?.(run);}
    const build=async(analysis:NonNullable<VideoReferenceInput['analysis']>,repair?:VideoReferenceInput['repair']):Promise<ReferenceDraft>=>{
      // Repairs keep the clean source montage plus one original frame per shot; the run retains every frame/detail.
      const buildSource=repair?{...source,detailSheet:undefined,frames:analysis.shots.flatMap((_,index)=>{const frames=source.frames.filter(frame=>frame.shotIndex===index).sort((a,b)=>a.time-b.time);return frames.length?[frames.find(frame=>frame.reason==='representative')??frames[Math.floor(frames.length/2)]]:[];})}:source;
      for(;;){signal.throwIfAborted();const result=await requestReferenceDraft({...input,source:buildSource,analysis,assets:repair?undefined:run.preparedAssets,repair},signal,run.id);if(!('preparation' in result))return result;
        run.preparedAssets=result.assets;if(repair)repair={...repair,assets:result.assets};if(run.next&&repair)run.next.assets=result.assets;run.preparations=(run.preparations??0)+1;run.phase='assets';await checkpoint?.(run);
        if(run.preparations>=2)throw new Error('Asset preparation reached its continuation limit. Approved assets and source observations are retained.');
        progress('Approved assets saved · continuing placement without regenerating them');
      }
    };
    signal.throwIfAborted();progress(run.initial?'Continuing from the preserved Muse draft':'Building the shared set from preserved observations');let draft=structuredClone(run.next??run.initial??await build(run.analysis!));run.initial??=structuredClone(draft);run.phase='initial';await checkpoint?.(run);
    if(!draft.analysis)throw new Error('The scene has no source observations to verify.');let analysis:NonNullable<ReferenceDraft['analysis']>=draft.analysis;
    source=await verifyBoundaryFrames(input.video,source,analysis.shots,signal);run.source=source;analysis.frameBounds=source.frameBounds;
    for(;;){
      signal.throwIfAborted();let attempt=run.attempts.at(-1);if(attempt?.quality)attempt=undefined;
      if(!attempt&&run.attempts.length>=MAX_REFERENCE_REVIEWS)break;
      progress('Checking rendered shots · round '+(attempt?run.attempts.length:run.attempts.length+1)+' / '+MAX_REFERENCE_REVIEWS);
      if(!attempt){
        if(draft.quality&&!draft.quality.approved){progress('Repairing the preserved set with the scene director and asset expert');draft=await build(analysis,{scene:draft.scene,assets:draft.assets,bindings:draft.bindings,quality:draft.quality,contactSheet:run.attempts.at(-1)?.contactSheet,layoutSheet:run.attempts.at(-1)?.layoutSheet,frames:run.attempts.at(-1)?.frames});run.next=structuredClone(draft);run.phase='initial';await checkpoint?.(run);}
        draft.scene=validateDocument(draft.scene);
        if(analysis.frameBounds)for(const camera of draft.scene.cameras)camera.frameBounds=[...analysis.frameBounds];
        const evidence=await referenceReview(draft.scene,capture,signal,source,analysis,draft.bindings,draft.assets??[]);
        attempt={...structuredClone(evidence),measurements:evidence.measurements as ReturnType<typeof measureReferenceFraming>,analysis:structuredClone(analysis)};run.attempts.push(attempt);run.phase='rendered';await checkpoint?.(run);
      }
      if(!attempt.frames?.length||!attempt.video)throw new Error('The saved review lacks its exact frame clock or motion video. Render it again before review.');
      analysis=attempt.analysis??analysis;
      const evidence={scene:attempt.scene,assets:attempt.assets,bindings:attempt.bindings,contactSheet:attempt.contactSheet,layoutSheet:attempt.layoutSheet,video:attempt.video,frames:attempt.frames,measurements:attempt.measurements,continuity:attempt.continuity,sourceRegions:attempt.sourceRegions};
      const result:ReferenceDraft=await requestReferenceDraft({...input,analysis,review:evidence},signal,run.id);if(!result.analysis)throw new Error('The visual review lost its source observations.');attempt.quality=result.quality;attempt.result=structuredClone(result);if(!result.quality?.approved)run.next=structuredClone(result);run.analysis=result.analysis;run.phase='reviewed';await checkpoint?.(run);
      const withinFrame=referenceFramingMatches(attempt.measurements);
      if(result.quality?.approved&&withinFrame&&Object.values(result.quality.scores).every(v=>v>=MIN_REFERENCE_SCORE)){
        run.result=result;delete run.next;run.phase='passed';await checkpoint?.(run);return result;
      }
      if(result.quality?.approved&&!withinFrame)throw new Error('The reviewer approved a draft whose subjects still miss the measured frame targets.');
      draft=result;analysis=result.analysis!;run.analysis=analysis;
    }
    throw new Error('The rendered reconstruction did not pass visual review. The draft and per-round diagnostics are retained; your project is unchanged.');
  }catch(error){run.error=(error as Error).message;run.phase='failed';await checkpoint?.(run);throw error;}
}
