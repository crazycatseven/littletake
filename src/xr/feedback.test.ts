import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { XRObjectOutline, XRPointerFeedback, XRSelectionFeedback, XR_FEEDBACK } from './feedback';

test('XR feedback tracks transformed bounds at every rig scale without modifying source models', () => {
  const geometry = new THREE.BoxGeometry(.5, 1, .3), material = new THREE.MeshStandardMaterial({ color: '#734a32' });
  const object = new THREE.Mesh(geometry, material), parent = new THREE.Group(); parent.add(object);
  const outline = new XRObjectOutline(), selected = new XRSelectionFeedback();
  const original = material.color.clone();
  try {
    for (const scale of [.05, 1, 20]) {
      parent.scale.setScalar(scale); parent.position.set(2, 3, -4); parent.rotation.y = .7;
      outline.update(object, scale, XR_FEEDBACK.held);
      assert.equal(outline.root.visible, true);
      const edges = outline.root.children[0] as THREE.InstancedMesh;
      assert.equal(edges.count, 24); assert.equal(edges.frustumCulled, false);
      const box = new THREE.Box3().setFromObject(object, true).expandByScalar(.011 * scale);
      const matrix = new THREE.Matrix4(), size = new THREE.Vector3(), position = new THREE.Vector3();
      for (let i = 0; i < edges.count; i++) {
        edges.getMatrixAt(i, matrix); position.setFromMatrixPosition(matrix); size.setFromMatrixScale(matrix);
        assert.ok(box.containsPoint(position));
        assert.ok(Math.abs(Math.min(size.x, size.y, size.z) / scale - .004) < 1e-6);
      }
      selected.sync([object], scale); assert.equal(selected.root.children.length, 1);
      parent.visible = false; outline.update(object, scale, XR_FEEDBACK.ready); selected.sync([object], scale);
      assert.equal(outline.root.visible, false); assert.equal(selected.root.children[0].visible, false);
      parent.visible = true;
    }
    let disposed = 0;
    selected.root.traverse(node => { if (node instanceof THREE.Mesh) node.geometry.addEventListener('dispose', () => disposed++); });
    selected.sync([], 1); assert.equal(selected.root.children.length, 0); assert.equal(disposed, 1);
    assert.ok(material.color.equals(original)); assert.equal(material.opacity, 1); assert.equal(material.depthTest, true);
  } finally { outline.dispose(); selected.dispose(); geometry.dispose(); material.dispose(); }
});

test('XR pointer distinguishes hits and active gestures, survives scaling and disposes its resources', () => {
  const controller = new THREE.Group(), pointer = new XRPointerFeedback(controller);
  const beam = pointer.root.children[0] as THREE.Mesh, cursor = pointer.root.children[1] as THREE.Mesh;
  pointer.update(true, 2, false, XR_FEEDBACK.idle);
  assert.equal(cursor.visible, false); const idleWidth = beam.scale.x;
  for (const scale of [.05, 1, 20]) {
    controller.scale.setScalar(scale); pointer.update(true, 2, true, XR_FEEDBACK.held, true);
    controller.updateMatrixWorld(true);
    assert.equal(cursor.visible, true); assert.ok(beam.scale.x > idleWidth);
    assert.ok(Math.abs(cursor.getWorldPosition(new THREE.Vector3()).z / scale + 2) < 1e-6);
    assert.equal((beam.material as THREE.MeshBasicMaterial).color.getHexString(), 'ffbd66');
  }
  pointer.update(false, 2, false, XR_FEEDBACK.idle); assert.equal(pointer.root.visible, false);
  let disposed = 0;
  pointer.root.traverse(node => { if (node instanceof THREE.Mesh) node.geometry.addEventListener('dispose', () => disposed++); });
  pointer.dispose(); assert.equal(controller.children.length, 0); assert.equal(disposed, 3);
});
