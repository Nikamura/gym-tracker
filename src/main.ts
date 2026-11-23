import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, fetch } from 'undici';
import { HttpError, runSource, type Fetcher } from './collector.ts';
import { openStore } from './db.ts';
import { applyRetention } from './retention.ts';
import { createHandler } from './server.ts';
import { SOURCES } from './sources.ts';

const INTERVAL_MS = 15 * 60_000;
const MAX_JITTER_MS = 90_000;
const RETENTION_INTERVAL_MS = 24 * 3600_000;

// Fail closed: without a proxy the collector refuses to run, so requests can
// never leave from the home IP.
const proxyUrl = process.env.PROXY_URL;
if (!proxyUrl) {
  console.error('PROXY_URL is required');
  process.exit(1);
}
let dispatcher: ProxyAgent;
try {
  dispatcher = new ProxyAgent(proxyUrl);
} catch {
  // The error object would contain the credential-bearing URL.
  console.error('PROXY_URL is invalid');
  process.exit(1);
}

const MAX_RESPONSE_BYTES = 5_000_000;

async function readLimited(body: AsyncIterable<Uint8Array> | null): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body ?? []) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error('Response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const fetcher: Fetcher = async (source) => {
  const res = await fetch(source.url, {
    ...source.init,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache', ...source.init?.headers },
    dispatcher,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new HttpError(res.status);
  return readLimited(res.body as AsyncIterable<Uint8Array> | null);
};

const store = openStore(process.env.DB_PATH ?? 'db/gym-tracker.sqlite');
const log = (event: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

async function collect() {
  for (const source of SOURCES) {
    const result = await runSource(store, source, fetcher);
    log({ source: source.id, result, error: store.getStatus(source.id)?.lastError ?? undefined });
  }
}

function retain() {
  try {
    log({ retention: applyRetention(store) });
  } catch (error) {
    log({ retentionError: error instanceof Error ? error.name : 'Unknown' });
  }
}

const server = createServer(createHandler(store, fileURLToPath(new URL('../public', import.meta.url))));
server.listen(8080);

let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    wake?.();
  });
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

retain();
let lastRetention = Date.now();
await collect();
while (!stopping) {
  const nextSlot = Math.ceil((Date.now() + 1) / INTERVAL_MS) * INTERVAL_MS;
  await wait(nextSlot - Date.now() + Math.random() * MAX_JITTER_MS);
  if (stopping) break;
  await collect();
  if (Date.now() - lastRetention >= RETENTION_INTERVAL_MS) {
    retain();
    lastRetention = Date.now();
  }
}

server.close();
await dispatcher.close();
store.close();
