import { icon } from '../icons';
import { componentAddReason, componentsSchema, componentScripts, movement, pivotOffset, followPath, type ObjectComponent } from './model';
import type { SceneObject } from '../types';
import './inspector.css';
import { scriptParameters, type ScriptDefinition } from '../scripts/model';
import { appearanceReference } from '../appearance/model';

type ComponentOwner = Pick<SceneObject, 'kind' | 'components'>;
const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');

function componentPicker(components: ObjectComponent[], locked: boolean, scripts:ScriptDefinition[]=[], preview=false): string {
  return `<button class="add-motion component-add-button" data-component-picker-open aria-haspopup="dialog" aria-expanded="false" ${locked ? 'disabled' : ''}>${icon('plus')} Add Component</button>
    <div class="component-picker" data-component-picker popover="auto" role="dialog" aria-label="Add Component">
      <header><strong>Add Component</strong><button data-component-picker-close aria-label="Close component picker">${icon('close')}</button></header>
      <input type="search" data-component-search aria-label="Search components" placeholder="Search components…" autocomplete="off"/>
      <div class="component-options">${Object.entries(componentScripts).filter(([type,script]) => script.addable !== false && (!preview || type !== 'appearanceReference')).map(([type, script]) => { const reason = componentAddReason(components, type as ObjectComponent['type']); return `<button class="component-option" data-component-add="${type}" ${reason || locked ? 'disabled' : ''}><span><strong>${script.title}</strong>${reason === 'Added' ? '<small class="component-added">Added</small>' : ''}</span><small>${reason && reason !== 'Added' ? reason : script.description}</small></button>`; }).join('')}</div>
      ${preview?'':`<div class="component-options">${scripts.map(script=>{const reason=componentAddReason(components,'script');return `<button class="component-option" data-script-attach="${esc(script.id)}" ${locked||reason?'disabled':''}><span><strong>${esc(script.name)}</strong></span><small>${reason||'Project script · revision '+script.revision}</small></button>`;}).join('')}<button class="component-option" data-script-manage ${locked?'disabled':''}><strong>Project Scripts…</strong><small>Create or edit a reusable controller</small></button></div>`}
      <p class="component-empty" hidden>No components found.</p>
    </div>`;
}

