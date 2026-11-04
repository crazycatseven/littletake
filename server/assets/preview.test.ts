import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { createAsset, type AssetRecipe } from '../../src/assets/model.ts';
import { renderAssetPreview } from './preview.ts';
import { AssetLibrary } from './library.ts';
import { generateAsset } from './expert.ts';
import {readFileSync} from 'node:fs';
import {renderScenePreview} from './preview.ts';
import {validateAsset} from '../../src/assets/model.ts';
import {validateProjectContent} from '../../src/project/model.ts';
import {serializeContent} from '../../src/project/model.ts';
import {createEmptyScene,createCamera,createShot,createObject} from '../../src/model.ts';

test('expert cabinet views hide interior geometry behind closed mirrored doors, reveal it when opened, and record both inspection poses', async () => {
  type Part = AssetRecipe['parts'][number];
  const part = (id: string, position: Part['position'], size: Part['size']): Part => ({ id, name:id, kind:'cube', position, size, rotation:[0,0,0], color:'#00ff00', parentId:null, joint:null });
  const recipe: AssetRecipe = { name:'Occlusion cabinet', description:'Green closed shell around a red interior', tags:['test'], parts:[
    part('left',[-1,1,0],[.06,2,1]), part('right',[1,1,0],[.06,2,1]),
    part('top',[0,2,0],[2,.06,1]), part('bottom',[0,0,0],[2,.06,1]), part('back',[0,1,-.5],[2,2,.06]),
    {...part('door',[-1,1,.5],[1,1,1]),kind:'group',joint:{type:'hinge',axis:'y',pivot:[0,0,0],min:-100,max:0}},
    {...part('door-panel',[.5,0,0],[1,2,.04]),parentId:'door'},
    {...part('interior',[0,1,0],[1.6,1.6,.5]),color:'#ff0000'},
  ], construction:{parameters:[],bindings:[],anchors:[],constraints:[],modifiers:[{id:'mirror',type:'mirror',targetId:'door',enabled:true,axes:['x'],referenceId:null}],excluded:[],offset:[0,0,0]} };
  const asset = createAsset(recipe,'occlusion-cabinet');
  const redPixels = (png: Uint8Array) => {
    const rendered = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="420"><image width="1080" height="420" href="data:image/png;base64,${Buffer.from(png).toString('base64')}"/></svg>`).render();
    const pixels=rendered.pixels; let count=0;
    for(let i=0;i<pixels.length;i+=4) if(pixels[i]>100&&pixels[i+1]<60&&pixels[i+2]<60)count++;
    return count;
  };
  assert.equal(redPixels(renderAssetPreview(asset)),0,'Hidden interior must not leak through opaque doors or walls in any view.');
  assert.ok(redPixels(renderAssetPreview(asset,{'door':-80,'door~mirror.x':-80}))>100,'Opening both independently posed mirrored doors exposes the interior.');
  const library=new AssetLibrary(await mkdtemp(path.join(tmpdir(),'littletake-depth-'))); let calls=0;
  const provider={name:'test',model:'test',async generateObject(request:any){
    calls++;
    if(calls===1)return recipe;
    const data=JSON.parse(request.content[0].text);
    assert.equal(request.content.filter((p:any)=>p.type==='image').length,2);
    assert.deepEqual(data.trialJointAngles,{door:-50,'door~mirror.x':-50});
    assert.ok(data.posedMeasurements.joints.every((j:any)=>j.poseDegrees===-50));
    assert.equal(redPixels(Buffer.from(request.content[1].dataUrl.split(',')[1],'base64')),0);
    assert.ok(redPixels(Buffer.from(request.content[2].dataUrl.split(',')[1],'base64'))>100);
    return {approved:true,notes:'Closed and open views inspected.',revisedRecipe:null};
  }};
  const result=await generateAsset('A cabinet with mirrored opening doors',provider,library);
  assert.equal(calls,2);assert.equal(result.job.status,'ready');assert.deepEqual(await library.read(result.asset.id),result.asset);
});

test('recorded scene inspection matches actual WebGL visibility across three shots, keyed poses and a portable project reload',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/scene-preview.json',import.meta.url),'utf8')),assets=fixture.assets.map(validateAsset),project=validateProjectContent({name:'Geometry inspection',scenes:[fixture.scene],assets}),frozen=JSON.stringify(project),preview=renderScenePreview(project.scenes[0],assets,fixture.frames);
  assert.ok(preview.image.length>10_000);assert.equal(preview.frames.length,3);
  for(const expected of fixture.expected){const actual=preview.frames.find(frame=>frame.time===expected.time)!.visibleBoxes[expected.id]?.box??null;if(!expected.box){assert.equal(actual,null,expected.name);continue;}assert.ok(actual,expected.name+' must be visible.');assert.ok(Math.max(...actual!.map((value,index)=>Math.abs(value-expected.box[index])))<.004,expected.name+' differs from the recorded WebGL object-ID pass.');}
  assert.equal(JSON.stringify(project),frozen,'Inspection cannot mutate the scene, prefabs or animation.');const reopened=validateProjectContent(JSON.parse(serializeContent(project))),again=renderScenePreview(reopened.scenes[0],reopened.assets!,fixture.frames);assert.deepEqual(again.frames,preview.frames);
  const matte:[number,number,number,number]=[.125,.1,.875,.9],framed=structuredClone(project);for(const camera of framed.scenes[0].cameras)camera.frameBounds=matte;
  const cropped=renderScenePreview(framed.scenes[0],assets,fixture.frames),explicit=renderScenePreview(project.scenes[0],assets,fixture.frames,matte);
  assert.deepEqual(cropped.frames,explicit.frames,'Persisted camera framing and transient reference framing must measure the same pixels.');
  let removedPixels=0;
  for(const [index,frame] of cropped.frames.entries())for(const [id,visible] of Object.entries(frame.visibleBoxes)){
    const original=preview.frames[index].visibleBoxes[id];removedPixels+=(original?.pixels??0)-(visible?.pixels??0);if(!visible)continue;
    assert.ok(visible.box[0]>=matte[0]&&visible.box[1]>=matte[1]&&visible.box[2]<=matte[2]&&visible.box[3]<=matte[3],'Black-matte pixels cannot count as a visible subject.');assert.ok(visible.pixels<=(original?.pixels??0));
  }
  assert.ok(removedPixels>100,'The recorded scene must exercise real clipped geometry.');
  const restored=validateProjectContent(JSON.parse(serializeContent(framed))),restoredPreview=renderScenePreview(restored.scenes[0],restored.assets!,fixture.frames);assert.deepEqual(restoredPreview.frames,cropped.frames);assert.deepEqual(restoredPreview.image,cropped.image);
  const pixels=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="1152"><image width="640" height="1152" href="data:image/png;base64,${Buffer.from(cropped.image).toString('base64')}"/></svg>`).render().pixels;
  for(const row of [24+10,24+180,24+350])for(const x of [10,630])assert.deepEqual([...pixels.subarray((row*640+x)*4,(row*640+x)*4+4)],[0,0,0,255]);
  assert.equal(JSON.stringify(project),frozen,'Applying a measured matte cannot modify the source geometry, lens or animation.');
});

