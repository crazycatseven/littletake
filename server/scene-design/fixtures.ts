// Offline model/network fixtures. No fixture is used by the application or quality verification runs.
import { Resvg } from '@resvg/resvg-js';
import type {AIProvider,StructuredRequest} from '../ai/provider.ts';
import type {SceneDesign} from './design.ts';
export const fixturePNG=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#abc"/></svg>').render().asPng();
export const fixtureImage='data:image/png;base64,'+Buffer.from(fixturePNG).toString('base64');
export const fixturePlan={scope:'Preserve the full original requested set and all its defining relationships.',brief:'Use the original request to build the full intended set at consistent scale. Follow the attached original source images, preserve visible defining forms and spatial relationships, and keep all requested subjects in the establishing framing.',identityFeatures:['Preserve the characteristic forms and layout from the original references.'],displayScale:1,assetBriefs:[{name:'Requested asset',brief:'Preserve the requested asset silhouette, palette and relative proportions seen in the original reference.'}],regions:[]};
export const fixtureResearch={findings:'Original reference evidence describes the requested subject, layout and defining silhouettes; it is not a generic substitute for the original task.',imageQueries:[{query:'reference layout',purpose:'layout'},{query:'reference silhouette',purpose:'identity'}],sourceUrls:['https://example.org/original-layout']};
export const envelope=(value:unknown)=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
export const researchEnvelope=()=>({status:'completed',output:[{type:'message',phase:'commentary',content:[{type:'output_text',text:'Checking reference sources.'}]},{type:'web_search_call',status:'completed',results:[{type:'text_result',url:'https://example.org/original-layout',title:'Original source layout',snippet:'Original researched evidence.'}]},...envelope(fixtureResearch).output]});
export const fixtureReview={scopePreserved:true,identityVisible:true,layoutCoherent:true,notes:'The intended scope, visual identity and reference layout are preserved.'};
export const fixtureReferenceSelection={layoutUsable:true,selected:[{candidate:0,reason:'Clear full-extent original reference.'}],notes:'The reference establishes the requested whole layout.'};
export const fixtureObservation={visibleSubjects:['Visible test geometry'],coverage:'The intended subjects occupy the visible set.',massing:'Distinct volumes and proportions are visible.',framingIssues:[]};
export const fixtureSceneReview={approved:true,scopePreserved:true,identityVisible:true,referenceLayoutMatched:true,grades:{identity:9,layout:9,coverage:9,composition:9},blockingDefects:[],notes:'The actual rendered geometry matches the intended reference structure.'};
export function designHTTPFixture(body:any):unknown|undefined{
  if(body.tools?.some((tool:any)=>tool.type==='web_search'))return researchEnvelope();
  if(body.model?.startsWith('muse-image'))return {status:'completed',output:[{type:'image_generation_call',result:Buffer.from(fixturePNG).toString('base64')}]};
  if(body.instructions?.startsWith('Select ORIGINAL visual references'))return envelope(fixtureReferenceSelection);
  if(body.instructions?.startsWith("You are LittleTake's scene designer."))return envelope(fixturePlan);
  if(body.instructions?.startsWith('You independently review a proposed scene design BEFORE modeling.'))return envelope(fixtureReview);
  if(body.instructions?.startsWith('You assess an existing prefab for ONE canonical scene-design role.'))return envelope({approved:true,notes:'This specific prefab fits the requested role.'});
  if(body.instructions?.startsWith('Observe only the ACTUAL rendered geometry images.'))return envelope(fixtureObservation);
}
export const researchFetchFixture=(async(url:unknown)=>{
  const value=new URL(String(url));
  if(value.hostname==='commons.wikimedia.org')return Response.json({query:{pages:{'1':{title:'File:Original reference.png',imageinfo:[{thumburl:'https://upload.wikimedia.org/reference.png',descriptionurl:'https://commons.wikimedia.org/wiki/File:Original_reference.png',extmetadata:{Artist:{value:'Reference photographer'},LicenseShortName:{value:'CC BY'}}}]}}}});
  if(value.hostname==='upload.wikimedia.org')return new Response(new Uint8Array(fixturePNG),{headers:{'Content-Type':'image/png'}});
  throw new Error('Unexpected network request in offline reference fixture: '+value.origin);
}) as typeof fetch;
export function designProviderFixture(base:AIProvider,plan:NonNullable<SceneDesign['plan']>=fixturePlan):AIProvider{
  return {...base,async generateImage(){return {image:fixtureImage,model:'fixture-image'};},async generateObject(request:StructuredRequest){
    if(request.schemaName==='scene_reference_research'){request.onResponse?.(researchEnvelope());request.onOutput?.(JSON.stringify(fixtureResearch));return fixtureResearch;}
    if(request.schemaName==='scene_reference_selection')return fixtureReferenceSelection;
    if(request.schemaName==='scene_design_plan')return plan;
    if(request.schemaName==='scene_design_review')return fixtureReview;
    if(request.schemaName==='scene_asset_fit')return {approved:true,notes:'The rendered prefab fits this canonical role.'};
    if(request.schemaName==='scene_visual_observation')return fixtureObservation;
    return base.generateObject(request);
  }};
}
