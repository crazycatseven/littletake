import { z } from 'zod';
import type { ProjectContent } from '../../src/types.ts';
import type { ToolDefinition } from '../ai/provider.ts';
import { scriptDefinitionSchema } from '../../src/scripts/model.ts';
import { checkProjectScript } from '../../src/scripts/check.ts';
import type { ScriptOperation } from '../../src/scripts/operations.ts';

const schemas={read_script:z.strictObject({scriptId:z.string().nullable()}),check_script:z.strictObject({script:scriptDefinitionSchema,target:z.strictObject({sceneId:z.string(),id:z.string()}).nullable().optional()})};
export const scriptToolDefinitions:ToolDefinition[]=Object.entries(schemas).map(([name,schema])=>({name,parameters:z.toJSONSchema(schema),description:name==='read_script'?'Read a project controller source, public fields, revision and all attached instances. null lists scripts.':'Compile and run a bounded smoke test of this JavaScript controller in the SAME isolated runtime as the editor. Returns a checkId to use in the final plan; no project changes are applied.'}));
export class ScriptTools {
  private checks=new Map<string,ScriptOperation & {type:'upsert_script'}>();
  private calls=0;
  constructor(private project:ProjectContent){}
  handles(name:string){return name in schemas;}
  async execute(name:string,raw:unknown){
    if(name==='read_script'){
      const {scriptId}=schemas.read_script.parse(raw);
      const scripts=this.project.scripts??[];
      if(!scriptId)return {result:{scripts:scripts.map(({id,name,revision,description})=>({id,name,revision,description}))}};
      const script=scripts.find(s=>s.id===scriptId);if(!script)throw new Error('Unknown project script.');
      return {result:{script,instances:this.project.scenes.flatMap(scene=>scene.objects.flatMap(object=>object.components?.filter(c=>c.type==='script'&&c.scriptId===scriptId).map(component=>({sceneId:scene.id,id:object.id,name:object.name,component}))??[]))}};
    }
    if(name!=='check_script')throw new Error('Unknown script tool.');
    if(++this.calls>4)throw new Error('Script check budget reached (4). Keep the current version and report the error.');
    const {script,target}=schemas.check_script.parse(raw),expectedRevision=this.project.scripts?.find(s=>s.id===script.id)?.revision??0;
    if(script.revision!==expectedRevision+1)throw new Error(`Use revision ${expectedRevision+1} for this script.`);
    const report=await checkProjectScript(script,this.project,target),checkId=`script-check-${this.calls}`;
    this.checks.set(checkId,{type:'upsert_script',sceneId:'',script,expectedRevision});
    return {result:{ok:true,checkId,scriptId:script.id,revision:script.revision,frames:report.frames,last:report.last,elapsedMs:report.elapsedMs,applied:false,scope:'Isolated synthetic keyboard smoke test; use the editor to judge feel and mouse interaction.'}};
  }
  operation(checkId:string,sceneId:string){const operation=this.checks.get(checkId);if(!operation)throw new Error('Check the script before proposing it.');return {...structuredClone(operation),sceneId};}
}
