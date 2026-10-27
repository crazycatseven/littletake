import { z } from 'zod';

export const identifier = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v));
export const vector = (min: number, max: number) => z.tuple([z.number().min(min).max(max), z.number().min(min).max(max), z.number().min(min).max(max)]);
export const scalar = z.union([z.number().finite(), z.string().trim().min(1).max(240)]);
export const expressionVector = z.tuple([scalar, scalar, scalar]);
export const axes = ['x', 'y', 'z'] as const;
export const propertySchema = z.enum(['position.x','position.y','position.z','rotation.x','rotation.y','rotation.z','size.x','size.y','size.z']);
export const partSchema = z.strictObject({
  id: identifier, name: z.string().min(1).max(120), parentId: identifier.nullable(), kind: z.enum(['cube', 'sphere', 'cylinder', 'cone', 'group']),
  position: vector(-1000, 1000), rotation: vector(-360, 360), size: vector(.005, 100), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  joint: z.strictObject({ type: z.enum(['hinge', 'wheel']), pivot: vector(-100,100), axis: z.enum(axes), min: z.number().min(-360).max(360), max: z.number().min(-360).max(360) }).nullable(),
  // Reflection belongs to the coordinate frame, never to primitive dimensions.
  reflection: z.tuple([z.union([z.literal(1),z.literal(-1)]),z.union([z.literal(1),z.literal(-1)]),z.union([z.literal(1),z.literal(-1)])]).optional(),
});
export const parameterSchema = z.strictObject({ id: identifier, name: z.string().min(1).max(80), value: z.number().finite(), min: z.number().finite(), max: z.number().finite() });
export const bindingSchema = z.strictObject({ partId: identifier, property: propertySchema, expression: scalar });
export const anchorSchema = z.strictObject({ id: identifier, name: z.string().min(1).max(80), partId: identifier.nullable(), position: expressionVector });
export const constraintSchema = z.discriminatedUnion('type', [
  z.strictObject({ id: identifier, type: z.literal('attach'), targetId: identifier, anchorId: identifier, offset: expressionVector }),
  z.strictObject({ id: identifier, type: z.literal('span'), targetId: identifier, from: identifier, to: identifier, axis: z.enum(axes) }),
]);
const common = { id: identifier, targetId: identifier, enabled: z.boolean() };
export const modifierSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('mirror'), axes: z.array(z.enum(axes)).min(1).max(3), referenceId: identifier.nullable() }),
  z.strictObject({ ...common, type: z.literal('array'), count: scalar, offset: expressionVector }),
]);
export const constructionSchema = z.strictObject({
  parameters: z.array(parameterSchema).max(64), bindings: z.array(bindingSchema).max(512), anchors: z.array(anchorSchema).max(128),
  constraints: z.array(constraintSchema).max(128), modifiers: z.array(modifierSchema).max(64),
  excluded: z.array(z.string().max(2048)).max(256), offset: vector(-100,100),
});
export type Part = z.infer<typeof partSchema>;
export type Construction = z.infer<typeof constructionSchema>;
export type Modifier = z.infer<typeof modifierSchema>;
export type Scalar = z.infer<typeof scalar>;
export type Property = z.infer<typeof propertySchema>;
export type RecipeGeometry = { parts: Part[]; construction?: Construction };
export const emptyConstruction = (): Construction => ({ parameters:[], bindings:[], anchors:[], constraints:[], modifiers:[], excluded:[], offset:[0,0,0] });
export const MAX_EVALUATED_PARTS = 2048;
