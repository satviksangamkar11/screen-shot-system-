/**
 * Per-(model, credential) health tracking.
 *
 * Separate from quota.ts: quota tracks rate-limit windows (temporary,
 * self-clearing), while health tracks:
 *
 *   authDisabled — set on 401/403; the credential is rejected by the provider
 *     for this model. Persists until process restart (or manual clear). The
 *     router skips this (model, key) pair without attempting a call.
 *
 *   cooldownUntil — set on 5xx / transport failures; the pair is temporarily
 *     unhealthy and retried after the backoff window elapses. Shorter than a
 *     full RPM window so transient errors self-clear quickly.
 */

const DEFAULT_COOLDOWN_MS = 30_000; // 30 s for 5xx / transport errors

interface HealthEntry {
  authDisabled: boolean;
  cooldownUntil: number; // epoch ms; 0 = healthy
}

const entries = new Map<string, HealthEntry>();

function key(modelKey: string, credIndex: number): string {
  return `${modelKey}:${credIndex}`;
}

function entry(modelKey: string, credIndex: number): HealthEntry {
  const k = key(modelKey, credIndex);
  let e = entries.get(k);
  if (!e) {
    e = { authDisabled: false, cooldownUntil: 0 };
    entries.set(k, e);
  }
  return e;
}

/** Returns true when this (model, credential) pair is safe to attempt. */
export function isHealthy(modelKey: string, credIndex: number): boolean {
  const e = entry(modelKey, credIndex);
  if (e.authDisabled) return false;
  if (e.cooldownUntil > Date.now()) return false;
  return true;
}

/**
 * Called on a 401 or 403 response. The credential is treated as permanently
 * invalid for this model until the process restarts (or `clearAuthFailure` is
 * called). Does not affect the credential's use with other models.
 */
export function recordAuthFailure(modelKey: string, credIndex: number): void {
  entry(modelKey, credIndex).authDisabled = true;
}

/**
 * Called on a 5xx or transport error. Applies a short backoff so the pair is
 * not retried immediately. Shorter than the RPM window because a 503 often
 * self-clears in seconds, not minutes.
 */
export function recordCooldown(
  modelKey: string,
  credIndex: number,
  ms: number = DEFAULT_COOLDOWN_MS,
): void {
  entry(modelKey, credIndex).cooldownUntil = Date.now() + ms;
}

/** Clears an auth-disabled flag (e.g. after the operator rotates a key). */
export function clearAuthFailure(modelKey: string, credIndex: number): void {
  entry(modelKey, credIndex).authDisabled = false;
}
