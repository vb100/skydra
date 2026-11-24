import { createHash } from 'node:crypto';
import type { ProviderExchange } from './provider';

/**
 * One provider call with the reliability rules of the client specification: 15 s per attempt,
 * up to 3 attempts with growing waits (0.5 s, then 1 s) when there is no answer, the provider is
 * rate limiting (429) or failing (5xx). Any other answer is final. Every attempt is returned as
 * an exchange for screening_requests; credentials travel in headers and are never part of it.
 */
export type HttpOptions = {
  attempts?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type HttpOutcome =
  | { ok: true; json: unknown; exchanges: ProviderExchange[] }
  | { ok: false; error: string; exchanges: ProviderExchange[] };

const retryable = (status: number | null) => status === null || status === 429 || status >= 500;

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function callWithRetry(
  request: {
    provider: string;
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: unknown;
    /** What is kept as the request: the URL without credentials and the body. */
    logged: unknown;
  },
  options: HttpOptions = {},
): Promise<HttpOutcome> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const attempts = options.attempts ?? 3;
  const exchanges: ProviderExchange[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(500 * 2 ** (attempt - 2));
    const sentAt = new Date();
    const started = performance.now();
    let status: number | null = null;
    let text: string | null = null;
    let error: string | null = null;
    try {
      const res = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      status = res.status;
      text = await res.text();
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network error';
    }

    let json: unknown = null;
    if (text !== null) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { unparsed: text.slice(0, 10_000) };
        error ??= 'invalid JSON';
      }
    }
    exchanges.push({
      provider: request.provider,
      attempt,
      request: request.logged,
      response: text === null ? null : json,
      httpStatus: status,
      responseSha256: text === null ? null : createHash('sha256').update(text).digest('hex'),
      error,
      durationMs: Math.round(performance.now() - started),
      sentAt,
    });
    if (!error) return { ok: true, json, exchanges };
    if (!retryable(status)) break;
  }
  return { ok: false, error: exchanges.at(-1)?.error ?? 'failed', exchanges };
}
