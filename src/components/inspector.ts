import { componentsSchema, componentScripts, movement, type ObjectComponent } from './model';
import type { SceneObject } from '../types';
export function componentInspector(item: SceneObject, locked: boolean, controlling: boolean): string {
  const component = item.components?.[0], disabled = locked ? 'disabled' : '';
  if (!component) return `<section class="inspector-section"><div class="section-label">组件</div><button class="add-motion" data-component-add="movement" ${disabled}>＋ 添加移动操控</button><button class="add-motion" data-component-add="hinge" ${disabled}>＋ 添加转轴开合</button></section>`;
  const script = componentScripts[component.type], values = component as unknown as Record<string, string|number>;
  return `<section class="inspector-section"><div class="section-label">组件 <span>1</span></div><details class="control-component" open><summary><input type="checkbox" aria-label="启用操控组件" data-component-enabled ${component.enabled ? 'checked' : ''} ${disabled}/><span>${script.title}</span><button data-component-remove aria-label="移除操控组件" ${disabled}>×</button></summary><div class="component-fields">${script.actions.map(action => `<button class="primary-button" data-component-action="${action.id}" ${!component.enabled || (locked && !controlling) ? 'disabled' : ''}>${controlling ? '退出操控，保留位置' : action.label}</button>`).join('')}${script.fields.map(field => field.options ? `<label>${field.label}<select aria-label="${field.label}" data-component-field="${field.key}" ${disabled}>${Object.entries(field.options).map(([value,label]) => `<option value="${value}" ${values[field.key] === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>` : `<label class="component-number">${field.label}<span><input type="number" aria-label="${field.label}" data-component-field="${field.key}" min="${field.min}" max="${field.max}" step="${field.step}" value="${values[field.key]}" ${disabled}/><small>${field.unit}</small></span></label>`).join('')}<p>${script.help(component)}</p><small>相机保持固定 · 蓝色箭头表示前进方向</small></div></details></section>`;
}
export function bindComponents(root: HTMLElement, item: SceneObject, change: () => void, control: () => void): void {
  root.querySelectorAll<HTMLButtonElement>('[data-component-add]').forEach(button => button.onclick = () => { item.components = [button.dataset.componentAdd === 'hinge' ? { type:'hinge', enabled:true, speed:50 } : movement(item.kind === 'human' ? 'walk' : 'free')]; change(); });
  const component = item.components?.[0]; if (!component) return;
  root.querySelector<HTMLButtonElement>('[data-component-remove]')!.onclick = () => { item.components = []; change(); };
  root.querySelector<HTMLInputElement>('[data-component-enabled]')!.onchange = event => { component.enabled = (event.target as HTMLInputElement).checked; change(); };
  root.querySelector<HTMLButtonElement>('[data-component-action="control"]')!.onclick = control;
  for (const field of componentScripts[component.type].fields) root.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-component-field="${field.key}"]`)!.onchange = event => {
    const input = event.target as HTMLInputElement, value = field.options ? input.value : Math.max(field.min!, Math.min(field.max!, Number(input.value) || field.min!));
    item.components = componentsSchema.parse([{ ...component, [field.key]: value }]) as ObjectComponent[]; change();
  };
}
