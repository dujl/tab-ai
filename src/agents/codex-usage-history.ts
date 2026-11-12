import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { codexUsage } from './token-usage.js';
import type { NativeUsageSnapshot, Session } from '../core/types.js';

const limit = 4 * 1024 * 1024;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
// Read only native metadata and token_count events. Never start/resume a model turn.
export class CodexUsageHistory {
  private paths = new Map<string, string>();
  private cache = new Map<string, { signature: string; value?: NativeUsageSnapshot }>();
  private indexedAt = 0;
  constructor(private home = process.env.CODEX_HOME || join(homedir(), '.codex')) {}
  private locate(id: string): string | undefined {
    const known = this.paths.get(id);
    if (known) return known;
    const databases = readdirSync(this.home)
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const database of databases) {
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(join(this.home, database), { readOnly: true });
        const row = db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id);
        if (typeof row?.rollout_path === 'string') {
          this.paths.set(id, row.rollout_path);
          return row.rollout_path;
        }
      } catch {
        /* Native database versions are not a framework schema contract. */
      } finally {
        db?.close();
      }
    }
    if (Date.now() - this.indexedAt > 30000) {
      this.indexedAt = Date.now();
      const walk = (dir: string, depth: number) => {
        if (depth > 5) return;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            const candidate = entry.name.slice(-42, -6);
            if (uuid.test(candidate)) this.paths.set(candidate, join(dir, entry.name));
          }
        }
      };
      walk(join(this.home, 'sessions'), 0);
      walk(join(this.home, 'archived_sessions'), 0);
    }
    return this.paths.get(id);
  }
  read(session: Session): NativeUsageSnapshot | undefined {
    if (session.agent !== 'codex' || !session.nativeId || !uuid.test(session.nativeId)) return;
    let fd: number | undefined;
    try {
      const path = this.locate(session.nativeId);
      if (!path) return;
      const canonical = realpathSync(path),
        home = realpathSync(this.home),
        rel = relative(home, canonical);
      if (
        isAbsolute(rel) ||
        rel.startsWith('..' + sep) ||
        !['sessions', 'archived_sessions'].includes(rel.split(sep)[0]!)
      )
        return;
      const stat = statSync(canonical);
      if (!stat.isFile()) return;
      const signature = `${canonical}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cached = this.cache.get(session.nativeId);
      if (cached?.signature === signature) return cached.value;
      fd = openSync(canonical, 'r');
      const head = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
      const headSize = readSync(fd, head, 0, head.length, 0),
        newline = head.subarray(0, headSize).indexOf(10);
      if (newline < 0) return;
      const meta = JSON.parse(head.subarray(0, newline).toString('utf8'));
      if (meta.type !== 'session_meta' || meta.payload?.id !== session.nativeId) return;
      const start = Math.max(0, stat.size - limit),
        tail = Buffer.alloc(Math.min(stat.size, limit));
      const size = readSync(fd, tail, 0, tail.length, start);
      const text = tail.subarray(0, size).toString('utf8');
      const lines = (start ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
      let value: NativeUsageSnapshot | undefined, compactedAt: number | undefined;
      for (const line of lines) {
        try {
          const event = JSON.parse(line),
            at = Date.parse(event.timestamp);
          if (!Number.isFinite(at)) continue;
          if (event.type === 'compacted') {
            compactedAt = at;
            if (value) {
              delete value.value.contextTokens;
              value.contextInvalidated = true;
            }
          }
          if (
            event.type !== 'event_msg' ||
            event.payload?.type !== 'token_count' ||
            !event.payload.info
          )
            continue;
          const info = event.payload.info;
          const breakdown = (b: any) =>
            b && {
              inputTokens: b.input_tokens,
              cachedInputTokens: b.cached_input_tokens,
              cacheWriteInputTokens: b.cache_write_input_tokens,
              outputTokens: b.output_tokens,
              reasoningOutputTokens: b.reasoning_output_tokens,
              totalTokens: b.total_tokens,
            };
          const usage = codexUsage(
            {
              threadId: session.nativeId,
              tokenUsage: {
                last: breakdown(info.last_token_usage),
                total: breakdown(info.total_token_usage),
                modelContextWindow: info.model_context_window,
              },
            },
            session.nativeId,
          );
          if (usage)
            value = { nativeId: session.nativeId, at, value: usage, origin: 'native-history' };
        } catch {
          /* Ignore incomplete appends and unrelated native records. */
        }
      }
      if (value && compactedAt !== undefined) value.compactedAt = compactedAt;
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(session.nativeId, { signature, value });
      return value;
    } catch {
      // Missing, locked or incompatible native history must not break management.
      this.paths.delete(session.nativeId);
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
