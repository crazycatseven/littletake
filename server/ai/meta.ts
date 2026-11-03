import { AIError, type AIContent, type AIProvider, type SegmentedFrame, type StructuredRequest, type ToolRequest, type ToolResponse } from './provider.ts';
import { segmentConcept } from '../reference/sam.ts';

interface MetaConfig { apiKey: string; model: string }

/** Muse's Responses API is the only place that knows Meta's wire format. */
export class MetaProvider implements AIProvider {
  readonly name = 'Meta';
  readonly model: string;
  constructor(private readonly config: MetaConfig, private readonly transport: typeof fetch = fetch) {
    this.model = config.model;
  }

  async generateObject(request: StructuredRequest): Promise<unknown> {
    const data = await this.respond({
      ...(request.reasoningEffort?{reasoning:{effort:request.reasoningEffort},max_output_tokens:20_000}:{}),
      ...(request.maxOutputTokens?{max_output_tokens:request.maxOutputTokens}:{}),
      instructions: request.format === 'json_object'
        ? `${request.instructions}\nReturn one JSON object conforming to this schema. The application validates every field and operation:\n${JSON.stringify(request.schema)}`
        : request.instructions,
      text: { format: request.format === 'json_object' ? { type: 'json_object' }
        : { type: 'json_schema', name: request.schemaName, strict: true, schema: request.schema } },
      input: [...(request.history ?? []).map(message => ({ type: 'message', role: message.role,
        content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.text }],
      })), { type: 'message', role: 'user', content: request.content.map(part => part.type === 'text'
        ? { type: 'input_text', text: part.text } : part.type === 'image' ? { type: 'input_image', image_url: part.dataUrl } : { type: 'input_video', video_url: part.dataUrl }) }],
    }, request.signal);
    const text = this.outputText(data);
    request.onOutput?.(text);
    if (data.status && data.status !== 'completed') throw new AIError('incomplete_response', 'Muse did not finish its response. Please try again.');
    try { if (!text) throw new Error(); return JSON.parse(text); }
    catch { throw new AIError('invalid_response', 'Muse did not return complete JSON. Please try again.'); }
  }

  async segmentMedia(media:Extract<AIContent,{type:'image'|'video'}>,concept:string,signal?:AbortSignal):Promise<SegmentedFrame[]>{
    return parseSAMRegions(await segmentConcept(concept, media, this.config.apiKey, this.transport, signal));
  }

  async generateToolTurn(request: ToolRequest): Promise<ToolResponse> {
    const data = await this.respond({ instructions: `${request.instructions}\nYour final reply must be JSON matching this schema:\n${JSON.stringify(request.schema)}`,
      input: request.input, text: { format: { type: 'json_object' } },
      ...(request.reasoningEffort?{reasoning:{effort:request.reasoningEffort},max_output_tokens:20_000}:{}),
      tools: request.tools.map(tool => ({ type: 'function', ...tool, strict: false })), parallel_tool_calls: request.parallelCalls??false,
    }, request.signal);
    request.onResponse?.(data);
    if (data.status && data.status !== 'completed') throw new AIError('incomplete_response', 'Muse did not finish its tool response.');
    return { output: data.output ?? [], calls: (data.output ?? []).filter(item => item.type === 'function_call').map(item => ({ id: item.call_id!, name: item.name!, arguments: item.arguments! })), text: this.outputText(data) };
  }

  private outputText(data: MetaResponse): string { return data.output_text ?? data.output?.flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join('') ?? ''; }

  private async respond(body: Record<string, unknown>, signal?: AbortSignal): Promise<MetaResponse> {
    let response: Response;
    try {
      response = await this.transport('https://api.meta.ai/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.any([AbortSignal.timeout(Number(body.max_output_tokens)>=32_000?165_000:150_000), ...(signal ? [signal] : [])]),
        body: JSON.stringify({
          model: this.model, store: false, reasoning: { effort: 'low' }, max_output_tokens: 10_000,
          ...body,
        }),
      });
    } catch (error) {
      if (error instanceof AIError) throw error;
      if (signal?.aborted) throw new AIError('cancelled', 'Request cancelled.', 499);
      throw new AIError('provider_unavailable', 'Muse could not finish the request. Please try again.', 504);
    }
    if (!response.ok) {
      // Never echo an upstream error body: it can contain request data or credentials.
      if (response.status === 402) throw new AIError('credits_required', 'Muse needs API credits before it can finish this request.', 503);
      if (response.status === 401 || response.status === 403) throw new AIError('provider_auth', 'Muse is not authorized on this server.', 503);
      if (response.status === 429) throw new AIError('rate_limited', 'Muse is busy. Please wait a moment and try again.', 429);
      throw new AIError('provider_error', 'Muse could not finish this request. Please try again.');
    }
    try { return await response.json(); } catch { throw new AIError('invalid_response', 'Muse returned an unreadable response. Please try again.'); }
  }
}

/** Parse only measured boxes; masks remain in the provider response and are not sent back to the editor. */
export function parseSAMRegions(text:string):SegmentedFrame[]{
  const frames:SegmentedFrame[]=[];
  for(const frame of text.matchAll(/<(\d+)f>([\s\S]*?)(?=<\d+f>|$)/g)){
    const regions:SegmentedFrame['regions']=[];
    for(const match of frame[2].matchAll(/(?:^|,)(\d+)<\|box;([^|]+)\|>/g)){
      const fields=Object.fromEntries(match[2].split(';').map(pair=>{const [key,value]=pair.split('=');return [key,Number(value)];})),{x1,y1,x2,y2,w,h,c=1}=fields;
      if(![x1,y1,x2,y2,w,h,c].every(Number.isFinite)||w<=0||h<=0||x1<0||y1<0||x2<x1||y2<y1||x2>=w||y2>=h||c<0||c>1)throw new AIError('invalid_segmentation','SAM returned invalid image coordinates.');
      regions.push({id:match[1],box:[x1/w,y1/h,(x2+1)/w,(y2+1)/h],confidence:c});
    }
    frames.push({index:Number(frame[1]),regions});
  }
  if(text.trim()&&!frames.length)throw new AIError('invalid_segmentation','SAM returned an unreadable measurement.');
  return frames;
}

interface MetaResponse { status?: string; output_text?: string; output?: { type?: string; call_id?: string; name?: string; arguments?: string; content?: { type?: string; text?: string }[] }[] }
