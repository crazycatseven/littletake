import {sceneWorldMatrices,worldTransform,effectivelyHidden} from '../../src/placement/hierarchy.ts';
import {createObjectGroup} from '../../src/spatial/geometry.ts';
import { Resvg } from '@resvg/resvg-js';
import { Box3, Camera, Color, Mesh, Object3D, OrthographicCamera, PerspectiveCamera, Vector3,Vector4,Matrix4,MathUtils,MeshStandardMaterial } from 'three';
import { createAssetGroup, disposeAssetGroup, poseAssetJoints, type AssetDefinition } from '../../src/assets/model.ts';
import { encodePreviewPng, rasterTriangle } from './raster.ts';
import {saveObjectAsset} from '../../src/assets/library.ts';
import {evaluateFov,evaluateJointAngles,evaluateTransform} from '../../src/model.ts';
import type {SceneDocument,ImageBounds} from '../../src/types.ts';
import {maskFramePixels} from '../../src/scene-snapshot.ts';

/** Deterministic CPU previews for the expert. Uses the same Three geometry as the interactive stage. */
export function renderAssetPreview(asset: AssetDefinition, jointAngles: Record<string, number> = {}): Uint8Array {
  const root = createAssetGroup(asset);
  try { poseAssetJoints(root, asset, {...asset.template?.jointAngles,...jointAngles}); } catch (error) { disposeAssetGroup(root); throw error; }
  const box = new Box3().setFromObject(root, true), center = box.getCenter(new Vector3()), dimensions = box.getSize(new Vector3()).toArray();
  const radius = Math.max(...dimensions) * 0.85, width = 360, height = 360;
  const views: [string, Vector3][] = [['FRONT +Z', new Vector3(0, 0, 1)], ['SIDE +X', new Vector3(1, 0, 0)], ['PERSPECTIVE', new Vector3(1, 0.7, 1.3)]];
  const labels = views.map(([label], panel) => `<g transform="translate(${panel * width},0)"><text x="16" y="22" font-size="14" fill="#4f514c">${label}</text><text x="16" y="409" font-size="12" fill="#4f514c">${dimensions.map(n => n.toFixed(2)).join(' x ')} m</text></g>`).join('');
  const rendered = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="420"><rect width="1080" height="420" fill="#f4f1ea"/>${labels}</svg>`, { fitTo: { mode: 'zoom', value: 2 } }).render();
  const pixels = rendered.pixels, depth = new Float64Array(rendered.width * rendered.height).fill(Infinity);
  views.forEach(([, direction], panel) => {
    const camera = new OrthographicCamera(-radius, radius, radius, -radius, 0.01, radius * 20 + 100);
    camera.position.copy(center).addScaledVector(direction.normalize(), radius * 5 + 10); camera.lookAt(center); camera.updateMatrixWorld(true);
    rasterRoot(root,camera,pixels,depth,rendered.width,rendered.height,{x:panel*width*2,y:56,width:width*2,height:height*2});
  });
  disposeAssetGroup(root);
  return encodePreviewPng(pixels, 1080, 420);
}

/** Transient geometry inspection. Final color, lighting and motion are judged in the WebGL review. */
export function renderScenePreview(scene:SceneDocument,assets:AssetDefinition[],frames:{shotId:string;time:number}[],frameBounds?:ImageBounds){
  const width=640,height=360,results=frames.map(frame=>{
    const shot=scene.shots.find(shot=>shot.id===frame.shotId),cameraData=scene.cameras.find(camera=>camera.id===shot?.cameraId);
    if(!shot||!cameraData||frame.time<shot.start||frame.time>shot.start+shot.duration)throw new Error('Preview frames must belong to an existing shot at its scene time.');
    const camera=new PerspectiveCamera(evaluateFov(cameraData,frame.time),width/height,.05,500),pose=worldTransform(scene,cameraData.id,frame.time);camera.position.fromArray(pose.position);camera.rotation.set(...pose.rotation.map(MathUtils.degToRad) as [number,number,number]);camera.updateMatrixWorld(true);
    const background=new Color(scene.look?.background??'#e9e7e2').getHex(),pixels=new Uint8Array(width*height*16),depth=new Float64Array(width*height*4).fill(Infinity),owners=new Uint16Array(width*height*4),objects=scene.objects.filter(object=>!effectivelyHidden(scene,object.id)),poses:unknown[]=[];
    for(let offset=0;offset<pixels.length;offset+=4)pixels.set([background>>16&255,background>>8&255,background&255,255],offset);
    for(const [index,object] of objects.entries()){
      const material=new MeshStandardMaterial({color:object.color}),accent=material.clone();accent.color.multiplyScalar(.72);const root=createObjectGroup(object,assets,material,accent,undefined,frame.time);root.traverse(node=>{if(node instanceof Mesh)node.userData.baseColor=(node.material as MeshStandardMaterial).color.getHex();});
      try{const pose=worldTransform(scene,object.id,frame.time);root.matrix.copy(sceneWorldMatrices(scene,frame.time).get(object.id)!);root.matrixAutoUpdate=false;root.matrix.decompose(root.position,root.quaternion,root.scale);root.updateMatrixWorld(true);rasterRoot(root,camera,pixels,depth,width*2,height*2,{x:0,y:0,width:width*2,height:height*2},{pixels:owners,id:index+1});
        const right=new Vector3(1,0,0).applyQuaternion(camera.quaternion),toward=camera.position.clone().sub(root.position).normalize(),direction=(node:Object3D)=>{const forward=new Vector3(0,0,1).transformDirection(node.matrixWorld);return {world:forward.toArray(),worldYaw:MathUtils.radToDeg(Math.atan2(forward.x,forward.z)),screenRight:forward.dot(right),towardCamera:forward.dot(toward)};};let head:Object3D|undefined,body:Object3D|undefined;root.traverse(node=>{if(node.userData.partId==='head')head=node;if(node.userData.partId==='body')body=node;});poses.push({id:object.id,name:object.name,transform:pose,rootForward:direction(root),...(head?{headForward:direction(head)}:{}),...(body?{bodyForward:direction(body)}:{})});
      }
      finally{disposeAssetGroup(root);material.dispose();accent.dispose();}
    }
    maskFramePixels(pixels,width*2,height*2,frameBounds??cameraData.frameBounds,false,owners);const bounds=objects.map(()=>({x0:width*2,y0:height*2,x1:0,y1:0,pixels:0}));for(let pixel=0;pixel<owners.length;pixel++){const id=owners[pixel];if(!id)continue;const box=bounds[id-1],x=pixel%(width*2),y=Math.floor(pixel/(width*2));box.x0=Math.min(box.x0,x);box.y0=Math.min(box.y0,y);box.x1=Math.max(box.x1,x+1);box.y1=Math.max(box.y1,y+1);box.pixels++;}
    return {...frame,camera:{position:camera.position.toArray(),screenRight:new Vector3(1,0,0).applyQuaternion(camera.quaternion).toArray()},objects:poses,visibleBoxes:Object.fromEntries(objects.map((object,index)=>{const box=bounds[index];return [object.id,box.pixels?{box:[box.x0/(width*2),box.y0/(height*2),box.x1/(width*2),box.y1/(height*2)],pixels:box.pixels/4}:null];})),image:encodePreviewPng(pixels,width,height)};
  });
  const montage=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${frames.length*384}"><rect width="100%" height="100%" fill="#f4f1ea"/>${results.map((frame,index)=>`<text x="8" y="${index*384+17}" font-size="13">FRAME ${index+1} · ${frame.time.toFixed(3)}s · geometry preview</text><image y="${index*384+24}" width="${width}" height="${height}" href="data:image/png;base64,${Buffer.from(frame.image).toString('base64')}"/>`).join('')}</svg>`).render().asPng();
  return {image:montage,frames:results.map(({image,...frame})=>frame)};
}

