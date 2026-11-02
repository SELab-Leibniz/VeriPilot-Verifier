// Evaluation fixture only. Business operations remain installed native tools;
// this hook can veto them, but cannot execute tools or publish RC evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dispatchHarborOriginalAgent } from '../bench/harbor-gateway-runner.mjs';

import { integratedDeliverables, integratedInputs, integratedHash } from './native-integrated-fixture-fence.mjs';
export { integratedDeliverables, integratedInputs, integratedHash, integratedFixtureFence } from './native-integrated-fixture-fence.mjs';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const execute = promisify(execFile);

export function integratedVerifierCommand(projectRoot, nodeBinary) {
  // Exact public command: no inherited credentials, NODE_OPTIONS, write, net,
  // child-process, worker or project-directory read grant.
  const files = ['app.mjs', 'docs/guide.md', 'tools/verify.mjs'].map(file => path.join(projectRoot, file));
  return `/usr/bin/env -i PATH=/opt/homebrew/bin:/usr/bin:/bin ${quote(nodeBinary)} --permission ${files.map(file => quote(`--allow-fs-read=${file}`)).join(' ')} ${quote(files[2])}`;
}

export function integratedPolicy({ modelRef, roleTimeoutMs = 180000, assessmentTimeoutMs = 210000 }) {
  if (!/^[\w./:-]+$/u.test(modelRef) || !Number.isSafeInteger(roleTimeoutMs) || roleTimeoutMs < 1000
    || !Number.isSafeInteger(assessmentTimeoutMs) || assessmentTimeoutMs <= 30000)
    throw new Error('Invalid finite integrated policy');
  return `version: 2
locale: en
groundTruth:
  - id: original-contract
    type: user-confirmed-requirement
    authority: user
    required: true
    patterns: [requirements/original-contract.md]
artifacts:
  - name: usage-guide
    stage: solution-design
    format: markdown
    patterns: [docs/guide.md]
    groundTruth: [original-contract]
    rules:
      enabled: false
    review:
      enabled: true
      criteria: review.md
dynamicGroundTruth:
  enabled: true
  materialRoots: [requirements/original-contract.md]
  panel:
    size: 0
skillCorrection:
  enabled: true
  selection:
    mode: include
    include: [delivery-verifier]
    exclude: []
  skillRoots: [skills]
artifactCorrection:
  groundTruthReviewEnabled: true
  stageMetricsEnabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: true
  waitMode: until_pass
  maxCorrectionsPerSession: 1
  maxCorrectionsPerFlow: 1
  assessmentTimeoutMs: ${assessmentTimeoutMs}
  feedbackReserveMs: 30000
reviewers:
  defaults:
    model: ${modelRef}
    effort: low
    timeoutMs: ${roleTimeoutMs}
    maxOutputTokens: 32768
    formatRepairAttempts: 12
  groundTruthExtractor:
    effort: high
output:
  persist: true
  mode: centralized
  directory: .runtime-correction
`;
}

export const integratedVerifierSource = `import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const appUrl = new URL('../app.mjs', import.meta.url);
const guideUrl = new URL('../docs/guide.md', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const app = await fs.readFile(appUrl), guide = await fs.readFile(guideUrl);
const { accept } = await import(appUrl.href);
const values = [0, 1, -1, 7, 0.5, -4.5, Number.MAX_SAFE_INTEGER];
const codePassed = typeof accept === 'function' && values.every(value => accept(value) === value + 1)
  && values.every(value => accept(value) === value + 1);
// Public smoke check, not an official grader or a semantic document review.
const text = guide.toString('utf8');
const guidePassed = /finite/i.test(text) && /accept\\s*\\(\\s*2\\s*\\)\\s*(?:===|==|=>|→|returns)\\s*3/.test(text)
  && /stateless|without (?:storing |retaining )?state/i.test(text) && /out(?:side| of) scope/i.test(text);
console.log(JSON.stringify({ kind: 'public-delivery-verification-v1', appSha256: sha(app), guideSha256: sha(guide), codePassed, guidePassed }));
process.exitCode = codePassed && guidePassed ? 0 : 3;
`;

