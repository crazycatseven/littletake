import { z } from 'zod';
import { operationSchema } from './operations.ts';

export const MAX_HISTORY_MESSAGES = 200;
export const MAX_HISTORY_CHARACTERS = 120_000;
export const conversationHistorySchema = z.array(z.strictObject({
  role: z.enum(['user', 'assistant']), text: z.string().min(1).max(32_000),
})).max(MAX_HISTORY_MESSAGES).refine(messages => messages.reduce((n, m) => n + m.text.length, 0) <= MAX_HISTORY_CHARACTERS);
export type ConversationHistory = z.infer<typeof conversationHistorySchema>;

const identifier = z.string().min(1).max(64);
const userMessageSchema = z.strictObject({
  id: identifier, role: z.literal('user'), text: z.string().min(1).max(2000),
  status: z.enum(['pending', 'answered', 'failed', 'stopped']), detail: z.string().max(500).optional(),
  context: z.strictObject({ sceneId: identifier.nullable(), shotId: identifier.nullable(), selectedId: identifier.nullable().optional(), time: z.number().min(0).max(60).optional() }).optional(),
});
const assistantMessageSchema = z.strictObject({
  id: identifier, role: z.literal('assistant'), text: z.string().min(1).max(4000), model: z.string().max(160),
  edit: z.strictObject({
    operations: z.array(operationSchema).min(1).max(64), time: z.number().min(0).max(60),
    sceneId: identifier.nullable(), shotId: identifier.nullable(),
    revision: z.number().int().nonnegative(), status: z.enum(['pending', 'applied', 'discarded', 'stale']),
  }).optional(),
});
export const conversationsSchema = z.strictObject({
  activeId: identifier,
  threads: z.array(z.strictObject({
    id: identifier, title: z.string().min(1).max(120), draft: z.string().max(2000),
    messages: z.array(z.discriminatedUnion('role', [userMessageSchema, assistantMessageSchema])),
  })).min(1),
}).superRefine((book, ctx) => {
  const ids = book.threads.map(t => t.id), messages = book.threads.flatMap(t => t.messages.map(m => m.id));
  if (!ids.includes(book.activeId) || new Set(ids).size !== ids.length || new Set(messages).size !== messages.length)
    ctx.addIssue({ code: 'custom', message: 'Conversation IDs are inconsistent.' });
});
export type ConversationBook = z.infer<typeof conversationsSchema>;
export type Conversation = ConversationBook['threads'][number];
export type ChatMessage = Conversation['messages'][number];
export type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;
export type UserMessage = Extract<ChatMessage, { role: 'user' }>;

export function newConversation(): Conversation {
  return { id: crypto.randomUUID(), title: 'New conversation', draft: '', messages: [] };
}
export function createConversations(): ConversationBook {
  const thread = newConversation();
  return { activeId: thread.id, threads: [thread] };
}
export function conversationHistory(messages: ChatMessage[]): ConversationHistory {
  const history = messages.map(message => ({
    role: message.role,
    text: message.role === 'assistant' && message.edit
      ? JSON.stringify({ summary: message.text, operations: message.edit.operations.map(operation => operation.type === 'instantiate_asset'
          ? { ...operation, asset: { id: operation.asset.id, version: operation.asset.version, name: operation.asset.name } } : operation), applicationStatus: message.edit.status })
      : message.role === 'user' && (message.status === 'failed' || message.status === 'stopped')
        ? `${message.text}\n[This earlier request was ${message.status}; no changes were applied by it.]`
        : message.role === 'user' && message.context ? JSON.stringify({ message: message.text, context: message.context }) : message.text,
  }));
  if (!conversationHistorySchema.safeParse(history).success)
    throw new Error('This conversation is too long for another request. Start a new conversation; your saved history is kept.');
  return history;
}
