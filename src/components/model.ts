import { z } from 'zod';
import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import type { Transform } from '../types.ts';

export const componentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('movement'), enabled: z.boolean(), mode: z.enum(['walk', 'drive', 'free']), space: z.enum(['local', 'world']), speed: z.number().min(.1).max(20), turnSpeed: z.number().min(1).max(360) }),
  z.strictObject({ type: z.literal('hinge'), enabled: z.boolean(), speed: z.number().min(1).max(360) }),
]);
export const componentsSchema = z.array(componentSchema).max(1);
export type ObjectComponent = z.infer<typeof componentSchema>;
export const movement = (mode: 'walk'|'drive'|'free' = 'walk', speed = 1.7): ObjectComponent => ({ type: 'movement', enabled: true, mode, space: 'local', speed, turnSpeed: 90 });
export interface ComponentField { key: string; label: string; options?: Record<string, string>; min?: number; max?: number; step?: number; unit?: string }
export interface ComponentScript {
  title: string; fields: ComponentField[]; actions: { id: string; label: string }[];
  help(component: ObjectComponent): string;
  update(component: ObjectComponent, pose: Transform, keys: Set<string>, dt: number, runtime: { velocity: number; yaw: number }): void;
}
export const componentScripts: Record<ObjectComponent['type'], ComponentScript> = {
  movement: {
    title: '移动操控', actions: [{ id: 'control', label: '开始操控' }],
    fields: [
      { key: 'mode', label: '操作方式', options: { walk: '人物行走', drive: '车辆驾驶', free: '自由移动' } },
      { key: 'space', label: '移动坐标系', options: { local: '自身坐标（Local）', world: '世界坐标（World）' } },
      { key: 'speed', label: '移动速度', min: .1, max: 20, step: .1, unit: 'm/s' },
      { key: 'turnSpeed', label: '转向速度', min: 1, max: 360, step: 15, unit: '°/s' },
    ],
    help: c => c.type === 'movement' ? `W/S ${c.space === 'local' ? '沿自身前进、后退' : '沿世界 Z 轴移动'}，A/D 原地左转、右转。${c.mode === 'drive' ? '空格刹车。' : 'Shift 加速。'}${c.mode === 'free' ? 'F/V 升降。' : ''}` : '',
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
    title: '转轴开合', actions: [{ id: 'control', label: '开始操控' }],
    fields: [{ key: 'speed', label: '开合速度', min: 1, max: 360, step: 5, unit: '°/s' }],
    help: () => 'W 打开，S 关闭。绕对象原点的 Y 轴转动。',
    update(c, pose, keys, dt, runtime) { if (c.enabled) pose.rotation[1] = MathUtils.clamp(pose.rotation[1] + (Number(keys.has('w')) - Number(keys.has('s'))) * c.speed * dt, runtime.yaw, runtime.yaw + 120); },
  },
};