export async function prepareIntegratedFixture({ projectRoot, modelRef, nodeBinary = process.execPath,
  roleTimeoutMs, assessmentTimeoutMs, businessTimeoutMs = 600000, deadlineAt = null }) {
  if (!Number.isSafeInteger(businessTimeoutMs) || businessTimeoutMs < 1000 || businessTimeoutMs > 3600000)
    throw new Error('Invalid original business timeout');
  if (deadlineAt !== null && (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()))
    throw new Error('Invalid integrated stage deadline');
  await fs.mkdir(projectRoot); // Fresh fixture required; never overwrite a project.
  projectRoot = await fs.realpath(projectRoot);
  nodeBinary = await fs.realpath(nodeBinary);
  const command = integratedVerifierCommand(projectRoot, nodeBinary);
  const contract = 'The exported accept(value) in app.mjs must return the supplied finite number plus one without storing state. Other input types are outside scope. docs/guide.md must describe the supported finite-number input, show accept(2) === 3, explain that the operation is stateless, and identify other input types as outside scope.\n';
  const skill = `---\nname: delivery-verifier\ndescription: Finish this small module and usage guide with a fresh public verification.\n---\n\nRead the original contract and implement the code and guide. After the final change to either deliverable, run the following exact public command with the native exec tool, workdir ${projectRoot}, timeout 10, yieldMs 10000, background false. Establish its actual exit code 0 before declaring completion. If a later correction changes either deliverable, run it again after that change; an earlier success does not satisfy the new verification duty.\n\n${command}\n\nThis command reads only app.mjs, docs/guide.md and tools/verify.mjs and has no network, filesystem write or child-process permissions. Inputs and the verifier are supplied read-only; edit only the two deliverables.\n`;
  const files = {
    'app.mjs': 'export const accept = value => value;\n',
    'docs/guide.md': '# Usage guide\n\nTo be completed for the supplied module.\n',
    'requirements/original-contract.md': contract,
    'skills/delivery-verifier/SKILL.md': skill,
    'tools/verify.mjs': integratedVerifierSource,
    '.runtime-corrector/config.yaml': integratedPolicy({ modelRef, roleTimeoutMs, assessmentTimeoutMs }),
    '.runtime-corrector/review.md': 'Assess the current usage guide against the complete original user request and adopted original contract. Preserve conditions and exclusions. Report only concrete contradictions or omissions applicable to this guide; do not invent requirements or apply edits.\n',
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(projectRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, { flag: 'wx' });
  }
  // Give the original business a genuine, isolated starting tree. Otherwise
  // git discovery could walk up into this RC development repository.
  const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const gitOptions = { env: gitEnv, timeout: 10000, maxBuffer: 65536 };
  await execute('git', ['init', '--quiet', '--template=', projectRoot], gitOptions);
  await execute('git', ['-C', projectRoot, 'add', '--', ...Object.keys(files)], gitOptions);
  await execute('git', ['-C', projectRoot, '-c', 'user.name=RC Local Evaluation', '-c', 'user.email=rc@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'public fixture starting tree'], gitOptions);
  const immutableHashes = Object.fromEntries(Object.entries(files).filter(([file]) => !integratedDeliverables.includes(file))
    .map(([file, text]) => [file, integratedHash(text)]));
  const requirement = `Implement app.mjs and complete docs/guide.md according to the complete original contract in requirements/original-contract.md. Read and follow the matching delivery-verifier Skill at skills/delivery-verifier/SKILL.md. After your final code or guide edit, actually run its supplied public verifier and establish exit code 0 before declaring completion. Repeat verification after any later correction. Preserve the contract and explicit exclusions. Edit only app.mjs and docs/guide.md; the supplied contract, Skill and verifier are read-only.`;
  return { kind: 'native-integrated-module-fixture-v1', projectRoot, nodeBinary, deadlineAt, businessTimeoutMs,
    nodeSha256: integratedHash(await fs.readFile(nodeBinary)), command, immutableHashes, requirement,
    deliverables: [...integratedDeliverables], inputs: [...integratedInputs] };
}

export async function createIntegratedFencePlugin({ outputRoot, fixtureFile, bindingFile }) {
  const root = path.join(outputRoot, 'integrated-fixture-fence'); await fs.mkdir(root);
  const id = 'rc-integrated-fixture-fence';
  await fs.writeFile(path.join(root, 'openclaw.plugin.json'), JSON.stringify({ id, name: 'Isolated integrated fixture fence', main: './index.mjs', version: '0.0.0',
    activation: { onCapabilities: ['hook'] },
    contracts: { agentToolResultMiddleware: ['openclaw'] },
    configSchema: { type: 'object', additionalProperties: false, properties: {} } }, null, 2));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: id, version: '0.0.0', type: 'module', openclaw: { extensions: ['./index.mjs'] } }));
  await fs.writeFile(path.join(root, 'index.mjs'), `import fs from 'node:fs/promises';
import { integratedFixtureFence } from ${JSON.stringify(new URL('./native-integrated-fixture-fence.mjs', import.meta.url).href)};
import { createIntegratedBusinessObserver } from ${JSON.stringify(new URL('./native-integrated-observation.mjs', import.meta.url).href)};
export default { id: ${JSON.stringify(id)}, register(api) {
  const eventsFile = ${JSON.stringify(path.join(outputRoot, 'native-business-tools.jsonl'))};
  const observers = globalThis[Symbol.for('rc-eval.integrated-observation.v1')] ??= new Map();
  let observer = observers.get(${JSON.stringify(bindingFile)});
  if (!observer) observers.set(${JSON.stringify(bindingFile)}, observer = createIntegratedBusinessObserver({
    business: () => fs.readFile(${JSON.stringify(bindingFile)}, 'utf8').then(JSON.parse, () => null),
    append: item => fs.appendFile(eventsFile, JSON.stringify(item) + '\\n'),
  }));
  api.on('before_tool_call', async (event, ctx) => {
    try {
      const fixture = JSON.parse(await fs.readFile(${JSON.stringify(fixtureFile)}, 'utf8'));
      const business = JSON.parse(await fs.readFile(${JSON.stringify(bindingFile)}, 'utf8'));
      const decision = await integratedFixtureFence({ fixture, business }, event, ctx);
      await observer.before(event, ctx, decision);
      return decision;
    } catch { return { block: true, blockReason: 'INTEGRATED_FIXTURE_DENIED: missing experiment binding' }; }
  }, { priority: 2000, timeoutMs: 10000 });
  api.registerAgentToolResultMiddleware(async (event, ctx) => {
    // Read-only observation of actual host tool receipts, including native
    // exec exit status which the persisted model transcript may omit.
    await observer.result(event, ctx);
  }, { runtimes: ['openclaw'] });
} };
`);
  return { id, path: root };
}

