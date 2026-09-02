import type { LiveRateLimit, ModelSpec } from './types.js';

const MINUTE_MS = 60_000;
/** A live snapshot older than this is treated as unreliable and ignored. */
const LIVE_STALE_MS = 65_000;

/** How much headroom to leave below a provider's published limit. */
const REQUEST_BUFFER = 2;

/**
 * Tracks how much of each (model, credential) free-tier quota has been used,
 * so the selector can rule a combination out *before* the provider returns a
 * 429 rather than discovering the limit by hitting it.
 *
 * Keyed by `${modelKey}:${credIndex}` so each API key has its own independent
 * quota window — two keys for the same model each start with their full RPM/RPD
 * allocation. In-memory only, per process; two buffer requests are always kept.
 */
class ModelQuota {
  private requestTimestampsMinute: number[] = [];
  private tokensThisMinute: { at: number; tokens: number }[] = [];
  private dayKey = '';
  private requestsToday = 0;
  private tokensToday = 0;
  /** Set on a 429; cleared once the window that produced it has rolled over. */
  private rateLimitedUntil = 0;
  /** Most recent provider-reported remaining requests/tokens, if any. */
  private live: { remainingRequests?: number; remainingTokens?: number; at: number } | undefined;

  private freshLive(now: number) {
    if (!this.live || now - this.live.at > LIVE_STALE_MS) return undefined;
    return this.live;
  }

  /** Records the provider's own rate-limit snapshot; preferred over self-tracked counts. */
  syncLive(live: LiveRateLimit | undefined): void {
    if (!live) return;
    this.live = {
      remainingRequests: live.remainingRequests,
      remainingTokens: live.remainingTokens,
      at: Date.now(),
    };
  }

  private rollDay(): void {
    const key = new Date().toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.requestsToday = 0;
      this.tokensToday = 0;
    }
  }

  private pruneMinute(now: number): void {
    const cutoff = now - MINUTE_MS;
    while (this.requestTimestampsMinute.length && this.requestTimestampsMinute[0]! < cutoff) {
      this.requestTimestampsMinute.shift();
    }
    while (this.tokensThisMinute.length && this.tokensThisMinute[0]!.at < cutoff) {
      this.tokensThisMinute.shift();
    }
  }

  /** True when this (model, credential) has room for one more request of roughly this size. */
  canAccept(spec: ModelSpec, estimatedTokens: number): { ok: true } | { ok: false; reason: string } {
    const now = Date.now();
    if (now < this.rateLimitedUntil) {
      return { ok: false, reason: `cooling down after a rate-limit response` };
    }
    this.rollDay();
    this.pruneMinute(now);

    const live = this.freshLive(now);
    if (live?.remainingRequests !== undefined && live.remainingRequests <= REQUEST_BUFFER) {
      return { ok: false, reason: `provider reports only ${live.remainingRequests} requests left this window (buffer ${REQUEST_BUFFER})` };
    }
    if (live?.remainingTokens !== undefined && live.remainingTokens < estimatedTokens) {
      return { ok: false, reason: `provider reports only ${live.remainingTokens} tokens left this window, need ~${estimatedTokens}` };
    }

    const { rpm, rpd, tpm, tpd } = spec.limits;
    if (rpm !== undefined && this.requestTimestampsMinute.length >= rpm - REQUEST_BUFFER) {
      return { ok: false, reason: `RPM budget exhausted (${this.requestTimestampsMinute.length}/${rpm}, buffer ${REQUEST_BUFFER})` };
    }
    if (rpd !== undefined && this.requestsToday >= rpd - REQUEST_BUFFER) {
      return { ok: false, reason: `RPD budget exhausted (${this.requestsToday}/${rpd}, buffer ${REQUEST_BUFFER})` };
    }
    const tokensInWindow = this.tokensThisMinute.reduce((sum, t) => sum + t.tokens, 0);
    if (tpm !== undefined && tokensInWindow + estimatedTokens > tpm) {
      return { ok: false, reason: `TPM budget would be exceeded (${tokensInWindow}+${estimatedTokens} > ${tpm})` };
    }
    if (tpd !== undefined && this.tokensToday + estimatedTokens > tpd) {
      return { ok: false, reason: `TPD budget would be exceeded (${this.tokensToday}+${estimatedTokens} > ${tpd})` };
    }
    return { ok: true };
  }

  /** Remaining requests this minute, floored at 0; used for ranking, not gating. */
  remainingRpm(spec: ModelSpec): number {
    const now = Date.now();
    const live = this.freshLive(now);
    if (live?.remainingRequests !== undefined) return live.remainingRequests;
    if (spec.limits.rpm === undefined) return Infinity;
    this.pruneMinute(now);
    return Math.max(0, spec.limits.rpm - this.requestTimestampsMinute.length);
  }

  recordSuccess(tokensUsed: number): void {
    const now = Date.now();
    this.rollDay();
    this.requestTimestampsMinute.push(now);
    this.tokensThisMinute.push({ at: now, tokens: tokensUsed });
    this.requestsToday += 1;
    this.tokensToday += tokensUsed;
  }

  recordRateLimited(retryAfterMs?: number): void {
    // Absent explicit guidance, back off for the rest of the current minute
    // window so the (model, credential) pair is not retried until it plausibly
    // has headroom.
    this.rateLimitedUntil = Date.now() + (retryAfterMs ?? MINUTE_MS);
  }
}

/** Composite key for the per-(model, credential) quota store. */
function compositeKey(modelKey: string, credIndex: number): string {
  return `${modelKey}:${credIndex}`;
}

const quotaByKey = new Map<string, ModelQuota>();

/**
 * Returns the quota tracker for one (model, credential) pair.
 * Each API key carries its own independent RPM/RPD window.
 */
export function quotaForCredential(modelKey: string, credIndex: number): ModelQuota {
  const k = compositeKey(modelKey, credIndex);
  let q = quotaByKey.get(k);
  if (!q) {
    q = new ModelQuota();
    quotaByKey.set(k, q);
  }
  return q;
}

/**
 * Backward-compatible alias: quota for the first (index 0) credential.
 * Used by code that predates multi-key support.
 */
export function quotaFor(modelKey: string): ModelQuota {
  return quotaForCredential(modelKey, 0);
}
