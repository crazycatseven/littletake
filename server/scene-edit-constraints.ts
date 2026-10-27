import type { ProjectContent } from '../src/types.ts';
import type { EditPlan } from '../src/scene-edit/operations.ts';

type CountRequirement = { source: string; comparison: 'at_most' | 'exactly'; count: number };
const numeral = '[0-9零〇一二两三四五六七八九十百]+';
function number(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = '零一二三四五六七八九'; let total = 0, digit = 0;
  for (const ch of text.replaceAll('两', '二').replaceAll('〇', '零')) {
    if (ch === '百' || ch === '十') { total += (digit || 1) * (ch === '百' ? 100 : 10); digit = 0; }
    else digit = digits.indexOf(ch);
  }
  return total + digit;
}

/** Only explicit object totals, never incidental statements such as "currently has 11 objects". */
export function objectCountRequirements(prompt: string): CountRequirement[] {
  const patterns: [RegExp, CountRequirement['comparison']][] = [
    [new RegExp(`(?:最多|至多|不超过|不能超过|不得超过|上限(?:为|是)?)\\s*(${numeral})\\s*(?:个)?\\s*物体`, 'g'), 'at_most'],
    [new RegExp(`(?:恰好|正好|剩下?|保留|总共|一共|仅有|只有)\\s*(${numeral})\\s*(?:个)?\\s*物体`, 'g'), 'exactly'],
    [/\b(?:at most|no more than|up to|a maximum of)\s+(\d+)\s+objects?\b/gi, 'at_most'],
    [/\b(?:exactly|only|leave|keep)\s+(\d+)\s+objects?\b/gi, 'exactly'],
  ];
  return patterns.flatMap(([pattern, comparison]) => [...prompt.matchAll(pattern)].map(match => ({ source: match[0], comparison, count: number(match[1]) })));
}

/** Count the validated result, not additions, prose summaries, cameras or shots. */
export function validateObjectCounts(project: ProjectContent, plan: EditPlan, requirements: CountRequirement[]) {
  const checks = plan.objectCounts ?? [];
  // Discussion and clarification replies may have no changes. They cannot silently apply a noncompliant set.
  if (!plan.operations.length && !checks.length) return;
  for (const requirement of requirements) {
    if (!checks.some(check => check.source === requirement.source && check.comparison === requirement.comparison && check.count === requirement.count))
      throw new Error(`Missing object count check for "${requirement.source}". Bind this requirement to its sceneId in objectCounts.`);
  }
  for (const check of checks) {
    if (!requirements.some(requirement => requirement.source === check.source && requirement.comparison === check.comparison && requirement.count === check.count))
      throw new Error(`Object count check "${check.source}" does not match an explicit requirement in this request.`);
    const scene = project.scenes.find(scene => scene.id === check.sceneId);
    if (!scene) throw new Error(`Object count check refers to missing scene ${check.sceneId}; do not remove a scene when asked to remove its objects.`);
    const actual = scene.objects.length;
    if (check.comparison === 'exactly' ? actual !== check.count : actual > check.count)
      throw new Error(`Scene ${scene.id} has ${actual} objects; "${check.source}" requires ${check.comparison} ${check.count}. Count every entry in objects, including floors, people and decorative primitives. Cameras/shots are separate.`);
  }
}
