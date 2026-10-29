import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuButtonBinding } from './buttons';

test('menu binding respects profiles, reserved buttons and handedness without confusing thumb-rest with Menu', () => {
  const source = { handedness: 'left', profiles: ['oculus-touch-v3'], gamepad: { mapping: 'xr-standard', buttons: Array.from({ length: 8 }, () => ({ pressed: false })) } } as unknown as XRInputSource;
  assert.deepEqual(menuButtonBinding(source), { index: 7, fallback: false });
  assert.deepEqual(menuButtonBinding({ ...source, profiles: ['meta-quest-touch-plus'] }), { index: 7, fallback: false });
  assert.deepEqual(menuButtonBinding({ ...source, profiles: ['oculus-touch-v2'] }), { index: 3, fallback: true });
  assert.deepEqual(menuButtonBinding({ ...source, gamepad: { ...source.gamepad!, buttons: source.gamepad!.buttons.slice(0, 7) } }), { index: 3, fallback: true });
  assert.deepEqual(menuButtonBinding({ ...source, profiles: ['custom'] }, { menu: { gamepadIndices: { button: 6 } } }), { index: 6, fallback: false });
  assert.deepEqual(menuButtonBinding(source, { menu: { gamepadIndices: { button: 42 } } }), { index: 7, fallback: false });
  assert.equal(menuButtonBinding({ ...source, handedness: 'right' }), undefined);
  assert.equal(menuButtonBinding({ ...source, hand: {} } as XRInputSource), undefined);
});
