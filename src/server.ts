import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Store } from './db.ts';
import { createReader } from './read.ts';

const STATIC_FILES: Record<string, [file: string, type: string, maxAge: number]> = {
  '/': ['index.html', 'text/html; charset=utf-8', 300],
  '/index.html': ['index.html', 'text/html; charset=utf-8', 300],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml', 86_400],
  '/manifest.json': ['manifest.json', 'application/manifest+json', 3600],
  '/icon-192.png': ['icon-192.png', 'image/png', 86_400],
  '/icon-512.png': ['icon-512.png', 'image/png', 86_400],
  '/og.png': ['og.png', 'image/png', 86_400],
};
const COMPRESSIBLE = /^(text\/|application\/json|application\/manifest|image\/svg)/;

export function createHandler(store: Store, publicDir: string, nowSeconds = () => Math.floor(Date.now() / 1000)) {
  const reader = createReader(store);
  const files = new Map(
    Object.entries(STATIC_FILES).map(([path, [file, type, maxAge]]) => {
      const raw = readFileSync(join(publicDir, file));
      return [path, { raw, gzip: COMPRESSIBLE.test(type) ? gzipSync(raw) : null, type, maxAge }];
    }),
  );

  function send(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    type: string,
    body: Buffer,
    cache: string,
    gzipped: Buffer | null = null,
  ) {
    const accepts = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const compressed = accepts && COMPRESSIBLE.test(type) ? (gzipped ?? (body.length > 512 ? gzipSync(body) : null)) : null;
    const payload = compressed ?? body;
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': payload.length,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Accept-Encoding',
      ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : payload);
  }

  const json = (req: IncomingMessage, res: ServerResponse, status: number, value: unknown, maxAge = 30) =>
    send(req, res, status, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(value)),
      maxAge ? `public, max-age=${maxAge}` : 'no-store');

  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const path = url.pathname;
    const now = nowSeconds();

    try {
      // Internal only: Caddy does not route this path.
      if (path === '/healthz') {
        const healthy = reader.healthy(now);
        return json(req, res, healthy ? 200 : 503, { healthy, sources: store.allStatuses() }, 0);
      }
      if (path === '/api/health') {
        const healthy = reader.healthy(now);
        return json(req, res, healthy ? 200 : 503, { healthy }, 0);
      }
      if (path === '/api/overview') return json(req, res, 200, reader.overview(now));

      const match = /^\/api\/clubs\/([a-z0-9-]{1,64})$/.exec(path);
      if (match) {
        const raw = url.searchParams.get('days') ?? '1';
        if (raw !== '1' && raw !== '7' && raw !== '30') return json(req, res, 400, { error: 'days must be 1, 7 or 30' }, 0);
        const data = reader.club(match[1]!, Number(raw) as 1 | 7 | 30, now);
        return data ? json(req, res, 200, data) : json(req, res, 404, { error: 'Unknown club' }, 0);
      }

      const file = files.get(path);
      if (file) return send(req, res, 200, file.type, file.raw, `public, max-age=${file.maxAge}`, file.gzip);
      return json(req, res, 404, { error: 'Not found' }, 0);
    } catch (error) {
      console.error(JSON.stringify({ at: new Date().toISOString(), requestError: error instanceof Error ? error.name : 'Unknown', path }));
      if (!res.headersSent) json(req, res, 500, { error: 'Internal error' }, 0);
      else res.destroy();
    }
  };
}
