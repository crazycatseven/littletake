import { propertyPaths, type PropertyAnimation, type PropertyPath, type VectorProperty } from './model.ts';

export type PropertyGroup = VectorProperty | 'fov';
const labels: Record<PropertyGroup,string> = {position:'Position',rotation:'Rotation',scale:'Scale',pivot:'Pivot Offset',fov:'Field of View'};
export const groupPaths = (group: PropertyGroup): PropertyPath[] => group === 'fov' ? ['fov'] : propertyPaths(group);
const at = (a: number, b: number) => Math.abs(a-b) < 1e-6;

export function keyState(animation: PropertyAnimation | undefined, group: PropertyGroup, time: number): 'on-key' | 'animated' | '' {
  const paths = groupPaths(group);
  if (paths.every(path => animation?.curves[path]?.some(key => at(key.time,time)))) return 'on-key';
  return paths.some(path => animation?.curves[path]?.length) ? 'animated' : '';
}

export function keyButton(animation: PropertyAnimation | undefined, group: PropertyGroup, time: number, disabled = false): string {
  const state=keyState(animation,group,time), action=state==='on-key'?'Remove':'Insert';
  return `<button class="property-key ${state}" type="button" data-key-group="${group}" aria-label="${action} ${labels[group]} keyframe" title="${action} ${labels[group]} keyframe" ${disabled?'disabled':''}>${state==='on-key'?'◆':'◇'}</button>`;
}

export interface SelectedPropertyKey { group: PropertyGroup; path?: PropertyPath; time: number }
export function renderPropertyRows(animation: PropertyAnimation | undefined, groups: PropertyGroup[], open: Set<PropertyGroup>, selected: SelectedPropertyKey | null, duration: number, fps: number, allSamples: boolean): string {
  const marker=(group:PropertyGroup,path:PropertyPath|undefined,time:number,recorded:boolean) => {
    const active=selected && selected.group===group && selected.path===path && at(selected.time,time);
    const label=path ? `${labels[group]} ${path.split('.')[1]?.toUpperCase()??''}`.trim() : labels[group];
    return `<button class="property-marker ${active?'selected':''} ${recorded?'recorded':''}" type="button" data-animation-group="${group}" ${path?`data-animation-path="${path}"`:''} data-animation-time="${time}" style="left:${time/duration*100}%" aria-label="${label} key at frame ${Math.round(time*fps)}" title="${label} · ${time.toFixed(2)} s"></button>`;
  };
  return groups.map(group=>{
    const paths=groupPaths(group), keyed=paths.flatMap(path=>animation?.curves[path]??[]), unique=new Map<string,typeof keyed[number]>();
    for(const key of keyed)if(!unique.has(key.time.toFixed(7)))unique.set(key.time.toFixed(7),key);
    const keys=[...unique.values()].sort((a,b)=>a.time-b.time), expanded=open.has(group), takeBars=(group==='position'||group==='rotation')?(animation?.takes??[]).filter(take=>keyed.some(key=>key.take===take.id)).map(take=>`<div class="animation-take" data-take="${take.id}" style="left:${take.start/duration*100}%;width:${(take.end-take.start)/duration*100}%" title="Drag to move; drag edges to retime"><span data-take-edge="left"></span>${take.source==='legacy'?'Sampled motion':'Recorded'}<span data-take-edge="right"></span></div>`).join(''):'';
    const summary=`<div class="timeline-row animation-row"><button class="track-label" data-animation-toggle="${group}" aria-expanded="${expanded}">${group==='fov'?'·':expanded?'▾':'▸'} <span>${labels[group]}</span><small>${keys.length||'—'}</small></button><div class="track-lane">${takeBars}${keys.filter((key,index)=>allSamples||!key.take||index%4===0).map(key=>marker(group,undefined,key.time,!!key.take)).join('')}<span class="lane-playhead"></span></div></div>`;
    if(!expanded||group==='fov')return summary;
    return summary+paths.map(path=>{
      const keys=animation?.curves[path]??[], axis=path.split('.')[1].toUpperCase();
      return `<div class="timeline-row animation-axis-row"><div class="track-label"><span class="animation-axis ${axis.toLowerCase()}">${axis}</span> ${labels[group]} ${axis}<small>${keys.length||'—'}</small></div><div class="track-lane">${keys.filter((key,index)=>allSamples||!key.take||index%3===0).map(key=>marker(group,path,key.time,!!key.take)).join('')}<span class="lane-playhead"></span></div></div>`;
    }).join('');
  }).join('');
}
