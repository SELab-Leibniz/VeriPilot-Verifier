#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { reportArktsReviewRequests } from './summarize-arkts-paired-cohort.mjs';

const usage = 'node scripts/report-arkts-review-requests.mjs --directory=DIR --plan-sha256=SHA --release=FILE';

async function main() {
  const { values } = parseArgs({ options: {
    directory: { type: 'string' }, 'plan-sha256': { type: 'string' }, release: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); return; }
  assert(values.directory && values['plan-sha256'] && values.release, usage);
  const report = await reportArktsReviewRequests({ directory: values.directory,
    planSha256: values['plan-sha256'], release: JSON.parse(await fs.readFile(values.release)) });
  console.log(JSON.stringify(report, null, 2));
}

await main().catch(() => {
  console.error('Unable to verify the terminal campaign for request attribution. ' + usage);
  process.exitCode = 1;
});
