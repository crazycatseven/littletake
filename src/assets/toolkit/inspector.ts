import type { AssetDraft, AssetEdit } from '../edit.ts';
import { emptyConstruction, propertySchema, type Construction } from './schema.ts';
import { evaluateAsset } from './evaluate.ts';

const esc=(s:unknown)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const input=(label:string,key:string,value:unknown,type='text')=>`<label>${label}<input aria-label="${esc(label)}" data-tk-field="${key}" value="${esc(value)}" type="${type}" ${type==='number'?'step="any"':''}/></label>`;
const select=(label:string,key:string,value:string,options:[string,string][])=>`<label>${label}<select aria-label="${label}" data-tk-field="${key}">${options.map(([id,name])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(name)}</option>`).join('')}</select></label>`;
const button=(action:string,label:string)=>`<button type="button" data-tk="${action}">${label}</button>`;
const vector=(key:string,values:(string|number)[],label:string)=>`<div class="tk-vector">${values.map((v,i)=>input(label+' '+['X','Y','Z'][i],key+'.'+i,v)).join('')}</div>`;

/** Adds controls to the existing Inspector; source and evaluation stay outside the UI. */
export function constructionFields(draft:AssetDraft,selected:string|null):string {
  const c=draft.construction??emptyConstruction(), evaluated=evaluateAsset(draft), p=evaluated.parts.find(p=>p.id===selected);
  const parts:[string,string][]=[['','资产原点'],...draft.parts.map(p=>[p.id,p.name] as [string,string])], anchors=c.anchors.map(a=>[a.id,a.name] as [string,string]);
  if(p?.generatedBy.length)return `<section class="tk-section"><strong>关联复制结果</strong><p>由 ${esc(p.generatedBy.join(' → '))} 生成。编辑源部件会同步所有关联副本。</p>${button('source','编辑源部件')}${button('unique','解除此副本关联')}</section>`;
  const parameters=!p?`<section class="tk-section"><h3>尺寸参数</h3>${c.parameters.map(v=>`<div class="tk-card" data-param="${esc(v.id)}">${input(v.name,'value',v.value,'number')}<details data-tk-key="param-${esc(v.id)}"><summary>${esc(v.id)} · 范围与名称</summary>${input('参数名称','name',v.name)}<div class="tk-vector">${input('最小值','min',v.min,'number')}${input('最大值','max',v.max,'number')}</div>${button('remove-param','移除参数')}</details></div>`).join('')}<details data-tk-key="new-param"><summary>＋ 参数</summary><div data-new-param>${input('参数 ID','id','width')}${input('参数名称','name','宽度')}${input('初始值','value',1,'number')}<div class="tk-vector">${input('最小值','min',.01,'number')}${input('最大值','max',10,'number')}</div>${button('add-param','添加参数')}</div></details></section>`:'';
  const anchorFields=!p?`<details class="tk-section" data-tk-key="anchors"><summary>连接锚点 · ${c.anchors.length}</summary><p>锚点坐标相对所属部件，可填写参数表达式。</p>${c.anchors.map(a=>`<div class="tk-card" data-anchor="${esc(a.id)}"><strong>${esc(a.id)}</strong>${input('锚点名称','name',a.name)}${select('锚点所属部件','partId',a.partId??'',parts)}${vector('position',a.position,'锚点位置')}${button('remove-anchor','移除锚点')}</div>`).join('')}${button('add-anchor','＋ 锚点')}</details>`:'';
  const bindings=p?`<details class="tk-section" data-tk-key="bindings-${p.id}"><summary>参数关联 · ${c.bindings.filter(b=>b.partId===p.id).length}</summary><p>填写参数或部件数值，如 width / 2，parts.base.size.y。带连字符的 ID 使用 {parts.part-id.size.x}。</p>${c.bindings.filter(b=>b.partId===p.id).map(b=>`<div class="tk-card" data-binding="${b.property}"><strong>${b.property}</strong>${input('关联表达式','expression',b.expression)}${button('remove-binding','解除数值关联')}</div>`).join('')}<div data-new-binding>${select('关联属性','property','position.x',propertySchema.options.map(v=>[v,v]))}${input('表达式','expression','')}${button('add-binding','添加关联')}</div></details>`:'';
  const constraints=p?`<details class="tk-section" data-tk-key="constraints-${p.id}"><summary>锚点连接</summary>${c.constraints.filter(q=>q.targetId===p.id).map(q=>`<div class="tk-card" data-constraint="${q.id}"><strong>${q.type==='attach'?'吸附锚点':'连接两点'}</strong>${q.type==='attach'?`${select('连接锚点','anchorId',q.anchorId,anchors)}${vector('offset',q.offset,'局部偏移')}`:`${select('起点锚点','from',q.from,anchors)}${select('终点锚点','to',q.to,anchors)}${select('拉伸轴','axis',q.axis,[['x','X'],['y','Y'],['z','Z']])}`}${button('remove-constraint','解除连接')}</div>`).join('')}${anchors.length?button('attach','＋ 吸附到锚点')+(anchors.length>1?button('span','＋ 连接两个锚点'):''):'<p>先选择资产根节点，创建连接锚点。</p>'}</details>`:'';
  const mods=c.modifiers.filter(m=>!p||m.targetId===p.id);
  const modifiers=`<${p?'section':'details'} class="tk-section" data-tk-key="modifiers"><${p?'h3':'summary'}>修改器 ${p?'':'· 全部'}</${p?'h3':'summary'}>${mods.map(m=>`<div class="tk-card" data-mod="${esc(m.id)}"><div class="tk-heading"><label><input type="checkbox" data-tk-field="enabled" aria-label="启用 ${esc(m.id)}" ${m.enabled?'checked':''}/> ${m.type==='mirror'?'Mirror · 镜像':'Array · 阵列'}</label>${button('up','↑')}${button('down','↓')}${button('remove-mod','×')}</div><small>${esc(draft.parts.find(p=>p.id===m.targetId)?.name??m.targetId)} · ${esc(m.id)}</small>${m.type==='mirror'?`<div class="tk-axes">${['x','y','z'].map(axis=>`<label><input type="checkbox" data-tk-axis="${axis}" aria-label="镜像 ${axis.toUpperCase()}" ${m.axes.includes(axis as 'x')?'checked':''}/> ${axis.toUpperCase()}</label>`).join('')}</div>${select('镜像参考坐标系','referenceId',m.referenceId??'',parts)}`:`${input('阵列数量','count',m.count)}${vector('offset',m.offset,'阵列间距')}<small>数量包含源部件，间距沿源部件局部坐标。</small>`}</div>`).join('')||'<p>重复结构共用源部件，按列表顺序计算。</p>'}${p?`<div class="tk-actions">${button('mirror','＋ Mirror')}${button('array','＋ Array')}${button('group','建立组')}</div>`:'<p>选择部件或组后添加修改器。</p>'}</${p?'section':'details'}>`;
  const bake=!p&&draft.construction?`<details class="tk-section" data-tk-key="bake"><summary>转换为独立部件</summary><p>应用当前全部参数和修改器。形状保持不变，之后分别编辑各个部件；可撤销。</p>${button('bake','应用构建结果')}</details>`:'';
  return `<div class="tk-inspector">${parameters}${modifiers}${bindings}${constraints}${anchorFields}${bake}</div>`;
}
function id(prefix:string,items:{id:string}[]){let n=1;while(items.some(x=>x.id===prefix+n))n++;return prefix+n;}
function scalar(value:string){const n=Number(value);return value.trim()!==''&&Number.isFinite(n)?n:value;}
function fields(root:Element){return Object.fromEntries(Array.from(root.querySelectorAll<HTMLInputElement>('[data-tk-field]')).map(e=>[e.dataset.tkField!,e.type==='number'?Number(e.value):e.value]));}
export function constructionAction(button:HTMLButtonElement,draft:AssetDraft,selected:string|null):AssetEdit[]|null {
  const action=button.dataset.tk;if(!action||action==='source')return null;
  const c=structuredClone(draft.construction??emptyConstruction()), part=draft.parts.find(p=>p.id===selected);
  const modId=button.closest<HTMLElement>('[data-mod]')?.dataset.mod, parameter=button.closest<HTMLElement>('[data-param]')?.dataset.param;
  const anchor=button.closest<HTMLElement>('[data-anchor]')?.dataset.anchor, binding=button.closest<HTMLElement>('[data-binding]')?.dataset.binding, constraint=button.closest<HTMLElement>('[data-constraint]')?.dataset.constraint;
  if(action==='unique')return [{type:'make_unique',partId:selected!}];
  if(action==='bake')return [{type:'bake_construction'}];
  if(action==='group'&&part)return [{type:'group_parts',id:id('group',draft.parts),name:part.name+'组',partIds:[part.id]}];
  if(action==='add-param')c.parameters.push(fields(button.closest('[data-new-param]')!) as Construction['parameters'][number]);
  if(action==='remove-param')c.parameters=c.parameters.filter(p=>p.id!==parameter);
  if(action==='add-anchor')c.anchors.push({id:id('anchor',c.anchors),name:'连接锚点',partId:null,position:[0,0,0]});
  if(action==='remove-anchor')c.anchors=c.anchors.filter(a=>a.id!==anchor);
  if(action==='add-binding'&&part){const v=fields(button.closest('[data-new-binding]')!);c.bindings=c.bindings.filter(b=>!(b.partId===part.id&&b.property===v.property));c.bindings.push({partId:part.id,property:v.property as Construction['bindings'][number]['property'],expression:scalar(String(v.expression))});}
  if(action==='remove-binding')c.bindings=c.bindings.filter(b=>!(b.partId===selected&&b.property===binding));
  if(action==='remove-constraint')c.constraints=c.constraints.filter(q=>q.id!==constraint);
  if((action==='attach'||action==='span')&&part){
    if(c.constraints.some(q=>q.targetId===part.id))throw new Error('请先解除当前锚点连接。');
    if(!c.anchors.length)throw new Error('请先创建锚点。');
    c.constraints.push(action==='attach'?{id:id('attach',c.constraints),type:'attach',targetId:part.id,anchorId:c.anchors[0].id,offset:[0,0,0]}:{id:id('span',c.constraints),type:'span',targetId:part.id,from:c.anchors[0].id,to:c.anchors[1].id,axis:'y'});
  }
  if(action==='mirror'&&part)c.modifiers.push({id:id('mirror',c.modifiers),targetId:part.id,type:'mirror',axes:['x'],referenceId:null,enabled:true});
  if(action==='array'&&part)c.modifiers.push({id:id('array',c.modifiers),targetId:part.id,type:'array',count:2,offset:[1,0,0],enabled:true});
  if(action==='remove-mod')c.modifiers=c.modifiers.filter(m=>m.id!==modId);
  if(action==='up'||action==='down'){const i=c.modifiers.findIndex(m=>m.id===modId),j=i+(action==='up'?-1:1);if(i>=0&&j>=0&&j<c.modifiers.length)[c.modifiers[i],c.modifiers[j]]=[c.modifiers[j],c.modifiers[i]];}
  const edits:AssetEdit[]=[{type:'set_construction',construction:c}];
  if((action==='remove-binding'||action==='remove-constraint')&&part){
    const resolved=evaluateAsset(draft).parts.find(p=>p.id===part.id)!;
    const position=[...resolved.position] as [number,number,number];if(!part.parentId)position.forEach((_,i)=>position[i]-=c.offset[i]);
    if(action==='remove-constraint'){const removed=draft.construction!.constraints.find(q=>q.id===constraint)!;const size=[...part.size] as [number,number,number];if(removed.type==='span')size[['x','y','z'].indexOf(removed.axis)]=resolved.size[['x','y','z'].indexOf(removed.axis)];edits.push({type:'set_part',id:part.id,changes:removed.type==='attach'?{position}:{position,rotation:resolved.rotation,size}});}
    else {const [field,axis]=binding!.split('.') as ['position'|'rotation'|'size',string];const values=[...part[field]] as [number,number,number];values[['x','y','z'].indexOf(axis)]=(field==='position'?position:resolved[field])[['x','y','z'].indexOf(axis)];edits.push({type:'set_part',id:part.id,changes:{[field]:values}});}
  }
  return edits;
}
export function constructionChange(input:HTMLInputElement,draft:AssetDraft,selected:string|null):AssetEdit[]|null {
  const key=input.dataset.tkField,axis=input.dataset.tkAxis;if(!key&&!axis)return null;
  if(input.closest('[data-new-param],[data-new-binding]'))return [];
  const c=structuredClone(draft.construction??emptyConstruction());
  const param=input.closest<HTMLElement>('[data-param]')?.dataset.param,mod=input.closest<HTMLElement>('[data-mod]')?.dataset.mod,anchor=input.closest<HTMLElement>('[data-anchor]')?.dataset.anchor,binding=input.closest<HTMLElement>('[data-binding]')?.dataset.binding,constraint=input.closest<HTMLElement>('[data-constraint]')?.dataset.constraint;
  const target=param?c.parameters.find(p=>p.id===param):mod?c.modifiers.find(m=>m.id===mod):anchor?c.anchors.find(a=>a.id===anchor):binding?c.bindings.find(b=>b.partId===selected&&b.property===binding):c.constraints.find(q=>q.id===constraint);
  if(!target)return null;
  if(axis){const mirror=target as Extract<Construction['modifiers'][number],{type:'mirror'}>;mirror.axes=input.checked?[...mirror.axes,axis as 'x']:mirror.axes.filter(a=>a!==axis);}
  else if(key!.includes('.')){const [field,index]=key!.split('.');(target as unknown as Record<string,(string|number)[]>)[field][Number(index)]=scalar(input.value);}
  else (target as unknown as Record<string,unknown>)[key!]=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):['count','expression'].includes(key!)?scalar(input.value):['referenceId','partId'].includes(key!)?input.value||null:input.value;
  return [{type:'set_construction',construction:c}];
}
