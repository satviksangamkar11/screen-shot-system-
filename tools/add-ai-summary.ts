/**
 * One-shot: generate AI summary for a finished capture run and embed it in the
 * existing Word document.  Run with:
 *   npx tsx tools/add-ai-summary.ts
 */
import { generateAiSummary } from '../src/summary/generate.js';
import { assembleDocument } from '../src/orchestrator/assemble.js';
import type { VersionId } from '../src/types.js';

const RUN_IDS: Partial<Record<VersionId, string>> = {
  new: 'job-1516fd77-new-20260901134043',
};
const OUTPUT = 'C:\\screenshot system\\output\\jobs\\1516fd77\\Web Components Form.docx';
const TITLE  = 'Web Components Form';

console.log('Generating AI summary…');
const summary = await generateAiSummary(RUN_IDS);
console.log(`Mode: ${summary.mode} | Bullets: ${summary.bullets.length}`);
summary.bullets.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));

console.log('\nRebuilding document with AI summary appended…');
await assembleDocument(
  { name: 'job-1516fd77', title: TITLE, versions: {}, requiresAuth: false, dataEntryMode: 'automatic' } as any,
  { runIds: RUN_IDS, outputPath: OUTPUT, aiSummary: summary },
);

console.log(`\nDocument ready: ${OUTPUT}`);
