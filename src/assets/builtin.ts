import { createAsset, type AssetRecipe } from './model.ts';

const box = (id: string, position: [number, number, number], size: [number, number, number]): AssetRecipe['parts'][number] => ({
  id, name: id, parentId: null, kind: 'cube', position, size, rotation: [0, 0, 0], color: '#a77950', joint: null,
});
const chair = createAsset({ name: 'Wooden chair', description: 'Simple wooden dining chair with four legs and a solid back. Seat height 0.46 m.', tags: ['prop', 'chair', 'wood', 'seat'], parts: [
  box('seat', [0, 0.43, 0], [0.46, 0.06, 0.46]), box('back', [0, 0.71, -0.2], [0.46, 0.5, 0.06]),
  ...[-1, 1].flatMap(x => [-1, 1].map(z => box(`leg_${x === 1 ? 'r' : 'l'}_${z === 1 ? 'f' : 'b'}`, [x * 0.18, 0.2, z * 0.18], [0.055, 0.4, 0.055]))),
] }, 'builtin-chair', 'builtin');
const table = createAsset({ name: 'Rectangular wooden table', description: 'Plain dining or work table, 1.4 m wide, 0.8 m deep and 0.75 m tall.', tags: ['prop', 'table', 'desk', 'wood'], parts: [
  box('top', [0, 0.715, 0], [1.4, 0.07, 0.8]),
  ...[-1, 1].flatMap(x => [-1, 1].map(z => box(`leg_${x === 1 ? 'r' : 'l'}_${z === 1 ? 'f' : 'b'}`, [x * 0.6, 0.34, z * 0.3], [0.07, 0.68, 0.07]))),
] }, 'builtin-table', 'builtin');
export const builtinAssets = [chair, table].map(asset => ({ ...asset, createdAt: '2026-10-27T00:00:00.000Z' }));
