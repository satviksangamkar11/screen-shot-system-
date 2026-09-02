import type { ProviderAdapter, ProviderId } from './types.js';
import { geminiAdapter } from './providers/gemini.js';
import { groqAdapter } from './providers/groq.js';
import { cloudflareAdapter, openrouterAdapter, huggingfaceAdapter } from './providers/unconfigured.js';

/**
 * The single map of provider id -> adapter, consulted by the router client.
 *
 * Mirrors `discovery/adapters/registry.ts`: adding a provider means adding
 * one adapter here (plus its entries in config/router/models.yaml) — nothing
 * else needs to know it exists.
 */
export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  gemini: geminiAdapter,
  groq: groqAdapter,
  cloudflare: cloudflareAdapter,
  openrouter: openrouterAdapter,
  huggingface: huggingfaceAdapter,
};
