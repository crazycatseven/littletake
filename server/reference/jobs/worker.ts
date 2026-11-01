import {chromium,type BrowserContext} from 'playwright-core';
import type {ReferenceJobStore} from './store.ts';
import {referenceFramingMatches} from '../../../src/reference/review.ts';
import {MIN_REFERENCE_SCORE} from '../../../src/reference/analysis.ts';
import type {ReferenceDraft} from '../../../src/reference/types.ts';
import type {ReferenceRun} from '../../../src/reference/workflow.ts';

/** A single worker owns the browser and scene work; client connections only observe it. */
export class ReferenceWorker{
  private working=false;
  private stopping=false;
  private running?:Promise<void>;
  private active?:{id:string;context?:BrowserContext;controller:AbortController};
  constructor(readonly store:ReferenceJobStore,private origin:string,private key:string){}
  signal(id:string){return this.active?.id===id?this.active.controller.signal:undefined;}
  kick(){if(!this.working&&!this.stopping)this.running=this.drain();}
  async cancel(id:string){this.store.get(id);this.store.finish(id,'cancelled','Analysis cancelled');if(this.active?.id===id){this.active.controller.abort();await this.active.context?.close();}}
  async stop(){this.stopping=true;this.active?.controller.abort();await this.active?.context?.close();await this.running;}
  private async drain(){
    this.working=true;
    try{for(let job=!this.stopping?this.store.claim():undefined;job;job=!this.stopping?this.store.claim():undefined){
      this.active={id:job.id,controller:new AbortController()};let browser;
      try{
        const channel=process.env.REFERENCE_CHROME_CHANNEL??(process.platform==='win32'?'chrome':undefined);
        browser=await chromium.launch({headless:true,...(process.env.REFERENCE_CHROME_PATH?{executablePath:process.env.REFERENCE_CHROME_PATH}:channel?{channel}:{}),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
        this.active.controller.signal.throwIfAborted();
        const context=await browser.newContext({viewport:{width:1280,height:900},extraHTTPHeaders:{Authorization:'Bearer '+this.key,'X-LittleTake-Job':job.id}});this.active.context=context;
        this.active.controller.signal.throwIfAborted();
        const page=await context.newPage();await page.exposeFunction('referenceCheckpoint',(run:ReferenceRun)=>this.store.checkpoint(job.id,run));await page.exposeFunction('referenceProgress',(message:string)=>this.store.progress(job.id,message));
        page.on('pageerror',error=>this.store.progress(job.id,'Renderer error: '+error.message.slice(0,150)));
        await page.goto(this.origin+'/src/reference/runner/index.html');await page.waitForFunction(()=>typeof window.executeReferenceJob==='function',undefined,{timeout:30_000});
        const {input,run}=this.store.payload(job.id),result=await page.evaluate(async({input,run})=>window.executeReferenceJob(input,run),{input,run}) as ReferenceDraft;
        const saved=this.store.payload(job.id).run,last=saved.attempts.at(-1);
        if(!result.quality?.approved||result.quality.issues.length||Object.values(result.quality.scores).some(score=>score<MIN_REFERENCE_SCORE)||!last?.video||!referenceFramingMatches(last.measurements)||JSON.stringify(saved.result)!==JSON.stringify(result))throw new Error('The scene has not passed the saved motion and framing review.');
        this.store.finish(job.id,'succeeded','Scene ready · visual review passed');
      }catch(error){if(!this.stopping&&this.store.get(job.id).status!=='cancelled'){const saved=this.store.payload(job.id).run,message=saved.error??(error instanceof Error?error.message.split('\n')[0].replace(/^page.evaluate:\s*(?:Error:\s*)?/,''):'The background task stopped.');this.store.finish(job.id,'failed','Analysis did not pass; evidence retained',message.slice(0,500));}}
      finally{await browser?.close();this.active=undefined;}
    }}finally{this.working=false;}
  }
}
