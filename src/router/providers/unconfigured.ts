import type { ProviderAdapter } from '../types.js';

/**
 * Placeholder for a provider with no entries yet in config/router/models.yaml.
 *
 * Cloudflare Workers AI, OpenRouter and Hugging Face were named as intended
 * providers but no verified free-tier model id + limits were supplied for
 * any of them, and this router refuses to guess at numbers that gate real
 * spend. Add a model to models.yaml and swap this for a real adapter (see
 * `gemini.ts`/`groq.ts` for the shape) once you have the provider's
 * documented free-tier limits in hand.
 */
function unconfigured(id: ProviderAdapter['id']): ProviderAdapter {
  return {
    id,
    async call() {
      throw new Error(
        `Provider "${id}" has no real adapter yet — it should be unreachable because ` +
          `config/router/models.yaml has no models for it. If you added one, implement ` +
          `src/router/providers/${id}.ts and register it in registry.ts.`,
      );
    },
  };
}

export const cloudflareAdapter = unconfigured('cloudflare');
export const openrouterAdapter = unconfigured('openrouter');
export const huggingfaceAdapter = unconfigured('huggingface');
