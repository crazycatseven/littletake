import { Color } from 'three';
import { createAsset, recipeBounds, validateAsset, type AssetDefinition, type AssetRecipe } from './model.ts';
import { builtinAssets as furnitureAssets } from './builtin.ts';
import { movement, pivotOffset, type ObjectComponent } from '../components/model.ts';
import { trackPoses } from '../performance/motion.ts';
import type { ProjectContent, SceneObject, Transform, Vec3 } from '../types.ts';

type Part = AssetRecipe['parts'][number];
const part = (id: string, kind: Part['kind'], position: Vec3, size: Vec3, color: string, rotation: Vec3 = [0,0,0]): Part => ({ id, name:id, kind, position, size, color, rotation, parentId:null, joint:null });
const box = (id:string,p:Vec3,s:Vec3,c:string) => part(id,'cube',p,s,c);
const person = (color:string): Part[] => [part('head','sphere',[0,1.63,0],[.35,.37,.35],'#d8b68b'),part('body','cylinder',[0,1.1,0],[.43,.62,.32],color),
  ...[-1,1].flatMap((x,i)=>[part('arm'+i,'cylinder',[x*.31,1.08,0],[.13,.55,.13],color),part('leg'+i,'cylinder',[x*.12,.42,0],[.16,.74,.16],'#6f7960'),box('foot'+i,[x*.12,.06,.055],[.18,.12,.31],'#505b47')]),
  ...[-1,1].map((x,i)=>part('eye'+i,'sphere',[x*.07,1.65,.16],[.035,.035,.035],'#30382d'))];
const car: Part[] = [box('body',[0,.65,0],[1.65,.55,3.1],'#8aa6a0'),box('cabin',[0,1.12,-.15],[1.4,.55,1.6],'#8aa6a0'),box('windshield',[0,1.14,.66],[1.22,.36,.025],'#b6c7c5'),box('bumper',[0,.41,1.57],[1.52,.13,.13],'#b9bcab'),
  ...[-1,1].flatMap((x,i)=>[-1,1].map((z,j)=>part('wheel'+i+j,'cylinder',[x*.85,.4,z*.98],[.72,.22,.72],'#505b49',[0,0,90]))),
  ...[-1,1].map((x,i)=>box('lamp'+i,[x*.55,.7,1.56],[.3,.17,.03],'#e1d9a4'))];
const trolley: Part[] = [box('base',[0,.22,0],[1.1,.16,1.4],'#839178'),...[-1,1].flatMap((x,i)=>[box('rail'+i,[x*.5,1.08,-.5],[.055,1.7,.055],'#bda574'),part('wheel'+i,'sphere',[x*.47,.12,.48],[.24,.24,.24],'#525d45')]),box('handle',[0,1.9,-.5],[1.06,.055,.055],'#bda574'),box('case',[0,.65,0],[.8,.7,.65],'#aa8961')];
const make = (id:string,name:string,tags:string[],parts:Part[],component:ObjectComponent|ObjectComponent[]):AssetDefinition => ({...createAsset({name,description:name,tags,parts},id,'builtin'),createdAt:'2026-10-27T00:00:00.000Z',template:{components:Array.isArray(component)?component:[component],track:null}});
export const builtinAssets: AssetDefinition[] = [
  make('builtin-visitor','Visitor',['person'],person('#b98661'),movement()),
  make('builtin-porter','Bellhop',['person'],person('#7f946d'),movement('walk',1.5)),
  make('builtin-car','Station Wagon',['vehicle'],car,movement('drive',3)),
  make('builtin-desk','Reception Desk',['prop'],[box('base',[0,.55,0],[2.6,1.1,.85],'#ad9165'),box('top',[0,1.14,0],[2.85,.12,1.03],'#8b6e4b')],movement('free',1)),
  make('builtin-trolley','Luggage Cart',['prop'],trolley,movement('drive',1.2)),
  make('builtin-door','Wooden Door',['prop'],[box('door',[0,1.05,0],[.95,2.1,.08],'#aa8260')],pivotOffset([-.475,0,0])),
  ...(['cube','sphere','cylinder','cone'] as const).map(kind=>make('builtin-'+kind,{cube:'Cube',sphere:'Sphere',cylinder:'Cylinder',cone:'Cone'}[kind],['primitive'],[part('shape',kind,[0,.5,0],[1,1,1],'#9fb9cf')],movement('free',1.7))),
  ...furnitureAssets,
];

