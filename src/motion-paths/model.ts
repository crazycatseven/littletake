import { CatmullRomCurve3, CubicBezierCurve3, Curve, Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { z } from 'zod';
import type { Transform, Vec3 } from '../types.ts';

const pointSchema = z.tuple([z.number().min(-990).max(990), z.number().min(-990).max(990), z.number().min(-990).max(990)]);
const handleSchema=z.strictObject({mode:z.enum(['auto','aligned','free']),in:z.tuple([z.number().min(-1980).max(1980),z.number().min(-1980).max(1980),z.number().min(-1980).max(1980)]),out:z.tuple([z.number().min(-1980).max(1980),z.number().min(-1980).max(1980),z.number().min(-1980).max(1980)])});
const transformSchema=z.strictObject({position:pointSchema,rotation:z.tuple([z.number().min(-360000).max(360000),z.number().min(-360000).max(360000),z.number().min(-360000).max(360000)]),scale:z.tuple([z.number().min(.01).max(100),z.number().min(.01).max(100),z.number().min(.01).max(100)])});
export const pathSchema = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).refine(id => !['__proto__','constructor','prototype'].includes(id)), name: z.string().trim().min(1).max(120), points: z.array(pointSchema).min(2).max(64), handles:z.array(handleSchema).min(2).max(64).optional(),transform:transformSchema.optional() }).refine(path => path.points.some(p => Math.hypot(...p.map((v,i) => v-path.points[0][i])) > .001), 'A path needs distinct points.').refine(path=>!path.handles||path.handles.length===path.points.length,'Each path point needs two handles.');
export type MotionPath = z.infer<typeof pathSchema>;
export type PathHandle=z.infer<typeof handleSchema>;
export type PathPart='point'|'in'|'out';
export const pathTransform=(path:Pick<MotionPath,'transform'>):Transform=>path.transform??{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]};
export function pathMatrix(path:Pick<MotionPath,'transform'>):Matrix4 {const pose=pathTransform(path);return new Matrix4().compose(new Vector3(...pose.position),new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3,'XYZ')),new Vector3(...pose.scale));}
const automatic=new WeakMap<Vec3[],PathHandle[]>();
/** Exact cubic conversion preserves existing centripetal routes when handles are introduced. */
export function pathHandles(path:Pick<MotionPath,'points'|'handles'>):PathHandle[]{
  let handles=automatic.get(path.points);
  if(!handles){const curve=new CatmullRomCurve3(path.points.map(p=>new Vector3(...p)),false,'centripetal');handles=path.points.map(()=>({mode:'auto',in:[0,0,0],out:[0,0,0]}));
    for(let i=0;i<path.points.length-1;i++){const n=path.points.length-1,a=new Vector3(...path.points[i]),b=new Vector3(...path.points[i+1]),r1=curve.getPoint((i+1/3)/n).multiplyScalar(27).addScaledVector(a,-8).sub(b),r2=curve.getPoint((i+2/3)/n).multiplyScalar(27).sub(a).addScaledVector(b,-8);
      handles[i].out=r1.clone().multiplyScalar(2).sub(r2).divideScalar(18).sub(a).toArray();handles[i+1].in=r2.multiplyScalar(2).sub(r1).divideScalar(18).sub(b).toArray();}
    handles[0].in=handles[0].out.map(v=>-v) as Vec3;handles.at(-1)!.out=handles.at(-1)!.in.map(v=>-v) as Vec3;automatic.set(path.points,handles);
  }
  return handles.map((handle,i)=>path.handles?.[i]?.mode&&path.handles[i].mode!=='auto'?path.handles[i]:handle);
}
class BezierPathCurve extends Curve<Vector3>{
  constructor(readonly segments:CubicBezierCurve3[]){super();this.arcLengthDivisions=Math.max(128,(segments.length+1)*32);}
  override getPoint(t:number,target=new Vector3()):Vector3{const at=MathUtils.clamp(t,0,1)*this.segments.length,index=Math.min(this.segments.length-1,Math.floor(at));return this.segments[index].getPoint(at-index,target);}
}
const curves = new WeakMap<Vec3[],{handles:MotionPath['handles'];transform:MotionPath['transform'];curve:BezierPathCurve}>();
/** Replace edited arrays/transform objects. Viewport, playback and exports use this one curve. */
export function pathCurve(source:MotionPath|Vec3[]):BezierPathCurve {
  const path:Pick<MotionPath,'points'|'handles'|'transform'>=Array.isArray(source)?{points:source}:source,cached=curves.get(path.points);
  if(cached&&cached.handles===path.handles&&cached.transform===path.transform)return cached.curve;
  const handles=pathHandles(path),matrix=pathMatrix(path),segments=path.points.slice(0,-1).map((point,i)=>{const a=new Vector3(...point),b=new Vector3(...path.points[i+1]);return new CubicBezierCurve3(a.clone().applyMatrix4(matrix),a.clone().add(new Vector3(...handles[i].out)).applyMatrix4(matrix),b.clone().add(new Vector3(...handles[i+1].in)).applyMatrix4(matrix),b.applyMatrix4(matrix));});
  const curve=new BezierPathCurve(segments);curves.set(path.points,{handles:path.handles,transform:path.transform,curve});return curve;
}
export function setPathHandle(path:MotionPath,index:number,side:'in'|'out',offset:Vec3):void{
  const handles=structuredClone(pathHandles(path)),handle=handles[index],other=side==='in'?'out':'in';if(handle.mode==='auto')handle.mode='aligned';
  if(handle.mode==='aligned'){const length=Math.hypot(...handle[other]),direction=new Vector3(...offset);if(direction.lengthSq()>1e-12)handle[other]=direction.setLength(-length).toArray();}
  handle[side]=[...offset];path.handles=handles;
}
export function setPathHandleMode(path:MotionPath,index:number,mode:PathHandle['mode']):void{const handles=structuredClone(pathHandles(path));handles[index].mode=mode;path.handles=handles;if(mode==='aligned')setPathHandle(path,index,'out',handles[index].out);}
/** Split the actual cubic, keeping the route unchanged instead of inserting a chord midpoint. */
export function insertPathPoint(path:MotionPath,index:number):number{
  const i=Math.max(0,Math.min(index,path.points.length-2)),handles=structuredClone(pathHandles(path)),a=new Vector3(...path.points[i]),d=new Vector3(...path.points[i+1]),b=a.clone().add(new Vector3(...handles[i].out)),c=d.clone().add(new Vector3(...handles[i+1].in)),ab=a.clone().lerp(b,.5),bc=b.clone().lerp(c,.5),cd=c.clone().lerp(d,.5),abc=ab.clone().lerp(bc,.5),bcd=bc.lerp(cd,.5),mid=abc.clone().lerp(bcd,.5);
  handles[i].mode=handles[i+1].mode='free';handles[i].out=ab.sub(a).toArray();handles[i+1].in=cd.sub(d).toArray();handles.splice(i+1,0,{mode:'aligned',in:abc.sub(mid).toArray(),out:bcd.sub(mid).toArray()});
  path.points=[...path.points.slice(0,i+1),mid.toArray(),...path.points.slice(i+1)];path.handles=handles;return i+1;
}
function segmentDistance(p: Vec3, a: Vector3, b: Vector3): number {
  const dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z,span=dx*dx+dy*dy+dz*dz;
  const t=span?MathUtils.clamp(((p[0]-a.x)*dx+(p[1]-a.y)*dy+(p[2]-a.z)*dz)/span,0,1):0;
  return Math.hypot(p[0]-a.x-t*dx,p[1]-a.y-t*dy,p[2]-a.z-t*dz);
}
/** Fit the smooth curve itself, then remove every redundant knot within the shape tolerance. */
export function fitPath(stroke: Vec3[], tolerance?: number): Vec3[] {
  const source=stroke.filter((p,i)=>i===0||Math.hypot(...p.map((v,a)=>v-stroke[i-1][a]))>.0001);
  if(source.length<3)return source.map(p=>[...p]);
  const min=[0,1,2].map(a=>Math.min(...source.map(p=>p[a]))),max=[0,1,2].map(a=>Math.max(...source.map(p=>p[a])));
  const error=tolerance??Math.max(.015,Math.hypot(...max.map((v,a)=>v-min[a]))*.008);
  // Bound fitting work independently of the pointer's sampling frequency.
  let input=source;
  if(source.length>384){
    const keep=new Set([0,source.length-1]),stack:[number,number][]=[[0,source.length-1]];
    while(stack.length){const [first,last]=stack.pop()!,a=new Vector3(...source[first]),b=new Vector3(...source[last]);let far=-1,distance=error*.2;
      for(let i=first+1;i<last;i++){const d=segmentDistance(source[i],a,b);if(d>distance){far=i;distance=d;}}
      if(far>=0){keep.add(far);stack.push([first,far],[far,last]);}
    }
    input=source.filter((_,i)=>keep.has(i));if(input.length>384)throw new Error('This route has too many small bends. Draw a smoother route.');
  }
  let knots=[0,input.length-1];
  const worst=(indices:number[])=>{
    const curve=new CatmullRomCurve3(indices.map(i=>new Vector3(...input[i])),false,'centripetal'); let distance=0,index=-1;
    for(let s=0;s<indices.length-1;s++){
      const samples=Array.from({length:17},(_,n)=>curve.getPoint((s+n/16)/(indices.length-1)));
      for(let i=indices[s]+1;i<indices[s+1];i++){let best=Infinity;for(let n=1;n<samples.length;n++)best=Math.min(best,segmentDistance(input[i],samples[n-1],samples[n]));if(best>distance){distance=best;index=i;}}
    }
    return {distance,index};
  };
  while(knots.length<64){const next=worst(knots);if(next.distance<=error||next.index<0)break;knots.push(next.index);knots.sort((a,b)=>a-b);}
  if(worst(knots).distance>error*1.001)throw new Error('This route needs more than 64 control points. Draw fewer bends.');
  let pruned=true;while(pruned){pruned=false;for(let i=1;i<knots.length-1;i++){const candidate=knots.filter((_,n)=>n!==i);if(worst(candidate).distance<=error){knots=candidate;pruned=true;break;}}}
  return knots.map(i=>[...input[i]] as Vec3);
}
/** Paths live in world space. Scale comes from the existing transform animation. */
export function pathPose(path: MotionPath, progress: number, base: Transform, facing: boolean, roll: number): Transform {
  const curve=pathCurve(path),at=MathUtils.clamp(progress,0,1),position=curve.getPointAt(at),pose={...base,position:position.toArray() as Vec3};
  if(facing){const forward=curve.getTangentAt(at).normalize(),up=Math.abs(forward.y)>.995?new Vector3(1,0,0):new Vector3(0,1,0),right=new Vector3().crossVectors(up,forward).normalize();
    const rotation=new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right,new Vector3().crossVectors(forward,right).normalize(),forward));
    rotation.multiply(new Quaternion().setFromAxisAngle(new Vector3(0,0,1),MathUtils.degToRad(roll)));
    const e=new Euler().setFromQuaternion(rotation,'XYZ');pose.rotation=[e.x,e.y,e.z].map(MathUtils.radToDeg) as Vec3;
  }
  return pose;
}
