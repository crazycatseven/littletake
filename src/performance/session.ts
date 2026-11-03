import { animationFor, evaluateTransform, evaluateJointAngles } from '../model.ts';
import { updateComponents, inputController } from '../components/model.ts';
import { performanceChanged, recordedTrack, repositionTrack, transformSchema } from './motion.ts';
import { emptyAnimation, propertyPaths, putKey, transformAnimatedSelection } from '../animation/model.ts';
import { localTransform, matrixTransform, sceneWorldMatrices } from '../placement/hierarchy.ts';
import type { MotionTrack, SceneDocument, SceneEntity, SceneObject, Transform } from '../types.ts';
import { ScriptInstance, idleScriptInput, validateScriptJoints } from '../scripts/runtime';
import type { ScriptDefinition, ScriptParameters } from '../scripts/model';
import { evaluateAsset, type AssetDefinition } from '../assets/model';
import { applyTransformModifiers } from '../components/transform';

export type RecordingClock = 'realtime' | 'motion';

/** Live input stays outside the project until placement or a take is accepted. */
export class PerformanceSession<T extends SceneEntity = SceneEntity> {
  mode:'control'|'record'|'review'='control';
  clock:RecordingClock='realtime';
  advancing=false;
  private takeClock:RecordingClock='realtime';
  readonly keys=new Set<string>();
  pose:Transform;
  private origin:Transform;
  before:T;
  time:number;
  draft:MotionTrack|null=null;
  private frames:{time:number;transform:Transform;joints?:Record<string,number>}[]=[];
  private runtime:{velocity:number;yaw:number};
  private script?:ScriptInstance;
  private params:ScriptParameters={};
  private recordingParams:ScriptParameters={};
  private jointLimits=new Map<string,{min:number;max:number}>();
  joints:Record<string,number>={};
  mouse={dx:0,dy:0,buttons:0};
  private controlTime=0;
  constructor(item:T,time:number,private readonly scene?:SceneDocument,scripts:ScriptDefinition[]=[],assets:AssetDefinition[]=[]){
    this.before=structuredClone(item);this.pose=evaluateTransform(item,time);this.origin=structuredClone(this.pose);this.time=time;this.controlTime=time;this.runtime={velocity:0,yaw:this.worldPose(time).rotation[1]};
    const component=inputController(this.components);
    if(component?.type==='script'&&'kind' in item){
      const definition=scripts.find(s=>s.id===component.scriptId);if(!definition)throw new Error('Missing controller script.');this.params=structuredClone(component.parameters);
      const asset=assets.find(a=>a.id===item.asset?.id);if(asset)for(const part of evaluateAsset(asset).parts)if(part.joint)this.jointLimits.set(part.id,part.joint);
      const angles=evaluateJointAngles(item,time);this.joints=Object.fromEntries([...this.jointLimits].map(([id])=>[id,angles[id]??0]));
      this.script=new ScriptInstance(definition,{dt:0,time,input:idleScriptInput(),pose:this.worldPose(time),params:this.params,joints:this.joints});
    }
  }
  get isCamera(){return 'fov' in this.before;}
  get components(){return 'kind' in this.before?this.before.components:undefined;}
  get scriptRevision(){return this.script?.definition.revision;}
  get recordingClock(){return this.takeClock;}
  get scriptError(){return this.script?.error??'';}
  get recordedFrames(){return structuredClone(this.frames);}
  refreshScripts(scripts:ScriptDefinition[],item:SceneObject){const component=inputController(item.components);if(!this.script||component?.type!=='script'||component.scriptId!==this.script.definition.id)return;const definition=scripts.find(s=>s.id===component.scriptId);if(definition)this.script.queue(definition);this.params=structuredClone(component.parameters);if('kind' in this.before)this.before.components=structuredClone(item.components);}
  dispose(){this.script?.dispose();this.script=undefined;this.keys.clear();}
  previewJoints(time:number){if(this.mode!=='review')return this.joints;const frames=this.frames;let i=0;while(i<frames.length-1&&frames[i+1].time<=time)i++;const a=frames[i],b=frames[Math.min(i+1,frames.length-1)];if(!a?.joints)return undefined;const f=a===b?0:Math.max(0,Math.min(1,(time-a.time)/(b.time-a.time)));return Object.fromEntries(Object.entries(a.joints).map(([id,v])=>[id,v+((b.joints?.[id]??v)-v)*f]));}
  private worldPose(time:number):Transform {return this.scene&&this.before.parentId?matrixTransform(sceneWorldMatrices(this.scene,time,{id:this.before.id,pose:this.pose}).get(this.before.id)!):structuredClone(this.pose);}
  placement():T {
    const item=structuredClone(this.before);
    if(JSON.stringify(this.origin)!==JSON.stringify(this.pose)){
      if('fov' in item&&(item.animation||item.track)){
        const animation=structuredClone(animationFor(item)??emptyAnimation());
        for(const group of ['position','rotation'] as const)for(const [index,path] of propertyPaths(group).entries())putKey(animation,path,this.time,this.pose[group][index],group==='rotation'?this.pose.rotation:undefined);
        item.animation=animation;item.track=null;
      }
      else if(item.animation)transformAnimatedSelection(item.animation,item.transform,this.origin,this.pose);
      else if(item.track){repositionTrack(item.track,this.origin,this.pose);item.transform=structuredClone(item.track.from);}
      else item.transform=structuredClone(this.pose);
    }
    if(this.script&&'kind' in item)for(const [id,angle] of Object.entries(this.joints))if(!item.animation?.curves[`jointAngles.${id}`])item.jointAngles={...item.jointAngles,[id]:angle};
    this.before=structuredClone(item);this.origin=structuredClone(this.pose);return item;
  }
  start(duration:number,start=0):void {if(this.time>duration-.1)this.time=start;if(this.isCamera)this.origin=structuredClone(this.pose);this.takeClock=this.clock;this.advancing=this.takeClock==='realtime';this.mode='record';this.draft=null;this.runtime.velocity=0;this.keys.clear();this.recordingParams=structuredClone(this.params);this.frames=[{time:this.time,transform:structuredClone(this.pose),...(this.script?{joints:structuredClone(this.joints)}:{})}];}
  update(dt:number,duration:number,cameraWorldPose?:Transform):boolean {
    if(this.mode==='review')return false;
    if(this.mode==='record'&&duration-this.time<1e-8){this.time=duration;this.stop();return true;}
    const step=this.mode==='record'?Math.min(dt,duration-this.time):dt;
    const previous=this.isCamera?this.worldPose(this.time):structuredClone(this.pose),previousJoints={...this.joints};
    const at=this.mode==='record'?Math.min(duration,this.time+step):this.time,pose=this.isCamera&&cameraWorldPose?transformSchema.parse(cameraWorldPose):this.worldPose(at);
    if(this.script){this.controlTime+=step;const before=structuredClone(pose),result=this.script.step({dt:Math.min(step,.1),time:this.mode==='record'?at:this.controlTime,input:{keys:{...idleScriptInput().keys,...Object.fromEntries([...this.keys].map(k=>[k===' '?'space':k,true]))},mouse:{...this.mouse}},pose,joints:this.joints,params:this.mode==='record'?this.recordingParams:this.params},this.mode==='record');
      validateScriptJoints(result.joints,this.jointLimits);
      Object.assign(pose,result.pose);applyTransformModifiers(before,pose,this.components);this.joints={...this.joints,...result.joints};this.mouse.dx=this.mouse.dy=0;
    }else if(!this.isCamera)updateComponents(this.components,pose,this.keys,step,this.runtime);
    const next=this.scene&&this.before.parentId?localTransform(this.scene,this.before.id,pose,at):pose;
    if(this.isCamera)next.scale=structuredClone(this.origin.scale);
    this.advancing=this.mode!=='record'||this.takeClock==='realtime'||performanceChanged(previous,this.isCamera?{...pose,scale:previous.scale}:next,previousJoints,this.joints);
    if(!this.advancing){this.joints=previousJoints;return false;}
    this.pose=this.isCamera?transformSchema.parse(next):next;
    if(this.mode==='record'){
      this.time=Math.min(duration,this.time+step);
      if(this.time-this.frames.at(-1)!.time>=1/30-1e-9)this.frames.push({time:this.time,transform:structuredClone(this.pose),...(this.script?{joints:structuredClone(this.joints)}:{})});
      if(this.time>=duration){this.stop();return true;}
    }
    return false;
  }
  stop():void {
    if(this.mode!=='record')return;
    if(this.time-this.frames[0].time<.1){this.time=this.frames[0].time;this.mode='control';this.keys.clear();return;}
    if(this.time>this.frames.at(-1)!.time)this.frames.push({time:this.time,transform:structuredClone(this.pose),...(this.script?{joints:structuredClone(this.joints)}:{})});
    this.draft=recordedTrack(this.frames);this.mode='review';this.keys.clear();
  }
  preview(time:number):Transform {return this.mode==='review'&&this.draft?evaluateTransform({...this.before,animation:undefined,track:this.draft},time):structuredClone(this.pose);}
  discard():void {this.time=this.frames[0]?.time??this.time;this.pose=structuredClone(this.origin);this.mode='control';this.draft=null;this.runtime.velocity=0;this.keys.clear();this.mouse={dx:0,dy:0,buttons:0};if(this.script&&'kind' in this.before){const angles=evaluateJointAngles(this.before,this.time);this.joints=Object.fromEntries([...this.jointLimits].map(([id])=>[id,angles[id]??0]));this.controlTime=this.time;this.script.reset({dt:0,time:this.time,input:idleScriptInput(),pose:this.worldPose(this.time),params:this.params,joints:this.joints});}}
  keep():T {if(!this.draft)throw new Error('There is no recorded take.');return {...structuredClone(this.before),transform:structuredClone(this.draft.from),track:structuredClone(this.draft)};}
}
