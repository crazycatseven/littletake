import { z } from 'zod';
import { Euler, MathUtils, Matrix4, Vector3 } from 'three';
import { evaluateTransform, validateDocument } from '../../src/model.ts';
import { DEFAULT_SCENE_LOOK, sceneLookSchema } from '../../src/scene-edit/look.ts';
import { recordedTrack } from '../../src/performance/motion.ts';
import type { SceneDocument, Transform, Vec3 } from '../../src/types.ts';
import type { ReferenceBindings } from '../../src/reference/types.ts';
import { AIError } from '../ai/provider.ts';

const vector = z.tuple([z.number().min(-100).max(100), z.number().min(-100).max(100), z.number().min(-100).max(100)]);
const transform = z.strictObject({ position: vector, rotation: z.array(z.number().min(-360).max(360)).length(3), scale: z.array(z.number().min(.01).max(30)).length(3) });
const time = z.number().min(0).max(60);
const cameraPose = z.strictObject({ position: vector, target: vector });
const frames = <T extends z.ZodType>(pose: T) => z.array(z.strictObject({ time, pose })).min(2).max(120);
export const proposalSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(2000),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(12),
  look: sceneLookSchema,
  bindings:z.array(z.strictObject({name:z.string().min(1).max(100),objects:z.array(z.string().min(1).max(120)).min(1).max(40)})).max(40),
  objects: z.array(z.strictObject({
    name: z.string().trim().min(1).max(120), kind: z.enum(['cube', 'sphere', 'cylinder', 'cone', 'plane', 'human']),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/), transform,
    motion: frames(transform).nullable(),
  })).min(1).max(100),
  shots: z.array(z.strictObject({
    name: z.string().trim().min(1).max(120), start: time, duration: z.number().min(.1).max(60),
    position: vector, target: vector, fov: z.number().min(15).max(100), motion: frames(cameraPose).nullable(),
  })).min(1).max(100),
});
export const proposalJSONSchema = z.toJSONSchema(proposalSchema, { target: 'draft-7' });

/** Give the reviewer the same absolute-time/target representation used for construction. */
export function proposalFromScene(scene:SceneDocument,bindings:ReferenceBindings={}):unknown{
  const keys=(entity:SceneDocument['objects'][number]|SceneDocument['cameras'][number])=>entity.track?[entity.track.start,...(entity.track.samples??[]).map(sample=>entity.track!.start+sample.at*entity.track!.duration),entity.track.start+entity.track.duration].map(time=>({time,pose:evaluateTransform(entity,time)})):null;
  const view=(pose:Transform)=>{const position=new Vector3(...pose.position),direction=new Vector3(0,0,-1).applyEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3));return {position:pose.position,target:position.addScaledVector(direction,4).toArray()};};
  const pose=(value:Transform,human:boolean)=>{const result=structuredClone(value),euler=new Euler(...value.rotation.map(MathUtils.degToRad) as Vec3),up=new Vector3(0,1,0).applyEuler(euler),forward=new Vector3(0,0,1).applyEuler(euler);if(human&&up.y>1-1e-8)result.rotation=[0,MathUtils.radToDeg(Math.atan2(forward.x,forward.z)),0];return result;};
  return {name:scene.name,summary:'Actual rendered candidate',assumptions:[],look:scene.look??DEFAULT_SCENE_LOOK,bindings:Object.entries(bindings).map(([name,ids])=>({name,objects:ids.map(id=>scene.objects.find(o=>o.id===id)!.name)})),objects:scene.objects.map(object=>({name:object.name,kind:object.kind,color:object.color,transform:pose(object.transform,object.kind==='human'),...(object.asset?{asset:object.asset,jointAngles:object.jointAngles??{}}:{}),motion:keys(object)?.map(key=>({...key,pose:pose(key.pose,object.kind==='human')}))??null})),shots:scene.shots.map(shot=>{const camera=scene.cameras.find(c=>c.id===shot.cameraId)!;return {name:shot.name,start:shot.start,duration:shot.duration,...view(evaluateTransform(camera,shot.start)),fov:camera.fov,motion:keys(camera)?.map(key=>({time:key.time,pose:view(key.pose)}))??null};})};
}

