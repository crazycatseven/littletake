/** App-owned request types. Provider SDK/HTTP types stay inside their adapter. */
export type AIContent = { type: 'text'; text: string } | { type: 'video'; dataUrl: string } | { type: 'image'; dataUrl: string;reference?:boolean;provenance?:{dataRef:string;transform:Record<string,unknown>} };
export interface StructuredRequest {
  instructions: string;
  content: AIContent[];
  history?: { role: 'user' | 'assistant'; text: string }[];
  schema: Record<string, unknown>;
  schemaName: string;
  format?: 'json_schema' | 'json_object';
  signal?: AbortSignal;
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxOutputTokens?: number;
  webSearch?: boolean;
  onResponse?(response: unknown): void;
  onOutput?(text: string): void;
}
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateObject(request: StructuredRequest): Promise<unknown>;
  generateToolTurn?(request: ToolRequest): Promise<ToolResponse>;
  generateImage?(request: { prompt: string; references?: AIContent[]; signal?: AbortSignal; onResponse?(response: unknown): void }): Promise<{ image: string; model: string }>;
  segmentMedia?(media:Extract<AIContent,{type:'image'|'video'}>,concept:string,signal?:AbortSignal):Promise<SegmentedFrame[]>;
}
export interface SegmentedFrame {index:number;regions:{id:string;box:[number,number,number,number];confidence:number}[]}

export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolRequest { instructions: string; input: unknown[]; tools: ToolDefinition[]; schema: Record<string, unknown>; signal?: AbortSignal; reasoningEffort?:StructuredRequest['reasoningEffort']; parallelCalls?:boolean;onResponse?(response:unknown):void }
export interface ToolResponse { output: unknown[]; calls: { id: string; name: string; arguments: string }[]; text: string }

export class AIError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) { super(message); }
}
