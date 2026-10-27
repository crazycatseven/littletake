import { Matrix4 } from 'three';
import type { Modifier } from './schema.ts';

export function mirrorCopies(modifier: Extract<Modifier,{type:'mirror'}>, reference: Matrix4, world: Matrix4) {
  const axes = [...new Set(modifier.axes)].sort();
  if (axes.length !== modifier.axes.length) throw new Error('Mirror axes must be unique.');
  const inverse = reference.clone().invert();
  return Array.from({length:2 ** axes.length - 1}, (_,i) => {
    const flipped = axes.filter((_,a) => (i+1) & (1<<a));
    const reflection = new Matrix4().makeScale(...(['x','y','z'].map(a => flipped.includes(a as 'x') ? -1 : 1) as [number,number,number]));
    return { key:flipped.join(''), matrix:reference.clone().multiply(reflection).multiply(inverse).multiply(world) };
  });
}