export function availableAssets(saved: AssetDefinition[] = []): AssetDefinition[] {
  return [...builtinAssets.map(a=>saved.find(b=>a.id===b.id)??a),...saved.filter(a=>!builtinAssets.some(b=>b.id===a.id))];
}
export function instantiateAsset(asset:AssetDefinition,id:string,position:Vec3,duration:number):SceneObject {
  const transform:Transform=structuredClone(asset.template?.transform??{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]});
  transform.position=[...position];
  const track=structuredClone(asset.template?.track??null);
  if(track){track.start=0;track.duration=Math.min(track.duration,duration);for(const pose of trackPoses(track))pose.position=pose.position.map((v,i)=>v+position[i]) as Vec3;}
  return {id,name:asset.name,kind:'asset',asset:{id:asset.id},color:'#ffffff',transform,track,components:structuredClone(asset.template?.components??[])};
}
export function saveObjectAsset(object:SceneObject,assets:AssetDefinition[],id:string):AssetDefinition {
  const source=assets.find(a=>a.id===object.asset?.id);
  if(object.kind==='asset'&&!source)throw new Error('This object’s prefab is missing. Reload its asset before creating a copy.');
  const parts=source?structuredClone(source.parts):object.kind==='human'?sceneHumanParts():[part('shape',object.kind==='plane'?'cube':object.kind as Part['kind'],[0,0,0],[1,object.kind==='plane'?.005:1,1],'#ffffff')];
  const metadata={name:object.name,description:'Saved scene object',tags:['saved']};
  // Preserve the source's local origin. Bottom-centering here would make a linked cube jump.
  const asset=validateAsset({...structuredClone(source),...metadata,parts,id,source:'edited',createdAt:new Date().toISOString(),bounds:recipeBounds({...metadata,parts,...(source?.construction?{construction:source.construction}:{})})});
  // Match the renderer's linear-light tint, then neutralize the linked instance's tint once.
  if(object.color.toLowerCase()!=='#ffffff')for(const p of asset.parts)p.color='#'+new Color(p.color).multiply(new Color(object.color)).getHexString();
  const transform=structuredClone(object.transform),track=structuredClone(object.track);
  if(track)for(const pose of trackPoses(track))pose.position=pose.position.map((v,i)=>v-transform.position[i]) as Vec3;
  transform.position=[0,0,0];asset.template={transform,components:structuredClone(object.components??[]),track};return asset;
}

/** Detach only this object from its previous prefab; other instances keep their original reference. */
export function linkObjectAsset(project:ProjectContent,sceneId:string,objectId:string,asset:AssetDefinition):ProjectContent {
  const next=structuredClone(project),object=next.scenes.find(scene=>scene.id===sceneId)?.objects.find(object=>object.id===objectId);
  if(!object)throw new Error('The original object no longer exists. The prefab is available in My Assets.');
  next.assets=[...(next.assets??[]).filter(existing=>existing.id!==asset.id),validateAsset(asset)];
  object.kind='asset';object.asset={id:asset.id};object.color='#ffffff';return next;
}

// The scene's capsule mannequin expressed with the toolkit's cylinder/sphere primitives.
function sceneHumanParts():Part[]{
  const parts:Part[]=[],dark='#'+new Color('#ffffff').multiplyScalar(.72).getHexString();
  const add=(id:string,kind:Part['kind']|'capsule',position:Vec3,size:Vec3,accent=false,rotation:Vec3=[0,0,0])=>{
    const color=accent?dark:'#ffffff';
    if(kind!=='capsule'){parts.push(part(id,kind,position,size,color,rotation));return;}
    parts.push(part(id,'group',position,[1,1,1],color,rotation));
    parts.push({...part(id+'-body','cylinder',[0,0,0],size,color),parentId:id});
    for(const side of [-1,1])parts.push({...part(id+(side<0?'-bottom':'-top'),'sphere',[0,side*size[1]/2,0],size,color),parentId:id});
  };
  add('body','capsule',[0,1.12,0],[.41,.29,.27]);add('hips','sphere',[0,.82,0],[.39,.28,.29],true);
  add('neck','cylinder',[0,1.45,0],[.11,.12,.11]);add('head','sphere',[0,1.63,0],[.32,.37,.32]);
  for(const side of [-1,1]){const id=side<0?'left':'right';add(id+'-leg','capsule',[side*.12,.43,0],[.14,.34,.15],true);add(id+'-foot','cube',[side*.12,.055,-.045],[.155,.11,.28],true);add(id+'-arm','capsule',[side*.315,1.09,0],[.12,.28,.12],false,[0,0,side*.1*180/Math.PI]);add(id+'-hand','sphere',[side*.344,.79,0],[.13,.15,.13]);}
  return parts;
}
