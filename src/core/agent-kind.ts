import { z } from 'zod';
import { agentKind } from './types.js';

// Normalize aliases only at explicit provider-selection boundaries.
export const agentKindSchema = z.string().transform((value, ctx) => {
  try {
    return agentKind(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});
