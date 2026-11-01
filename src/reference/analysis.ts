import { z } from 'zod';
import type {ImageBounds} from '../types.ts';
import {frameBoundsSchema} from '../model.ts';
import { MAX_SOURCE_FRAMES, type SampleReason, type SourceSampling } from './shots.ts';
export {frameBoundsSchema} from '../model.ts';
const name=z.string().min(1).max(100);
const box=z.tuple([z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1)]);
const facing=z.enum(['front','back','left','right','three_quarter']);
export const analysisSchema=z.strictObject({
  summary:z.string().min(1).max(2000),
  frameBounds:frameBoundsSchema.optional(),
  entities:z.array(z.strictObject({name,description:z.string().max(500),color:z.string().regex(/^#[0-9a-fA-F]{6}$/),principal:z.boolean()})).min(1).max(40),
  shots:z.array(z.strictObject({start:z.number().min(0).max(60),duration:z.number().min(.1).max(60),framing:z.enum(['full_body','knees_up','waist_up','chest_up','head_shoulders']),description:z.string().max(1000)})).min(1).max(100),
  frames:z.array(z.strictObject({time:z.number().min(0).max(60),shotIndex:z.number().int().min(0).max(99),
    subjects:z.array(z.strictObject({name,box,headBox:box.nullable(),bodyRegionId:z.string().max(32).nullable(),headRegionId:z.string().max(32).nullable(),facing,bodyFacing:facing.nullable().default(null),action:z.string().max(300)})).max(24).describe('All VISIBLE tracked people AND fixed scene landmarks, not only people. Each visible named doorway, counter, arch wall or other landmark needs its own visible box in this frame, null region IDs and static action.'),
    setting:z.string().max(600)})).min(1).max(MAX_SOURCE_FRAMES),
  assumptions:z.array(z.string().max(500)).max(12),
});
export type ReferenceAnalysis=z.input<typeof analysisSchema>;
export const detectedRegionSchema=z.strictObject({id:z.string().max(32),kind:z.enum(['person','face']),box,confidence:z.number().min(0).max(1)});
export type DetectedRegion=z.infer<typeof detectedRegionSchema>;
export const faceLandmarkSchema=z.strictObject({box,confidence:z.number().min(0).max(1),points:z.array(z.tuple([z.number().min(-.5).max(1.5),z.number().min(-.5).max(1.5)])).length(5)});
export type FaceLandmarks=z.infer<typeof faceLandmarkSchema>;
export const sourceSamplingSchema=z.strictObject({algorithm:z.literal('adaptive-hsv-v1'),decodedFrames:z.number().int().min(1).max(15000),limited:z.boolean(),transitions:z.array(z.strictObject({kind:z.enum(['cut','fade']),time:z.number().min(0).max(60),start:z.number().min(0).max(60),end:z.number().min(0).max(60),score:z.number().min(0).max(255)})).max(MAX_SOURCE_FRAMES-1)});
export interface SourceEvidence { cuts:number[]; contactSheet:string;detailSheet?:string;frameBounds?:ImageBounds; sampling?:SourceSampling; frames:{time:number;frameIndex:number;shotIndex:number;dataUrl:string;reason?:SampleReason;detections?:DetectedRegion[];faceLandmarks?:FaceLandmarks[]}[] }
/** Restrict clear nose/eye direction using measured pixels; leave ambiguous bearings to the expert. */
export function groundFaceDirections(analysis:ReferenceAnalysis,frames:{time:number;faceLandmarks?:FaceLandmarks[]}[]){
  const measurements:{time:number;name:string;confidence:number;offset:number;before:string;after:string}[]=[];
  for(const frame of analysis.frames){const used=new Set<FaceLandmarks>(),faces=frames.find(item=>Math.abs(item.time-frame.time)<.002)?.faceLandmarks??[];
    for(const subject of frame.subjects){const box=subject.headBox;if(!box||!subject.bodyRegionId)continue;
      const face=faces.filter(face=>face.confidence>=.8&&!used.has(face)).map(face=>{const a=face.box,intersection=Math.max(0,Math.min(a[2],box[2])-Math.max(a[0],box[0]))*Math.max(0,Math.min(a[3],box[3])-Math.max(a[1],box[1]));return {face,overlap:intersection/((a[2]-a[0])*(a[3]-a[1])+(box[2]-box[0])*(box[3]-box[1])-intersection)};}).sort((a,b)=>b.overlap-a.overlap)[0];
      if(!face||face.overlap<.2)continue;used.add(face.face);const measured=face.face,width=measured.box[2]-measured.box[0],offset=(measured.points[2][0]-(measured.points[0][0]+measured.points[1][0])/2)/width,before=subject.facing;
      if(Math.abs(offset)>.1)subject.facing=offset<0?'left':'right';else if(Math.abs(offset)<.035)subject.facing='front';else if(subject.facing==='back')subject.facing='three_quarter';
      measurements.push({time:frame.time,name:subject.name,confidence:measured.confidence,offset,before,after:subject.facing});
    }
  }return measurements;
}
export const qualitySchema=z.strictObject({
  approved:z.boolean(),notes:z.string().min(1).max(2500),
  scores:z.strictObject({composition:z.number().min(0).max(10),motion:z.number().min(0).max(10),layout:z.number().min(0).max(10),color:z.number().min(0).max(10)}),
  issues:z.array(z.strictObject({shotIndex:z.number().int().min(0).max(99),time:z.number().min(0).max(60),problem:z.string().min(1).max(700),correction:z.string().min(1).max(1000)})).max(12),
});
export type ReferenceQuality=z.infer<typeof qualitySchema>;
export const MIN_REFERENCE_SCORE=8;
export const MAX_REFERENCE_REVIEWS=4;
