/** App-owned request types. Provider SDK/HTTP types stay inside their adapter. */
export type AIContent = { type: 'text'; text: string } | { type: 'video'; dataUrl: string } | { type: 'image'; dataUrl: string };
export interface StructuredRequest {
  instructions: string;
  content: AIContent[];
  history?: { role: 'user' | 'assistant'; text: string }[];
  schema: Record<string, unknown>;
  schemaName: string;
  format?: 'json_schema' | 'json_object';
  signal?: AbortSignal;
  onOutput?(text: string): void;
}
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateObject(request: StructuredRequest): Promise<unknown>;
  generateToolTurn?(request: ToolRequest): Promise<ToolResponse>;
}

export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolRequest { instructions: string; input: unknown[]; tools: ToolDefinition[]; schema: Record<string, unknown>; signal?: AbortSignal }
export interface ToolResponse { output: unknown[]; calls: { id: string; name: string; arguments: string }[]; text: string }

export class AIError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) { super(message); }
}
