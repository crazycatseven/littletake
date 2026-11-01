import type { SceneDocument } from '../types';
import type { VideoReferenceInput,ReferenceCapture } from './types';
import { measureCutContinuity, measureReferenceFraming } from './framing';
import type { AssetDefinition } from '../assets/model';
import { shotAtTime } from '../model';
import { exportVideo } from '../shot-export/export';

export function referenceFramingMatches(measurements:ReturnType<typeof measureReferenceFraming>):boolean{
  return measurements.filter(item=>item.principal).every(item=>item.actual&&item.centerError<=.09&&item.heightError<=.16&&(item.headCenterError===undefined||(item.headCenterError<=.05&&item.headHeightError!<=.08)));
}

/** Pair source and render at identical times; every corrected result is inspected afresh. */
export async function referenceReview(scene: SceneDocument, capture:ReferenceCapture, signal:AbortSignal, source:NonNullable<VideoReferenceInput['source']>, analysis:NonNullable<VideoReferenceInput['analysis']>,bindings:NonNullable<VideoReferenceInput['review']>['bindings']={},assets:AssetDefinition[]=[]):Promise<NonNullable<VideoReferenceInput['review']>>{
  const measurements=measureReferenceFraming(scene,analysis,bindings,assets),points=source.frames.map(frame=>analysis.frames.find(point=>Math.abs(point.time-frame.time)<.002)??{...frame,subjects:[]}).sort((a,b)=>a.time-b.time),canvas=document.createElement('canvas');canvas.width=1280;canvas.height=points.length*388;
  const ctx=canvas.getContext('2d')!;ctx.fillStyle='#f5f2eb';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.font='16px sans-serif';
  const frames:NonNullable<VideoReferenceInput['review']>['frames']=[];
  const layoutPoints=scene.shots.map((shot,index)=>{const group=points.filter(frame=>frame.shotIndex===index);return {shot,time:group[Math.floor(group.length/2)]?.time??shot.start};}),layout=document.createElement('canvas');layout.width=1024;layout.height=Math.ceil(layoutPoints.length/2)*512;const layoutContext=layout.getContext('2d')!;
  for(const [index,point] of layoutPoints.entries()){signal.throwIfAborted();const image=new Image();image.src=capture(scene,point.time,point.shot.id,assets,false,'top_down').dataUrl;await image.decode();layoutContext.drawImage(image,index%2*512,Math.floor(index/2)*512,512,512);}
  const draw=async(dataUrl:string,x:number,y:number)=>{signal.throwIfAborted();const image=new Image();image.src=dataUrl;await image.decode();signal.throwIfAborted();ctx.drawImage(image,x,y+24,640,360);};
  for(const [i,frame] of points.entries()){
    const shot=scene.shots[frame.shotIndex],original=source.frames.find(item=>Math.abs(item.time-frame.time)<.002);
    if(!shot||!original)throw new Error('Visual review is missing an original frame.');
    const captured=capture(scene,frame.time,shot.id,assets,true,'shot',analysis.frameBounds);if(!captured.visibleBoxes)throw new Error('Visual review needs depth-tested visible object bounds.');
    for(const measured of measurements.filter(item=>item.time===frame.time)){
      const visible=measured.objectIds.flatMap(id=>captured.visibleBoxes![id]?[captured.visibleBoxes![id]!]:[]),box=visible.length?[Math.min(...visible.map(v=>v.box[0])),Math.min(...visible.map(v=>v.box[1])),Math.max(...visible.map(v=>v.box[2])),Math.max(...visible.map(v=>v.box[3]))] as [number,number,number,number]:null;
      Object.assign(measured,{projected:measured.actual,measurement:'rendered-visible',visiblePixels:visible.reduce((total,item)=>total+item.pixels,0)});measured.actual=box;
      measured.centerError=box?Math.hypot((box[0]+box[2]-measured.expected[0]-measured.expected[2])/2,(box[1]+box[3]-measured.expected[1]-measured.expected[3])/2):1;
      measured.heightError=box?Math.abs(box[3]-box[1]-measured.expected[3]+measured.expected[1]):1;
    }
    const y=i*388;await draw(original.dataUrl,0,y);await draw(captured.dataUrl,640,y);
    ctx.fillStyle='#27342c';ctx.fillText('ORIGINAL · '+shot.id+' · '+frame.time.toFixed(3)+'s',8,y+18);ctx.fillText('RENDER · cyan=visible body / projected face',648,y+18);
    const box=(b:number[],offset:number,color:string,label:string)=>{ctx.strokeStyle=color;ctx.lineWidth=2;ctx.strokeRect(offset+b[0]*640,y+24+b[1]*360,(b[2]-b[0])*640,(b[3]-b[1])*360);ctx.fillStyle=color;ctx.font='12px sans-serif';ctx.fillText(label,offset+b[0]*640+3,y+24+Math.max(12,b[1]*360));ctx.font='16px sans-serif';};
    for(const subject of frame.subjects){box(subject.box,0,'#69ff8b',subject.name);box(subject.box,640,'#69ff8b',subject.name);const measured=measurements.find(m=>m.name===subject.name&&m.time===frame.time);if(measured?.actual)box(measured.actual,640,'#55dcff','');if(subject.headBox){box(subject.headBox,0,'#ffe074','face');box(subject.headBox,640,'#ffe074','');if(measured?.actualHead)box(measured.actualHead,640,'#55dcff','');}}
    frames.push({shotId:shot.id,time:frame.time});
  }
  // The same deterministic encoder as shot export, sampled across the entire scene clock.
  // Still pairs cannot reveal frozen limbs, sliding bodies or incorrect motion between samples.
  const motion=document.createElement('canvas');motion.width=800;motion.height=450;
  const motionContext=motion.getContext('2d')!;
  const blob=await exportVideo({canvas:motion,async render(time){
    signal.throwIfAborted();const shot=shotAtTime(scene,time);if(!shot)throw new Error('The timeline has no shot at '+time.toFixed(3)+'s.');
    const image=new Image();image.src=capture(scene,time,shot.id,assets,false,'shot',analysis.frameBounds).dataUrl;await image.decode();signal.throwIfAborted();motionContext.drawImage(image,0,0,800,450);return motion;
  }},{start:0,duration:scene.duration},8,signal,()=>{},Math.min(120_000,2_000_000/scene.duration),'mp4');
  if(blob.size>450_000)throw new Error('The rendered motion proof is too large for visual review.');
  const video=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('The rendered motion proof could not be preserved.'));reader.readAsDataURL(blob);});
  signal.throwIfAborted();
  return {scene,assets,contactSheet:canvas.toDataURL('image/jpeg',.65),layoutSheet:layout.toDataURL('image/jpeg',.65),video,frames,measurements,continuity:measureCutContinuity(scene,analysis,bindings),bindings,sourceRegions:source.frames.map(frame=>({time:frame.time,detections:frame.detections??[],faceLandmarks:frame.faceLandmarks}))};
}
