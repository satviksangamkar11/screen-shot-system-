import { readFile } from 'node:fs/promises';
import { route, loadModelHierarchy } from '../router/index.js';
import { loadFullPageScreenshots } from './collect.js';
import type { VersionId } from '../types.js';

/**
 * Safety buffer subtracted from every model's declared maxImages cap.
 *
 * If the tightest vision model in the hierarchy allows N images per request,
 * we batch at N - IMAGE_BUFFER to stay clear of the hard limit and force the
 * router to switch models before we ever reach it. Matches REQUEST_BUFFER in
 * quota.ts, which applies the same margin to RPM/RPD.
 */
const IMAGE_BUFFER = 2;

/**
 * Derives the batch size from the configured model hierarchy at runtime so
 * that adding or removing models in config/router/models.yaml immediately
 * changes how many screenshots are sent per vision call — no code change needed.
 *
 * Result: min(maxImages across all vision models) - IMAGE_BUFFER, floored at 1.
 */
async function getVisionBatchSize(): Promise<number> {
  const hierarchy = await loadModelHierarchy();
  const caps = hierarchy
    .filter((s) => s.capabilities.vision && (s.capabilities.maxImages ?? 0) > 0)
    .map((s) => s.capabilities.maxImages!);
  if (caps.length === 0) return 1;
  return Math.max(1, Math.min(...caps) - IMAGE_BUFFER);
}

// ── Output schema ────────────────────────────────────────────────────────────

export interface AiPoint {
  text: string;
  importance: 'high' | 'medium' | 'low';
  /** Comparison mode only: "added" | "removed" | "changed" | "state" | "structure" */
  category?: string;
}

export interface AiSummaryResult {
  type: 'single' | 'comparison';
  points: AiPoint[];
  /** Comparison mode only. */
  overallChange?: {
    level: 'no_change' | 'minor' | 'moderate' | 'major';
    text: string;
  };
}

// ── Internal batch observation type ─────────────────────────────────────────

