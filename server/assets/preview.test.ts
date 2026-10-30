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
