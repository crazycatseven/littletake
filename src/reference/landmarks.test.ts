import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analysisSchema,groundFaceDirections,type SourceEvidence} from './analysis.ts';
import {createReferenceHandler} from '../../server/reference-api.ts';

test('recorded left/right source failure is grounded after an incorrect Muse audit, retaining exact identities, boxes, cuts and independent torso poses',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/face-landmarks.json',import.meta.url),'utf8'));
  const analysis=analysisSchema.parse(fixture.analysis),jpeg='data:image/jpeg;base64,'+Buffer.from([255,216,255,217]).toString('base64');
  const original=structuredClone(analysis),source:SourceEvidence={cuts:analysis.shots.slice(1).map(shot=>shot.start),contactSheet:jpeg,frames:analysis.frames.map((frame,index)=>({time:frame.time,frameIndex:index,shotIndex:frame.shotIndex,dataUrl:jpeg,faceLandmarks:fixture.frames[index].faceLandmarks,detections:frame.subjects.flatMap(subject=>subject.bodyRegionId?[{id:subject.bodyRegionId,kind:'person' as const,box:subject.box,confidence:1},...(subject.headRegionId&&subject.headBox?[{id:subject.headRegionId,kind:'face' as const,box:subject.headBox,confidence:1}]:[])]:[])}))};
  const wrong=structuredClone(analysis);wrong.frames[0].subjects.find(subject=>subject.name==='lobby_boy')!.facing='right';wrong.frames[0].subjects.find(subject=>subject.name==='doorman')!.facing='back';
  let calls=0;const handler=createReferenceHandler({},()=>({name:'test',model:'test',async segmentMedia(){throw new Error('Preserved SAM regions must be reused.');},async generateObject(request){calls++;assert.equal(request.schemaName,'reference_observation_review');return wrong;}}));
  const response=await handler(new Request('https://test.example/api/reference',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({video:{dataUrl:'data:video/mp4;base64,'+Buffer.from([0,0,0,16,...Buffer.from('ftyp'),0,0,0,0]).toString('base64'),duration:12.011292,width:1280,height:720},direction:'',source,analysis,sourceReview:true})}));
  assert.equal(response.status,200);const result=await response.json(),audited=analysisSchema.parse(result.analysis);assert.equal(calls,1);
  assert.equal(audited.frames[0].subjects.find(subject=>subject.name==='lobby_boy')!.facing,'left');assert.equal(audited.frames[1].subjects.find(subject=>subject.name==='lobby_boy')!.facing,'right');assert.equal(audited.frames[0].subjects.find(subject=>subject.name==='doorman')!.facing,'front');
  assert.deepEqual(audited.shots,original.shots);
  for(const [index,frame] of audited.frames.entries())for(const [subjectIndex,subject] of frame.subjects.entries()){const prior=original.frames[index].subjects[subjectIndex];assert.equal(subject.name,prior.name);assert.deepEqual(subject.box,prior.box);assert.deepEqual(subject.headBox,prior.headBox);assert.equal(subject.bodyFacing,prior.bodyFacing);}
  assert.deepEqual(analysisSchema.parse(JSON.parse(JSON.stringify(audited))),audited);
  const unmeasured=structuredClone(wrong);groundFaceDirections(unmeasured,source.frames.map(frame=>({...frame,faceLandmarks:[]})));assert.equal(unmeasured.frames[0].subjects.find(subject=>subject.name==='lobby_boy')!.facing,'right','Missing measurements cannot fabricate a correction.');
});
