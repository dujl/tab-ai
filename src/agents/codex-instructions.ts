import { z } from 'zod';
import type { Session } from '../core/types.js';
import { agentInstructions } from '../core/channel-instructions.js';
import type { RpcProcess } from './rpc.js';

export async function prepareCodexInstructions(session: Session, rpc: RpcProcess): Promise<void> {
  return prepareAppServerInstructions(session, rpc, 'codex');
}

export async function prepareAppServerInstructions(
  session: Session,
  rpc: RpcProcess,
  provider: 'codex' | 'traecli',
): Promise<void> {
  const key =
    provider === 'traecli' ? 'traecliDeveloperInstructions' : 'codexDeveloperInstructions';
  if (!agentInstructions(session) || session[key] !== undefined) return;
  const loaded = z
    .object({ config: z.object({ developer_instructions: z.string().nullable().optional() }) })
    .parse(await rpc.request('config/read', { cwd: session.workspace, includeLayers: false }));
  // Existing snapshots are never rewritten or repeatedly appended to.
  session[key] = [loaded.config.developer_instructions, session.instructions]
    .filter(Boolean)
    .join('\n\n');
}
