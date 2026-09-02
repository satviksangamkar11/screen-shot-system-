import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PROJECT_ROOT } from '../config/load.js';
import type { ProviderId } from './types.js';

let loaded = false;

/** Loads `.env` at the project root into process.env, once, if present. */
function ensureEnvLoaded(): void {
  if (loaded) return;
  loaded = true;
  const file = path.join(PROJECT_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

const ENV_VAR_BY_PROVIDER: Record<ProviderId, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  cloudflare: 'CLOUDFLARE_API_TOKEN',
  openrouter: 'OPENROUTER_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
};

/**
 * Returns the first configured API key for a provider, or undefined when none
 * is set. Kept for callers that predate multi-key support.
 */
export function getApiKey(provider: ProviderId): string | undefined {
  return getApiKeys(provider)[0];
}

/**
 * Returns ALL configured API keys for a provider, in declaration order.
 *
 * The base variable (e.g. GROQ_API_KEY) is key 0. Additional keys follow the
 * pattern BASE_2, BASE_3, ... and are appended as long as consecutive numbered
 * variables are present. Gaps stop the scan (BASE_4 without BASE_3 is ignored).
 *
 * Example for Groq with three keys configured:
 *   GROQ_API_KEY=gsk_...    → index 0
 *   GROQ_API_KEY_2=gsk_...  → index 1
 *   GROQ_API_KEY_3=gsk_...  → index 2
 */
export function getApiKeys(provider: ProviderId): string[] {
  ensureEnvLoaded();
  const base = ENV_VAR_BY_PROVIDER[provider];
  const keys: string[] = [];

  const first = process.env[base];
  if (first) keys.push(first);

  for (let i = 2; ; i++) {
    const val = process.env[`${base}_${i}`];
    if (!val) break;
    keys.push(val);
  }

  return keys;
}
