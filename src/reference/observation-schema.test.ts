import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { observationSchema, qualitySchema } from './analysis.ts';

/** Meta strict structured outputs reject any object whose `required` omits a property. */
function optionalKeys(schema: unknown, path = '#'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
  const own = node.type === 'object' && node.properties ? Object.keys(node.properties).filter(key => !node.required?.includes(key)).map(key => `${path}.${key}`) : [];
  return [...own, ...Object.entries(node).flatMap(([key, value]) => optionalKeys(value, `${path}/${key}`))];
}

test('Muse observation and review schemas require every property', () => {
  assert.deepEqual(optionalKeys(z.toJSONSchema(observationSchema)), []);
  assert.deepEqual(optionalKeys(z.toJSONSchema(z.strictObject({ ...qualitySchema.shape, revisedAnalysis: observationSchema.nullable() }))), []);
});