function cameraTransform(position: number[], target: number[]): Transform {
  const eye = new Vector3(...position as Vec3), look = new Vector3(...target as Vec3);
  if (eye.distanceTo(look) < .05) throw new Error('Camera needs a distinct target.');
  const angles = new Euler().setFromRotationMatrix(new Matrix4().lookAt(eye, look, new Vector3(0, 1, 0)), 'XYZ');
  return { position: [...position] as Vec3, rotation: [angles.x, angles.y, angles.z].map(MathUtils.radToDeg) as Vec3, scale: [1, 1, 1] };
}

/** Compile absolute clip keyframes to the editor's shared clock. Cuts never become camera moves. */
export function sceneFromProposal(value: unknown, duration: number): { scene: SceneDocument; summary: string; assumptions: string[]; bindings?:ReferenceBindings } {
  try {
    const proposal = proposalSchema.parse(value);
    const track = (frames: { time: number; transform: Transform }[], start = 0, end = duration) => {
      if (frames.some((frame, i) => frame.time < start - .001 || frame.time > end + .001 || (i > 0 && frame.time <= frames[i - 1].time))) throw new Error('Motion keyframes must be ordered within their scene or shot.');
      return recordedTrack(frames.map(frame => ({ ...frame, time: Math.max(start, Math.min(frame.time, end)) })));
    };
    const objects = proposal.objects.map((item, index) => {
      const motion = item.motion ? track(item.motion.map(frame => ({ time: frame.time, transform: frame.pose as Transform }))) : null;
      return { id: 'object-' + (index + 1), name: item.name, kind: item.kind, color: item.color, transform: motion?.from ?? item.transform as Transform, track: motion };
    });
    const cameras: SceneDocument['cameras'] = [], shots: SceneDocument['shots'] = [];
    let boundary = 0;
    for (const [index, shot] of proposal.shots.entries()) {
      // Only reconcile millisecond rounding; reject missing footage or overlapping cuts.
      if (Math.abs(shot.start - boundary) > .025) throw new Error('Shots must cover the entire clip in order without gaps or overlaps.');
      const start = boundary, requestedEnd = shot.start + shot.duration;
      const end = index === proposal.shots.length - 1 && Math.abs(requestedEnd - duration) <= .025 ? duration : requestedEnd;
      if (end > duration + .001 || end - start < .1) throw new Error('Shot exceeds clip duration.');
      const cameraId = 'camera-' + (index + 1);
      const motion = shot.motion ? track(shot.motion.map(frame => ({ time: frame.time, transform: cameraTransform(frame.pose.position, frame.pose.target) })), start, end) : null;
      cameras.push({ id: cameraId, name: shot.name.slice(0, 105) + ' camera', fov: shot.fov, transform: motion?.from ?? cameraTransform(shot.position, shot.target), track: motion });
      shots.push({ id: 'shot-' + (index + 1), name: shot.name, cameraId, start, duration: end - start });
      boundary = end;
    }
    if (Math.abs(boundary - duration) > .001) throw new Error('Shots must include the end of the clip.');
    const scene = validateDocument({ format: 'LittleTake.scene', version: 3, id: 'scene-1', name: proposal.name, duration, look: proposal.look, objects, cameras, shots });
    const bindings:ReferenceBindings={};
    for(const binding of proposal.bindings??[]){if(bindings[binding.name])throw new Error('Duplicate reference binding.');bindings[binding.name]=binding.objects.map(name=>{const object=objects.find(o=>o.name===name);if(!object)throw new Error('A reference binding names a missing object: '+name);return object.id;});}
    return { scene, summary: proposal.summary, assumptions: proposal.assumptions,...(proposal.bindings?{bindings}:{}) };
  } catch (error) {
    const detail = error instanceof z.ZodError ? error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).slice(0, 3).join('; ') : (error as Error).message;
    throw new AIError('invalid_scene', 'The reference draft could not be loaded: ' + detail + '. Your current project is unchanged.');
  }
}
