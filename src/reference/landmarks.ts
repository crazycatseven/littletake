import * as ort from 'onnxruntime-web/wasm';
import wasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import wasmModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import type {FaceLandmarks} from './analysis.ts';

let session:Promise<ort.InferenceSession>|undefined;
/** YuNet runs lazily on CPU in the browser. No inference server or paid request. */
export async function measureFaceLandmarks(image:HTMLCanvasElement|OffscreenCanvas,signal:AbortSignal):Promise<FaceLandmarks[]>{
  signal.throwIfAborted();
  if(!session){
    ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths={wasm:new URL(wasmURL,location.href).href,mjs:new URL(wasmModuleURL,location.href).href};
    session=ort.InferenceSession.create('/models/yunet/face_detection_yunet_2026may.onnx',{executionProviders:['wasm']}).catch(error=>{session=undefined;throw error;});
  }
  const model=await session;signal.throwIfAborted();
  const scale=Math.min(1,1280/Math.max(image.width,image.height)),width=Math.round(image.width*scale),height=Math.round(image.height*scale),padWidth=Math.ceil(width/32)*32,padHeight=Math.ceil(height/32)*32;
  const canvas=document.createElement('canvas');canvas.width=padWidth;canvas.height=padHeight;const context=canvas.getContext('2d',{willReadFrequently:true})!;
  context.fillStyle='#000';context.fillRect(0,0,padWidth,padHeight);context.drawImage(image,0,0,width,height);
  const pixels=context.getImageData(0,0,padWidth,padHeight).data,plane=padWidth*padHeight,data=new Float32Array(plane*3);
  // The original model expects unnormalized BGR channels, NCHW, black padding at bottom/right.
  for(let i=0;i<plane;i++){data[i]=pixels[i*4+2];data[plane+i]=pixels[i*4+1];data[plane*2+i]=pixels[i*4];}
  const tensor=new ort.Tensor('float32',data,[1,3,padHeight,padWidth]);let output:ort.InferenceSession.ReturnType|undefined;
  try{
    output=await model.run({[model.inputNames[0]]:tensor});signal.throwIfAborted();const candidates:FaceLandmarks[]=[];
    const clamp=(value:number)=>Math.max(0,Math.min(1,value));
    for(const stride of [8,16,32]){
      const columns=padWidth/stride,rows=padHeight/stride,classification=output['cls_'+stride].data as Float32Array,objectness=output['obj_'+stride].data as Float32Array,boxes=output['bbox_'+stride].data as Float32Array,points=output['kps_'+stride].data as Float32Array;
      for(let index=0;index<columns*rows;index++){
        const confidence=Math.sqrt(clamp(classification[index])*clamp(objectness[index]));if(confidence<.7)continue;
        const column=index%columns,row=Math.floor(index/columns),x=(column+boxes[index*4])*stride,y=(row+boxes[index*4+1])*stride,w=Math.exp(boxes[index*4+2])*stride,h=Math.exp(boxes[index*4+3])*stride;
        if(x<0||y<0||x>width||y>height)continue;
        candidates.push({confidence,box:[clamp((x-w/2)/width),clamp((y-h/2)/height),clamp((x+w/2)/width),clamp((y+h/2)/height)],points:Array.from({length:5},(_,point)=>[(points[index*10+point*2]+column)*stride/width,(points[index*10+point*2+1]+row)*stride/height])});
      }
    }
    const kept:FaceLandmarks[]=[];
    for(const face of candidates.sort((a,b)=>b.confidence-a.confidence)){
      if(kept.some(other=>{const a=face.box,b=other.box,intersection=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));return intersection/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection)>.3;}))continue;
      kept.push(face);if(kept.length===32)break;
    }
    return kept;
  }finally{tensor.dispose();for(const value of Object.values(output??{}))value.dispose();}
}
