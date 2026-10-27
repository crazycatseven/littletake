import { evaluateTransform } from '../model.ts';
import { componentScripts } from '../components/model.ts';
import { recordedTrack, repositionTrack } from './motion.ts';
import type { MotionTrack, SceneObject, Transform } from '../types.ts';

/** Live input stays outside the project until placement or a take is accepted. */
export class PerformanceSession {
  mode:'control'|'record'|'review'='control';
  readonly keys=new Set<string>();
  pose:Transform;
  private origin:Transform;
  before:SceneObject;
  time:number;
  draft:MotionTrack|null=null;
  private frames:{time:number;transform:Transform}[]=[];
  private runtime:{velocity:number;yaw:number};
  constructor(item:SceneObject,time:number){this.before=structuredClone(item);this.pose=evaluateTransform(item,time);this.origin=structuredClone(this.pose);this.time=time;this.runtime={velocity:0,yaw:this.pose.rotation[1]};}
  placement():SceneObject {
    if(JSON.stringify(this.origin)===JSON.stringify(this.pose))return structuredClone(this.before);
    const item=structuredClone(this.before);
    if(item.track)repositionTrack(item.track,this.origin,this.pose);
    item.transform=structuredClone(item.track?.from??this.pose);
    this.before=structuredClone(item);this.origin=structuredClone(this.pose);return item;
  }
  start(duration:number):void {if(this.time>duration-.1)this.time=0;this.mode='record';this.draft=null;this.runtime.velocity=0;this.keys.clear();this.frames=[{time:this.time,transform:structuredClone(this.pose)}];}
  update(dt:number,duration:number):boolean {
    if(this.mode==='review')return false;
    const component=this.before.components?.[0];
    const step=this.mode==='record'?Math.min(dt,duration-this.time):dt;
    if(component)componentScripts[component.type].update(component,this.pose,this.keys,step,this.runtime);
    if(this.mode==='record'){
      this.time=Math.min(duration,this.time+step);
      if(this.time-this.frames.at(-1)!.time>=1/30)this.frames.push({time:this.time,transform:structuredClone(this.pose)});
      if(this.time>=duration){this.stop();return true;}
    }
    return false;
  }
  stop():void {
    if(this.mode!=='record')return;
    if(this.time-this.frames[0].time<.1){this.time=this.frames[0].time;this.mode='control';this.keys.clear();return;}
    if(this.time>this.frames.at(-1)!.time)this.frames.push({time:this.time,transform:structuredClone(this.pose)});
    this.draft=recordedTrack(this.frames);this.mode='review';this.keys.clear();
  }
  preview(time:number):Transform {return this.mode==='review'&&this.draft?evaluateTransform({...this.before,track:this.draft},time):structuredClone(this.pose);}
  discard():void {this.time=this.frames[0]?.time??this.time;this.pose=structuredClone(this.origin);this.mode='control';this.draft=null;this.runtime.velocity=0;this.keys.clear();}
  keep():SceneObject {if(!this.draft)throw new Error('There is no recorded take.');return {...structuredClone(this.before),transform:structuredClone(this.draft.from),track:structuredClone(this.draft)};}
}
