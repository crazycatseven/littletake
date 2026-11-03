import { REFERENCE_LIMITS, type ReferenceVideo } from './types';
import type { SourceEvidence,ReferenceAnalysis } from './analysis';
import type {ImageBounds} from '../types';
import { MAX_SOURCE_FRAMES, SCAN_HEIGHT, SCAN_WIDTH, ShotScanner } from './shots';

/** Conservative consensus of constant near-black boundary bands across the preserved original frames. */
export async function measureReferenceFrameBounds(source:SourceEvidence,signal:AbortSignal):Promise<ImageBounds>{
  const width=640,height=360,canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d',{willReadFrequently:true})!;let left=width,right=0,top=height,bottom=0;
  for(const frame of source.frames){signal.throwIfAborted();const image=new Image();image.src=frame.dataUrl;await image.decode();context.drawImage(image,0,0,width,height);const pixels=context.getImageData(0,0,width,height).data,black=(x:number,y:number)=>{const offset=(y*width+x)*4;return Math.max(pixels[offset],pixels[offset+1],pixels[offset+2])<=4;},column=(x:number)=>{let dark=0;for(let y=0;y<height;y++)if(black(x,y))dark++;return dark/height>=.995;},row=(y:number)=>{let dark=0;for(let x=0;x<width;x++)if(black(x,y))dark++;return dark/width>=.995;};
    let x0=0,x1=width,y0=0,y1=height;while(x0<width/4&&column(x0))x0++;while(x1>width*.75&&column(x1-1))x1--;while(y0<height/4&&row(y0))y0++;while(y1>height*.75&&row(y1-1))y1--;left=Math.min(left,x0);right=Math.max(right,x1);top=Math.min(top,y0);bottom=Math.max(bottom,y1);
  }
  return [left>=4?left/width:0,top>=4?top/height:0,width-right>=4?right/width:1,height-bottom>=4?bottom/height:1];
}

/** Read the original clip, not a montage of screenshots. Nothing is uploaded here. */
export async function readReferenceVideo(file: File, signal: AbortSignal): Promise<ReferenceVideo> {
  const mime = file.type || (/\.mp4$/i.test(file.name) ? 'video/mp4' : /\.webm$/i.test(file.name) ? 'video/webm' : '');
  if (!['video/mp4', 'video/webm'].includes(mime)) throw new Error('Choose an MP4 or WebM video.');
  if (!file.size || file.size > REFERENCE_LIMITS.maxVideoBytes) throw new Error('Choose a clip up to 3 MB for this first version.');
  signal.throwIfAborted();
  const video = document.createElement('video'), url = URL.createObjectURL(file);
  video.preload = 'metadata'; video.muted = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); video.onloadedmetadata = null; video.onerror = null; signal.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      const aborted = () => finish(new DOMException('Cancelled', 'AbortError'));
      const timer = setTimeout(() => finish(new Error('The video could not be opened. Try an H.264 MP4 clip.')), 12_000);
      video.onloadedmetadata = () => finish();
      video.onerror = () => finish(new Error('Your browser cannot read this video. Try an H.264 MP4 clip.'));
      signal.addEventListener('abort', aborted, { once: true });
      video.src = url;
    });
    const { duration, videoWidth: width, videoHeight: height } = video;
    if (!Number.isFinite(duration) || duration < REFERENCE_LIMITS.minSeconds || duration > REFERENCE_LIMITS.maxSeconds) throw new Error('Choose a clip between 1 and 60 seconds showing one connected set.');
    if (!width || !height || width > 8192 || height > 8192) throw new Error('The video dimensions could not be read. Try another clip.');
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      const aborted = () => { reader.abort(); reject(new DOMException('Cancelled', 'AbortError')); };
      reader.onload = () => { signal.removeEventListener('abort', aborted); resolve(String(reader.result)); };
      reader.onerror = () => { signal.removeEventListener('abort', aborted); reject(new Error('The video file could not be read.')); };
      reader.onabort = () => signal.removeEventListener('abort', aborted);
      signal.addEventListener('abort', aborted, { once: true });
      reader.readAsDataURL(file.slice(0, file.size, mime));
    });
    signal.throwIfAborted();
    return { dataUrl, duration, width, height };
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}

