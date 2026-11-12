// Optional LAN entry point; keeps the daemon on loopback and preserves its bearer authentication.
// Usage: node scripts/dashboard-lan.mjs <local-LAN-IPv4> [port]
import { createServer, request } from 'node:http';
import { networkInterfaces } from 'node:os';
const host = process.argv[2];
const port = Number(process.argv[3] || 4317);
const local = Object.values(networkInterfaces())
  .flat()
  .some((a) => a && a.family === 'IPv4' && !a.internal && a.address === host);
const privateAddress = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host || '');
if (!local || !privateAddress || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Specify this machine’s private LAN IPv4 address and a valid dashboard port.');
}
const authority = `${host}:${port}`;
const upstream = `127.0.0.1:${port}`;
const server = createServer((req, res) => {
  if (
    req.headers.host !== authority ||
    (req.headers.origin && req.headers.origin !== `http://${authority}`)
  ) {
    res.writeHead(403);
    res.end('Invalid host or origin');
    return;
  }
  if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
    res.writeHead(400);
    res.end('Invalid path');
    return;
  }
  const headers = { ...req.headers, host: upstream };
  if (headers.origin) headers.origin = `http://${upstream}`;
  delete headers.forwarded;
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-for'];
  const proxy = request(
    { hostname: '127.0.0.1', port, method: req.method, path: req.url, headers },
    (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    },
  );
  proxy.setTimeout(30_000, () => proxy.destroy(new Error('Upstream timeout')));
  proxy.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('Dashboard unavailable');
  });
  req.on('aborted', () => proxy.destroy());
  res.on('close', () => {
    if (!res.writableEnded) proxy.destroy();
  });
  req.pipe(proxy);
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(port, host, () => console.log(`Dashboard LAN entry: http://${authority}`));
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => server.close(() => process.exit(0)));
