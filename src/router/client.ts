import { loadModelHierarchy } from './config.js';
import { getApiKeys } from './env.js';
import { PROVIDERS } from './registry.js';
import { shapeEligibility } from './select.js';
import { quotaForCredential } from './quota.js';
import { isHealthy, recordAuthFailure, recordCooldown } from './health.js';
import {
  NoEligibleModelError,
  type ModelSpec,
  type RequestShape,
  type RouterRequest,
  type RouterResponse,
} from './types.js';

/** Fallback per-image cost when a model doesn't declare `tokensPerImage`. */
const DEFAULT_IMAGE_TOKENS = 800;

/**
 * Token estimate for the TPM gate, specific to the model about to be tried.
 *
 * Flat per-image guesses undercount real vision cost badly — these Groq
 * models charge ~2048 tokens/image, well above a generic estimate — which let
 * the quota gate wave through calls it shouldn't have, only for the
 * provider's own (authoritative) remaining-token count to collapse much
 * faster than expected. Using each model's declared `tokensPerImage` keeps
 * the pre-flight estimate honest.
 */
function estimateTokens(req: RouterRequest, spec: ModelSpec): number {
  const textTokens = Math.ceil(req.prompt.length / 4);
  const perImage = spec.capabilities.tokensPerImage ?? DEFAULT_IMAGE_TOKENS;
  const imageTokens = (req.images?.length ?? 0) * perImage;
  return textTokens + imageTokens;
}

/**
 * Model-agnostic estimate used only for the context-window sanity check in
 * `shapeEligibility`, before any specific model is chosen. The context
 * window (131K tokens) is generous enough that the flat per-image guess is
 * fine here — accuracy only matters once a specific model's TPM budget is
 * being checked, which `estimateTokens` above handles per-spec.
 */
function baseEstimateTokens(req: RouterRequest): number {
  const textTokens = Math.ceil(req.prompt.length / 4);
  const imageTokens = (req.images?.length ?? 0) * DEFAULT_IMAGE_TOKENS;
  return textTokens + imageTokens;
}

/**
 * Backoff schedule tried when the entire model×credential hierarchy is
 * exhausted. TPM windows and rate-limit cooldowns are self-clearing within
 * roughly a minute — failing immediately wastes a retry that would very
 * likely succeed once the window rolls over, which matters for a background
 * job like AI analysis where an extra minute of wait is cheap.
 */