/** Original-resolution face/torso evidence, separate from the normalized full-frame boxes. */
export async function collectReferenceDetails(video:ReferenceVideo,source:SourceEvidence,analysis:ReferenceAnalysis,signal:AbortSignal):Promise<string>{
  source.frameBounds??=await measureReferenceFrameBounds(source,signal);analysis.frameBounds=source.frameBounds;
  const people=source.frames.flatMap(frame=>(frame.detections??[]).filter(region=>region.kind==='person'&&(region.box[2]-region.box[0])*(region.box[3]-region.box[1])>.02&&region.box[3]-region.box[1]>.25).map(body=>({frame,body}))).slice(0,36);
  if(!people.length)throw new Error('Measure source people before extracting their original-resolution details.');
  const {Input,BlobSource,ALL_FORMATS,CanvasSink}=await import('mediabunny'),input=new Input({source:new BlobSource(await(await fetch(video.dataUrl)).blob()),formats:ALL_FORMATS});
  try{
    const track=await input.getPrimaryVideoTrack();if(!track)throw new Error('Source detail frames could not be decoded.');const sink=new CanvasSink(track,{width:Math.min(1920,video.width)}),sheet=document.createElement('canvas');sheet.width=1152;sheet.height=Math.ceil(people.length/3)*280;const ctx=sheet.getContext('2d')!;ctx.fillStyle='#ede9df';ctx.fillRect(0,0,sheet.width,sheet.height);ctx.font='14px sans-serif';
    let decoded:Awaited<ReturnType<typeof sink.getCanvas>>=null,lastTime=-1;const measuredTimes=new Set<number>();
    for(const [index,{frame,body}] of people.entries()){
      signal.throwIfAborted();if(lastTime!==frame.time){decoded=await sink.getCanvas(frame.time+.001);lastTime=frame.time;}if(!decoded||Math.abs(decoded.timestamp-frame.time)>.002)throw new Error('A detail crop did not match its preserved source frame.');
      if(!measuredTimes.has(frame.time)){frame.faceLandmarks=await(await import('./landmarks.ts')).measureFaceLandmarks(decoded.canvas,signal);measuredTimes.add(frame.time);}
      const subject=analysis.frames.find(point=>Math.abs(point.time-frame.time)<.002)?.subjects.find(subject=>subject.bodyRegionId===body.id),face=(frame.detections??[]).filter(region=>region.kind==='face'&&(subject?.headRegionId?region.id===subject.headRegionId:(region.box[0]+region.box[2])/2>body.box[0]&&(region.box[0]+region.box[2])/2<body.box[2]&&(region.box[1]+region.box[3])/2>body.box[1]&&(region.box[1]+region.box[3])/2<body.box[3])).sort((a,b)=>(b.box[2]-b.box[0])*(b.box[3]-b.box[1])-(a.box[2]-a.box[0])*(a.box[3]-a.box[1]))[0];
      const x=index%3*384,y=Math.floor(index/3)*280;ctx.fillStyle='#27342c';ctx.fillText(`${frame.time.toFixed(3)}s · ${body.id}/${face?.id??'no face'} · ${(subject?.name??'unassigned').slice(0,18)}`,x+6,y+17);
      const crop=(box:number[],left:number,width:number)=>{const b=box.map(value=>Math.max(0,Math.min(1,value))),sw=(b[2]-b[0])*decoded!.canvas.width,sh=(b[3]-b[1])*decoded!.canvas.height,scale=Math.min(width/sw,250/sh);ctx.drawImage(decoded!.canvas,b[0]*decoded!.canvas.width,b[1]*decoded!.canvas.height,sw,sh,left+(width-sw*scale)/2,y+25+(250-sh*scale)/2,sw*scale,sh*scale);};
      crop(body.box,x,128);const b=face?.box,w=b?b[2]-b[0]:0,h=b?b[3]-b[1]:0;crop(b?[b[0]-w*.4,b[1]-h*.8,b[2]+w*.4,b[3]+h*.2]:[body.box[0],body.box[1],body.box[2],body.box[1]+(body.box[3]-body.box[1])*.38],x+128,256);
    }
    const result=sheet.toDataURL('image/jpeg',.7);if(result.length>600_000)throw new Error('The source detail sheet exceeds the request limit.');return result;
  }finally{input.dispose();}
}

/** Scan cheap local pixels once; preserve only representative frames and meaningful changes. */
export async function scanReferenceShots(video: ReferenceVideo, signal: AbortSignal, progress?: (message: string) => void): Promise<ReturnType<ShotScanner['finish']>> {
  const {Input,BlobSource,ALL_FORMATS,CanvasSink}=await import('mediabunny');
  const input=new Input({source:new BlobSource(await (await fetch(video.dataUrl)).blob()),formats:ALL_FORMATS});
  try {
    const track=await input.getPrimaryVideoTrack();if(!track||!await track.canDecode())throw new Error('This browser cannot decode the reference video.');
    const sink=new CanvasSink(track,{width:SCAN_WIDTH,height:SCAN_HEIGHT,fit:'contain'}),canvas=document.createElement('canvas');canvas.width=SCAN_WIDTH;canvas.height=SCAN_HEIGHT;
    const ctx=canvas.getContext('2d',{willReadFrequently:true})!;
    const scanner = new ShotScanner(); let frameCount = 0;
    for await(const frame of sink.canvases()){
      signal.throwIfAborted();ctx.drawImage(frame.canvas,0,0);scanner.push(ctx.getImageData(0,0,SCAN_WIDTH,SCAN_HEIGHT).data,frame.timestamp);
      if (++frameCount > 15000) throw new Error('This clip contains too many frames. Choose a shorter excerpt.');
      if (frameCount % 24 === 0) { progress?.(`Finding shots · ${Math.min(99,Math.round(frame.timestamp/video.duration*100))}%`); await new Promise(resolve=>setTimeout(resolve,0)); }
    }
    return scanner.finish(video.duration);
  } finally {input.dispose();}
}

