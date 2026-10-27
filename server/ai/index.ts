import { MetaProvider } from './meta.ts';
import { AIError, type AIProvider } from './provider.ts';

export type AIEnvironment = Record<string, string | undefined>;

export function aiConnection(env: AIEnvironment) {
  const provider = env.AI_PROVIDER || 'meta';
  return {
    available: provider === 'meta' && Boolean(env.MODEL_API_KEY?.trim()),
    provider: provider === 'meta' ? 'Meta' : provider,
    model: env.MUSE_MODEL || 'muse-spark-1.3',
  };
}

/** Add another adapter here; the reference workflow and editor do not change. */
export function createAIProvider(env: AIEnvironment, transport: typeof fetch = fetch): AIProvider {
  const connection = aiConnection(env);
  if (!connection.available) throw new AIError('not_configured', 'AI analysis is not configured on this server. You can keep editing your scene.', 503);
  return new MetaProvider({ apiKey: env.MODEL_API_KEY!.trim(), model: connection.model }, transport);
}