interface BatchObservation {
  screenshotRange: string;
  sections: string[];
  controls: string[];
  patterns: string[];
  states: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strips reasoning model's <think>…</think> traces, then extracts the first JSON object or array. */
function extractJson(raw: string): unknown {
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Remove markdown code fences if present.
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : stripped;
  // Find the first { or [ and parse from there.
  const start = candidate.search(/[{[]/);
  if (start === -1) throw new Error('No JSON found in model response');
  return JSON.parse(candidate.slice(start));
}

async function imageParts(paths: string[]): Promise<{ base64: string; mimeType: string }[]> {
  const parts: { base64: string; mimeType: string }[] = [];
  for (const p of paths) {
    const buf = await readFile(p);
    parts.push({ base64: buf.toString('base64'), mimeType: 'image/png' });
  }
  return parts;
}

// ── Stage 1: visual understanding per version ────────────────────────────────

/**
 * Sends one batch of screenshots (up to VISION_BATCH_SIZE) to a vision model
 * and returns a partial UI observation as a JSON object.
 *
 * The range strings ("1–3 of 7") give the model positional context so it
 * understands where in the page these screenshots sit.
 */
async function analyseScreenshotBatch(
  paths: string[],
  batchStart: number,
  total: number,
): Promise<BatchObservation> {
  const images = await imageParts(paths);
  const end = batchStart + paths.length - 1;
  const range = total === 1
    ? 'the only screenshot (full page)'
    : `screenshots ${batchStart}–${end} of ${total} (consecutive viewport sections, top to bottom)`;

  const prompt =
    `You are analyzing ${range} of ONE COMPLETE business application UI screen.\n\n` +
    `Describe what is visible in these screenshots:\n` +
    `- Major UI sections, panels, tabs, or toolbars present\n` +
    `- UI controls and patterns (filters, tables, forms, dialogs, dropdowns, date pickers, etc.)\n` +
    `- Visible states (selected tab, active view, expanded/collapsed, populated/empty fields)\n` +
    `- Repeated control structures (e.g. multiple partner-role blocks, repeated filter rows)\n\n` +
    `Output ONLY valid JSON — no preamble, no markdown fences:\n` +
    `{\n` +
    `  "sections": ["..."],\n` +
    `  "controls": ["..."],\n` +
    `  "patterns": ["..."],\n` +
    `  "states": ["..."]\n` +
    `}`;

  const res = await route({ prompt, images });

  let parsed: Record<string, string[]>;
  try {
    parsed = extractJson(res.text) as Record<string, string[]>;
  } catch {
    // Fallback: treat the whole response as a single section observation.
    parsed = { sections: [res.text.slice(0, 400)], controls: [], patterns: [], states: [] };
  }

  return {
    screenshotRange: range,
    sections: parsed['sections'] ?? [],
    controls: parsed['controls'] ?? [],
    patterns: parsed['patterns'] ?? [],
    states: parsed['states'] ?? [],
  };
}

/**
 * Builds a semantic UI model for one version by analysing all its screenshots.
 *
 * Screenshots are batched at the dynamically derived batch size (model maxImages
 * minus the safety buffer) so every vision call stays within the provider's
 * hard limit and the router can switch models before a limit is hit.
 */
async function buildVersionModel(runId: string): Promise<BatchObservation[]> {
  const paths = await loadFullPageScreenshots(runId);
  if (paths.length === 0) return [];

  const batchSize = await getVisionBatchSize();
  const observations: BatchObservation[] = [];
  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize);
    const obs = await analyseScreenshotBatch(batch, i + 1, paths.length);
    observations.push(obs);
  }
  return observations;
}

// ── Stage 2: significance filtering + TL;DR generation ─────────────────────

/** Returns a fallback result when AI analysis cannot be completed. */
function fallbackSingle(reason: string): AiSummaryResult {
  return {
    type: 'single',
    points: [{ text: reason, importance: 'medium' }],
  };
}

/**
 * Consolidates batch observations for a single version into 3–8 TL;DR
 * documentation points, filtered for HIGH/MEDIUM significance only.
 */
async function generateSinglePoints(observations: BatchObservation[]): Promise<AiSummaryResult> {
  if (observations.length === 0) return fallbackSingle('No screenshots available for AI analysis.');

  const obs = JSON.stringify(observations, null, 2);
  const prompt =
    `You are a UI documentation analyst.\n\n` +
    `Below are observations from ALL screenshots of ONE COMPLETE business application UI screen, ` +
    `captured as consecutive viewport sections scrolling top to bottom.\n\n` +
    `OBSERVATIONS:\n${obs}\n\n` +
    `Generate 3–8 TL;DR documentation points about the most important UI characteristics.\n\n` +
    `FOCUS ON:\n` +
    `• Overall UI structure — major sections, their organization, how they relate\n` +
    `• Distinctive control patterns — filters, tables, repeated structures, dialogs\n` +
    `• Meaningful visible states — active tab, selected view, expanded/collapsed areas\n` +
    `• Documentation-worthy characteristics that add value beyond a field list\n\n` +
    `DO NOT:\n` +
    `• List individual fields by name (the document already contains them)\n` +
    `• Write paragraphs or essays\n` +
    `• Repeat the same observation with different wording\n` +
    `• Include trivial details (fonts, spacing, render artifacts, generic labels)\n` +
    `• Infer backend behavior, APIs, or business rules not visible in the screenshots\n\n` +
    `Prefer fewer strong points over many weak ones.\n` +
    `Each point = one concise meaningful observation (one sentence).\n\n` +
    `Output ONLY valid JSON — no preamble, no markdown:\n` +
    `{\n` +
    `  "type": "single",\n` +
    `  "points": [\n` +
    `    { "text": "...", "importance": "high" }\n` +
    `  ]\n` +
    `}\n` +
    `importance: "high" | "medium" | "low". Include only high and medium points.`;

  const res = await route({ prompt });

  try {
    const parsed = extractJson(res.text) as { type: string; points: AiPoint[] };
    const points = (parsed.points ?? []).filter(
      (p) => p.importance === 'high' || p.importance === 'medium',
    );
    return { type: 'single', points: points.slice(0, 8) };
  } catch {
    return fallbackSingle('AI analysis could not be parsed.');
  }
}

/**
 * Compares the semantic models of two versions and returns structured
 * comparison points — ADDED, REMOVED, CHANGED, STATE, STRUCTURE.
 */
async function generateComparisonPoints(
  oldObs: BatchObservation[],
  newObs: BatchObservation[],
): Promise<AiSummaryResult> {
  if (oldObs.length === 0 && newObs.length === 0) {
    return {
      type: 'comparison',
      points: [{ category: 'structure', text: 'No screenshots available for either version.', importance: 'medium' }],
    };
  }

  const oldJson = JSON.stringify(oldObs, null, 2);
  const newJson = JSON.stringify(newObs, null, 2);

  const prompt =
    `You are a UI documentation analyst comparing two versions of a business application.\n\n` +
    `OLD VERSION observations (all screenshots, top to bottom):\n${oldJson}\n\n` +
    `NEW VERSION observations (all screenshots, top to bottom):\n${newJson}\n\n` +
    `Identify MEANINGFUL differences between the two UI versions. Compare:\n` +
    `• Section structure — sections added, removed, or reorganized\n` +
    `• Control types and groupings — new/removed controls, changed control types\n` +
    `• Labels and patterns — renamed areas, different repeated structures\n` +
    `• Visible states — active tab, selected view, expanded/collapsed differences\n\n` +
    `IGNORE: pixel-level differences, fonts, minor spacing, browser rendering noise, ` +
    `cursor position, compression artifacts.\n\n` +
    `Use these category prefixes exactly:\n` +
    `• "added" — UI visible in New but not Old\n` +
    `• "removed" — UI visible in Old but not New\n` +
    `• "changed" — UI in both versions but structurally different\n` +
    `• "state" — Meaningful visible state differs (selected tab, active view, etc.)\n` +
    `• "structure" — Major organizational or layout change\n\n` +
    `If the two versions are visually and functionally equivalent, return a single point:\n` +
    `{ "category": "structure", "text": "NO MEANINGFUL UI CHANGE — captured UI structure and visible controls remain consistent between versions.", "importance": "high" }\n\n` +
    `3–8 points maximum. Prefer fewer strong points.\n\n` +
    `Output ONLY valid JSON — no preamble, no markdown:\n` +
    `{\n` +
    `  "type": "comparison",\n` +
    `  "points": [\n` +
    `    { "category": "added", "text": "...", "importance": "high" }\n` +
    `  ],\n` +
    `  "overallChange": {\n` +
    `    "level": "no_change" | "minor" | "moderate" | "major",\n` +
    `    "text": "one short sentence"\n` +
    `  }\n` +
    `}`;

  const res = await route({ prompt });

  try {
    const parsed = extractJson(res.text) as {
      type: string;
      points: AiPoint[];
      overallChange?: AiSummaryResult['overallChange'];
    };
    const points = (parsed.points ?? []).filter(
      (p) => p.importance === 'high' || p.importance === 'medium',
    );
    return {
      type: 'comparison',
      points: points.slice(0, 8),
      overallChange: parsed.overallChange,
    };
  } catch {
    return {
      type: 'comparison',
      points: [{ category: 'structure', text: 'AI comparison could not be parsed.', importance: 'medium' }],
    };
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Generates the "AI UI Documentation" section for a job.
 *
 * Single version → "AI UI DOCUMENTATION" with 3–8 TL;DR points describing the
 * UI structure and patterns.
 *
 * Two versions → "AI UI COMPARISON" with 3–8 meaningful change points (ADDED /
 * REMOVED / CHANGED / STATE / STRUCTURE) and an overall change level.
 *
 * Pipeline:
 *   Full-page screenshots
 *     → visual understanding batches (vision calls, VISION_BATCH_SIZE each)
 *     → semantic UI observations per version
 *     → significance filter + TL;DR generation (text-only call)
 *     → AiSummaryResult
 */
export async function generateAiSummary(
  runIds: Partial<Record<VersionId, string>>,
): Promise<AiSummaryResult> {
  const entries = Object.entries(runIds) as [VersionId, string][];
  if (entries.length === 0) {
    return fallbackSingle('No captured version available for AI analysis.');
  }

  if (entries.length === 1) {
    const [, runId] = entries[0]!;
    const observations = await buildVersionModel(runId);
    return generateSinglePoints(observations);
  }

  // Two versions: build semantic model for each independently, then compare.
  const [oldEntry, newEntry] = entries as [[VersionId, string], [VersionId, string]];
  const [oldObs, newObs] = await Promise.all([
    buildVersionModel(oldEntry[1]),
    buildVersionModel(newEntry[1]),
  ]);
  return generateComparisonPoints(oldObs, newObs);
}
