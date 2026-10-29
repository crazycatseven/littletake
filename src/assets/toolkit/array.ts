import { Matrix4 } from 'three';
import type { Modifier, Scalar } from './schema.ts';
import type { Vec3 } from '../../types.ts';

/** Count includes the source. Offset is in the target's local coordinate frame. */
export function arrayCopies(modifier: Extract<Modifier,{type:'array'}>, scalar: (v:Scalar)=>number, world: Matrix4) {
  const count = scalar(modifier.count), offset = modifier.offset.map(scalar) as Vec3;
  if (!Number.isInteger(count) || count < 1 || count > 128) throw new Error('Array count must be an integer from 1 to 128.');
  if (count > 1 && Math.hypot(...offset) < 1e-6) throw new Error('Array copies need a nonzero offset.');
  return Array.from({length:count-1},(_,i) => ({ key:String(i+1), matrix:world.clone().multiply(new Matrix4().makeTranslation(...offset.map(v=>v*(i+1)) as Vec3)) }));
}