function rasterRoot(root:Object3D,camera:Camera,pixels:Uint8Array,depth:Float64Array,width:number,height:number,viewport:{x:number;y:number;width:number;height:number},owner?:{pixels:Uint16Array;id:number}){
  const light=new Vector3(-.4,.8,.6).normalize(),projection=new Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
  root.traverse(node=>{if(!(node instanceof Mesh))return;const position=node.geometry.getAttribute('position'),index=node.geometry.getIndex(),count=index?.count??position.count;
    for(let i=0;i<count;i+=3){const world=[0,1,2].map(k=>new Vector3().fromBufferAttribute(position,index?index.getX(i+k):i+k).applyMatrix4(node.matrixWorld)),normal=world[1].clone().sub(world[0]).cross(world[2].clone().sub(world[0])).normalize();if(node.matrixWorld.determinant()<0)normal.negate();if(normal.dot(camera.position.clone().sub(world[0]))<=0)continue;
      let polygon=world.map(point=>new Vector4(point.x,point.y,point.z,1).applyMatrix4(projection));
      // Clip in homogeneous space before dividing by W; near-plane crossings cannot invert a wall.
      for(let axis=0;axis<3&&polygon.length;axis++)for(const sign of [-1,1]){const clipped:Vector4[]=[];for(let point=0;point<polygon.length;point++){const a=polygon[point],b=polygon[(point+1)%polygon.length],da=a.w+sign*a.getComponent(axis),db=b.w+sign*b.getComponent(axis);if(da>=0)clipped.push(a);if((da>=0)!==(db>=0))clipped.push(a.clone().lerp(b,da/(da-db)));}polygon=clipped;}
      if(polygon.length<3)continue;const projected=polygon.map(point=>({x:viewport.x+(point.x/point.w+1)*viewport.width/2,y:viewport.y+(1-point.y/point.w)*viewport.height/2,z:point.z/point.w})),hex=new Color(node.userData.baseColor).multiplyScalar(.55+Math.max(0,normal.dot(light))*.45).getHex();
      for(let point=1;point<projected.length-1;point++)rasterTriangle(pixels,depth,width,height,[projected[0],projected[point],projected[point+1]],[hex>>16&255,hex>>8&255,hex&255],owner);
    }
  });
}
