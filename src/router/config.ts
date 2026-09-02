import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { PROJECT_ROOT } from '../config/load.js';
import type { ModelSpec } from './types.js';

const ProviderIdSchema = z.enum(['gemini', 'groq', 'cloudflare', 'openrouter', 'huggingface']);

const ModelSpecSchema = z.object({
  key: z.string(),
  provider: ProviderIdSchema,
  modelId: z.string(),
  priority: z.number().int(),
  capabilities: z.object({
    text: z.boolean(),
    vision: z.boolean(),
    maxImages: z.number().int().positive().optional(),
    maxImageBytes: z.number().int().positive().optional(),
    tokensPerImage: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive().optional(),
  }),
  limits: z.object({
    rpm: z.number().int().positive().optional(),
    rpd: z.number().int().positive().optional(),
    tpm: z.number().int().positive().optional(),
    tpd: z.number().int().positive().optional(),
  }),
  // Every model this router can select must be free; a schema-level literal
  // (rather than a comment) is what stops a paid model being added silently.
  free: z.literal(true),
});

const ModelsFileSchema = z.object({
  models: z.array(ModelSpecSchema),
});

let cached: ModelSpec[] | undefined;

/** Loads and validates the free-tier model hierarchy from config/router/models.yaml. */
export async function loadModelHierarchy(): Promise<ModelSpec[]> {
  if (cached) return cached;
  const file = path.join(PROJECT_ROOT, 'config', 'router', 'models.yaml');
  const raw = await readFile(file, 'utf8');
  const parsed = YAML.parse(raw);
  const result = ModelsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid config in ${file}:\n${result.error.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')}`,
    );
  }
  cached = [...result.data.models].sort((a, b) => a.priority - b.priority);
  return cached;
}
