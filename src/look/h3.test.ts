import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProject } from '../project/storage.ts';
import { applyProjectOperations } from '../scene-edit/operations.ts';
import { h3Prompt, shotFacts } from './h3.ts';

const example = () => parseProject(readFileSync(new URL('../../public/examples/knight-vs-dragon.json', import.meta.url), 'utf8'));
const brief = { prompt: 'Photoreal dark-fantasy film.', beats: [{ at: 1.6, action: 'Fire pours from the dragon\'s mouth.' }, { at: 0, action: 'The dragon lowers its head' }] };

test('a close camera behind the knight is measured as an over-the-shoulder shot of the dragon', () => {
  const project = example(), scene = project.scenes[0], shot = scene.shots[1];
  const moved = applyProjectOperations({ name: project.name, scenes: project.scenes, assets: project.assets }, [{ type: 'set_camera_motion', sceneId: scene.id, id: shot.cameraId,
    frames: [{ time: 4, position: [-.45, 1.8, 5.1], target: [.15, 1.55, .2] }, { time: 8, position: [-.45, 1.8, 5.1], target: [.15, 1.55, .2] }] }], 4);
  const facts = shotFacts(moved.scenes[0], moved.scenes[0].shots[1], moved.assets);
  assert.deepEqual(facts.overShoulder, { near: 'Muse Knight', far: 'Ash Dragon' });
  assert.equal(facts.move, 'The camera holds still.');
  const knight = facts.subjects.find(subject => subject.name === 'Muse')!;
  assert.equal(knight.side, 'right'); assert.equal(knight.depth, 'foreground'); assert.equal(knight.facing, 'back to the camera');
});

test('effects are listed with the times they are visible, and a circling camera is called an orbit', () => {
  const project = example(), scene = project.scenes[0];
  const fire = shotFacts(scene, scene.shots[1], project.assets);
  assert.ok(fire.effects.length >= 1 && fire.effects.every(effect => effect.kind === 'fire'));
  assert.ok(Math.abs(fire.effects[0].from - 1.7) <= .15 && Math.abs(fire.effects[0].to - 3.4) <= .15, JSON.stringify(fire.effects));
  const stand = shotFacts(scene, scene.shots[2], project.assets);
  assert.match(stand.move, /circles .* to its right around the subject/);
});

test('the H3 prompt follows H3\'s own format: three fields, one shot block, no time ranges and no negative prompt', () => {
  const project = example(), scene = project.scenes[0];
  const text = h3Prompt(shotFacts(scene, scene.shots[1], project.assets), brief);
  const lines = text.split('\n');
  assert.match(lines[0], /^integrated_multimodal_description: /);
  assert.match(lines[1], /^\[Shot 1\] /);
  assert.match(lines[2], /^overall_soundscape: /);
  assert.equal(lines[3], 'non_diegetic_music: N/A');
  assert.doesNotMatch(text, /\[\d+(\.\d+)?s?\s*-\s*\d/);
  assert.doesNotMatch(text, /negative|avoid|\bno\b/i);
  // Beats come in time order, and the effect left out of the depth pass is named.
  assert.ok(lines[1].indexOf('At the start, the dragon lowers its head') < lines[1].indexOf('At 1.6 s, fire pours'));
  assert.match(lines[1], /Real fire appears at 1\.7 s/);
});
