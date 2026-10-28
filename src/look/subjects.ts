import * as THREE from 'three';
import { evaluateFov, evaluateTransform } from '../model';
import type { SceneDocument } from '../types';

export interface LookSubject { name: string; position: 'left' | 'center' | 'right'; depth: 'foreground' | 'midground' | 'background' }

/** Describe where each visible object sits in the shot camera, so the image model can map proxies to subjects. */
export function lookSubjects(doc: SceneDocument, cameraId: string, time: number, aspect = 16 / 9, limit = 40): LookSubject[] {
  const source = doc.cameras.find(item => item.id === cameraId);
  if (!source) return [];
  const pose = evaluateTransform(source, time);
  const camera = new THREE.PerspectiveCamera(evaluateFov(source, time), aspect, .05, 500);
  camera.position.fromArray(pose.position);
  camera.rotation.set(...pose.rotation.map(THREE.MathUtils.degToRad) as [number, number, number], 'XYZ');
  camera.updateMatrixWorld(true);
  const found: (LookSubject & { distance: number })[] = [];
  for (const item of doc.objects) {
    if (item.hidden || !item.name.trim()) continue;
    const world = new THREE.Vector3().fromArray(evaluateTransform(item, time).position);
    const ndc = world.clone().project(camera);
    if (ndc.z < -1 || ndc.z > 1 || Math.abs(ndc.x) > 1.1 || Math.abs(ndc.y) > 1.1) continue;
    const distance = camera.position.distanceTo(world);
    found.push({
      name: item.name.trim().slice(0, 80),
      position: ndc.x < -1 / 3 ? 'left' : ndc.x > 1 / 3 ? 'right' : 'center',
      depth: distance < 3.5 ? 'foreground' : distance < 10 ? 'midground' : 'background',
      distance,
    });
  }
  return found.sort((a, b) => a.distance - b.distance).slice(0, limit).map(({ distance: _, ...subject }) => subject);
}
