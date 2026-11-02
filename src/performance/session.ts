import { evaluateTransform, evaluateJointAngles } from '../model.ts';
import { updateComponents, inputController } from '../components/model.ts';
import { recordedTrack, repositionTrack } from './motion.ts';
import { transformAnimatedSelection } from '../animation/model.ts';
import { localTransform, matrixTransform, sceneWorldMatrices } from '../placement/hierarchy.ts';
import type { MotionTrack, SceneDocument, SceneObject, Transform } from '../types.ts';
import { ScriptInstance, idleScriptInput, validateScriptJoints } from '../scripts/runtime';
import type { ScriptDefinition, ScriptParameters } from '../scripts/model';
import { evaluateAsset, type AssetDefinition } from '../assets/model';
import { applyTransformModifiers } from '../components/transform';

/** Live input stays outside the project until placement or a take is accepted. */
export class PerformanceSession {
  mode:'control'|'record'|'review'='control';
  readonly keys=new Set<string>();
  pose:Transform;
  private origin:Transform;
  before:SceneObject;
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
  constructor(item:SceneObject,time:number,private readonly scene?:SceneDocument,scripts:ScriptDefinition[]=[],assets:AssetDefinition[]=[]){
    this.before=structuredClone(item);this.pose=evaluateTransform(item,time);this.origin=structuredClone(this.pose);this.time=time;this.controlTime=time;this.runtime={velocity:0,yaw:this.worldPose(time).rotation[1]};
    const component=inputController(item.components);
    if(component?.type==='script'){
      const definition=scripts.find(s=>s.id===component.scriptId);if(!definition)throw new Error('Missing controller script.');this.params=structuredClone(component.parameters);
      const asset=assets.find(a=>a.id===item.asset?.id);if(asset)for(const part of evaluateAsset(asset).parts)if(part.joint)this.jointLimits.set(part.id,part.joint);
      const angles=evaluateJointAngles(item,time);this.joints=Object.fromEntries([...this.jointLimits].map(([id])=>[id,angles[id]??0]));
      this.script=new ScriptInstance(definition,{dt:0,time,input:idleScriptInput(),pose:this.worldPose(time),params:this.params,joints:this.joints});
    }
  }
  get scriptRevision(){return this.script?.definition.revision;}
  get scriptError(){return this.script?.error??'';}
  get recordedFrames(){return structuredClone(this.frames);}
  refreshScripts(scripts:ScriptDefinition[],item:SceneObject){const component=inputController(item.components);if(!this.script||component?.type!=='script'||component.scriptId!==this.script.definition.id)return;const definition=scripts.find(s=>s.id===component.scriptId);if(definition)this.script.queue(definition);this.params=structuredClone(component.parameters);this.before.components=structuredClone(item.components);}
  dispose(){this.script?.dispose();this.script=undefined;this.keys.clear();}
  previewJoints(time:number){if(this.mode!=='review')return this.joints;const frames=this.frames;let i=0;while(i<frames.length-1&&frames[i+1].time<=time)i++;const a=frames[i],b=frames[Math.min(i+1,frames.length-1)];if(!a?.joints)return undefined;const f=a===b?0:Math.max(0,Math.min(1,(time-a.time)/(b.time-a.time)));return Object.fromEntries(Object.entries(a.joints).map(([id,v])=>[id,v+((b.joints?.[id]??v)-v)*f]));}
  private worldPose(time:number):Transform {return this.scene&&this.before.parentId?matrixTransform(sceneWorldMatrices(this.scene,time,{id:this.before.id,pose:this.pose}).get(this.before.id)!):structuredClone(this.pose);}
  placement():SceneObject {
    const item=structuredClone(this.before);
    if(JSON.stringify(this.origin)!==JSON.stringify(this.pose)){
      if(item.animation)transformAnimatedSelection(item.animation,item.transform,this.origin,this.pose);
      else if(item.track){repositionTrack(item.track,this.origin,this.pose);item.transform=structuredClone(item.track.from);}
      else item.transform=structuredClone(this.pose);
    }
    if(this.script)for(const [id,angle] of Object.entries(this.joints))if(!item.animation?.curves[`jointAngles.${id}`])item.jointAngles={...item.jointAngles,[id]:angle};
    this.before=structuredClone(item);this.origin=structuredClone(this.pose);return item;
  }
  start(duration:number):void {if(this.time>duration-.1)this.time=0;this.mode='record';this.draft=null;this.runtime.velocity=0;this.keys.clear();this.recordingParams=structuredClone(this.params);this.frames=[{time:this.time,transform:structuredClone(this.pose),...(this.script?{joints:structuredClone(this.joints)}:{})}];}
  update(dt:number,duration:number):boolean {
    if(this.mode==='review')return false;
    const step=this.mode==='record'?Math.min(dt,duration-this.time):dt;
    const at=this.mode==='record'?Math.min(duration,this.time+step):this.time,pose=this.worldPose(at);
    if(this.script){this.controlTime+=step;const before=structuredClone(pose),result=this.script.step({dt:Math.min(step,.1),time:this.mode==='record'?at:this.controlTime,input:{keys:{...idleScriptInput().keys,...Object.fromEntries([...this.keys].map(k=>[k===' '?'space':k,true]))},mouse:{...this.mouse}},pose,joints:this.joints,params:this.mode==='record'?this.recordingParams:this.params},this.mode==='record');
      validateScriptJoints(result.joints,this.jointLimits);
      Object.assign(pose,result.pose);applyTransformModifiers(before,pose,this.before.components);this.joints={...this.joints,...result.joints};this.mouse.dx=this.mouse.dy=0;
    }else updateComponents(this.before.components,pose,this.keys,step,this.runtime);
    this.pose=this.scene&&this.before.parentId?localTransform(this.scene,this.before.id,pose,at):pose;
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
  discard():void {this.time=this.frames[0]?.time??this.time;this.pose=structuredClone(this.origin);this.mode='control';this.draft=null;this.runtime.velocity=0;this.keys.clear();this.mouse={dx:0,dy:0,buttons:0};if(this.script){const angles=evaluateJointAngles(this.before,this.time);this.joints=Object.fromEntries([...this.jointLimits].map(([id])=>[id,angles[id]??0]));this.controlTime=this.time;this.script.reset({dt:0,time:this.time,input:idleScriptInput(),pose:this.worldPose(this.time),params:this.params,joints:this.joints});}}
  keep():SceneObject {if(!this.draft)throw new Error('There is no recorded take.');return {...structuredClone(this.before),transform:structuredClone(this.draft.from),track:structuredClone(this.draft)};}
}
