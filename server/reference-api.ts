import { MAX_REFERENCE_BODY_BYTES, type ReferenceDraft, type ReferenceInput } from '../src/reference/types.ts';
import { aiConnection, createAIProvider, type AIEnvironment } from './ai/index.ts';
import { AIError, type AIProvider } from './ai/provider.ts';
import { analyzeReference, parseReferenceInput } from './reference/analyze.ts';
import { newDiagnostic,compactDiagnosticMedia } from '../src/scene-edit/diagnostics.ts';
import { AssetLibrary } from './assets/library.ts';


const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export async function readReferenceJSON(request: Request,limit=MAX_REFERENCE_BODY_BYTES): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AIError('invalid_input', 'Send a JSON video request.', 415);
  if (Number(request.headers.get('content-length')) > limit) throw new AIError('video_too_large', 'This first version accepts clips up to 3 MB.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AIError('invalid_input', 'Choose a reference clip first.', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new AIError('video_too_large', 'This first version accepts clips up to 3 MB.', 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError('invalid_input', 'The reference request could not be read.', 400);
  } finally { reader.releaseLock(); }
}

export function createReferenceHandler(env: AIEnvironment = process.env, providerFactory = (): AIProvider => createAIProvider(env), beforeCall?: (request: Request) => void) {
  const library=new AssetLibrary(env.LITTLETAKE_ASSET_DIR);

  return async (request: Request): Promise<Response> => {
    if (request.method === 'GET') return json(aiConnection(env));
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    const diagnostic=newDiagnostic('reference');let input:ReferenceInput|undefined;
    try {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) throw new AIError('wrong_origin', 'Open LittleTake directly to analyze a clip.', 403);
      input = parseReferenceInput(await readReferenceJSON(request));
      const httpRequest = request;
      const provider=providerFactory();diagnostic.provider=provider.name;diagnostic.model=provider.model;
      const traced:AIProvider={name:provider.name,model:provider.model,async generateObject(request){
        beforeCall?.(httpRequest);
        const attempt={request:{instructions:request.instructions,content:request.content,history:request.history??[],schema:request.schema,schemaName:request.schemaName,format:request.format,reasoningEffort:request.reasoningEffort,maxOutputTokens:request.maxOutputTokens}} as typeof diagnostic.attempts[number];diagnostic.attempts.push(attempt);
        try{const result=await provider.generateObject({...request,onOutput:text=>{attempt.rawOutput=text;}});attempt.rawProposal=result;return result;}
        catch(error){attempt.error={code:error instanceof AIError?error.code:'analysis_failed',message:error instanceof AIError?error.message:'Reference request failed.'};throw error;}
      },...(provider.generateToolTurn?{async generateToolTurn(request){beforeCall?.(httpRequest);return provider.generateToolTurn!(request);}}:{}),...(provider.segmentMedia?{async segmentMedia(media,concept,signal){beforeCall?.(httpRequest);const frames=await provider.segmentMedia!(media,concept,signal);(diagnostic.measurements??=[]).push({model:'sam-3.1',concept,media:'source frame atlas',frames});return frames;}}:{})};
      const draft = await analyzeReference(input, traced, request.signal,library,diagnostic);diagnostic.outcome='ready';
      return json({...draft,diagnostic:diagnosticMedia(diagnostic,input)});

    } catch (error) {
      const detail=error instanceof AIError?{code:error.code,message:error.message}:{code:'analysis_failed',message:'The clip could not be analyzed. Your current scene is unchanged.'};diagnostic.outcome='failed';diagnostic.error=detail;
      return json({error:detail,diagnostic:diagnosticMedia(diagnostic,input)},error instanceof AIError?error.status:500);
    }
  };
}

/** Keep exact media once, using input references for pixels the client already preserved. */
function diagnosticMedia(diagnostic:ReturnType<typeof newDiagnostic>,input?:ReferenceInput){
  const refs=new Map<string,string>();
  if(input&&'image' in input)refs.set(input.image.dataUrl,'input.image.dataUrl');
  if(input&&'video' in input){refs.set(input.video.dataUrl,'input.video.dataUrl');if(input.source){refs.set(input.source.contactSheet,'input.source.contactSheet');if(input.source.detailSheet)refs.set(input.source.detailSheet,'input.source.detailSheet');input.source.frames.forEach((frame,i)=>refs.set(frame.dataUrl,`input.source.frames[${i}].dataUrl`));}if(input.review){refs.set(input.review.contactSheet,'input.review.contactSheet');if(input.review.video)refs.set(input.review.video,'input.review.video');if(input.review.layoutSheet)refs.set(input.review.layoutSheet,'input.review.layoutSheet');}if(input.repair){if(input.repair.contactSheet)refs.set(input.repair.contactSheet,'input.repair.contactSheet');if(input.repair.layoutSheet)refs.set(input.repair.layoutSheet,'input.repair.layoutSheet');}}
  return compactDiagnosticMedia(diagnostic,refs);
}
