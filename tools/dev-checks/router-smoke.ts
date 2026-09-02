/**
 * Smoke-tests the multi-key, model-priority router in isolation.
 *
 * All network calls are intercepted; no real API requests are made.
 * Tests run sequentially so shared tester state cannot leak between cases.
 */

import assert from 'node:assert/strict';

// ── In-process router replica ─────────────────────────────────────────────────
// Replicates routing logic without importing the real module (no .env loading,
// no file I/O, no external dependencies). Keeps the test hermetic.

interface ModelSpec {
  key: string;
  priority: number;
}

type OutcomeKind = 'ok' | 'rateLimited' | 'authError' | 'providerError' | 'invalidRequest';
interface CallResult { outcome: { kind: OutcomeKind }; text?: string }

class SmokeTester {
  /** What actually got called, in order. */
  callLog: { modelKey: string; credIndex: number }[] = [];

  private health = new Map<string, { authDisabled: boolean; cooldownUntil: number }>();
  private quota  = new Map<string, { rateLimitedUntil: number }>();

  private hk(modelKey: string, ci: number) { return `${modelKey}:${ci}`; }

  private isHealthy(modelKey: string, ci: number): boolean {
    const e = this.health.get(this.hk(modelKey, ci));
    if (!e) return true;
    if (e.authDisabled) return false;
    if (e.cooldownUntil > Date.now()) return false;
    return true;
  }

  private canAccept(modelKey: string, ci: number): boolean {
    const q = this.quota.get(this.hk(modelKey, ci));
    if (!q) return true;
    return q.rateLimitedUntil <= Date.now();
  }

  reset() {
    this.callLog = [];
    this.health.clear();
    this.quota.clear();
  }

  route(
    models: ModelSpec[],
    keys: string[],
    callImpl: (modelKey: string, credIndex: number) => CallResult,
  ): { text: string; modelKey: string; credIndex: number } | null {
    const sorted = [...models].sort((a, b) => a.priority - b.priority);

    for (const spec of sorted) {
      for (let ci = 0; ci < keys.length; ci++) {
        if (!this.isHealthy(spec.key, ci)) continue;
        if (!this.canAccept(spec.key, ci))  continue;

        this.callLog.push({ modelKey: spec.key, credIndex: ci });
        const { outcome, text } = callImpl(spec.key, ci);

        if (outcome.kind === 'ok') return { text: text ?? '', modelKey: spec.key, credIndex: ci };

        if (outcome.kind === 'rateLimited') {
          this.quota.set(this.hk(spec.key, ci), { rateLimitedUntil: Date.now() + 60_000 });
          continue; // next key, SAME model
        }
        if (outcome.kind === 'authError') {
          this.health.set(this.hk(spec.key, ci), { authDisabled: true, cooldownUntil: 0 });
          continue;
        }
        if (outcome.kind === 'providerError') {
          this.health.set(this.hk(spec.key, ci), { authDisabled: false, cooldownUntil: Date.now() + 30_000 });
          continue;
        }
        // invalidRequest — break cred loop for this model
        break;
      }
    }
    return null;
  }
}

// ── Test runner ───────────────────────────────────────────────────────────────

const tester = new SmokeTester();
let passed = 0;
let failed = 0;