export async function collectReferenceSource(video: ReferenceVideo, signal: AbortSignal, progress?: (message: string) => void): Promise<SourceEvidence> {
  const {Input,BlobSource,ALL_FORMATS,CanvasSink}=await import('mediabunny');
  const input=new Input({source:new BlobSource(await (await fetch(video.dataUrl)).blob()),formats:ALL_FORMATS});
  try {
    const track=await input.getPrimaryVideoTrack();if(!track||!await track.canDecode())throw new Error('This browser cannot decode the reference video.');
    const selected=await scanReferenceShots(video,signal,progress),{cuts,sampling}=selected;
    progress?.(`${cuts.length+1} shots · preserving ${selected.frames.length} selected frames`);
    const frames:SourceEvidence['frames']=[],full=new CanvasSink(track,{width:640});const sheet=document.createElement('canvas');sheet.width=1440;sheet.height=Math.ceil(selected.frames.length/3)*294;
    const sheetCtx=sheet.getContext('2d')!;sheetCtx.fillStyle='#f5f2eb';sheetCtx.fillRect(0,0,sheet.width,sheet.height);sheetCtx.font='16px sans-serif';
    for(const [i,point] of selected.frames.entries()){
      signal.throwIfAborted();const frame=await full.getCanvas(point.time+.00001);if(!frame||Math.abs(frame.timestamp-point.time)>.0001)throw new Error('A selected frame did not match its original timestamp.');
      const image=document.createElement('canvas');image.width=640;image.height=360;image.getContext('2d')!.drawImage(frame.canvas,0,0,640,360);
      frames.push({...point,dataUrl:image.toDataURL('image/jpeg',.8)});
      const x=i%3*480,y=Math.floor(i/3)*294;sheetCtx.drawImage(image,x,y+24,480,270);sheetCtx.fillStyle='#27342c';sheetCtx.fillText(`SOURCE ${point.shotIndex+1} · ${frame.timestamp.toFixed(3)}s`,x+8,y+18);
    }
    const source={cuts,sampling,frames,contactSheet:sheet.toDataURL('image/jpeg',.75)};return {...source,frameBounds:await measureReferenceFrameBounds(source,signal)};
  } finally {input.dispose();}
}

/** Add missing boundary pixels to older preserved runs without repeating paid source analysis. */
export async function verifyBoundaryFrames(video:ReferenceVideo,source:SourceEvidence,shots:{start:number;duration:number}[],signal:AbortSignal):Promise<SourceEvidence>{
  source.frameBounds??=await measureReferenceFrameBounds(source,signal);
  // New runs already retain change/endpoint evidence where movement needs it.
  if (source.sampling) return source;
  const points=shots.flatMap((shot,shotIndex)=>[shot.start+.005,shot.start+shot.duration-.005].map(time=>({time,shotIndex}))).filter(point=>!source.frames.some(frame=>Math.abs(frame.time-point.time)<.06)).slice(0,MAX_SOURCE_FRAMES-source.frames.length);
  if(!points.length)return source;
  const {Input,BlobSource,ALL_FORMATS,CanvasSink,EncodedPacketSink}=await import('mediabunny'),input=new Input({source:new BlobSource(await(await fetch(video.dataUrl)).blob()),formats:ALL_FORMATS});
  try{const track=await input.getPrimaryVideoTrack();if(!track)throw new Error('Boundary frames could not be decoded.');const firstTimestamp=Math.max(0,await track.getFirstTimestamp()),sink=new CanvasSink(track,{width:640}),frames=[...source.frames],times:number[]=[];
    for await(const packet of new EncodedPacketSink(track).packets(undefined,undefined,{metadataOnly:true}))times.push(packet.timestamp);times.sort((a,b)=>a-b);
    for(const point of points){signal.throwIfAborted();const frame=await sink.getCanvas(Math.max(point.time,firstTimestamp));if(!frame||frames.some(existing=>Math.abs(existing.time-frame.timestamp)<.002))continue;const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;canvas.getContext('2d')!.drawImage(frame.canvas,0,0,640,360);frames.push({...point,frameIndex:times.findIndex(time=>Math.abs(time-frame.timestamp)<1e-6),time:frame.timestamp,dataUrl:canvas.toDataURL('image/jpeg',.8)});}
    return {...source,frames};
  }finally{input.dispose();}
}
