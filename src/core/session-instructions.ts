import { z } from 'zod';

// Whitespace in actual instructions is preserved; only an all-whitespace value means empty.
export const instructionsSchema = z
  .string()
  .max(16_000, '附加指令最多 16000 字符')
  .refine((value) => !value.includes('\0'), '附加指令不能包含 NUL 字符');
export function sessionInstructions(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const text = instructionsSchema.parse(value);
  return text.trim() ? text : undefined;
}

// --instructions consumes the rest verbatim, including newlines. No shell evaluation.
export function creationOptions(text: string): { args: string[]; instructions?: string } {
  const match = /(?:^|\s)--instructions(?:[ \t]|\r?\n|$)/.exec(text);
  const head = match ? text.slice(0, match.index) : text;
  const args = head.trim().split(/\s+/).slice(2);
  if (args.length > 2 || args.some((arg) => arg.startsWith('--')))
    throw new Error('用法：/tab new [codex|claude|opencode] [工作区] --instructions 附加指令');
  return {
    args,
    ...(match
      ? { instructions: instructionsSchema.parse(text.slice(match.index + match[0].length)) }
      : {}),
  };
}
