import { Color, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Vec3 } from '../types.ts';
import type { Part } from './toolkit/schema.ts';
export interface HumanProxyPart {id:string;kind:'cube'|'sphere'|'cylinder'|'capsule';position:Vec3;size:Vec3;rotation?:Vec3;accent?:boolean;color?:string}
const skin='#d4ad87',eye='#273038';
/** Geometry shared by scene rendering, camera fitting and Save as Prefab. Y-up, feet at zero, +Z forward. */
export const humanProxyParts:HumanProxyPart[]=[
  {id:'body',kind:'capsule',position:[0,1.12,0],size:[.41,.29,.27]},
  {id:'hips',kind:'sphere',position:[0,.82,0],size:[.39,.28,.29],accent:true},
  {id:'neck',kind:'cylinder',position:[0,1.48,0],size:[.11,.13,.11],color:skin},
  {id:'head',kind:'sphere',position:[0,1.66,0],size:[.24,.28,.24],color:skin},
  {id:'nose',kind:'sphere',position:[0,1.65,.12],size:[.045,.055,.06],color:skin},
  ...[-1,1].flatMap(side=>{const prefix=side<0?'left':'right';return [
    {id:prefix+'-eye',kind:'sphere',position:[side*.045,1.69,.11],size:[.02,.02,.02],color:eye},
    {id:prefix+'-thigh',kind:'capsule',position:[side*.12,.605,0],size:[.14,.17,.15],accent:true},
    {id:prefix+'-knee',kind:'sphere',position:[side*.12,.435,0],size:[.14,.14,.15],accent:true},
    {id:prefix+'-shin',kind:'capsule',position:[side*.12,.265,0],size:[.13,.17,.14],accent:true},
    {id:prefix+'-foot',kind:'cube',position:[side*.12,.055,.045],size:[.155,.11,.28],accent:true},
    {id:prefix+'-upperarm',kind:'capsule',position:[side*.315,1.225,0],size:[.12,.145,.12],rotation:[0,0,side*.1*180/Math.PI]},
    {id:prefix+'-shoulder',kind:'sphere',position:[side*.255,1.37,0],size:[.18,.18,.21]},
    {id:prefix+'-elbow',kind:'sphere',position:[side*.329,1.08,0],size:[.12,.12,.12]},
    {id:prefix+'-forearm',kind:'capsule',position:[side*.329, .945,0],size:[.11,.135,.11],rotation:[0,0,side*.1*180/Math.PI]},
    {id:prefix+'-hand',kind:'sphere',position:[side*.344,.79,0],size:[.13,.15,.13],color:skin},
  ] as HumanProxyPart[];}),
];

