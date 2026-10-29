import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { distanceToObject, XRNearSelection } from './near-selection';

test('sphere selection uses visible component bounds and stable nearest candidates at every view scale', () => {
  const grip = new THREE.Group(), feedback = new XRNearSelection(); feedback.addHand(grip);
  const geometry = new THREE.BoxGeometry(.1, .1, .1), material = new THREE.MeshBasicMaterial();
  const a = new THREE.Mesh(geometry, material), b = new THREE.Mesh(geometry, material);
  try {
    for (const scale of [.05, 1, 20]) {
      feedback.clear(); grip.scale.setScalar(scale);
      a.scale.setScalar(scale); b.scale.setScalar(scale);
      a.position.set(.24 * scale, 0, 0); b.position.set(.5 * scale, 0, 0);
      assert.deepEqual(feedback.update(0, [a, b], true, scale), { active: true, target: undefined });
      a.position.x = .15 * scale; b.position.x = .16 * scale;
      assert.equal(feedback.update(0, [a, b], true, scale).target, a);
      b.position.x = .148 * scale; assert.equal(feedback.update(0, [a, b], true, scale).target, a);
      b.position.x = .10 * scale; assert.equal(feedback.update(0, [a, b], true, scale).target, b);
      a.visible = false; b.visible = false;
      assert.equal(feedback.update(0, [a, b], true, scale).active, false);
      a.visible = true; b.visible = true;
    }
    feedback.clear(); a.scale.setScalar(1); a.position.x = .29; b.position.x = 5;
    assert.equal(feedback.update(0, [a], true, 1).active, true);
    a.position.x = .33; assert.equal(feedback.update(0, [a], true, 1).active, true);
    a.position.x = .36; assert.equal(feedback.update(0, [a], true, 1).active, false);
    assert.equal(feedback.update(0, [a], true, 1, a).target, a);
    feedback.update(0, [a], false, 1); assert.equal(grip.getObjectByName('Grab range')!.visible, false);
    assert.equal(feedback.root.children[0].visible, false);
    const compound = new THREE.Group(); a.position.x = -1; b.position.x = 1; b.scale.setScalar(1); compound.add(a, b);
    assert.ok(distanceToObject(compound, new THREE.Vector3()) > .9); // Empty space between parts is not grabbable.
    compound.visible = false; assert.equal(distanceToObject(a, new THREE.Vector3()), Infinity);
    assert.equal(material.opacity, 1); // Feedback never mutates the object's material.
  } finally { feedback.dispose(); geometry.dispose(); material.dispose(); }
});
