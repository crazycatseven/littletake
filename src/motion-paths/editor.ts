import * as T from 'three';
import type { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { pathCurve, pathHandles, pathMatrix, pathSchema, pathTransform, setPathHandle, type MotionPath, type PathPart } from './model';
import type { Transform, Vec3 } from '../types';

export type PathGesture = 'start'|'change'|'end'|'cancel';
type RouteView={line:T.Line;points:MotionPath['points']|null;handles:MotionPath['handles'];transform:MotionPath['transform']};
/** Persistent editor-only buffers; a gesture updates the document once per rendered frame. */
export class PathEditor {
  private group=new T.Group(); private geometry=new T.BufferGeometry(); private line:T.Line;
  private root=new T.Object3D(); private routes=new Map<string,RouteView>();
  private routeMaterial=new T.LineBasicMaterial({color:'#938c77',transparent:true,opacity:.7,depthTest:false,toneMapped:false});
  private nodeGeometry=new T.SphereGeometry(1,10,7);
  private materials=[new T.MeshBasicMaterial({color:'#e7d9ac',depthTest:false,toneMapped:false}),new T.MeshBasicMaterial({color:'#ffe8a6',depthTest:false,toneMapped:false}),new T.MeshBasicMaterial({color:'#8acbdc',depthTest:false,toneMapped:false})];
  private nodes:T.Mesh[]=[]; private labels=document.createElement('div');
  private handleGeometry=new T.BufferGeometry().setAttribute('position',new T.BufferAttribute(new Float32Array(12),3).setUsage(T.DynamicDrawUsage));
  private handleLine=new T.LineSegments(this.handleGeometry,new T.LineBasicMaterial({color:'#8acbdc',depthTest:false,toneMapped:false}));
  private handleNodes=[new T.Mesh(this.nodeGeometry,this.materials[2]),new T.Mesh(this.nodeGeometry,this.materials[2])];
  private path:MotionPath|null=null; private points:Vec3[]|null=null;private handles:MotionPath['handles'];private transform:MotionPath['transform'];
  private index=-1; private part:PathPart='point'; private editable=false;
  private before:Pick<MotionPath,'points'|'handles'|'transform'>|null=null; private pending:Vec3|Transform|null=null; private pointer:number|null=null; private plane=new T.Plane(); private offset=new T.Vector3();
  constructor(private scene:T.Scene,private canvas:HTMLCanvasElement,private gizmo:TransformControls,private orbit:OrbitControls,private camera:()=>T.Camera,private select:(index:number,part:PathPart)=>void,private change:(id:string,index:number,phase:PathGesture)=>void){
    this.geometry.setAttribute('position',new T.BufferAttribute(new Float32Array(769*3),3).setUsage(T.DynamicDrawUsage));
    this.geometry.setAttribute('color',new T.BufferAttribute(new Float32Array(769*3),3).setUsage(T.DynamicDrawUsage));
    this.line=new T.Line(this.geometry,new T.LineBasicMaterial({vertexColors:true,depthTest:false,toneMapped:false}));this.line.layers.set(1);this.line.renderOrder=20;this.line.frustumCulled=false;this.group.add(this.line);this.scene.add(this.group,this.root);
    for(const node of [this.handleLine,...this.handleNodes]){node.layers.set(1);node.renderOrder=22;node.frustumCulled=false;this.group.add(node);}
    Object.assign(this.labels.style,{position:'absolute',inset:'0',pointerEvents:'none',overflow:'hidden',zIndex:'3'});canvas.parentElement!.append(this.labels);
  }
  get active(){return this.editable&&!!this.path;}
  get editing(){return this.index>=0;}
  get point(){return this.index<0?this.root:this.part==='point'?this.nodes[this.index]:this.handleNodes[this.part==='in'?0:1];}
  get gesturing(){return this.before!==null;}
  get bounds(){return this.path?new T.Box3().setFromPoints(pathCurve(this.path).getPoints(128)):null;}
  private fill(geometry:T.BufferGeometry,path:MotionPath){const curve=pathCurve(path),count=Math.min(768,Math.max(128,path.points.length*12)),position=geometry.getAttribute('position'),p=new T.Vector3();
    for(let n=0;n<=count;n++){curve.getPoint(n/count,p);position.setXYZ(n,p.x,p.y,p.z);}position.needsUpdate=true;geometry.setDrawRange(0,count+1);return count;
  }
  setPaths(paths:MotionPath[]){const live=new Set(paths.map(path=>path.id));for(const [id,view] of this.routes)if(!live.has(id)){view.line.removeFromParent();view.line.geometry.dispose();this.routes.delete(id);}
    for(const path of paths){let view=this.routes.get(path.id);if(!view){const geometry=new T.BufferGeometry().setAttribute('position',new T.BufferAttribute(new Float32Array(769*3),3).setUsage(T.DynamicDrawUsage)),line=new T.Line(geometry,this.routeMaterial);line.layers.set(1);line.renderOrder=19;line.frustumCulled=false;this.scene.add(line);view={line,points:null,handles:undefined,transform:undefined};this.routes.set(path.id,view);}
      if(view.points!==path.points||view.handles!==path.handles||view.transform!==path.transform){this.fill(view.line.geometry,path);view.points=path.points;view.handles=path.handles;view.transform=path.transform;}view.line.visible=path.id!==this.path?.id;
    }
  }
  show(path:MotionPath|null,index:number,editable:boolean,part:PathPart='point'){
    if(this.before&&(path!==this.path||!editable||index!==this.index||part!==this.part))this.finish(true);
    this.path=path;this.index=index;this.part=part;this.editable=editable;this.group.visible=!!path;this.labels.hidden=!path||index<0;
    if(!path)return;
    if(this.points!==path.points||this.handles!==path.handles||this.transform!==path.transform){this.points=path.points;this.handles=path.handles;this.transform=path.transform;const count=this.fill(this.geometry,path),position=this.geometry.getAttribute('position'),colors=this.geometry.getAttribute('color'),c=new T.Color();
      for(let n=0;n<=count;n++){c.set(position.getY(n)<0?'#8acbdc':'#e7d9ac');colors.setXYZ(n,c.r,c.g,c.b);}colors.needsUpdate=true;
      while(this.nodes.length>path.points.length)this.nodes.pop()!.removeFromParent();
      while(this.nodes.length<path.points.length){const node=new T.Mesh(this.nodeGeometry,this.materials[0]);node.layers.set(1);node.renderOrder=21;this.nodes.push(node);this.group.add(node);}
      if(this.labels.children.length!==path.points.length){this.labels.replaceChildren(...path.points.map(()=>{const e=document.createElement('span');Object.assign(e.style,{position:'absolute',fontSize:'10px',color:'#efdc9f',textShadow:'0 1px 3px #151515',whiteSpace:'nowrap',transform:'translate(10px,-16px)'});return e;}));}
      const matrix=pathMatrix(path),pose=pathTransform(path);this.nodes.forEach((node,i)=>node.position.fromArray(path.points[i]).applyMatrix4(matrix));
      this.root.position.fromArray(pose.position);this.root.rotation.set(...pose.rotation.map(T.MathUtils.degToRad) as Vec3);this.root.scale.fromArray(pose.scale);this.root.updateMatrixWorld();
    }
    this.nodes.forEach((node,i)=>{node.visible=index>=0;node.material=this.materials[i===index?1:0];});
    this.handleLine.visible=index>=0;
    if(index>=0){const handles=pathHandles(path)[index],matrix=pathMatrix(path),anchor=this.nodes[index].position,positions=this.handleGeometry.getAttribute('position');
      this.handleNodes.forEach((node,i)=>{node.position.fromArray(path.points[index]).add(new T.Vector3(...handles[i===0?'in':'out'])).applyMatrix4(matrix);node.visible=i===0?index>0:index<path.points.length-1;node.material=this.materials[this.part===(i===0?'in':'out')?1:2];positions.setXYZ(i*2,anchor.x,anchor.y,anchor.z);positions.setXYZ(i*2+1,...(node.visible?node.position:anchor).toArray());});positions.needsUpdate=true;
    }else this.handleNodes.forEach(node=>node.visible=false);
  }
  begin(){if(!this.active||this.before)return;this.before={points:this.path!.points,handles:this.path!.handles,transform:this.path!.transform};this.orbit.enabled=false;this.change(this.path!.id,this.index,'start');}
  queue(){if(!this.active||!this.gesturing)return;if(this.index<0){const e=new T.Euler().setFromQuaternion(this.root.quaternion,'XYZ');this.pending={position:this.root.position.toArray(),rotation:[e.x,e.y,e.z].map(T.MathUtils.radToDeg) as Vec3,scale:this.root.scale.toArray()};}else this.pending=this.point.position.toArray();}
  flush(){if(!this.pending||!this.path)return;const value=this.pending;this.pending=null;
    if(!Array.isArray(value)){this.path.transform={position:value.position.map(v=>T.MathUtils.clamp(v,-990,990)) as Vec3,rotation:value.rotation,scale:value.scale.map(v=>T.MathUtils.clamp(v,.01,100)) as Vec3};}
    else{const local=new T.Vector3(...value).applyMatrix4(pathMatrix(this.path).invert());if(this.part==='point')this.path.points=this.path.points.map((p,i)=>i===this.index?local.toArray().map(v=>T.MathUtils.clamp(v,-990,990)) as Vec3:p);else setPathHandle(this.path,this.index,this.part,local.sub(new T.Vector3(...this.path.points[this.index])).toArray().map(v=>T.MathUtils.clamp(v,-1980,1980)) as Vec3);}
    this.change(this.path.id,this.index,'change');
  }
  finish(cancel=false){if(!this.before||!this.path)return;this.flush();cancel=cancel||!pathSchema.safeParse(this.path).success;if(cancel){this.path.points=this.before.points;if(this.before.handles)this.path.handles=this.before.handles;else delete this.path.handles;if(this.before.transform)this.path.transform=this.before.transform;else delete this.path.transform;}
    this.before=null;if(this.pointer!==null&&this.canvas.hasPointerCapture(this.pointer))this.canvas.releasePointerCapture(this.pointer);this.pointer=null;this.orbit.enabled=true;this.change(this.path.id,this.index,cancel?'cancel':'end');}
  private ray(event:PointerEvent){const r=this.canvas.getBoundingClientRect(),camera=this.camera();camera.updateMatrixWorld();const ray=new T.Raycaster();ray.setFromCamera(new T.Vector2((event.clientX-r.left)/r.width*2-1,1-(event.clientY-r.top)/r.height*2),camera);return ray.ray;}
  down(event:PointerEvent){
    if(!this.active||!this.editing||event.button!==0||this.gizmo.axis)return false;
    const r=this.canvas.getBoundingClientRect(),camera=this.camera();let index=-1,part:PathPart='point',best=12;
    const test=(node:T.Mesh,i:number,kind:PathPart)=>{if(!node.visible)return;const p=node.position.clone().project(camera),d=Math.hypot(r.left+(p.x+1)*r.width/2-event.clientX,r.top+(1-p.y)*r.height/2-event.clientY);if(p.z>=-1&&p.z<1&&d<best){best=d;index=i;part=kind;}};
    this.nodes.forEach((node,i)=>test(node,i,'point'));this.handleNodes.forEach((node,i)=>test(node,this.index,i===0?'in':'out'));
    if(index<0)return false;
    event.preventDefault();event.stopImmediatePropagation();this.canvas.focus({preventScroll:true});this.index=index;this.part=part;this.select(index,part);this.begin();this.pointer=event.pointerId;
    this.plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new T.Vector3()),this.point.position);const p=this.ray(event).intersectPlane(this.plane,new T.Vector3());if(p)this.offset.copy(this.point.position).sub(p);this.canvas.setPointerCapture(event.pointerId);return true;
  }
  move(event:PointerEvent){if(this.pointer!==event.pointerId)return false;event.preventDefault();event.stopImmediatePropagation();const p=this.ray(event).intersectPlane(this.plane,new T.Vector3());if(p){p.add(this.offset);this.pending=p.toArray();this.point.position.copy(p);}return true;}
  up(event:PointerEvent){if(this.pointer!==event.pointerId)return false;event.preventDefault();event.stopImmediatePropagation();this.finish();return true;}
  pick(event:PointerEvent):string|null{const rect=this.canvas.getBoundingClientRect(),camera=this.camera(),a=new T.Vector3(),b=new T.Vector3();let id:string|null=null,best=8;
    for(const [key,view] of this.routes){const geometry=key===this.path?.id?this.geometry:view.line.geometry,positions=geometry.getAttribute('position');for(let i=1;i<geometry.drawRange.count;i++){a.fromBufferAttribute(positions,i-1).project(camera);b.fromBufferAttribute(positions,i).project(camera);if(a.z < -1||a.z>1||b.z < -1||b.z>1)continue;
        const ax=rect.left+(a.x+1)*rect.width/2,ay=rect.top+(1-a.y)*rect.height/2,dx=(b.x-a.x)*rect.width/2,dy=(a.y-b.y)*rect.height/2,t=T.MathUtils.clamp(((event.clientX-ax)*dx+(event.clientY-ay)*dy)/(dx*dx+dy*dy||1),0,1),distance=Math.hypot(event.clientX-ax-t*dx,event.clientY-ay-t*dy);if(distance<best){best=distance;id=key;}}
    }return id;
  }
  render(){
    if(!this.path||this.index<0)return;const camera=this.camera(),r=this.canvas.getBoundingClientRect();
    const size=(node:T.Mesh,pixels:number)=>{const scale=camera instanceof T.OrthographicCamera?(camera.top-camera.bottom)/camera.zoom/r.height:2*camera.position.distanceTo(node.position)*Math.tan((camera as T.PerspectiveCamera).fov*Math.PI/360)/r.height;node.scale.setScalar(scale*pixels);};
    this.nodes.forEach((node,i)=>{const p=node.position.clone().project(camera);size(node,i===this.index?7:5);const e=this.labels.children[i] as HTMLElement,label=`P${i+1}`;if(e.textContent!==label)e.textContent=label;e.style.left=`${(p.x+1)*r.width/2}px`;e.style.top=`${(1-p.y)*r.height/2}px`;e.hidden=(i!==this.index&&i!==0&&i!==this.nodes.length-1)||p.z>1||p.z< -1;});this.handleNodes.forEach(node=>size(node,5));
  }
  dispose(){this.finish(true);this.group.removeFromParent();this.root.removeFromParent();this.geometry.dispose();(this.line.material as T.Material).dispose();this.handleGeometry.dispose();(this.handleLine.material as T.Material).dispose();this.nodeGeometry.dispose();this.materials.forEach(m=>m.dispose());for(const view of this.routes.values()){view.line.removeFromParent();view.line.geometry.dispose();}this.routes.clear();this.routeMaterial.dispose();this.labels.remove();}
}