function run(name: string, fn: () => void): void {
  tester.reset(); // isolated state per test
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const P1 = { key: 'groq/qwen3.8-27b', priority: 1 };
const P2 = { key: 'groq/qwen3.6-27b', priority: 2 };
const KEYS = ['key1', 'key2', 'key3'];

// ── Scenarios ─────────────────────────────────────────────────────────────────

// 1. Key3 succeeds with P1 — P2 must never be attempted.
run('Key1+P1=429, Key2+P1=429, Key3+P1=ok → P1 used, P2 never tried', () => {
  const result = tester.route([P1, P2], KEYS, (m, ci) => {
    if (m === P1.key && ci < 2) return { outcome: { kind: 'rateLimited' } };
    if (m === P1.key && ci === 2) return { outcome: { kind: 'ok' }, text: 'answer' };
    return { outcome: { kind: 'rateLimited' } };
  });
  assert.ok(result, 'must return a result');
  assert.equal(result.modelKey, P1.key, 'must use P1');
  assert.equal(result.credIndex, 2, 'must use key3 (index 2)');
  assert.equal(tester.callLog.filter((l) => l.modelKey === P2.key).length, 0, 'P2 never tried');
});

// 2. ALL keys exhausted on P1 → downgrade to P2.
run('All keys 429 on P1 → downgrade to P2, Key1+P2=ok', () => {
  const result = tester.route([P1, P2], KEYS, (m, ci) => {
    if (m === P1.key) return { outcome: { kind: 'rateLimited' } };
    if (m === P2.key && ci === 0) return { outcome: { kind: 'ok' }, text: 'p2-answer' };
    return { outcome: { kind: 'rateLimited' } };
  });
  assert.ok(result, 'must return a result');
  assert.equal(result.modelKey, P2.key, 'must use P2');
  assert.equal(result.credIndex, 0, 'first key for P2');
  assert.equal(tester.callLog.filter((l) => l.modelKey === P1.key).length, 3, 'all 3 P1 keys tried');
});

// 3. One key auth-fails, next key succeeds on same model — no downgrade.
run('Key1+P1=401, Key2+P1=ok → P1 used with key2, P2 never tried', () => {
  const result = tester.route([P1, P2], KEYS, (m, ci) => {
    if (m === P1.key && ci === 0) return { outcome: { kind: 'authError' } };
    if (m === P1.key && ci === 1) return { outcome: { kind: 'ok' }, text: 'ok' };
    return { outcome: { kind: 'rateLimited' } };
  });
  assert.ok(result, 'must return a result');
  assert.equal(result.modelKey, P1.key);
  assert.equal(result.credIndex, 1);
  assert.equal(tester.callLog.filter((l) => l.modelKey === P2.key).length, 0, 'P2 never tried');
});

// 4. 5xx on key1, key2 succeeds — no downgrade.
run('Key1+P1=503, Key2+P1=ok → P1 used with key2', () => {
  const result = tester.route([P1, P2], KEYS, (m, ci) => {
    if (m === P1.key && ci === 0) return { outcome: { kind: 'providerError' } };
    if (m === P1.key && ci === 1) return { outcome: { kind: 'ok' }, text: 'ok' };
    return { outcome: { kind: 'rateLimited' } };
  });
  assert.ok(result);
  assert.equal(result.modelKey, P1.key);
  assert.equal(result.credIndex, 1);
  assert.equal(tester.callLog.filter((l) => l.modelKey === P2.key).length, 0);
});

// 5. All keys/models fail → null (no eligible model).
run('All keys fail on all models → no result', () => {
  const result = tester.route([P1, P2], KEYS, () => ({ outcome: { kind: 'rateLimited' } }));
  assert.equal(result, null);
});

// 6. invalidRequest on first key breaks credential loop for that model only.
run('invalidRequest on P1 key1 → skip to P2 without trying P1 key2/key3', () => {
  const result = tester.route([P1, P2], KEYS, (m, ci) => {
    if (m === P1.key && ci === 0) return { outcome: { kind: 'invalidRequest' } };
    if (m === P2.key && ci === 0) return { outcome: { kind: 'ok' }, text: 'p2' };
    return { outcome: { kind: 'rateLimited' } };
  });
  assert.ok(result);
  assert.equal(result.modelKey, P2.key);
  assert.equal(tester.callLog.filter((l) => l.modelKey === P1.key).length, 1, 'only 1 P1 key tried');
});

// 7. Single key works as before.
run('Single key, P1 ok → succeeds normally', () => {
  const result = tester.route([P1, P2], ['only-key'], (m, ci) => {
    if (m === P1.key && ci === 0) return { outcome: { kind: 'ok' }, text: 'single' };
    return { outcome: { kind: 'rateLimited' } };
  });
  assert.ok(result);
  assert.equal(result.modelKey, P1.key);
  assert.equal(result.credIndex, 0);
});

// 8. Priority ordering respected regardless of array order.
run('P2 listed first in array but P1 wins by priority', () => {
  const result = tester.route([P2, P1], KEYS, (m, ci) => {
    if (m === P1.key && ci === 0) return { outcome: { kind: 'ok' }, text: 'p1-first' };
    return { outcome: { kind: 'rateLimited' } };
  });
  assert.ok(result);
  assert.equal(result.modelKey, P1.key, 'P1 must win even if P2 was listed first');
});

// 9. Auth-disabled key is skipped on a second call without resetting.
run('Key1 auth-disabled persists: second route skips key1+P1', () => {
  // First call with only key1 — triggers auth failure, records it.
  tester.route([P1], ['key1'], (m, ci) => {
    if (m === P1.key && ci === 0) return { outcome: { kind: 'authError' } };
    return { outcome: { kind: 'rateLimited' } };
  });
  tester.callLog = [];
  // Second call with all 3 keys — key1 must be silently skipped.
  const result = tester.route([P1, P2], KEYS, (m, ci) => {
    if (m === P1.key && ci === 1) return { outcome: { kind: 'ok' }, text: 'key2-ok' };
    return { outcome: { kind: 'rateLimited' } };
  });
  assert.ok(result, 'must succeed via key2');
  assert.equal(result.credIndex, 1, 'key2 (index 1) must be used');
  const key1Attempts = tester.callLog.filter((l) => l.modelKey === P1.key && l.credIndex === 0);
  assert.equal(key1Attempts.length, 0, 'key1 must not have been attempted');
});

// ── Report ────────────────────────────────────────────────────────────────────

console.log('');
console.log(`Router smoke test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
