import type { AssetDraft } from '../../edit.ts';
import { emptyConstruction, type Part } from '../schema.ts';

/** Reconstruction of the real v2 hotel cart used in asset-editor verification. */
export function trolleyDraft(): AssetDraft {
  const part=(id:string,name:string,kind:Part['kind'],position:Part['position'],size:Part['size'],parentId:string|null=null,color='#D4AF37'):Part=>({id,name,kind,parentId,position,size,rotation:[0,0,0],color,joint:null});
  const parts:Part[]=[
    part('base_platform','红色底板平台','cube',[0,.175,0],[1.12,.05,.65],null,'#B22222'),
    part('wheel_module','轮组','group',[-.42,0,.26],[1,1,1]),
    part('caster_FL','轮组支杆','cylinder',[0,.115,0],[.03,.07,.03],'wheel_module','#1A1A1A'),
    {...part('wheel_FL','轮胎','cylinder',[0,.06,0],[.12,.06,.12],'wheel_module','#1A1A1A'),rotation:[0,0,90],joint:{type:'wheel',pivot:[0,0,0],axis:'y',min:-360,max:360}},
    part('post_LF','立柱','cylinder',[-.475,1.09,.305],[.04,1.78,.04]),
    part('top_side_L','侧横梁','cylinder',[-.475,1.98,0],[.04,.65,.04]),
    part('top_cross','顶部横梁','cylinder',[0,1.98,0],[.04,.99,.04]),
  ];
  const c=emptyConstruction();
  c.parameters=[{id:'width',name:'底板宽度',value:1.12,min:.8,max:3},{id:'depth',name:'底板深度',value:.65,min:.4,max:2},{id:'postHeight',name:'立柱高度',value:1.78,min:.4,max:3},{id:'wheelRadius',name:'轮子半径',value:.06,min:.025,max:.2}];
  c.bindings=[
    {partId:'base_platform',property:'size.x',expression:'width'},{partId:'base_platform',property:'size.z',expression:'depth'},
    {partId:'base_platform',property:'position.y',expression:'wheelRadius * 4 / 3 + parts.caster_FL.size.y + parts.base_platform.size.y / 2'},
    {partId:'wheel_module',property:'position.x',expression:'-width / 2 + 0.14'},{partId:'wheel_module',property:'position.z',expression:'depth / 2 - 0.065'},
    {partId:'wheel_FL',property:'position.y',expression:'wheelRadius'},{partId:'wheel_FL',property:'size.x',expression:'wheelRadius * 2'},{partId:'wheel_FL',property:'size.z',expression:'wheelRadius * 2'},
    {partId:'caster_FL',property:'position.y',expression:'wheelRadius * 4 / 3 + parts.caster_FL.size.y / 2'},
    {partId:'post_LF',property:'size.y',expression:'postHeight'},
  ];
  c.anchors=[
    {id:'post_center',name:'立柱中心',partId:'base_platform',position:['-width / 2 + 0.085','parts.base_platform.size.y / 2 + postHeight / 2','depth / 2 - 0.02']},
    {id:'left_front_top',name:'左前柱顶',partId:'base_platform',position:['-width / 2 + 0.085','parts.base_platform.size.y / 2 + postHeight','depth / 2 - 0.02']},
    {id:'left_back_top',name:'左后柱顶',partId:'base_platform',position:['-width / 2 + 0.085','parts.base_platform.size.y / 2 + postHeight','-depth / 2 + 0.02']},
    {id:'left_center_top',name:'左侧横梁中心',partId:'base_platform',position:['-width / 2 + 0.085','parts.base_platform.size.y / 2 + postHeight',0]},
    {id:'right_center_top',name:'右侧横梁中心',partId:'base_platform',position:['width / 2 - 0.085','parts.base_platform.size.y / 2 + postHeight',0]},
  ];
  c.constraints=[{id:'post_attach',type:'attach',targetId:'post_LF',anchorId:'post_center',offset:[0,0,0]},{id:'side_span',type:'span',targetId:'top_side_L',from:'left_front_top',to:'left_back_top',axis:'y'},{id:'cross_span',type:'span',targetId:'top_cross',from:'left_center_top',to:'right_center_top',axis:'y'}];
  c.modifiers=[{id:'wheel_mirror',targetId:'wheel_module',type:'mirror',axes:['x','z'],referenceId:'base_platform',enabled:true},{id:'post_mirror',targetId:'post_LF',type:'mirror',axes:['x','z'],referenceId:'base_platform',enabled:true},{id:'side_mirror',targetId:'top_side_L',type:'mirror',axes:['x'],referenceId:'base_platform',enabled:true}];
  return {name:'参数化酒店行李车',description:'以现有酒店行李车为参考，轮组与立柱复用，横梁通过锚点连接。',tags:['hotel','trolley','parametric'],parts,construction:c};
}
