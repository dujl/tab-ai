import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
// A session-scoped endpoint. The caller guards each tool invocation against the
// current authorized work turn; no dashboard token is exposed to agents.
export async function capabilityBridge(
  name: string,
  register: (mcp: McpServer, call: <T>(fn: () => T | Promise<T>) => Promise<any>) => void,
  signal: AbortSignal,
) {
  const token = randomBytes(32).toString('hex');
  let closed = false;
  const servers = new Set<McpServer>();
  const server = createServer((req, res) => {
    void (async () => {
      const port = (server.address() as { port: number }).port;
      if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin || req.url !== '/mcp') {
        res.writeHead(403).end();
        return;
      }
      const supplied = Buffer.from(req.headers.authorization ?? ''),
        expected = Buffer.from(`Bearer ${token}`);
      if (
        closed ||
        signal.aborted ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        res.writeHead(401).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 150000) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
      const mcp = new McpServer({ name, version: '0.3.0' });
      servers.add(mcp);
      const call = async (fn: () => unknown | Promise<unknown>) => {
        try {
          signal.throwIfAborted();
          if (closed) throw new Error('工具已失效');
          const result = await fn();
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: error instanceof Error ? error.message : '任务操作失败',
              },
            ],
          };
        }
      };
      register(mcp, call);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.once('close', () => {
        servers.delete(mcp);
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, input);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(400).end('Invalid task request');
      else res.end();
    });
  });
  server.requestTimeout = 30000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', abort);
    await Promise.allSettled([...servers].map((s) => s.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const abort = () => {
    void close();
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) await close();
  return { url, token, close };
}
