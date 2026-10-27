import { Resvg } from '@resvg/resvg-js';
import { Box3, Color, Mesh, OrthographicCamera, Vector3 } from 'three';
import { createAssetGroup, disposeAssetGroup, poseAssetJoints, type AssetDefinition } from '../../src/assets/model.ts';
import { encodePreviewPng, rasterTriangle } from './raster.ts';

/** Deterministic CPU previews for the expert. Uses the same Three geometry as the interactive stage. */
export function renderAssetPreview(asset: AssetDefinition, jointAngles: Record<string, number> = {}): Uint8Array {
  const root = createAssetGroup(asset);
  try { poseAssetJoints(root, asset, jointAngles); } catch (error) { disposeAssetGroup(root); throw error; }
  const box = new Box3().setFromObject(root, true), center = box.getCenter(new Vector3()), dimensions = box.getSize(new Vector3()).toArray();
  const radius = Math.max(...dimensions) * 0.85, width = 360, height = 360;
  const views: [string, Vector3][] = [['FRONT +Z', new Vector3(0, 0, 1)], ['SIDE +X', new Vector3(1, 0, 0)], ['PERSPECTIVE', new Vector3(1, 0.7, 1.3)]];
  const labels = views.map(([label], panel) => `<g transform="translate(${panel * width},0)"><text x="16" y="22" font-size="14" fill="#4f514c">${label}</text><text x="16" y="409" font-size="12" fill="#4f514c">${dimensions.map(n => n.toFixed(2)).join(' x ')} m</text></g>`).join('');
  const rendered = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="420"><rect width="1080" height="420" fill="#f4f1ea"/>${labels}</svg>`, { fitTo: { mode: 'zoom', value: 2 } }).render();
  const pixels = rendered.pixels, depth = new Float64Array(rendered.width * rendered.height).fill(Infinity);
  views.forEach(([, direction], panel) => {
    const camera = new OrthographicCamera(-radius, radius, radius, -radius, 0.01, radius * 20 + 100);
    camera.position.copy(center).addScaledVector(direction.normalize(), radius * 5 + 10); camera.lookAt(center); camera.updateMatrixWorld(true);
    const light = new Vector3(-0.4, 0.8, 0.6).normalize();
    root.traverse(node => {
      if (!(node instanceof Mesh)) return;
      const position = node.geometry.getAttribute('position'), index = node.geometry.getIndex();
      const count = index?.count ?? position.count;
      for (let i = 0; i < count; i += 3) {
        const world = [0, 1, 2].map(k => new Vector3().fromBufferAttribute(position, index ? index.getX(i + k) : i + k).applyMatrix4(node.matrixWorld));
        const normal = world[1].clone().sub(world[0]).cross(world[2].clone().sub(world[0])).normalize();
        if (node.matrixWorld.determinant() < 0) normal.negate();
        if (normal.dot(camera.position.clone().sub(world[0])) <= 0) continue;
        const projected = world.map(p => p.clone().project(camera));
        const color = new Color(node.userData.baseColor).multiplyScalar(0.55 + Math.max(0, normal.dot(light)) * 0.45);
        const hex = color.getHex();
        rasterTriangle(pixels, depth, rendered.width, rendered.height,
          projected.map(p => ({ x: ((p.x + 1) * width / 2 + panel * width) * 2, y: ((1 - p.y) * height / 2 + 28) * 2, z: p.z })),
          [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]);
      }
    });
  });
  disposeAssetGroup(root);
  return encodePreviewPng(pixels, 1080, 420);
}
