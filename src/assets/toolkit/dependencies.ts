import { Matrix4, Quaternion, Vector3 } from 'three';
import { expression } from './expression.ts';
import { axes, type Construction, type Part, type Property, type Scalar } from './schema.ts';
import { localMatrix, setMatrix } from './transforms.ts';
import type { Vec3 } from '../../types.ts';

/** Lazy dependency evaluation catches cycles across fields, parents and anchors. */
export function resolveDependencies(source: Part[], construction: Construction) {
  const parts = structuredClone(source), byId = new Map(parts.map(p => [p.id,p]));
  const parameters = new Map(construction.parameters.map(p => [p.id,p]));
  const bindings = new Map(construction.bindings.map(b => [b.partId + ':' + b.property,b]));
  const constraints = new Map(construction.constraints.map(c => [c.targetId,c]));
  const anchors = new Map(construction.anchors.map(a => [a.id,a]));
  const unique = (n: number, map: Map<unknown,unknown>, label: string) => { if (n !== map.size) throw new Error('Duplicate ' + label); };
  unique(parts.length,byId,'part ID'); unique(construction.parameters.length,parameters,'parameter ID');
  unique(construction.bindings.length,bindings,'binding'); unique(construction.constraints.length,constraints,'constraint target'); unique(construction.anchors.length,anchors,'anchor ID');
  for (const p of parameters.values()) if (p.min > p.max || p.value < p.min || p.value > p.max) throw new Error('Parameter outside its range: ' + p.id);
  for (const b of bindings.values()) if (!byId.has(b.partId)) throw new Error('Binding part not found: ' + b.partId);
  for (const c of constraints.values()) {
    if (!byId.has(c.targetId)) throw new Error('Constraint target not found: ' + c.targetId);
    for (const b of bindings.values()) if (b.partId === c.targetId && (b.property.startsWith('position.') || (c.type === 'span' && (b.property.startsWith('rotation.') || b.property === 'size.' + c.axis)))) throw new Error('A field cannot be driven by both a binding and a constraint: ' + b.partId + ':' + b.property);
  }
  const cache = new Map<string,unknown>(), visiting: string[] = [];
  function memo<T>(key: string, fn: () => T): T {
    if (cache.has(key)) return cache.get(key) as T;
    if (visiting.includes(key)) throw new Error('Construction dependency cycle: ' + [...visiting,key].join(' → '));
    if (visiting.length > 256) throw new Error('Construction dependency depth exceeded.');
    visiting.push(key); try { const value = fn(); cache.set(key,value); return value; } finally { visiting.pop(); }
  }
  function reference(name: string): number {
    const parameter = parameters.get(name); if (parameter) return parameter.value;
    const tokens = name.split('.');
    if (tokens[0] === 'parts' && tokens.length === 4 && ['position','rotation','size'].includes(tokens[2]) && axes.includes(tokens[3] as typeof axes[number])) return field(tokens[1], (tokens[2] + '.' + tokens[3]) as Property);
    if (tokens[0] === 'anchors' && tokens.length === 3 && axes.includes(tokens[2] as typeof axes[number])) return new Vector3().setFromMatrixPosition(anchor(tokens[1]))[tokens[2] as 'x'|'y'|'z'];
    throw new Error('Unknown construction reference: ' + name);
  }
  const scalar = (value: Scalar) => expression(value,reference);
  function field(id: string, property: Property): number {
    return memo('field:' + id + ':' + property, () => {
      const part = byId.get(id); if (!part) throw new Error('Part not found: ' + id);
      const [key,axis] = property.split('.') as ['position'|'rotation'|'size', 'x'|'y'|'z'];
      const constraint = constraints.get(id);
      const driven = constraint && (key === 'position' || (constraint.type === 'span' && (key === 'rotation' || property === 'size.' + constraint.axis)));
      const binding = bindings.get(id + ':' + property);
      const value = driven ? placed(id)[key][axes.indexOf(axis)] : binding ? scalar(binding.expression) : part[key][axes.indexOf(axis)];
      const min = key === 'size' ? .005 : key === 'rotation' ? -360 : -1000, max = key === 'rotation' ? 360 : key === 'size' ? 100 : 1000;
      if (!Number.isFinite(value) || value < min - 1e-8 || value > max + 1e-8) throw new Error(`Resolved ${id}.${property} outside [${min}, ${max}]: ${value}`);
      return value;
    });
  }
  function world(id: string): Matrix4 {
    return memo('world:' + id, () => {
      const part = byId.get(id); if (!part) throw new Error('Part not found: ' + id);
      const resolved = { ...part, position: axes.map(a => field(id,('position.'+a) as Property)) as Vec3, rotation: axes.map(a => field(id,('rotation.'+a) as Property)) as Vec3 };
      return (part.parentId ? world(part.parentId).clone() : new Matrix4()).multiply(localMatrix(resolved));
    });
  }
  function anchor(id: string): Matrix4 {
    return memo('anchor:' + id, () => {
      const a = anchors.get(id); if (!a) throw new Error('Anchor not found: ' + id);
      return (a.partId ? world(a.partId).clone() : new Matrix4()).multiply(new Matrix4().makeTranslation(...a.position.map(scalar) as Vec3));
    });
  }
  function placed(id: string): Part {
    return memo('constraint:' + id, () => {
      const original = byId.get(id)!, result = structuredClone(original), c = constraints.get(id)!;
      const parentInverse = original.parentId ? world(original.parentId).clone().invert() : new Matrix4();
      if (c.type === 'attach') result.position = new Vector3(...c.offset.map(scalar) as Vec3).applyMatrix4(anchor(c.anchorId)).applyMatrix4(parentInverse).toArray() as Vec3;
      else {
        const from = new Vector3().setFromMatrixPosition(anchor(c.from)).applyMatrix4(parentInverse), to = new Vector3().setFromMatrixPosition(anchor(c.to)).applyMatrix4(parentInverse);
        const direction = to.clone().sub(from), length = direction.length(); if (length < .005) throw new Error('Span anchors are coincident: ' + c.id);
        const axis = new Vector3(); axis[c.axis] = 1;
        setMatrix(result,new Matrix4().compose(from.clone().add(to).multiplyScalar(.5), new Quaternion().setFromUnitVectors(axis,direction.normalize()),new Vector3(1,1,1)));
        if (original.reflection?.some(v => v < 0)) throw new Error('Span targets need an unreflected local frame; put reflection on their parent: ' + id);
        result.size[axes.indexOf(c.axis)] = length;
      }
      return result;
    });
  }
  for (const p of parts) for (const key of ['position','rotation','size'] as const) p[key] = axes.map(a => field(p.id,(key+'.'+a) as Property)) as Vec3;
  // Force every parent and declared anchor to resolve, including unused references.
  const worlds = new Map(parts.map(p => [p.id,world(p.id)]));
  const anchorMatrices = new Map([...anchors.keys()].map(id => [id,anchor(id)]));
  return { parts, worlds, anchorMatrices, scalar, parameters: Object.fromEntries([...parameters].map(([id,p]) => [id,p.value])) };
}
