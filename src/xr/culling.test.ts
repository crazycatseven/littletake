import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { setXRObjectCulling } from './culling';

test('XR object culling covers nested and hidden meshes, rebuilt assets, and restores desktop settings', () => {
  const root = new THREE.Group(), nested = new THREE.Group();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
  const ordinary = new THREE.Mesh(geometry, material), custom = new THREE.Mesh(geometry, material);
  const hidden = new THREE.InstancedMesh(geometry, material, 2);
  custom.frustumCulled = false; hidden.visible = false;
  root.add(ordinary, nested); nested.add(custom, hidden);
  ordinary.castShadow = true; ordinary.receiveShadow = true;
  try {
    for (let session = 0; session < 2; session++) {
      setXRObjectCulling(root, true); setXRObjectCulling(root, true);
      for (const mesh of [ordinary, custom, hidden]) assert.equal(mesh.frustumCulled, false);
      assert.equal(hidden.visible, false); assert.equal(root.frustumCulled, true);
      assert.equal(material.depthTest, true); assert.equal(material.depthWrite, true);
      assert.equal(material.side, THREE.FrontSide);
      assert.equal(ordinary.castShadow, true); assert.equal(ordinary.receiveShadow, true);

      const replacement = new THREE.Group(), part = new THREE.Mesh(geometry, material);
      replacement.add(part); root.remove(nested); root.add(replacement);
      setXRObjectCulling(replacement, true); assert.equal(part.frustumCulled, false);
      setXRObjectCulling(root, false); setXRObjectCulling(root, false);
      assert.equal(ordinary.frustumCulled, true); assert.equal(part.frustumCulled, true);
      setXRObjectCulling(nested, false);
      assert.equal(custom.frustumCulled, false); assert.equal(hidden.frustumCulled, true);
      root.remove(replacement); root.add(nested);
    }
  } finally {
    hidden.dispose(); geometry.dispose(); material.dispose();
  }
});
