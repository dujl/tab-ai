import { z } from 'zod';
import { tokenBreakdownSchema } from '../core/token-usage.js';
import type { AgentUsage, TokenBreakdown } from '../core/types.js';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const codexSchema = z.object({
  threadId: z.string(),
  tokenUsage: z.object({
    last: tokenBreakdownSchema,
    total: tokenBreakdownSchema,
    modelContextWindow: count.positive().nullish(),
  }),
});
export function codexUsage(params: unknown, nativeId?: string): AgentUsage | undefined {
  const parsed = codexSchema.safeParse(params);
  if (!parsed.success || parsed.data.threadId !== nativeId) return;
  const value = parsed.data.tokenUsage;
  return {
    source: 'codex',
    last: value.last,
    total: value.total,
    totalScope: 'session',
    ...(value.last.totalTokens === undefined
      ? {}
      : { contextTokens: value.last.totalTokens, contextKind: 'native' }),
    ...(value.modelContextWindow ? { modelContextWindow: value.modelContextWindow } : {}),
  };
}
const claudeLast = z.object({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count.nullish(),
  cache_creation_input_tokens: count.nullish(),
});
const claudeModel = z.object({
  inputTokens: count,
  outputTokens: count,
  cacheReadInputTokens: count,
  cacheCreationInputTokens: count,
  contextWindow: count.positive().optional(),
});
export function claudeUsage(message: unknown): AgentUsage | undefined {
  const m = message as any;
  if (m?.type === 'assistant' && !m.parent_tool_use_id) {
    const p = claudeLast.safeParse(m.message?.usage);
    if (p.success) {
      const v = p.data,
        input = v.input_tokens + (v.cache_read_input_tokens ?? 0);
      return {
        source: 'claude',
        last: {
          inputTokens: input,
          cachedInputTokens: v.cache_read_input_tokens ?? 0,
          cacheWriteInputTokens: v.cache_creation_input_tokens ?? 0,
          outputTokens: v.output_tokens,
        },
        contextTokens: input + (v.cache_creation_input_tokens ?? 0) + v.output_tokens,
        contextKind: 'last-call',
      };
    }
  }
  if (m?.type === 'result' && m.subtype === 'success' && !m.is_error) {
    const p = z.record(z.string(), claudeModel).safeParse(m.modelUsage);
    if (p.success && Object.keys(p.data).length) {
      const total: TokenBreakdown = {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
      };
      for (const v of Object.values(p.data)) {
        total.inputTokens += v.inputTokens + v.cacheReadInputTokens;
        total.cachedInputTokens += v.cacheReadInputTokens;
        total.cacheWriteInputTokens! += v.cacheCreationInputTokens;
        total.outputTokens += v.outputTokens;
      }
      const entries = Object.values(p.data);
      return {
        source: 'claude',
        total,
        totalScope: 'query',
        ...(entries.length === 1 && entries[0]!.contextWindow
          ? { modelContextWindow: entries[0]!.contextWindow }
          : {}),
      };
    }
  }
}
const openCodeTokens = z.object({
  input: count,
  output: count,
  reasoning: count.optional(),
  cache: z.object({ read: count, write: count }),
});
export function openCodeUsage(info: unknown): AgentUsage | undefined {
  const p = z.object({ tokens: openCodeTokens }).safeParse(info);
  if (!p.success) return;
  const v = p.data.tokens;
  // Reasoning is kept separate by OpenCode; include it once in output for our common representation.
  const output = v.output + (v.reasoning ?? 0);
  return {
    source: 'opencode',
    last: {
      inputTokens: v.input + v.cache.read,
      cachedInputTokens: v.cache.read,
      cacheWriteInputTokens: v.cache.write,
      outputTokens: output,
      ...(v.reasoning === undefined ? {} : { reasoningOutputTokens: v.reasoning }),
    },
    contextTokens: v.input + v.cache.read + v.cache.write + output,
    contextKind: 'last-call',
  };
}
