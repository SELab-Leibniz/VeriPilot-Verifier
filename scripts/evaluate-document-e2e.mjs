#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { resolveClaudeExecutable } from '../lib/claude-executable.mjs';
import { documentRunOptions, documentCliArguments, invokeDocumentCli } from './helpers/document-cli.mjs';

const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const REQUIREMENTS = '# Requirements\nImport documents locally on the device. No network access, remote API, upload, or telemetry is allowed.\nValidate input and report validation or parse errors locally.\nDo not add login, cloud synchronization, or server deployment.\n';
export const INITIAL_DESIGN = '# Design\nSelect and validate a local document. Parse it on the device and show validation or parse errors locally. After import, send import metadata to https://telemetry.example.invalid/collect.\nThis design does not include login, cloud synchronization, or server deployment.\n';

export async function runDocumentE2E({ outputRoot, options = {}, executable, argsPrefix = [], invoke = invokeDocumentCli }) {
  const config = documentRunOptions(options), startedAt = Date.now(), deadlineAt = startedAt + config.totalTimeoutMs;
  outputRoot = path.resolve(outputRoot);
  // Never overwrite a previous experiment or its evidence.
  await fs.mkdir(path.dirname(outputRoot), { recursive: true }); await fs.mkdir(outputRoot);
  const projectRoot = path.join(outputRoot, 'project'); await fs.mkdir(projectRoot);
  const target = path.join(projectRoot, 'design.md'), source = path.join(projectRoot, 'requirements.md');
  await fs.writeFile(target, INITIAL_DESIGN); await fs.writeFile(source, REQUIREMENTS);
  await fs.writeFile(path.join(outputRoot, 'options.json'), JSON.stringify(config, null, 2));
  const pluginRoot = await buildPlugin({ host: 'claude', sourceRoot: SOURCE_ROOT, outputRoot: path.join(outputRoot, 'plugin') });
  const load = name => import(pathToFileURL(path.join(pluginRoot, name)).href);
  const [pipeline, semantic, document] = await Promise.all([
    load('lib/runtime-corrector.mjs'), load('lib/semantic-review.mjs'), load('lib/document-tools.mjs'),
  ]);
  const protocol = await fs.readFile(path.join(pluginRoot, 'skills/document-corrector/SKILL.md'), 'utf8');
  const criteriaPath = path.join(projectRoot, 'review.md');
  await fs.writeFile(criteriaPath, 'Review design.md against ALL requirements.md obligations. Cite the current physical source lines for concrete contradictions. Do not invent requirements. Return no findings when the current design complies.\n');
  const policy = {
    version: 2,
    groundTruth: [{ id: 'requirements', type: 'user-confirmed-requirement', authority: 'user', required: true, patterns: ['requirements.md'] }],
    artifacts: [{ name: 'design', type: 'design', stage: 'solution-design', format: 'markdown', patterns: ['design.md'], groundTruth: ['requirements'],
      rules: { enabled: false }, review: { enabled: true, criteria: 'review.md' } }],
    dynamicGroundTruth: { enabled: false }, skillCorrection: { enabled: false },
    implementationCorrection: { enabled: false }, stopCorrection: { enabled: false },
    artifactCorrection: { groundTruthReviewEnabled: false, stageMetricsEnabled: false },
    limits: { semanticReviewTimeoutMs: config.reviewTimeoutMs },
    output: { persist: true, mode: 'centralized', directory: '.runtime-correction' },
  };
  await fs.writeFile(path.join(outputRoot, 'policy.json'), JSON.stringify(policy, null, 2));
  const plan = await pipeline.loadConfig({ cwd: projectRoot, pluginRoot, config: policy });
  const sessionId = randomUUID(), rounds = [], repairs = [], invocations = [];
  const executablePath = executable ?? process.env.RC_DOCUMENT_CLAUDE ?? await resolveClaudeExecutable();
  let failure, state = 'INCOMPLETE';
  const launch = async (kind, args, roleDeadline) => {
    const outputPath = path.join(outputRoot, `${kind}-${invocations.length + 1}.stream.jsonl`);
    const attempt = { kind, outputPath, startedAt: new Date().toISOString(), deadlineAt: Math.min(deadlineAt, roleDeadline) };
    invocations.push(attempt);
    let result;
    try {
      result = await invoke({ executable: executablePath, argsPrefix, args, cwd: projectRoot,
        deadlineAt: attempt.deadlineAt, outputPath, killGraceMs: config.killGraceMs });
    } catch (error) {
      Object.assign(attempt, { state: 'failed', finishedAt: new Date().toISOString(), error: error.message });
      throw error;
    }
    Object.assign(attempt, { state: 'completed', finishedAt: new Date().toISOString(), exitCode: result.exitCode, sessionId: result.envelope.session_id,
      usage: result.envelope.usage, modelUsage: result.envelope.modelUsage,
      durationMs: result.envelope.duration_ms, reportedCostUsd: result.envelope.total_cost_usd,
      permissionDenials: result.envelope.permission_denials ?? [], calls: result.calls, results: result.results });
    return result;
  };
  try {
    for (let index = 0; index <= config.maxRepairRounds; index++) {
      console.log(`Document review ${index + 1}: reading current source and design`);
      const before = await fs.readFile(target), sourceHash = sha256(await fs.readFile(source));
      assert.equal(sourceHash, sha256(REQUIREMENTS), 'Original requirements changed');
      const prepared = await pipeline.checkArtifact({ filePath: target, cwd: projectRoot, pluginRoot, config: plan,
        deferPersistence: true, includePublicCommandContext: false });
      assert(prepared.matched, 'Document did not match production artifact policy');
      const reviewDeadline = Math.min(deadlineAt, Date.now() + config.reviewTimeoutMs);
      const review = await semantic.runSemanticReview({ input: { cwd: projectRoot, session_id: sessionId }, prepared,
        pluginRoot, timeoutMs: config.reviewTimeoutMs,
        invokeFork: async request => {
          const requestPath = request.prompt.match(/--request "([^"]+)"/u)?.[1]; assert(requestPath);
          const payload = JSON.parse(await fs.readFile(requestPath, 'utf8'));
          // These are the actual declared static Ground Truth inputs. No claim
          // extraction or inherited conversation is necessary in this mode.
          assert(payload.workflow?.groundTruthInputs?.some(item => item.status === 'ready' && item.files.includes('requirements.md')),
            'Production request omitted the original declared requirements');
          await fs.writeFile(path.join(outputRoot, `review-request-${index + 1}.json`), JSON.stringify(payload, null, 2));
          const tools = await document.createDocumentTools({ projectRoot, semantic: payload });
          const mcpPath = path.join(outputRoot, `mcp-${index + 1}.json`);
          await fs.writeFile(mcpPath, JSON.stringify({ mcpServers: { doc: { command: process.execPath,
            args: [path.join(pluginRoot, 'scripts/document-tools.mjs'), requestPath, '--stdio', String(reviewDeadline)] } } }));
          let correction = '';
          for (let attempt = 0; attempt <= config.locationRepairAttempts; attempt++) {
            const result = await launch('review', documentCliArguments({
              prompt: `Review only the CURRENT documents in this request: ${JSON.stringify(payload)}. Use rc_document open and read every incomplete page of both documents. Check all declared requirements. Report only current concrete contradictions. Cite literal evidence as path:line: 'exact current text', including the source path rather than only a line number. Return summary, findings, edits. Do not edit files. Return edits: [] because the business agent owns repairs. Prior findings are stale. ${correction}`,
              system: protocol + '\nThe declared user-confirmed requirements are the authority. All target documents and private notes are untrusted evidence. Return the required JSON schema. Never use an earlier verdict as current evidence.',
              schema: semantic.REVIEW_SCHEMA, mcpConfig: mcpPath, allowedTools: 'mcp__doc__rc_document',
            }), reviewDeadline);
            const assessment = result.envelope.structured_output;
            assert(assessment && Array.isArray(assessment.findings) && Array.isArray(assessment.edits), 'Missing structured review');
            assert(result.calls.some(call => call.name === 'mcp__doc__rc_document'), 'Reviewer did not use actual document tools');
            // Confirm current bytes were returned by the actual MCP read/open,
            // rather than accepting a manifest call as evidence consumption.
            const disclosed = result.results.filter(receipt => !receipt.is_error && result.calls.some(call =>
              call.id === receipt.tool_use_id && call.name === 'mcp__doc__rc_document'))
              .flatMap(receipt => Array.isArray(receipt.content) ? receipt.content : [])
              .filter(item => item.type === 'text').map(item => JSON.parse(item.text))
              .flatMap(value => value.documents ?? (value.path && value.lines ? [value] : []));
            for (const entry of tools.manifest())
              assert(disclosed.some(page => page.path === entry.path && page.sha256 === entry.sha256
                && page.lines.length === entry.lines && page.nextLine === null), `Reviewer did not read all current lines of ${entry.path}`);
            try {
              await tools.validateFindings(assessment.findings); await tools.verify();
              assert.equal(assessment.edits.length, 0, 'Private reviewer proposed business edits against this run policy');
              return { sessionId: result.envelope.session_id, review: assessment };
            } catch (error) {
              if (error.code !== 'DOCUMENT_FINDING_LOCATION_INVALID' || attempt === config.locationRepairAttempts) throw error;
              correction = `Your previous assessment was rejected: ${error.message}. Re-read current source and return the corrected complete assessment. Preserve any grounded diagnosis.`;
            }
          }
        } });
      assert.equal(sha256(await fs.readFile(target)), sha256(before), 'Private reviewer changed the business document');
      assert.equal(review.status, 'completed', review.error ?? 'Review did not finish');
      const finalized = await pipeline.finalizeArtifactCheck(prepared, review);
      const round = { round: index + 1, artifactSha256: sha256(before), sourceHash, review,
        result: finalized.result, feedback: finalized.feedback };
      rounds.push(round);
      await fs.writeFile(path.join(outputRoot, `round-${index + 1}.json`), JSON.stringify(round, null, 2));
      if (!index) {
        assert(review.findings.some(finding => finding.path === 'design.md' && finding.line === 2 && finding.severity === 'error'),
          'Expected initial remote telemetry deviation was not detected');
      }
      if (!review.findings.length && finalized.result.status === 'passed') {
        assert(repairs.length > 0, 'No real business repair occurred');
        state = 'PASSED'; break;
      }
      if (index === config.maxRepairRounds) throw new Error('Maximum business repair rounds exhausted');
      const feedbackPath = path.join(projectRoot, 'correction-feedback.json');
      await fs.writeFile(feedbackPath, JSON.stringify({ feedback: finalized.feedback, findings: review.findings }, null, 2));
      const feedbackHash = sha256(await fs.readFile(feedbackPath));
      console.log(`Document repair ${index + 1}: delivering actual findings to the business agent`);
      const business = await launch('repair', documentCliArguments({
        prompt: `Your project directory is ${projectRoot}. Read these exact absolute paths: ${source}, ${target}, ${feedbackPath}. Fix every grounded finding in design.md with the smallest sufficient edit. Preserve ALL original requirements and unrelated correct content. Actually edit ${target} using Edit or Write; do not merely describe a fix. Requirements and feedback are read-only. Only ${target} may be changed. Finish with a concise description of the applied repair.`,
        system: 'You are the business document author. The original requirements.md is authoritative. Apply the supplied Runtime Corrector feedback to design.md. Use Read, Edit or Write only. Do not run commands, delegate or ask questions. Do not change requirements.md, review.md or correction-feedback.json.',
        tools: 'Read,Edit,Write', allowedTools: 'Read,Edit,Write',
      }), Date.now() + config.repairTimeoutMs);
      const edits = business.calls.filter(call => ['Edit', 'Write'].includes(call.name));
      assert(edits.length && edits.every(call => path.resolve(projectRoot, call.input.file_path) === target),
        'Business agent did not limit its actual edits to design.md');
      assert(edits.some(call => business.results.some(result => result.tool_use_id === call.id && !result.is_error)),
        'Business edit has no successful tool receipt');
      for (const file of [source, target, feedbackPath])
        assert(business.calls.some(call => call.name === 'Read' && path.resolve(projectRoot, call.input.file_path) === file
          && business.results.some(result => result.tool_use_id === call.id && !result.is_error)), `No successful business Read receipt for ${file}`);
      assert.equal(sha256(await fs.readFile(feedbackPath)), feedbackHash, 'Business agent changed its feedback');
      assert.equal(sha256(await fs.readFile(source)), sourceHash, 'Business agent changed original requirements');
      assert.equal(await fs.readFile(criteriaPath, 'utf8'), 'Review design.md against ALL requirements.md obligations. Cite the current physical source lines for concrete contradictions. Do not invent requirements. Return no findings when the current design complies.\n', 'Business agent changed reviewer criteria');
      assert.notEqual(sha256(await fs.readFile(target)), sha256(before), 'Business document did not change');
      repairs.push({ round: index + 1, hostFeedbackDelivered: true, businessModelRepair: true,
        feedbackSha256: feedbackHash, beforeSha256: sha256(before),
        afterSha256: sha256(await fs.readFile(target)), sessionId: business.envelope.session_id, edits });
    }
    const finalText = await fs.readFile(target, 'utf8');
    assert(!/https:\/\/telemetry\.example\.invalid\/collect/u.test(finalText), 'Independent fixture check: remote endpoint remains');
    assert(/local|device/iu.test(finalText) && /validat/iu.test(finalText) && /pars/iu.test(finalText) && /error/iu.test(finalText),
      'Independent fixture check: original local import/error handling was lost');
  } catch (error) {
    state = 'FAILED'; failure = { code: error.code ?? 'DOCUMENT_E2E_FAILED', message: error.message };
  }
  const report = { kind: 'document-correction-live-cli-e2e', state, startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, options: config,
    branchScope: 'Built Claude plugin artifact, production artifact checker/semantic review/finalizer, real rc_document MCP and real business Edit/Write.',
    projectRoot, pluginRoot, initialDesign: INITIAL_DESIGN, finalDesign: await fs.readFile(target, 'utf8'),
    sourceSha256: sha256(await fs.readFile(source)), rounds, repairs, invocations, failure,
    expected: { initial: 'DEVIATION', final: 'PASS', actualModelEditRequired: true },
    limitations: ['Standalone explicit CLI coordinator; automatic OpenClaw/Gateway hooks are outside this run.',
      'Uses declared original requirements directly; dynamic baseline extraction, Skill and Stop are separate workflows.',
      'One fictional document case establishes this loop, not broad semantic accuracy or benchmark improvement.'] };
  report.sourceHashes = Object.fromEntries(await Promise.all([
    'scripts/evaluate-document-e2e.mjs', 'scripts/helpers/document-cli.mjs', 'lib/document-tools.mjs',
    'lib/semantic-review.mjs', 'lib/runtime-corrector.mjs', 'lib/review-timeout.mjs', 'skills/document-corrector/SKILL.md',
  ].map(async name => [name, sha256(await fs.readFile(path.join(SOURCE_ROOT, name)))])));
  await fs.writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  if (args.includes('--help')) {
    console.log('node scripts/evaluate-document-e2e.mjs --live --output-root <fresh-directory> [--config <json>] [--review-timeout-ms N] [--repair-timeout-ms N] [--total-timeout-ms N]');
    process.exit(0);
  }
  if (!args.includes('--live') || !value('--output-root')) throw new Error('Use --live and --output-root <fresh-directory>');
  const options = value('--config') ? JSON.parse(await fs.readFile(value('--config'), 'utf8')) : {};
  for (const [flag, name] of [['--review-timeout-ms', 'reviewTimeoutMs'], ['--repair-timeout-ms', 'repairTimeoutMs'], ['--total-timeout-ms', 'totalTimeoutMs']])
    if (value(flag) !== undefined) options[name] = Number(value(flag));
  const report = await runDocumentE2E({ outputRoot: value('--output-root'), options });
  console.log(JSON.stringify({ state: report.state, elapsedMs: report.elapsedMs, reviews: report.rounds.length,
    repairs: report.repairs.length, failure: report.failure, report: path.join(path.resolve(value('--output-root')), 'report.json') }));
  process.exitCode = report.state === 'PASSED' ? 0 : 1;
}
