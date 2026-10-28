import { createAsset, validateAsset, type AssetDefinition, type AssetRecipe } from './model.ts';
import { builtinAssets as furnitureAssets } from './builtin.ts';
import { movement, type ObjectComponent } from '../components/model.ts';
import { trackPoses } from '../performance/motion.ts';
import type { SceneObject, Transform, Vec3 } from '../types.ts';

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
const make = (id:string,name:string,tags:string[],parts:Part[],component:ObjectComponent):AssetDefinition => ({...createAsset({name,description:name,tags,parts},id,1,'builtin'),createdAt:'2026-10-27T00:00:00.000Z',template:{components:[component],track:null}});
export const builtinAssets: AssetDefinition[] = [
  make('builtin-visitor','访客',['人物','person'],person('#b98661'),movement()),
  make('builtin-porter','门童',['人物','person'],person('#7f946d'),movement('walk',1.5)),
  make('builtin-car','旅行车',['车辆','vehicle'],car,movement('drive',3)),
  make('builtin-desk','接待前台',['道具','prop'],[box('base',[0,.55,0],[2.6,1.1,.85],'#ad9165'),box('top',[0,1.14,0],[2.85,.12,1.03],'#8b6e4b')],movement('free',1)),
  make('builtin-trolley','行李车',['道具','prop'],trolley,movement('drive',1.2)),
  make('builtin-door','木门',['道具','prop'],[box('door',[0,1.05,0],[.95,2.1,.08],'#aa8260')],{type:'hinge',enabled:true,speed:50}),
  ...(['cube','sphere','cylinder','cone'] as const).map(kind=>make('builtin-'+kind,{cube:'方块',sphere:'球体',cylinder:'圆柱',cone:'圆锥'}[kind],['基础几何','primitive'],[part('shape',kind,[0,.5,0],[1,1,1],'#9fb9cf')],movement('free',1.7))),
  ...furnitureAssets,
];

export function availableAssets(saved: AssetDefinition[] = []): AssetDefinition[] {
  return [...builtinAssets.map(a=>saved.find(b=>a.id===b.id&&a.version===b.version)??a),...saved.filter(a=>!builtinAssets.some(b=>b.id===a.id&&b.version===a.version))];
}
export function instantiateAsset(asset:AssetDefinition,id:string,position:Vec3,duration:number):SceneObject {
  const transform:Transform=structuredClone(asset.template?.transform??{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]});
  transform.position=[...position];
  const track=structuredClone(asset.template?.track??null);
  if(track){track.start=0;track.duration=Math.min(track.duration,duration);for(const pose of trackPoses(track))pose.position=pose.position.map((v,i)=>v+position[i]) as Vec3;}
  return {id,name:asset.name,kind:'asset',asset:{id:asset.id,version:asset.version},color:'#ffffff',transform,track,components:structuredClone(asset.template?.components??[])};
}
export function saveObjectAsset(object:SceneObject,assets:AssetDefinition[],id:string):AssetDefinition {
  const source=assets.find(a=>a.id===object.asset?.id&&a.version===object.asset.version);
  const parts=source?structuredClone(source.parts):object.kind==='human'?person(object.color):[part('shape',object.kind==='plane'?'cube':object.kind as Part['kind'],[0,object.kind==='plane'?.01:.5,0],[1,object.kind==='plane'?.02:1,1],object.color)];
  const metadata={name:object.name,description:'Saved scene object',tags:['我的资产','saved']};
  const asset=source?validateAsset({...structuredClone(source),...metadata,id,version:1,source:'edited',createdAt:new Date().toISOString()}):createAsset({...metadata,parts},id,1,'edited');
  if(source && object.color!=='#ffffff') { /* Colour is already an instance tint; bake it into the reusable parts. */
    for(const p of asset.parts){const a=parseInt(p.color.slice(1),16),b=parseInt(object.color.slice(1),16);p.color='#'+[16,8,0].map(s=>Math.round(((a>>s)&255)*((b>>s)&255)/255).toString(16).padStart(2,'0')).join('');}
  }
  const transform=structuredClone(object.transform),track=structuredClone(object.track);
  if(track)for(const pose of trackPoses(track))pose.position=pose.position.map((v,i)=>v-transform.position[i]) as Vec3;
  transform.position=[0,0,0];asset.template={transform,components:structuredClone(object.components??[]),track};return asset;
}