export function componentInspector(item: ComponentOwner, locked: boolean, controlling: boolean, preview = false, keyButton?: (group: 'pivot') => string, axisButton?: (group: 'pivot', axis: number) => string, scripts:ScriptDefinition[]=[]): string {
  const components = item.components ?? [], disabled = locked ? 'disabled' : '';
  const follows=components.some(c=>c.type==='followPath'&&c.enabled&&c.pathId);
  const cards = components.map(component => {
    if (component.type === 'appearanceReference') return `<details class="control-component" data-component-card="appearanceReference" open><summary>${icon('chevron-right', {class:'ui-icon component-chevron'})}<input type="checkbox" aria-label="Enable Appearance Reference" data-component-enabled ${component.enabled ? 'checked' : ''} ${disabled}/><span>Appearance Reference</span><button data-component-remove aria-label="Remove Appearance Reference" ${disabled}>${icon('close')}</button></summary><div class="component-fields" data-appearance-fields></div></details>`;
    if(component.type==='script'){
      const script=scripts.find(s=>s.id===component.scriptId),fieldsDisabled=locked&&!controlling?'disabled':'',structureDisabled=locked?'disabled':'';
      const fields=script?.fields.map(field=>{
        const input=field.type==='boolean'?`<input type="checkbox" data-script-param="${esc(field.key)}" ${component.parameters[field.key]?'checked':''} ${fieldsDisabled}/>`
          :field.type==='choice'?`<select data-script-param="${esc(field.key)}" ${fieldsDisabled}>${field.options.map(value=>`<option ${value===component.parameters[field.key]?'selected':''}>${esc(value)}</option>`).join('')}</select>`
          :`<input type="number" data-script-param="${esc(field.key)}" min="${field.min}" max="${field.max}" step="${field.step}" value="${component.parameters[field.key]??field.default}" ${fieldsDisabled}/>`;
        return `<label>${esc(field.label)}${input}</label>`;
      }).join('')??'';
      return `<details class="control-component" data-component-card="script" open><summary>${icon('chevron-right', {class:'ui-icon component-chevron'})}
        <input type="checkbox" aria-label="Enable script controller" data-component-enabled ${component.enabled?'checked':''} ${structureDisabled}/>
        <span>${esc(script?.name??'Missing Script')}</span><button data-component-remove ${structureDisabled} aria-label="Remove script controller">${icon('close')}</button></summary>
        <div class="component-fields script-parameters"><button class="primary-button" data-component-action="control" ${!script||!component.enabled||follows||fieldsDisabled?'disabled':''}>${controlling?'Stop Control · Keep Position':'Start Control'}</button>
        ${fields}<small>${esc(script?.controls??'Choose an existing project script.')}</small>
        <small>${follows?'Disable Follow Path before using controls.':'Revision '+(script?.revision??'?')+' · Control parameters are not keyframed.'}</small>
        <button data-script-open="${esc(component.scriptId)}">Edit Script…</button></div></details>`;
    }
    const script = componentScripts[component.type], values = component as unknown as Record<string, string|number|number[]>;
    const fields = script.fields.map(field => {
      if (field.vector) return `<fieldset class="component-vector"><legend>${field.label} <small>(${field.unit})</small>${field.animatable&&keyButton?keyButton('pivot'):''}</legend>${['X','Y','Z'].map((axis,i) => `<label>${axis}<input type="number" aria-label="${field.label} ${axis}" data-component-field="${field.key}" data-component-axis="${i}" min="${field.min}" max="${field.max}" step="${field.step}" value="${(values[field.key] as number[])[i]}" ${disabled}/>${field.animatable&&axisButton?axisButton('pivot',i):''}</label>`).join('')}</fieldset>`;
      if (field.options) return `<label>${field.label}<select aria-label="${field.label}" data-component-field="${field.key}" ${disabled}>${Object.entries(field.options).map(([value,label]) => `<option value="${value}" ${values[field.key] === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
      return `<label class="component-number">${field.label}<span><input type="number" aria-label="${field.label}" data-component-field="${field.key}" min="${field.min}" max="${field.max}" step="${field.step}" value="${values[field.key]}" ${disabled}/><small>${field.unit}</small></span></label>`;
    }).join('');
    return `<details class="control-component" data-component-card="${component.type}" open><summary>${icon('chevron-right', {class:'ui-icon component-chevron'})}<input type="checkbox" aria-label="Enable ${script.title}" data-component-enabled ${component.enabled ? 'checked' : ''} ${disabled}/><span>${script.title}</span><button data-component-remove aria-label="Remove ${script.title}" ${disabled}>${icon('close')}</button></summary><div class="component-fields">${script.actions.map(action => `<button class="primary-button" data-component-action="${action.id}" ${!component.enabled || (locked && !controlling) || follows ? 'disabled' : ''}>${controlling ? (preview ? 'Stop Preview' : 'Stop Control · Keep Position') : (preview ? 'Preview Controls' : action.label)}</button>`).join('')}${fields}<p>${follows && (component.type === 'movement' || component.type === 'hinge') ? 'Disable Follow Path to use keyboard control.' : script.help(component)}</p>${component.type === 'movement' && !preview ? '<small>Camera stays fixed · Blue arrow shows forward</small>' : ''}</div></details>`;
  }).join('');
  return `<section class="inspector-section component-section"><div class="section-label">${preview ? 'DEFAULT COMPONENTS' : 'COMPONENTS'} <span>${components.length || ''}</span></div>${cards}${componentPicker(components, locked,scripts,preview)}</section>`;
}

export function bindComponents(root: HTMLElement, item: ComponentOwner, change: () => void, control: () => void, keyframedFields = false,scripts:ScriptDefinition[]=[]): void {
  const update = (components: ObjectComponent[]) => { item.components = componentsSchema.parse(components); change(); };
  bindComponentPicker(root, type => {
    const components = item.components ?? [];
    if (componentAddReason(components, type)) return;
    update(type === 'pivot' ? [pivotOffset(), ...components] : [...components, type==='appearanceReference'?appearanceReference():type==='followPath'?followPath():movement(item.kind === 'human' ? 'walk' : 'free')]);
  });
  for (const component of item.components ?? []) {
    const card = root.querySelector<HTMLElement>(`[data-component-card="${component.type}"]`)!;
    const replace = (next: ObjectComponent) => update(item.components!.map(c => c.type === next.type ? next : c));
    if(component.type==='script')for(const input of card.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[data-script-param]'))input.onchange=()=>{const script=scripts.find(s=>s.id===component.scriptId),field=script?.fields.find(f=>f.key===input.dataset.scriptParam);if(!script||!field)return;if(field.type==='number'&&(!input.value.trim()||!Number.isFinite(Number(input.value)))){input.value=String(component.parameters[field.key]??field.default);return;}const value=field.type==='boolean'?(input as HTMLInputElement).checked:field.type==='number'?Math.max(field.min,Math.min(field.max,Number(input.value))):input.value;replace({...component,parameters:scriptParameters(script,{...component.parameters,[field.key]:value})});};
    card.querySelector<HTMLButtonElement>('[data-component-remove]')!.onclick = () => update(item.components!.filter(c => c.type !== component.type));
    card.querySelector<HTMLInputElement>('[data-component-enabled]')!.onchange = event => replace({...component, enabled: (event.target as HTMLInputElement).checked});
    const action = card.querySelector<HTMLButtonElement>('[data-component-action="control"]');
    if (action) action.onclick = control;
    for (const field of componentScripts[component.type].fields) card.querySelectorAll<HTMLInputElement|HTMLSelectElement>(`[data-component-field="${field.key}"]`).forEach(input => {
      if (field.animatable && keyframedFields) return;
      input.onchange = () => {
      const numeric = Number(input.value);
      if (!field.options && !Number.isFinite(numeric)) return;
      let value: string | number | number[] = field.options ? input.value : Math.max(field.min!, Math.min(field.max!, numeric));
      if (field.vector) { const values = [...(component as unknown as Record<string, number[]>)[field.key]]; values[Number(input.dataset.componentAxis)] = value as number; value = values; }
      replace({...component, [field.key]: value} as ObjectComponent);
      };
    });
  }
}

function bindComponentPicker(root: HTMLElement, add: (type: ObjectComponent['type']) => void): void {
  const picker = root.querySelector<HTMLElement>('[data-component-picker]')!;
  const opener = root.querySelector<HTMLButtonElement>('[data-component-picker-open]')!;
  const search = picker.querySelector<HTMLInputElement>('[data-component-search]')!;
  const options = [...picker.querySelectorAll<HTMLButtonElement>('.component-option')];
  const empty = picker.querySelector<HTMLElement>('.component-empty')!;
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    for (const option of options) option.hidden = !option.textContent?.toLowerCase().includes(query);
    empty.hidden = options.some(option => !option.hidden);
  };
  opener.onclick = () => {
    if (picker.matches(':popover-open')) { picker.hidePopover(); return; }
    search.value = ''; filter(); picker.showPopover();
    const anchor = opener.getBoundingClientRect(), bounds = picker.getBoundingClientRect();
    picker.style.left = `${Math.max(12, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 12))}px`;
    picker.style.top = `${Math.max(12, Math.min(anchor.bottom + bounds.height + 8 <= window.innerHeight ? anchor.bottom + 6 : anchor.top - bounds.height - 6, window.innerHeight - bounds.height - 12))}px`;
    search.focus();
  };
  picker.addEventListener('toggle', () => opener.setAttribute('aria-expanded', String(picker.matches(':popover-open'))));
  picker.querySelector<HTMLButtonElement>('[data-component-picker-close]')!.onclick = () => { picker.hidePopover(); opener.focus(); };
  search.oninput = event => { event.stopPropagation(); filter(); };
  search.onchange = event => event.stopPropagation();
  picker.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); picker.hidePopover(); opener.focus(); return; }
    const available = options.filter(option => !option.hidden && !option.disabled);
    if (!available.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      const index = available.indexOf(document.activeElement as HTMLButtonElement);
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : available.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : available.length - 1)) % available.length;
      available[next].focus();
    } else if (event.key === 'Enter' && event.target === search) {
      event.preventDefault(); available[0].click();
    }
  };
  for (const option of options) option.onclick = () => {
    if (option.disabled) return;
    picker.hidePopover(); if(option.dataset.componentAdd)add(option.dataset.componentAdd as ObjectComponent['type']);
  };
}
