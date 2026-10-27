/** App-owned request types. Provider SDK/HTTP types stay inside their adapter. */
export type AIContent = { type: 'text'; text: string } | { type: 'video'; dataUrl: string };
export interface StructuredRequest {
  instructions: string;
  content: AIContent[];
  schema: Record<string, unknown>;
  schemaName: string;
  signal?: AbortSignal;
}
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateObject(request: StructuredRequest): Promise<unknown>;
}

export class AIError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) { super(message); }
}
