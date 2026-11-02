import * as THREE from 'three';
import type { SceneSnapshot, SceneView } from './scene-edit/operations.ts';
import type {ImageBounds} from './types.ts';

export interface SnapshotObject { id: string; name: string; root: THREE.Object3D }
export function clipFrameBox(box:ImageBounds|null,bounds:ImageBounds=[0,0,1,1]):ImageBounds|null{if(!box)return null;const result:ImageBounds=[Math.max(box[0],bounds[0]),Math.max(box[1],bounds[1]),Math.min(box[2],bounds[2]),Math.min(box[3],bounds[3])];return result[2]>result[0]&&result[3]>result[1]?result:null;}

/** Match the measured source matte without changing scene geometry or camera projection. */
export function maskFramePixels(pixels:Uint8Array|Uint8ClampedArray,width:number,height:number,bounds?:ImageBounds,bottomUp=false,owners?:Uint16Array){
  if(!bounds)return;for(let row=0;row<height;row++){const y=(bottomUp?height-row-.5:row+.5)/height;for(let x=0;x<width;x++)if((x+.5)/width<bounds[0]||(x+.5)/width>bounds[2]||y<bounds[1]||y>bounds[3]){const pixel=row*width+x,offset=pixel*4;pixels[offset]=pixels[offset+1]=pixels[offset+2]=0;pixels[offset+3]=255;if(owners)owners[pixel]=0;}}
}

/** Apply the same source matte to live camera previews and exported frames. */
export function renderCameraFrame(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera,bounds?:ImageBounds):void{
  renderer.render(scene,camera);if(!bounds)return;
  const size=renderer.getSize(new THREE.Vector2()),scissor=renderer.getScissor(new THREE.Vector4()),scissorTest=renderer.getScissorTest(),color=renderer.getClearColor(new THREE.Color()),alpha=renderer.getClearAlpha();
  const left=bounds[0]*size.x,right=bounds[2]*size.x,bottom=(1-bounds[3])*size.y,top=(1-bounds[1])*size.y;
  try{renderer.setScissorTest(true);renderer.setClearColor(0,1);for(const [x,y,w,h] of [[0,0,left,size.y],[right,0,size.x-right,size.y],[left,0,right-left,bottom],[left,top,right-left,size.y-top]])if(w>0&&h>0){renderer.setScissor(x,y,w,h);renderer.clear(true,false,false);}}
  finally{renderer.setClearColor(color,alpha);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);}
}

/** Orthographic framing is based on actual transformed meshes, not primitive origins. */
export function topDownCamera(bounds: THREE.Box3, aspect = 1): THREE.OrthographicCamera {
  const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  const halfHeight = Math.max(2, size.z * 0.62, size.x * 0.62 / aspect);
  const height = Math.max(20, size.y + size.length() * 1.5);
  const camera = new THREE.OrthographicCamera(-halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, 0.1, height + size.y + 20);
  camera.position.set(center.x, bounds.max.y + height, center.z);
  camera.up.set(0, 0, -1); camera.lookAt(center); camera.updateMatrixWorld(true);
  return camera;
}