test('large sets keep distant animated subjects visible instead of clipping them at the former 500 metre limit',()=>{
  const scene=createEmptyScene(),camera=createCamera('camera'),object=createObject('cube',1);scene.duration=5;camera.transform.position=[0,2,0];camera.transform.rotation=[0,0,0];object.transform.position=[0,2,-600];object.transform.scale=[100,4,4];object.color='#ff0000';object.track={start:0,duration:5,from:structuredClone(object.transform),to:{...structuredClone(object.transform),position:[0,2,-900]}};
  scene.objects=[object];scene.cameras=[camera];scene.shots=[createShot(camera,'shot',5)];const frozen=JSON.stringify(scene),preview=renderScenePreview(scene,[],[{shotId:'shot',time:0},{shotId:'shot',time:5}],undefined,true);
  assert.ok(preview.frames[0].visibleBoxes[object.id]!.pixels>50);assert.ok(preview.frames[1].visibleBoxes[object.id]!.pixels>20);assert.ok(preview.frames[1].visibleBoxes[object.id]!.pixels<preview.frames[0].visibleBoxes[object.id]!.pixels,'The farther subject must still project smaller.');const occupied=preview.frames.slice(2).map(frame=>{const box=frame.visibleBoxes[object.id]!.box;return Math.max(box[2]-box[0],box[3]-box[1]);});assert.ok(occupied.every(size=>size>.6)&&occupied.some(size=>size>.85),'Automatic inspection must fit the projected bounds instead of wasting most pixels around a long subject.');assert.equal(JSON.stringify(scene),frozen);
  const alongZ=structuredClone(scene);alongZ.objects[0].transform.scale=[4,4,100];alongZ.objects[0].track=null;const top=renderScenePreview(alongZ,[],[],undefined,true).frames.at(-1)!,box=top.visibleBoxes[object.id]!.box;assert.ok(box[2]-box[0]>.85);assert.ok(Math.abs(top.camera.screenRight[2])>.99,'The diagnostic top view should orient a long subject across the available image width, with measured axes supplied.');
});
