import { z } from 'zod';
import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import type { Transform } from '../types.ts';
import { applyTransformModifiers } from './transform.ts';

export const componentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('movement'), enabled: z.boolean(), mode: z.enum(['walk', 'drive', 'free']), space: z.enum(['local', 'world']), speed: z.number().min(.1).max(20), turnSpeed: z.number().min(1).max(360) }),
  z.strictObject({ type: z.literal('hinge'), enabled: z.boolean(), speed: z.number().min(1).max(360) }),
  z.strictObject({ type: z.literal('pivot'), enabled: z.boolean(), offset: z.tuple([z.number().min(-1000).max(1000), z.number().min(-1000).max(1000), z.number().min(-1000).max(1000)]) }),
]);
export const componentsSchema = z.array(componentSchema).max(2)
  .refine(items => new Set(items.map(c => c.type)).size === items.length, 'Each component can only be added once.')
  .refine(items => items.filter(c => c.type !== 'pivot').length <= 1, 'Only one keyboard controller can be attached.');
export type ObjectComponent = z.infer<typeof componentSchema>;
export const movement = (mode: 'walk'|'drive'|'free' = 'walk', speed = 1.7): ObjectComponent => ({ type: 'movement', enabled: true, mode, space: 'local', speed, turnSpeed: 90 });
export const pivotOffset = (offset: [number,number,number] = [0,0,0]): ObjectComponent => ({type:'pivot',enabled:true,offset});
export const inputController = (components: ObjectComponent[] = []) => components.find(c => c.type !== 'pivot' && c.enabled);
export interface ComponentField { key: string; label: string; options?: Record<string, string>; vector?: boolean; min?: number; max?: number; step?: number; unit?: string }
export interface ComponentScript {
  title: string; description: string; addable?: boolean; fields: ComponentField[]; actions: { id: string; label: string }[];
  help(component: ObjectComponent): string;
  update?(component: ObjectComponent, pose: Transform, keys: Set<string>, dt: number, runtime: { velocity: number; yaw: number }): void;
}
export const componentScripts: Record<ObjectComponent['type'], ComponentScript> = {
  movement: {
    title: 'Movement Controller', description: 'Walk, drive, or move objects with the keyboard.', actions: [{ id: 'control', label: 'Start Control' }],
    fields: [
      { key: 'mode', label: 'Movement Mode', options: { walk: 'Walk', drive: 'Drive', free: 'Free Move' } },
      { key: 'space', label: 'Movement Space', options: { local: 'Local', world: 'World' } },
      { key: 'speed', label: 'Move Speed', min: .1, max: 20, step: .1, unit: 'm/s' },
      { key: 'turnSpeed', label: 'Turn Speed', min: 1, max: 360, step: 15, unit: '°/s' },
    ],
    help: c => c.type === 'movement' ? `W/S ${c.space === 'local' ? 'move forward/back in the object’s local direction' : 'move along the world Z axis'}. A/D turn left/right. ${c.mode === 'drive' ? 'Space brakes.' : 'Shift moves faster.'}${c.mode === 'free' ? ' F/V move up/down.' : ''}` : '',
    update(c, pose, keys, dt, runtime) {
      if (c.type !== 'movement' || !c.enabled) return;
      const rotation=new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Transform['rotation'],'XYZ'));
      const turn=(Number(keys.has('d'))-Number(keys.has('a')))*c.turnSpeed*dt;
      if(turn){rotation.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),MathUtils.degToRad(turn)));const euler=new Euler().setFromQuaternion(rotation,'XYZ');pose.rotation=[euler.x,euler.y,euler.z].map(MathUtils.radToDeg) as Transform['rotation'];}
      const forward=new Vector3(0,0,1).applyQuaternion(rotation),angle=c.space==='world'?0:Math.atan2(forward.x,forward.z);
      let speed = (Number(keys.has('w')) - Number(keys.has('s'))) * c.speed;
      if (c.mode === 'drive') { const brake = keys.has(' '), target = brake ? 0 : speed; runtime.velocity = target + (runtime.velocity - target) * Math.exp(-(brake ? 18 : 5) * dt); speed = runtime.velocity; }
      else if (keys.has('shift')) speed *= 1.7;
      pose.position[0] += Math.sin(angle) * speed * dt; pose.position[2] += Math.cos(angle) * speed * dt;
      if (c.mode === 'free') pose.position[1] = Math.max(0, pose.position[1] + (Number(keys.has('f')) - Number(keys.has('v'))) * c.speed * dt);
      pose.position = pose.position.map(v => MathUtils.clamp(v, -990, 990)) as Transform['position'];
    },
  },
  hinge: {
    title: 'Legacy Rotation Controller', description: 'Retains the controls of an older project.', addable: false, actions: [{ id: 'control', label: 'Start Control' }],
    fields: [{ key: 'speed', label: 'Rotation Speed', min: 1, max: 360, step: 5, unit: '°/s' }],
    help: () => 'W opens, S closes. Rotates the whole object around its Y pivot, up to 120° from the starting angle.',
    update(c, pose, keys, dt, runtime) { if (c.type === 'hinge' && c.enabled) pose.rotation[1] = MathUtils.clamp(pose.rotation[1] + (Number(keys.has('w')) - Number(keys.has('s'))) * c.speed * dt, runtime.yaw, runtime.yaw + 120); },
  },
  pivot: {
    title: 'Pivot Offset', description: 'Choose the local center for rotation and scale without moving the object.', actions: [],
    fields: [{key:'offset',label:'Pivot Offset',vector:true,min:-1000,max:1000,step:.05,unit:'m'}],
    help: () => 'Local XYZ offset. Moving the pivot keeps the object and existing motion in place. Rotation and scale use this center.',
  },
};

/** Input produces a transform, then modifiers resolve the final geometry pose. */
export function updateComponents(components: ObjectComponent[] | undefined, pose: Transform, keys: Set<string>, dt: number, runtime: {velocity:number;yaw:number}): void {
  const before = structuredClone(pose), controller = inputController(components);
  if (!controller) return;
  componentScripts[controller.type].update?.(controller, pose, keys, dt, runtime);
  applyTransformModifiers(before, pose, components);
  pose.position = pose.position.map(value => MathUtils.clamp(value, -990, 990)) as Transform['position'];
}

export function componentAddReason(components: ObjectComponent[], type: ObjectComponent['type']): string {
  if (components.some(c => c.type === type)) return 'Added';
  if (type !== 'pivot' && components.some(c => c.type !== 'pivot')) return 'Remove the current controller first';
  return '';
}