const RETRY_BACKOFF_MS = [20_000, 40_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Routes one request across the free-tier model hierarchy using a
 * model-priority × credential traversal:
 *
 *   for each model (ascending priority):
 *     for each API key (declaration order):
 *       if healthy + quota OK → attempt call
 *       on success            → return immediately (stay on this model)
 *       on 429                → update quota for this key, try NEXT key (same model)
 *       on 401/403            → disable this key for this model, try next key (same model)
 *       on 5xx/timeout        → short cooldown, try next key (same model)
 *       on invalidRequest     → bad payload; no other key will help → skip to next model
 *     all keys exhausted      → move to next model priority
 *   all models exhausted      → throw NoEligibleModelError
 *
 * A higher-priority model is NEVER abandoned while any API key for it can
 * still serve the request. Model downgrade only happens when every key for
 * the current model is unavailable.
 */
export async function route(req: RouterRequest): Promise<RouterResponse> {
  let lastError: NoEligibleModelError | undefined;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_BACKOFF_MS[attempt - 1]!);
    }
    try {
      return await attemptRoute(req);
    } catch (err) {
      if (!(err instanceof NoEligibleModelError)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * One full pass over the model×credential hierarchy. Separated from `route`
 * so the retry wrapper above can re-run it wholesale after a backoff without
 * duplicating the traversal logic.
 */
async function attemptRoute(req: RouterRequest): Promise<RouterResponse> {
  const shape: RequestShape = {
    imageCount: req.images?.length ?? 0,
    maxImageBytes: req.images?.length
      ? Math.max(...req.images.map((i) => Math.ceil((i.base64.length * 3) / 4)))
      : undefined,
    // Base estimate for the context-window check below, which is generous
    // enough (131K tokens) that the generic per-image guess is fine here —
    // the TPM gate below needs the accurate, per-model figure instead.
    estimatedTokens: req.estimatedTokens ?? baseEstimateTokens(req),
  };

  const hierarchy = await loadModelHierarchy();
  const attempts: RouterResponse['attempts'] = [];

  for (const spec of hierarchy) {
    // ── Shape check: model-level, credential-independent ─────────────────────
    const shapeVerdict = shapeEligibility(spec, shape);
    if (!shapeVerdict.ok) {
      attempts.push({ modelKey: spec.key, reason: shapeVerdict.reason });
      continue; // skip ALL credentials for this model
    }

    const credentials = getApiKeys(spec.provider);
    if (credentials.length === 0) {
      attempts.push({ modelKey: spec.key, reason: `no API key configured (${spec.provider})` });
      continue;
    }

    const adapter = PROVIDERS[spec.provider];
    // Per-model estimate: this model's own declared tokensPerImage, not a
    // generic guess — the TPM gate below must reflect what this specific
    // model will actually be billed.
    const modelEstimatedTokens = req.estimatedTokens ?? estimateTokens(req, spec);

    // ── Credential loop: exhaust all keys before downgrading model ────────────
    for (let credIndex = 0; credIndex < credentials.length; credIndex++) {
      // Health check: auth failures and cooldowns.
      if (!isHealthy(spec.key, credIndex)) {
        attempts.push({ modelKey: spec.key, credIndex, reason: 'unhealthy (auth failure or cooldown)' });
        continue;
      }

      // Quota check: per-(model, credential) rate-limit windows.
      const quotaVerdict = quotaForCredential(spec.key, credIndex).canAccept(spec, modelEstimatedTokens);
      if (!quotaVerdict.ok) {
        attempts.push({ modelKey: spec.key, credIndex, reason: quotaVerdict.reason });
        continue;
      }

      const apiKey = credentials[credIndex]!;
      const { text, outcome } = await adapter.call(spec.modelId, req, apiKey);

      if (outcome.kind === 'ok') {
        quotaForCredential(spec.key, credIndex).recordSuccess(outcome.usedTokens ?? modelEstimatedTokens);
        quotaForCredential(spec.key, credIndex).syncLive(outcome.live);
        return {
          text,
          modelKey: spec.key,
          provider: spec.provider,
          latencyMs: outcome.latencyMs,
          attempts,
        };
      }

      if (outcome.kind === 'rateLimited') {
        // Key exhausted for this model — record and try the NEXT key (same model).
        quotaForCredential(spec.key, credIndex).recordRateLimited(outcome.retryAfterMs);
        quotaForCredential(spec.key, credIndex).syncLive(outcome.live);
        attempts.push({ modelKey: spec.key, credIndex, reason: 'rate limited by provider' });
        continue;
      }

      if (outcome.kind === 'authError') {
        // 401/403 — this credential is rejected for this model. Disable it and
        // try the next key. Does not affect other models or other credentials.
        recordAuthFailure(spec.key, credIndex);
        attempts.push({ modelKey: spec.key, credIndex, reason: outcome.message });
        continue;
      }

      if (outcome.kind === 'providerError') {
        // 5xx / transport error — short cooldown, try the next key.
        recordCooldown(spec.key, credIndex);
        attempts.push({ modelKey: spec.key, credIndex, reason: `provider error: ${outcome.message}` });
        continue;
      }

      // invalidRequest (400) — the payload is malformed in a way that no other
      // key or credential can fix. Break the credential loop and try the next
      // model (a different model's token limits or image encoding may differ).
      attempts.push({ modelKey: spec.key, credIndex, reason: `invalid request: ${outcome.message}` });
      break;
    }
    // All credentials exhausted (or an invalidRequest broke the loop) → move to
    // the next model priority. The model-priority invariant is preserved: we only
    // reach here after trying every available key for spec.
  }

  throw new NoEligibleModelError(attempts);
}
