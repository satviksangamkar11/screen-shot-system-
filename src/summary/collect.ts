import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_DIR } from '../config/load.js';
import { log } from '../util/logger.js';
import type { RunTrace } from '../types.js';

/**
 * Loads a run's trace and returns absolute paths to its "full page" evidence
 * screenshots — the closing capture(s) of each page. Prefers `finalFullPage`
 * over `initialFullPage`, and includes each entry's `additionalScreenshots`.
 *
 * All existing screenshots are returned in document order. The caller
 * (generate.ts) batches them according to the vision model's image limit.
 */
export async function loadFullPageScreenshots(runId: string): Promise<string[]> {
  const runDir = path.join(OUTPUT_DIR, 'runs', runId);
  const traceFile = path.join(runDir, 'trace.json');
  const trace = JSON.parse(await readFile(traceFile, 'utf8')) as RunTrace;

  const final = trace.evidence.filter((e) => e.interactionType === 'finalFullPage');
  const initial = trace.evidence.filter((e) => e.interactionType === 'initialFullPage');
  const chosen = final.length > 0 ? final : initial;

  const paths: string[] = [];
  for (const evidence of chosen) {
    paths.push(evidence.screenshotPath, ...(evidence.additionalScreenshots ?? []));
  }

  return paths
    .map((p) => path.join(runDir, p))
    .filter((abs) => {
      const ok = existsSync(abs);
      if (!ok) log.warn(`missing screenshot, skipping for AI analysis: ${abs}`);
      return ok;
    });
}