/** Render on demand into a disposable target. The live canvas and camera stay intact. */
export function renderSceneSnapshot(renderer: THREE.WebGLRenderer, scene: THREE.Scene, shotCamera: THREE.PerspectiveCamera, objects: SnapshotObject[], view: SceneView, time: number, cameraId: string | null = 'camera',measureVisible=false,frameBounds?:ImageBounds,imageOptions?:{width:number;height:number;type:'image/webp';quality:number}): SceneSnapshot {
  const width = imageOptions?.width ?? 1024, height = imageOptions?.height ?? (view === 'top_down' ? 1024 : 576);
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  for (const item of objects) bounds.union(new THREE.Box3().setFromObject(item.root));
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 2, 2));
  if (cameraId) bounds.expandByPoint(shotCamera.position);
  const camera = view === 'top_down' ? topDownCamera(bounds) : shotCamera;
  camera.updateMatrixWorld(true);
  const target = new THREE.WebGLRenderTarget(width, height);
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const previousTarget = renderer.getRenderTarget();
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const previousScissor = renderer.getScissor(new THREE.Vector4());
  const scissorTest = renderer.getScissorTest();
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); if (!ctx) { target.dispose(); throw new Error('Image capture is unavailable.'); }
  let visibleBoxes:SceneSnapshot['visibleBoxes'];
  try {
    renderer.setRenderTarget(target); renderer.setScissorTest(false); renderer.clear(); renderer.render(scene, camera);
    const pixels = new Uint8Array(width * height * 4); renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    const image = ctx.createImageData(width, height), row = width * 4;
    for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - y - 1) * row, (height - y) * row), y * row);
    maskFramePixels(image.data,width,height,view==='shot'?frameBounds:undefined);ctx.putImageData(image, 0, 0);
    if(measureVisible)visibleBoxes=visibleObjectBoxes(renderer,scene,camera,objects,pixels,width,height,view==='shot'?frameBounds:undefined);
  } finally {
    renderer.setRenderTarget(previousTarget); renderer.setViewport(previousViewport); renderer.setScissor(previousScissor); renderer.setScissorTest(scissorTest); target.dispose();
  }
  let mapBounds: SceneSnapshot['bounds'] = null;
  if (camera instanceof THREE.OrthographicCamera) {
    const center = bounds.getCenter(new THREE.Vector3());
    mapBounds = { minX: center.x + camera.left, maxX: center.x + camera.right, minZ: center.z - camera.top, maxZ: center.z - camera.bottom };
    const project = (point: THREE.Vector3) => { const p = point.clone().project(camera); return { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 }; };
    const occupied: { x: number; y: number; w: number; h: number }[] = [{ x: 15, y: 15, w: 260, h: 75 }];
    ctx.font = '13px system-ui, sans-serif';
    const label = (text: string, point: THREE.Vector3, fill: string) => {
      const p = project(point), w = Math.min(ctx.measureText(text).width + 18, width - 32), h = 26;
      let x = Math.max(12, Math.min(width - w - 12, p.x + 10)), y = Math.max(12, Math.min(height - h - 42, p.y - 30));
      for (let n = 0; n < 10 && occupied.some(r => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y); n++) y = Math.max(12, Math.min(height - h - 42, y + 29));
      occupied.push({ x, y, w, h });
      ctx.strokeStyle = '#637265'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(x + 6, y + h / 2); ctx.stroke();
      ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fbfcf7f2'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#cbd5c1'; ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = '#29362e'; ctx.fillText(text, x + 9, y + 17, w - 14);
    };
    for (const item of objects) label(`${item.id} · ${item.name}`, new THREE.Box3().setFromObject(item.root).getCenter(new THREE.Vector3()), '#526b42');
    const cameraPoint = project(shotCamera.position), forward = shotCamera.getWorldDirection(new THREE.Vector3());
    forward.y = 0;
    if (cameraId && forward.lengthSq() > 0.0001) {
      forward.normalize(); const targetPoint = project(shotCamera.position.clone().addScaledVector(forward, Math.max(0.5, bounds.getSize(new THREE.Vector3()).length() * 0.12)));
      ctx.strokeStyle = '#617fa6'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cameraPoint.x, cameraPoint.y); ctx.lineTo(targetPoint.x, targetPoint.y); ctx.stroke();
    }
    if (cameraId) label(cameraId + ' · Camera view', shotCamera.position, '#617fa6');
    ctx.fillStyle = '#fbfcf7ee'; ctx.fillRect(16, 16, 235, 68); ctx.fillStyle = '#29362e';
    ctx.font = '600 17px system-ui, sans-serif'; ctx.fillText('TOP VIEW', 29, 43);
    ctx.font = '13px system-ui, sans-serif'; ctx.fillText('X →    −Z ↑    Y = height', 29, 67);
    ctx.fillStyle = '#fbfcf7ee'; ctx.fillRect(16, height - 39, width - 32, 24); ctx.fillStyle = '#52634a';
    ctx.fillText(`Time ${time.toFixed(2)}s · Orthographic · Layout at this frame; lower objects may be occluded`, 27, height - 22);
  }
  const dataUrl = canvas.toDataURL(imageOptions?.type ?? 'image/png', imageOptions?.quality);
  if (dataUrl.length > 1_600_100) throw new Error('The captured image is too large. Simplify the scene and try again.');
  return { view, time, width, height, dataUrl, bounds: mapBounds,...(visibleBoxes?{visibleBoxes}:{}) };
}

/** Depth-tested ID pass: a wall or desk can hide a body even when its projected bound is aligned. */
function visibleObjectBoxes(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera,objects:SnapshotObject[],pixels:Uint8Array,width:number,height:number,frameBounds?:ImageBounds):NonNullable<SceneSnapshot['visibleBoxes']>{
  const originals=new Map<THREE.Mesh,THREE.Material|THREE.Material[]>(),materials=new Map<string,THREE.MeshBasicMaterial>(),background=scene.background,fog=scene.fog,previousTarget=renderer.getRenderTarget(),target=new THREE.WebGLRenderTarget(width,height);target.texture.colorSpace=THREE.LinearSRGBColorSpace;
  const material=(id:number,side:THREE.Side)=>{const key=id+':'+side;if(!materials.has(key))materials.set(key,new THREE.MeshBasicMaterial({color:new THREE.Color().setRGB((id>>16&255)/255,(id>>8&255)/255,(id&255)/255,THREE.LinearSRGBColorSpace),side,toneMapped:false,fog:false}));return materials.get(key)!;};
  try{
    scene.background=new THREE.Color(0);scene.fog=null;renderer.setRenderTarget(target);
    scene.traverse(node=>{if(node instanceof THREE.Mesh){originals.set(node,node.material);node.material=material(0,Array.isArray(node.material)?node.material[0].side:node.material.side);}});
    objects.forEach((object,index)=>object.root.traverse(node=>{if(node instanceof THREE.Mesh){const original=originals.get(node)!;node.material=material(index+1,Array.isArray(original)?original[0].side:original.side);}}));
    renderer.clear();renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,width,height,pixels);maskFramePixels(pixels,width,height,frameBounds,true);
    const bounds=objects.map(()=>({x0:width,y0:height,x1:0,y1:0,pixels:0}));
    for(let pixel=0;pixel<width*height;pixel++){const offset=pixel*4,id=(pixels[offset]<<16)|(pixels[offset+1]<<8)|pixels[offset+2];if(!id||id>bounds.length)continue;const b=bounds[id-1],x=pixel%width,y=height-1-Math.floor(pixel/width);b.x0=Math.min(b.x0,x);b.y0=Math.min(b.y0,y);b.x1=Math.max(b.x1,x+1);b.y1=Math.max(b.y1,y+1);b.pixels++;}
    return Object.fromEntries(objects.map((object,index)=>{const b=bounds[index];return [object.id,b.pixels?{box:[b.x0/width,b.y0/height,b.x1/width,b.y1/height],pixels:b.pixels}:null];}));
  }finally{for(const [mesh,original] of originals)mesh.material=original;scene.background=background;scene.fog=fog;renderer.setRenderTarget(previousTarget);target.dispose();materials.forEach(value=>value.dispose());}
}
