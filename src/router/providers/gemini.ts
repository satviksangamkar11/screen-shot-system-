import type { CallOutcome, ProviderAdapter, RouterRequest } from '../types.js';

/**
 * Google's official REST endpoint and field names (generateContent,
 * contents[].parts[], inline_data). See
 * https://ai.google.dev/gemini-api/docs/text-generation
 */
export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  async call(modelId, req: RouterRequest, apiKey: string) {
    const started = Date.now();
    const parts: unknown[] = [{ text: req.prompt }];
    for (const img of req.images ?? []) {
      parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ parts }] }),
      });
    } catch (err) {
      const outcome: CallOutcome = { kind: 'providerError', message: (err as Error).message };
      return { text: '', outcome };
    }
    const latencyMs = Date.now() - started;
    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('retry-after');
      const outcome: CallOutcome = {
        kind: 'rateLimited',
        retryAfterMs: retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined,
      };
      return { text: '', outcome };
    }
    if (res.status === 400) {
      const body = await res.text();
      return { text: '', outcome: { kind: 'invalidRequest', message: body } };
    }
    if (!res.ok) {
      const body = await res.text();
      return { text: '', outcome: { kind: 'providerError', message: `HTTP ${res.status}: ${body}` } };
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { totalTokenCount?: number };
    };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return {
      text,
      outcome: { kind: 'ok', latencyMs, usedTokens: json.usageMetadata?.totalTokenCount },
    };
  },
};
