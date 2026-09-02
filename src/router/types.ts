/**
 * Shared data model for the multi-provider AI router.
 *
 * Mirrors `discovery/adapters/`: one small interface every provider
 * implements, a declarative registry, and a selector that never needs to
 * know a provider's internals.
 */

/** A provider account, e.g. "gemini", "groq". One HTTP client per provider. */
export type ProviderId = 'gemini' | 'groq' | 'cloudflare' | 'openrouter' | 'huggingface';

/** What a request needs a model to accept. */
export interface RequestShape {
  /** Number of images attached, 0 for text-only. */
  imageCount: number;
  /** Largest single image, in bytes; used against a model's per-request cap. */
  maxImageBytes?: number;
  /** Rough estimate of prompt + expected completion tokens, for TPM checks. */
  estimatedTokens: number;
}

/** Declarative description of one free-tier model, loaded from config. */
export interface ModelSpec {
  /** Stable key, e.g. "groq/qwen3.8-27b". Matches provider+id for clarity. */
  key: string;
  provider: ProviderId;
  /** Exact model id as sent to the provider's API. */
  modelId: string;
  /** Lower number = tried first among otherwise-eligible models. */
  priority: number;
  capabilities: {
    text: boolean;
    vision: boolean;
    /** Max images accepted in one request; 0 or absent when vision is false. */
    maxImages?: number;
    maxImageBytes?: number;
    /** Tokens the model's own docs charge per image, if it bills that way. */
    tokensPerImage?: number;
    /** Total context window, tokens. */
    contextWindow?: number;
  };
  limits: {
    rpm?: number;
    rpd?: number;
    tpm?: number;
    tpd?: number;
  };
  /** Free-tier guarantee: the router refuses to select a model without this. */
  free: true;
}

/**
 * A provider's own live rate-limit snapshot, read off the response rather
 * than inferred — providers that report this (Groq's `x-ratelimit-*`
 * headers) let the router know exactly how much headroom is left instead of
 * relying solely on locally-tracked counters, which drift if anything else
 * (another process, a browser tab) shares the same API key.
 */
export interface LiveRateLimit {
  remainingRequests?: number;
  limitRequests?: number;
  remainingTokens?: number;
  limitTokens?: number;
}

/** Outcome of one call attempt, used to update quota/health bookkeeping. */
export type CallOutcome =
  | { kind: 'ok'; latencyMs: number; usedTokens?: number; live?: LiveRateLimit }
  | { kind: 'rateLimited'; retryAfterMs?: number; live?: LiveRateLimit }
  /** 401 / 403 — credential is rejected by the provider for this model. */
  | { kind: 'authError'; message: string }
  | { kind: 'providerError'; message: string }
  | { kind: 'invalidRequest'; message: string };

/** A normalised request the router accepts, provider-agnostic. */
export interface RouterRequest {
  /** System/user text prompt. */
  prompt: string;
  /** Zero or more images, as base64 (no data: prefix) with a mime type. */
  images?: { base64: string; mimeType: string }[];
  /** Overrides the default token estimate if the caller has a better one. */
  estimatedTokens?: number;
}

export interface RouterResponse {
  text: string;
  modelKey: string;
  provider: ProviderId;
  latencyMs: number;
  /** Every model/credential tried before success, in order, with why it was skipped. */
  attempts: { modelKey: string; credIndex?: number; reason: string }[];
}

/** What every provider adapter must implement. */
export interface ProviderAdapter {
  id: ProviderId;
  /** Sends one request to the given model; throws only on transport failure. */
  call(modelId: string, req: RouterRequest, apiKey: string): Promise<{
    text: string;
    outcome: CallOutcome;
  }>;
}

export class NoEligibleModelError extends Error {
  constructor(public readonly attempts: { modelKey: string; credIndex?: number; reason: string }[]) {
    super(
      `No eligible free-tier model could serve this request.\n` +
        attempts
          .map((a) => {
            const cred = a.credIndex !== undefined ? ` [key ${a.credIndex + 1}]` : '';
            return `  - ${a.modelKey}${cred}: ${a.reason}`;
          })
          .join('\n'),
    );
    this.name = 'NoEligibleModelError';
  }
}
