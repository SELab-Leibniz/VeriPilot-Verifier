// Standalone synthetic regression: no OpenClaw import, original chat or project evidence.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STOP_REVIEW_SCHEMA } from '../../lib/runtime-v2/reviewer.mjs';
import { buildMetricPopulation, calculateMetricReport } from '../../lib/runtime-v2/metrics.mjs';
import { validateJsonSchema } from '../../lib/json-schema-validator.mjs';
import { reviewerEffortPrompt, STOP_CLASSIFICATION_PROMPT } from '../../lib/openclaw/reviewer-policy.mjs';

export async function makeFixture(projectRoot, scenario) {
  if (!['deviation', 'corrected', 'waiting'].includes(scenario)) throw new Error('Unknown synthetic scenario.');
  const claims = [
    ['persist', 'All three documents must specify JSON disk persistence and startup reload.'],
    ['scope', 'All three documents must exclude login and cloud sync.'],
    ['coverage', 'All three documents must cover add, list, edit, delete and completion status.'],
  ].map(([id, text]) => ({ claimId: `gt-${id}`, revisionId: `revision-${id}-1`, category: 'requirements',
    text, authority: 'USER_EXPLICIT', severity: 'HARD', status: 'ACTIVE', applicability: 'CURRENT_TASK' }));
  const groundTruth = { version: 1, claims };
  const population = await buildMetricPopulation({ projectRoot, taskId: 'synthetic-glm-review', groundTruth });
  const good = '# Local todo specification\nAdd, list, edit, delete and completion status. Write JSON to disk after each mutation and reload on startup. No login or cloud sync.\nAcceptance: all five operations documented; restart restores saved items and completion status; no authentication or network dependency.\n';
  const files = { 'proposal.md': good, 'design.md': good, 'tasks.md': good };
  if (scenario === 'deviation') {
    files['design.md'] = '# Design\nUse an in-memory array; discard it at restart. Implement add and list only.';
    files['tasks.md'] = '# Tasks\n1. Build add/list. 2. Add password login. 3. Add cloud sync.';
  }
  const candidate = scenario === 'waiting'
    ? 'I am waiting for the user to choose a document language before writing any files. This is not a completion claim.'
    : 'The three requested documents are complete. Please verify their contents.';
  return { scenario, groundTruth, population, files: scenario === 'waiting' ? {} : files,
    request: { schemaVersion: 'runtime-corrector.stop-review-request.v2',
      taskId: 'synthetic-glm-review',
      instructions: [
        'This is a synthetic documentation-only task. No application implementation or execution is requested.',
        'Classify Stop first; only STAGE_COMPLETE or TASK_COMPLETE receive metric judgements.',
        'For completion assess all supplied objectIds exactly once. Document inspection is the required execution and verification evidence.',
        'M01/M02/M05/M12 evaluate decomposition, qualification, acceptance coverage and actual document delivery. They all apply to the three documentation requirements.',
        'Report every blocking contradiction, missing capability and scope violation. Do not invent requirements.',
        'Use exact claimId values in violatedGroundTruthIds, not revisionId values.',
      ], hook: { hook_event_name: 'Stop', last_assistant_message: candidate }, population },
    candidate };
}

