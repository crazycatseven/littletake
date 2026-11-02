import { z } from 'zod';

const id = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const key = z.string().min(1).max(48).regex(/^[A-Za-z][A-Za-z0-9_]*$/).refine(s => !['__proto__','constructor','prototype'].includes(s));
export const parameterValueSchema = z.union([z.number().finite(), z.boolean(), z.string().max(160)]);
export const parametersSchema = z.record(key, parameterValueSchema).refine(v => Object.keys(v).length <= 32);
const fieldBase = { key, label: z.string().min(1).max(80) };
export const scriptFieldSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...fieldBase, type: z.literal('number'), default: z.number().finite(), min: z.number().finite(), max: z.number().finite(), step: z.number().positive().max(1000) }),
  z.strictObject({ ...fieldBase, type: z.literal('boolean'), default: z.boolean() }),
  z.strictObject({ ...fieldBase, type: z.literal('choice'), default: z.string().max(160), options: z.array(z.string().min(1).max(160)).min(1).max(16) }),
]);
export const scriptDefinitionSchema = z.strictObject({
  id, name: z.string().trim().min(1).max(80), revision: z.number().int().min(1), apiVersion: z.literal(1),
  stateVersion: z.number().int().min(1), description: z.string().max(600), controls: z.string().max(400),
  fields: z.array(scriptFieldSchema).max(32), source: z.string().min(1).max(48_000),
}).superRefine((script, ctx) => {
  if (new Set(script.fields.map(f => f.key)).size !== script.fields.length) ctx.addIssue({ code:'custom', message:'Parameter keys must be unique.' });
  for (const f of script.fields) if (f.type === 'number' ? f.min > f.max || f.default < f.min || f.default > f.max : f.type === 'choice' && !f.options.includes(f.default)) ctx.addIssue({ code:'custom', message:`Invalid default or range for ${f.key}.` });
});
export const scriptComponentSchema = z.strictObject({ type:z.literal('script'), enabled:z.boolean(), scriptId:id, parameters:parametersSchema });
export type ScriptDefinition = z.infer<typeof scriptDefinitionSchema>;
export type ScriptComponent = z.infer<typeof scriptComponentSchema>;
export type ScriptParameters = z.infer<typeof parametersSchema>;

export function scriptParameters(script: ScriptDefinition, values: ScriptParameters = {}, migrate = false): ScriptParameters {
  const result: ScriptParameters = {};
  if (!migrate && Object.keys(values).some(k => !script.fields.some(f => f.key === k))) throw new Error('Unknown script parameter.');
  for (const field of script.fields) {
    let value = values[field.key] ?? field.default;
    const valid = field.type === 'number' ? typeof value === 'number' && Number.isFinite(value) && value >= field.min && value <= field.max
      : field.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string' && field.options.includes(value);
    if (!valid) { if (!migrate) throw new Error(`Invalid script parameter: ${field.key}`); value = field.default; }
    result[field.key] = value;
  }
  return result;
}

/** A working starter, also used in the scripting contract and the local editor. */
export function starterScript(id: string): ScriptDefinition {
  return { id, name:'Flight Controller', revision:1, apiVersion:1, stateVersion:1, description:'Keyboard and mouse flight with adjustable acceleration.', controls:'W/S accelerate or reverse · A/D turn · Hold left mouse and drag to steer and pitch · Shift boosts',
    fields:[{key:'speed',label:'Move Speed',type:'number',default:4,min:.1,max:30,step:.1},{key:'turnSpeed',label:'Turn Speed',type:'number',default:90,min:1,max:360,step:1},{key:'response',label:'Response',type:'number',default:5,min:.1,max:20,step:.1}],
    source:`function init(ctx) { return { velocity: 0 }; }
function update(ctx) {
  const { input, params, pose, state, dt } = ctx;
  const down = key => input.keys[key] ? 1 : 0;
  pose.rotation[1] += (down('d') - down('a')) * params.turnSpeed * dt + input.mouse.dx * 120;
  pose.rotation[0] = Math.max(-80, Math.min(80, pose.rotation[0] + input.mouse.dy * 120));
  const target = (down('w') - down('s')) * params.speed * (down('shift') ? 1.7 : 1);
  state.velocity += (target - state.velocity) * (1 - Math.exp(-params.response * dt));
  const yaw = pose.rotation[1] * Math.PI / 180, pitch = pose.rotation[0] * Math.PI / 180;
  pose.position[0] += Math.sin(yaw) * Math.cos(pitch) * state.velocity * dt;
  pose.position[1] -= Math.sin(pitch) * state.velocity * dt;
  pose.position[2] += Math.cos(yaw) * Math.cos(pitch) * state.velocity * dt;
}` };
}
