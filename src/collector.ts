import type { Store } from './db.ts';
import type { Source } from './sources.ts';

export const BLOCK_BACKOFF_SECONDS = 6 * 3600;
const RETRY_DELAY_MS = 20_000;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

export type Fetcher = (source: Source) => Promise<string>;
export type RunResult = 'ok' | 'blocked' | 'backing-off' | 'error';

// Proxy URLs contain credentials, so only safe error details are kept.
function safeMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof SyntaxError) return 'Invalid JSON response';
  if (error instanceof Error) {
    const code = (error.cause as { code?: unknown } | undefined)?.code ?? (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    if (error.name === 'TimeoutError') return 'Timeout';
    if (error.message.startsWith('LemonGym')) return error.message;
    return error.name;
  }
  return 'Unknown error';
}

const isBlock = (e: unknown) => e instanceof HttpError && (e.status === 403 || e.status === 429);
const isPermanent = (e: unknown) =>
  isBlock(e) || (e instanceof HttpError && e.status < 500) || e instanceof SyntaxError;

export async function runSource(
  store: Store,
  source: Source,
  fetcher: Fetcher,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<RunResult> {
  const status = store.getStatus(source.id);
  if (status?.blockedUntil && status.blockedUntil > nowSeconds()) return 'backing-off';

  try {
    let body: string;
    try {
      body = await fetcher(source);
    } catch (error) {
      if (isPermanent(error)) throw error;
      await sleep(RETRY_DELAY_MS);
      body = await fetcher(source);
    }
    const readings = source.parse(body);
    const ts = nowSeconds();
    store.record(source.id, ts, readings);
    store.setStatus(source.id, { lastOk: ts, lastError: null, blockedUntil: null });
    return 'ok';
  } catch (error) {
    const lastError = safeMessage(error);
    if (isBlock(error)) {
      store.setStatus(source.id, { lastError, blockedUntil: nowSeconds() + BLOCK_BACKOFF_SECONDS });
      return 'blocked';
    }
    store.setStatus(source.id, { lastError });
    return 'error';
  }
}
