/** Request data and model output only. Never include HTTP headers or provider configuration. */
export interface SceneEditDiagnostic {
  format: 'LittleTake.scene-edit-diagnostic'; version: 1; id: string; startedAt: string;
  input?: unknown; provider?: string; model?: string;
  attempts: {
    request: { instructions: string; content: unknown; history: unknown; schema: unknown; schemaName: string; format?: 'json_object' | 'json_schema' };
    rawOutput?: string; rawProposal?: unknown; error?: { code: string; message: string };
  }[];
  outcome?: 'ready' | 'needs_views' | 'failed'; error?: { code: string; message: string };
  toolCalls?: { name: string; arguments: string; startedAt: string; finishedAt?: string; result?: unknown; error?: string }[];
  toolTurns?: { input: unknown; output: unknown }[];
}

export function newDiagnostic(): SceneEditDiagnostic {
  return { format: 'LittleTake.scene-edit-diagnostic', version: 1, id: crypto.randomUUID(), startedAt: new Date().toISOString(), attempts: [] };
}
