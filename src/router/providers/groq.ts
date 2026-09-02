import type { CallOutcome, LiveRateLimit, ProviderAdapter, RouterRequest } from '../types.js';

/** Groq request timeout: generous enough for large image payloads, tight enough to fail fast. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Reads Groq's `x-ratelimit-*` response headers, present on every response
 * (success or 429) — the router prefers these over its own self-tracked
 * counters when both are available, since only the provider knows the true
 * remaining quota (another process or tab sharing the same key would
 * otherwise go undetected).
 */
function readLiveRateLimit(headers: Headers): LiveRateLimit | undefined {
  const remainingRequests = headers.get('x-ratelimit-remaining-requests');
  const limitRequests = headers.get('x-ratelimit-limit-requests');
  const remainingTokens = headers.get('x-ratelimit-remaining-tokens');
  const limitTokens = headers.get('x-ratelimit-limit-tokens');
  if (remainingRequests === null && remainingTokens === null) return undefined;
  return {
    remainingRequests: remainingRequests !== null ? Number(remainingRequests) : undefined,
    limitRequests: limitRequests !== null ? Number(limitRequests) : undefined,
    remainingTokens: remainingTokens !== null ? Number(remainingTokens) : undefined,
    limitTokens: limitTokens !== null ? Number(limitTokens) : undefined,
  };
}

/**
 * Parses a `retry-after` header (seconds as integer or an HTTP-date) into
 * milliseconds. Returns undefined when the header is absent or unparseable.
 */
function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  // HTTP-date fallback
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Groq's OpenAI-compatible chat completions endpoint. See
 * https://console.groq.com/docs/api-reference#chat-create and
 * https://console.groq.com/docs/vision for the image_url content-part shape.
 *
 * Error classification:
 *   200       → ok
 *   429       → rateLimited  (quota exhausted for this key; try another key)
 *   401/403   → authError    (credential rejected; disable this key for this model)
 *   400       → invalidRequest (bad payload; no other key will help)
 *   5xx/408   → providerError (transient; apply short cooldown, try another key)
 *   transport → providerError (network failure; short cooldown)
 */
export const groqAdapter: ProviderAdapter = {
  id: 'groq',
  async call(modelId, req: RouterRequest, apiKey: string) {
    const started = Date.now();
    const content: unknown[] = [{ type: 'text', text: req.prompt }];
    for (const img of req.images ?? []) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
      });
    }

    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content }],
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes('abort') || msg.includes('timeout');
      const outcome: CallOutcome = {
        kind: 'providerError',
        message: isTimeout ? `request timeout (>${REQUEST_TIMEOUT_MS}ms)` : msg,
      };
      return { text: '', outcome };
    }

    const latencyMs = Date.now() - started;
    const live = readLiveRateLimit(res.headers);

    if (res.status === 429) {
      const outcome: CallOutcome = {
        kind: 'rateLimited',
        retryAfterMs: parseRetryAfterMs(res.headers),
        live,
      };
      return { text: '', outcome };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        text: '',
        outcome: { kind: 'authError', message: `HTTP ${res.status}: credential rejected by Groq` },
      };
    }

    if (res.status === 400) {
      const body = await res.text();
      return { text: '', outcome: { kind: 'invalidRequest', message: body } };
    }

    if (res.status === 408 || res.status >= 500) {
      const body = await res.text().catch(() => '');
      return {
        text: '',
        outcome: { kind: 'providerError', message: `HTTP ${res.status}: ${body.slice(0, 200)}` },
      };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        text: '',
        outcome: { kind: 'providerError', message: `HTTP ${res.status}: ${body.slice(0, 200)}` },
      };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      text,
      outcome: { kind: 'ok', latencyMs, usedTokens: json.usage?.total_tokens, live },
    };
  },
};