/** The neutral mannequin as an ordinary articulated prefab. Geometry has one source above. */
export function humanProxyAssetParts(bodyColor:string):Part[]{
  const parts:Part[]=[],rootParts=new Map<string,Part>();
  const make=(id:string,kind:Part['kind'],position:Vec3,size:Vec3,color:string,rotation:Vec3=[0,0,0],parentId:string|null=null):Part=>({id,name:id,parentId,kind,position:[...position],size:[...size],color,rotation:[...rotation],joint:null});
  for(const spec of humanProxyParts){
    const color=spec.color??'#'+new Color(bodyColor).multiplyScalar(spec.accent ? .72 : 1).getHexString();
    const part=make(spec.id,spec.kind==='capsule'?'group':spec.kind,spec.position,spec.kind==='capsule'?[1,1,1]:spec.size,color,spec.rotation);parts.push(part);rootParts.set(part.id,part);
    if(spec.kind==='capsule'){
      parts.push(make(spec.id+'-body','cylinder',[0,0,0],spec.size,color,[0,0,0],spec.id));
      for(const side of [-1,1])parts.push(make(spec.id+(side<0?'-bottom':'-top'),'sphere',[0,side*spec.size[1]/2,0],spec.size,color,[0,0,0],spec.id));
    }
  }
  const yaw=make('head_yaw','group',[0,1.48,0],[1,1,1],skin);parts.push(yaw);rootParts.set(yaw.id,yaw);
  // Keep the exact rest geometry while changing parent coordinate frames; mesh size never scales children.
  const rest=new Map([...rootParts].map(([id,part])=>[id,new Matrix4().compose(new Vector3(...part.position),new Quaternion().setFromEuler(new Euler(...part.rotation.map(v=>v*Math.PI/180) as Vec3)),new Vector3(1,1,1))]));
  const parent=(id:string,parentId:string)=>{const part=rootParts.get(id)!,position=new Vector3(),rotation=new Quaternion(),scale=new Vector3();new Matrix4().copy(rest.get(parentId)!).invert().multiply(rest.get(id)!).decompose(position,rotation,scale);part.position=position.toArray() as Vec3;const euler=new Euler().setFromQuaternion(rotation,'XYZ');part.rotation=[euler.x,euler.y,euler.z].map(v=>v*180/Math.PI) as Vec3;part.parentId=parentId;};
  const joint=(id:string,axis:'x'|'y'|'z',pivot:Vec3,min:number,max:number)=>{rootParts.get(id)!.joint={type:'hinge',axis,pivot,min,max};};
  joint('body','x',[0,-.28,0],-25,25);joint('head_yaw','y',[0,0,0],-90,90);joint('head','x',[0,-.14,0],-50,45);
  parent('neck','body');parent('head_yaw','body');parent('head','head_yaw');parent('nose','head');parent('left-eye','head');parent('right-eye','head');
  for(const side of ['left','right']){
    parent(side+'-shoulder','body');parent(side+'-upperarm','body');parent(side+'-forearm',side+'-upperarm');parent(side+'-elbow',side+'-forearm');parent(side+'-hand',side+'-forearm');
    parent(side+'-shin',side+'-thigh');parent(side+'-knee',side+'-shin');parent(side+'-foot',side+'-shin');
    joint(side+'-upperarm','x',[0,.145,0],-150,90);joint(side+'-forearm','x',[0,.135,0],-145,0);
    joint(side+'-thigh','x',[0,.17,0],-65,65);joint(side+'-shin','x',[0,.17,0],0,140);
  }
  return upgradeHumanProxyParts(parts);
}
/** Add missing axes to the canonical rig. Zero new angles preserve every existing mesh and pose. */
export function upgradeHumanProxyParts(source:Part[]):Part[]{
  const byId=new Map(source.map(part=>[part.id,part]));
  const axes:Record<string,'x'|'y'>={body:'x',head:'x',head_yaw:'y'};
  for(const side of ['left','right'])for(const limb of ['upperarm','forearm','thigh','shin'])axes[side+'-'+limb]='x';
  const added=['body_yaw',...['left','right'].flatMap(side=>[side+'-shoulder_yaw',side+'-shoulder_side'])];
  if(added.some(id=>byId.has(id))||Object.entries(axes).some(([id,axis])=>byId.get(id)?.joint?.axis!==axis)||source.some(part=>part.reflection))return source;
  if(['left','right'].some(side=>!byId.has(side+'-hand')||byId.get(side+'-upperarm')!.parentId!=='body'||byId.get(side+'-forearm')!.parentId!==side+'-upperarm'||byId.get(side+'-hand')!.parentId!==side+'-forearm'))return source;
  const parts=structuredClone(source),partsById=new Map(parts.map(part=>[part.id,part]));
  const addAxis=(partId:string,id:string,axis:'y'|'z',limit:number)=>{
    const part=partsById.get(partId)!,pivot=new Vector3(...part.joint!.pivot).applyEuler(new Euler(...part.rotation.map(v=>v*Math.PI/180) as Vec3)).add(new Vector3(...part.position));
    const node:Part={id,name:id,parentId:part.parentId,kind:'group',position:pivot.toArray() as Vec3,rotation:[0,0,0],size:[1,1,1],color:part.color,joint:{type:'hinge',axis,pivot:[0,0,0],min:-limit,max:limit}};
    part.position=new Vector3(...part.position).sub(pivot).toArray() as Vec3;part.parentId=id;parts.push(node);partsById.set(id,node);
  };
  addAxis('body','body_yaw','y',70);
  for(const side of ['left','right']){
    addAxis(side+'-upperarm',side+'-shoulder_yaw','y',90);
    // Insert lateral swing at the same shoulder pivot, outside the original flexion axis.
    addAxis(side+'-shoulder_yaw',side+'-shoulder_side','z',120);
    const hand=partsById.get(side+'-hand')!;hand.joint??={type:'hinge',axis:'x',pivot:[0,0,0],min:-90,max:90};
  }
  return parts;
}
const directions:Vec3[]=[];for(const x of [-1,0,1])for(const y of [-1,0,1])for(const z of [-1,0,1])if(x||y||z){const length=Math.hypot(x,y,z);directions.push([x/length,y/length,z/length]);}
const pointsCache=new Map<string,Vec3[]>();
/** Sample actual primitive surfaces rather than projecting the empty corners of a standing bounding box. */
export function humanProxyPoints(bottom=0,headOnly=false):Vec3[]{
  const key=bottom+':'+headOnly,cached=pointsCache.get(key);if(cached)return cached;const points:Vec3[]=[];
  for(const part of humanProxyParts){
    if(headOnly&&part.id!=='head'&&part.id!=='nose'&&!part.id.endsWith('-eye'))continue;
    const halfHeight=(part.kind==='capsule'?1:.5)*part.size[1];if(part.position[1]+halfHeight<bottom)continue;
    let local:Vec3[]=[];
    if(headOnly&&part.id==='head'){
      // The observed face excludes hair/hat and neck. Project that same facial region,
      // rather than shrinking the whole skull to the visible skin patch.
      for(let row=0;row<=8;row++){const y=-.95+row/8*1.55,r=Math.sqrt(1-y*y);for(let column=0;column<=16;column++){const angle=(-110+column/16*220)*Math.PI/180;local.push([Math.sin(angle)*r*.5,y*.5,Math.cos(angle)*r*.5]);}}
    }
    else if(part.kind==='sphere'||part.kind==='capsule')local=directions.flatMap(d=>(part.kind==='capsule'?[-.5,.5]:[0]).map(offset=>[d[0]*.5,d[1]*.5+offset,d[2]*.5] as Vec3));
    else if(part.kind==='cylinder')for(let i=0;i<12;i++)for(const y of [-.5,.5])local.push([Math.cos(i*Math.PI/6)*.5,y,Math.sin(i*Math.PI/6)*.5]);
    else for(const x of [-.5,.5])for(const y of [-.5,.5])for(const z of [-.5,.5])local.push([x,y,z]);
    const euler=new Euler(...(part.rotation??[0,0,0]).map(v=>v*Math.PI/180) as Vec3);
    for(const p of local){const v=new Vector3(p[0]*part.size[0],p[1]*part.size[1],p[2]*part.size[2]).applyEuler(euler).add(new Vector3(...part.position));v.y=Math.max(bottom,v.y);points.push(v.toArray() as Vec3);}
  }
  pointsCache.set(key,points);return points;
}
