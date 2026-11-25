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
const traecliBreakdown = tokenBreakdownSchema
  .extend({ cacheCreationInputTokens: count.optional() })
  .transform(({ cacheCreationInputTokens, ...value }) => ({
    ...value,
    ...(cacheCreationInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: cacheCreationInputTokens }),
  }));
const traecliSchema = codexSchema.extend({
  tokenUsage: codexSchema.shape.tokenUsage.extend({
    last: traecliBreakdown,
    total: traecliBreakdown,
  }),
});

export function codexUsage(params: unknown, nativeId?: string): AgentUsage | undefined {
  return appServerUsage(params, nativeId, 'codex');
}
export function appServerUsage(
  params: unknown,
  nativeId: string | undefined,
  provider: 'codex' | 'traecli',
): AgentUsage | undefined {
  const parsed = (provider === 'traecli' ? traecliSchema : codexSchema).safeParse(params);
  if (!parsed.success || parsed.data.threadId !== nativeId) return;
  const value = parsed.data.tokenUsage;
  return {
    source: provider,
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

const agyContextSchema = z.object({
  used: count,
  size: count.positive().optional(),
});
const agyPromptUsageSchema = z
  .object({
    inputTokens: count.optional(),
    input_tokens: count.optional(),
    outputTokens: count.optional(),
    output_tokens: count.optional(),
    cachedReadTokens: count.optional(),
    cache_read_tokens: count.optional(),
    cachedWriteTokens: count.optional(),
    cache_write_tokens: count.optional(),
    thoughtTokens: count.optional(),
    thinking_tokens: count.optional(),
    totalTokens: count.optional(),
    total_tokens: count.optional(),
  })
  .passthrough();

export function agyContextUsage(update: unknown): AgentUsage | undefined {
  const parsed = agyContextSchema.safeParse(update);
  if (!parsed.success) return;
  return {
    source: 'agy',
    contextTokens: parsed.data.used,
    contextKind: 'native',
    ...(parsed.data.size ? { modelContextWindow: parsed.data.size } : {}),
  };
}

export function agyUsage(
  usage: unknown,
  context?: { contextTokens?: number; modelContextWindow?: number },
): AgentUsage | undefined {
  const parsed = agyPromptUsageSchema.safeParse(usage);
  if (!parsed.success) return;
  const v = parsed.data;
  const input = v.inputTokens ?? v.input_tokens;
  const output = v.outputTokens ?? v.output_tokens;
  if (input === undefined || output === undefined) return;
  const cached = v.cachedReadTokens ?? v.cache_read_tokens ?? 0;
  const cacheWrite = v.cachedWriteTokens ?? v.cache_write_tokens;
  const thought = v.thoughtTokens ?? v.thinking_tokens;
  const total = v.totalTokens ?? v.total_tokens;
  const totalOutput = thought !== undefined && output < thought ? output + thought : output;
  const last: TokenBreakdown = {
    inputTokens: input,
    cachedInputTokens: Math.min(cached, input),
    outputTokens: totalOutput,
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
    ...(thought === undefined ? {} : { reasoningOutputTokens: thought }),
    ...(total === undefined ? {} : { totalTokens: total }),
  };
  return {
    source: 'agy',
    last,
    ...(context?.contextTokens === undefined
      ? {
          contextTokens: input + (cacheWrite ?? 0) + totalOutput,
          contextKind: 'last-call' as const,
        }
      : { contextTokens: context.contextTokens, contextKind: 'native' as const }),
    ...(context?.modelContextWindow ? { modelContextWindow: context.modelContextWindow } : {}),
  };
}
