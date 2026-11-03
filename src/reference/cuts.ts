import {scanReferenceShots} from './video';
/** Conversational references and reconstruction share original-timestamp adaptive cut detection. */
export async function detectCuts(src:string,duration:number,signal=new AbortController().signal):Promise<number[]>{return (await scanReferenceShots({dataUrl:src,duration,width:1,height:1},signal)).cuts;}
