import type { ModelSpec, RequestShape } from './types.js';
import { quotaFor } from './quota.js';

/**
 * Shape eligibility: checks whether a model's declared capabilities can
 * satisfy this request's image count, image size, and context requirements.
 *
 * This is credential-independent — the same model spec is checked once per
 * model, not once per (model, key) pair. Quota and health are checked
 * separately per credential in client.ts.
 */
export function shapeEligibility(
  spec: ModelSpec,
  req: RequestShape,
): { ok: true } | { ok: false; reason: string } {
  if (req.imageCount > 0) {
    if (!spec.capabilities.vision) return { ok: false, reason: 'no vision support' };
    const maxImages = spec.capabilities.maxImages;
    if (maxImages !== undefined && req.imageCount > maxImages) {
      return {
        ok: false,
        reason: `request has ${req.imageCount} images, model allows ${maxImages}`,
      };
    }
    const maxBytes = spec.capabilities.maxImageBytes;
    if (
      maxBytes !== undefined &&
      req.maxImageBytes !== undefined &&
      req.maxImageBytes > maxBytes
    ) {
      return { ok: false, reason: `image exceeds ${maxBytes} byte limit` };
    }
  } else if (!spec.capabilities.text) {
    return { ok: false, reason: 'no text support' };
  }
  if (
    spec.capabilities.contextWindow !== undefined &&
    req.estimatedTokens > spec.capabilities.contextWindow
  ) {
    return {
      ok: false,
      reason: `estimated ${req.estimatedTokens} tokens exceeds context window ${spec.capabilities.contextWindow}`,
    };
  }
  return { ok: true };
}

/**
 * Full eligibility check: shape + quota for the first (index 0) credential.
 * Kept for backward compatibility; new code should call shapeEligibility +
 * quotaForCredential separately.
 */
export function eligibility(
  spec: ModelSpec,
  req: RequestShape,
): { ok: true } | { ok: false; reason: string } {
  const shape = shapeEligibility(spec, req);
  if (!shape.ok) return shape;
  return quotaFor(spec.key).canAccept(spec, req.estimatedTokens);
}

/**
 * Orders models by priority (the hierarchy is already priority-sorted on
 * load), breaking ties among equal-priority models by remaining RPM
 * headroom — the model with the most breathing room goes first.
 */
export function rank(specs: ModelSpec[]): ModelSpec[] {
  return [...specs].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return quotaFor(b.key).remainingRpm(b) - quotaFor(a.key).remainingRpm(a);
  });
}