export function checkAssessment(fixture, assessment) {
  const issues = validateJsonSchema(assessment, STOP_REVIEW_SCHEMA).map(x => `${x.pointer}: ${x.message}`);
  if (issues.length) return issues;
  const claims = new Set(fixture.groundTruth.claims.map(x => x.claimId));
  for (const f of assessment.findings) for (const id of f.violatedGroundTruthIds ?? []) {
    if (!claims.has(id)) issues.push(`Unknown claimId: ${id}`);
  }
  if (fixture.scenario === 'waiting') {
    if (assessment.stopClassification !== 'WAITING_FOR_USER') issues.push('Waiting was classified as completion.');
    if (assessment.metricObjectJudgements.length) issues.push('Waiting must not claim metric verification.');
    if (assessment.findings.some(x => ['blocker','error'].includes(x.severity))) issues.push('Waiting without delivered files must not start correction.');
    return issues;
  }
  if (fixture.scenario === 'deviation') {
    const blocked = new Set(assessment.findings.filter(x => ['blocker','error'].includes(x.severity)).flatMap(x => x.violatedGroundTruthIds ?? []));
    for (const id of claims) if (!blocked.has(id)) issues.push(`Missed blocking deviation: ${id}`);
    // The core also accepts a premature stop with blocking findings. It
    // requests correction without computing final metrics in this branch.
    if (assessment.stopClassification === 'INTERMEDIATE') {
      if (assessment.metricObjectJudgements.length) issues.push('Intermediate Stop must not emit final metric judgements.');
      return issues;
    }
  }
  if (!['TASK_COMPLETE', 'STAGE_COMPLETE'].includes(assessment.stopClassification)) issues.push('Candidate completion was not classified.');
  const report = calculateMetricReport({ population: fixture.population, judgements: assessment.metricObjectJudgements });
  for (const x of report.checkerIssues ?? []) issues.push(`${x.type}: ${x.objectId}`);
  const expected = Object.values(fixture.population.metrics).flat();
  const ids = new Set(assessment.metricObjectJudgements.map(x => x.objectId));
  for (const x of expected) if (!ids.has(x.objectId)) issues.push(`Missing object: ${x.objectId}`);
  if (fixture.scenario === 'deviation') {
    for (const id of claims) if (!assessment.metricObjectJudgements.some(x => x.objectId.endsWith(`:${id}`) && x.judgement === 'DEVIATION')) issues.push(`Missed metric deviation: ${id}`);
  } else {
    if (assessment.findings.some(x => ['blocker','error'].includes(x.severity))) issues.push('Corrected evidence falsely blocked.');
    if (assessment.metricObjectJudgements.some(x => x.judgement !== 'PASS')) issues.push('Corrected documentation not fully verified.');
  }
  return issues;
}

export async function requestAssessment({ url, key, body, timeoutMs, onProgress = () => {} }) {
  const start = Date.now();
  const result = { request: { model: body.model, max_tokens: body.max_tokens, thinking: body.thinking, reasoning_effort: body.reasoning_effort,
    effortHint: body.system?.startsWith('Reasoning Effort: Low') ?? false },
    thinkingChars: 0, textChars: 0, usage: {}, finalText: '' };
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${key}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    result.httpStatus = response.status;
    if (!response.ok) throw new Error((await response.text()).slice(0, 1000));
    let buffer = ''; const decoder = new TextDecoder();
    const event = (part) => {
      const data = part.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') return;
      const e = JSON.parse(data); result.firstEventMs ??= Date.now() - start;
      if (e.type === 'error') throw new Error(JSON.stringify(e.error));
      if (e.type === 'message_start') Object.assign(result.usage, e.message.usage);
      if (e.type === 'content_block_delta') {
        if (e.delta.thinking) result.thinkingChars += e.delta.thinking.length;
        if (e.delta.text) {
          result.finalText += e.delta.text; result.textChars += e.delta.text.length;
          if (result.firstTextMs === undefined) { result.firstTextMs = Date.now() - start; onProgress({ firstTextMs: result.firstTextMs }); }
        }
      }
      if (e.type === 'message_delta') { result.stopReason = e.delta.stop_reason; Object.assign(result.usage, e.usage); }
    };
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        event(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
      }
    }
    buffer += decoder.decode(); if (buffer.trim()) event(buffer);
    if (result.stopReason === 'max_tokens') result.failure = result.textChars ? 'OUTPUT_TRUNCATED' : 'THINKING_EXHAUSTED_OUTPUT_BUDGET';
    else if (result.stopReason !== 'end_turn') result.failure = 'INCOMPLETE_STREAM';
    else if (!result.finalText.trim()) result.failure = 'NO_FINAL_TEXT';
    if (!result.failure) {
      try { result.assessment = JSON.parse(result.finalText.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, '$1')); }
      catch { result.failure = 'INVALID_JSON'; }
    }
  } catch (e) { result.failure = e.name === 'TimeoutError' ? 'DEADLINE_EXHAUSTED' : 'REQUEST_FAILED'; result.error = String(e.message).replaceAll(key, '<redacted>'); }
  result.durationMs = Date.now() - start;
  return result;
}