export async function dispatchIntegratedOriginal({ gateway, fixture, bindingFile, deadlineAt, signal }) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt - Date.now() < 1000
    || !Number.isSafeInteger(fixture.deadlineAt) || deadlineAt > fixture.deadlineAt)
    throw new Error('Integrated stage deadline missing, expired or extended');
  const businessTimeoutMs = fixture.businessTimeoutMs ?? 600000;
  if (!Number.isSafeInteger(businessTimeoutMs) || businessTimeoutMs < 1000 || businessTimeoutMs > 3600000)
    throw new Error('Invalid original business timeout');
  const key = `agent:main:rc-integrated-${randomUUID()}`;
  const created = await gateway.request('sessions.create', { key, agentId: 'main', label: 'Isolated integrated original business' });
  if (!created.ok || !created.key) throw new Error('Actual isolated session creation failed');
  const scope = { agentId: 'main', sessionKey: created.key, storePath: gateway.config.session.store };
  await gateway.runtime.agent.session.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: fixture.projectRoot }) });
  const saved = await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' });
  if (!saved?.sessionId || saved.spawnedCwd !== fixture.projectRoot) throw new Error('Actual fixture selection did not persist');
  const business = { sessionId: saved.sessionId, sessionKey: created.key, originalRunId: randomUUID() };
  await fs.writeFile(bindingFile, JSON.stringify(business, null, 2), { flag: 'wx' });
  if (gateway.faultInjection) await fs.writeFile(path.join(gateway.root, 'fault-target.json'), JSON.stringify({ runId: business.originalRunId }), { flag: 'wx' });
  signal?.throwIfAborted();
  const accepted = await dispatchHarborOriginalAgent({ request: (...args) => gateway.request(...args), instruction: fixture.requirement,
    runId: business.originalRunId, sessionId: business.sessionId, sessionKey: business.sessionKey,
    deadlineAt: Math.min(deadlineAt, Date.now() + businessTimeoutMs) });
  return { ...business, accepted };
}