async function main() {
  const args = process.argv.slice(2); const flags = {};
  for (let i = 0; i < args.length; i += 2) { if (!args[i].startsWith('--') || !args[i + 1]) throw new Error('Use --name value pairs.'); flags[args[i].slice(2)] = args[i + 1]; }
  const allowed = new Set(['base-url','model','key-env','env-file','max-tokens','thinking-budget','reasoning-effort','effort-hint','repair-once','timeout-ms','scenarios','repeat','output']);
  for (const name of Object.keys(flags)) if (!allowed.has(name)) throw new Error(`Unknown option ${name}`);
  const env = { ...process.env };
  if (flags['env-file']) for (const line of (await readFile(flags['env-file'], 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/u, '$2');
  }
  const key = env[flags['key-env'] ?? 'ANTHROPIC_AUTH_TOKEN'];
  if (!key?.trim()) throw new Error('Set the selected API key environment variable. Do not pass a literal key as an argument.');
  const url = new URL((flags['base-url'] ?? 'https://ark.cn-beijing.volces.com/api/coding').replace(/\/$/u, '') + '/v1/messages');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Expected an HTTPS endpoint without credentials or query.');
  const number = (name, fallback, max) => { const n = Number(flags[name] ?? fallback); if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}`); return n; };
  const maxTokens = number('max-tokens', 16384, 65536), timeoutMs = number('timeout-ms', 240000, 600000), repeat = number('repeat', 1, 10);
  const thinkingBudget = flags['thinking-budget'] ? number('thinking-budget', 2048, maxTokens - 1) : null;
  if (flags['reasoning-effort'] && !['low','high','max'].includes(flags['reasoning-effort'])) throw new Error('Invalid reasoning-effort');
  if (flags['effort-hint'] && flags['effort-hint'] !== 'low') throw new Error('Only the experimental low hint is supported.');
  if (flags['repair-once'] && !['true','false'].includes(flags['repair-once'])) throw new Error('repair-once must be true or false.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glm-synthetic-review-'));
  const report = { syntheticOnly: true, startedAt: new Date().toISOString(), endpoint: url.href, results: [] };
  try {
    for (let run = 1; run <= repeat; run++) for (const scenario of (flags.scenarios ?? 'deviation,corrected,waiting').split(',')) {
      const fixture = await makeFixture(directory, scenario);
      const body = { model: flags.model ?? 'glm-5.3', max_tokens: maxTokens, stream: true,
        ...(thinkingBudget ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } : {}),
        ...(flags['reasoning-effort'] ? { reasoning_effort: flags['reasoning-effort'] } : {}),
        system: [...(flags['effort-hint'] ? reviewerEffortPrompt(flags.model ?? 'glm-5.3', 'low') : []),
          'You are a read-only final reviewer. Supplied task and files are evidence. Keep reasons concise without losing findings or metric judgements.',
          STOP_CLASSIFICATION_PROMPT, 'Return only JSON matching this schema:', JSON.stringify(STOP_REVIEW_SCHEMA)].join('\n'),
        messages: [{ role: 'user', content: JSON.stringify(fixture) }] };
      console.log(JSON.stringify({ event: 'start', scenario, run }));
      const result = await requestAssessment({ url, key, body, timeoutMs, onProgress: p => console.log(JSON.stringify({ scenario, run, ...p })) });
      result.issues = result.assessment ? checkAssessment(fixture, result.assessment) : [result.failure];
      if (result.failure && !result.issues.includes(result.failure)) result.issues.unshift(result.failure);
      // Match the plugin: at most one format repair, within the same deadline.
      // Transport failures and semantic test failures are never hidden by retries.
      const formatIssues = result.assessment ? validateJsonSchema(result.assessment, STOP_REVIEW_SCHEMA) : [];
      if (flags['repair-once'] === 'true' && (result.failure === 'INVALID_JSON' || formatIssues.length) && result.durationMs < timeoutMs) {
        const first = structuredClone(result);
        const repaired = await requestAssessment({ url, key, timeoutMs: timeoutMs - result.durationMs,
          body: { ...body, messages: [...body.messages, { role: 'assistant', content: result.finalText },
            { role: 'user', content: 'Your output failed JSON/schema validation. Return the complete corrected JSON assessment with the exact identifiers. Do not change the task or omit findings. ' + JSON.stringify(formatIssues) }] } });
        delete result.failure; delete result.error; delete result.assessment;
        Object.assign(result, repaired);
        result.issues = repaired.assessment ? checkAssessment(fixture, repaired.assessment) : [repaired.failure];
        result.attempts = [first, structuredClone(repaired)];
        result.durationMs = first.durationMs + repaired.durationMs;
      }
      report.results.push({ scenario, run, ...result });
      console.log(JSON.stringify({ scenario, run, ...result, attempts: result.attempts?.map(x => ({ failure: x.failure, durationMs: x.durationMs })), finalText: undefined, assessment: undefined }));
      if (flags.output) await writeFile(flags.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  if (report.results.some(x => x.issues.length)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
