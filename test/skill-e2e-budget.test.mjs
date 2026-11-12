import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dispatchIntegratedOriginal, prepareIntegratedFixture } from '../scripts/helpers/native-integrated-module-case.mjs';
import { integratedFixtureFence } from '../scripts/helpers/native-integrated-fixture-fence.mjs';
import { nativeGatewayCodingProvider } from '../scripts/helpers/native-gateway-evaluation.mjs';
import { skillE2eOptions, skillE2eProvider, skillVerifierCommand } from '../scripts/evaluate-skill-e2e.mjs';

test('Skill explicit provider retains streaming usage and the finite metered token envelope', () => {
  const options = skillE2eOptions(['--base-url','https://example.test/v1','--model','example-model']);
  const definition = { api:'openai-completions',baseUrl:options.baseUrl,model:options.model,
    definition:{id:options.model,maxTokens:65536,compat:{thinkingFormat:'deepseek'}} };
  const selected = skillE2eProvider(options,definition);
  assert.equal(selected.definition.maxTokens,32768);
  assert.equal(selected.definition.compat.supportsUsageInStreaming,true);
  assert.equal(selected.definition.compat.maxTokensField,'max_tokens');
  assert.equal(selected.definition.compat.thinkingFormat,'deepseek');
  assert.equal(definition.definition.maxTokens,65536,'the supplied public profile stays unchanged');
});

test('Windows Skill verifier executes with a cleared environment and exact read-only permissions',
  { skip: process.platform !== 'win32' }, async t => {
    const temp=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temp,'rc-skill-win-command-'));
    assert(root.startsWith(temp+path.sep));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const fixture=await prepareIntegratedFixture({projectRoot:path.join(root,'project with space'),modelRef:'fixture/model'});
    const privateFile=path.join(root,'private.txt'),writeFile=path.join(root,'must-not-write.txt');
    await fs.writeFile(privateFile,'not a verifier input');
    await fs.writeFile(path.join(fixture.projectRoot,'app.mjs'),`import fs from 'node:fs';
if(process.env.RC_VERIFY_ISOLATION_SENTINEL)throw Error('Verifier inherited environment');
for(const action of [()=>fs.readFileSync(${JSON.stringify(privateFile)}),()=>fs.writeFileSync(${JSON.stringify(writeFile)},'denied')]){
 let code;try{action();}catch(error){code=error.code;}if(code!=='ERR_ACCESS_DENIED')throw Error('Verifier permissions expanded');
}
export const accept=value=>value+1;\n`);
    await fs.writeFile(path.join(fixture.projectRoot,'docs/guide.md'),'finite numbers; accept(2) === 3; stateless; other inputs are outside scope.\n');
    const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',skillVerifierCommand(fixture)],{
      cwd:fixture.projectRoot,windowsHide:true,timeout:20000,
      env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,RC_VERIFY_ISOLATION_SENTINEL:'must-not-reach-verifier'}});
    const result=JSON.parse(stdout.trim());
    assert.equal(result.codePassed,true);assert.equal(result.guidePassed,true);
    assert.equal(await fs.stat(writeFile).then(()=>true,()=>false),false);
    await fs.writeFile(path.join(fixture.projectRoot,'app.mjs'),'export const accept=value=>value;\n');
    await assert.rejects(promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',skillVerifierCommand(fixture)],{
      cwd:fixture.projectRoot,windowsHide:true,timeout:20000,env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH}}),
      error=>error.code===3&&JSON.parse(error.stdout.trim()).codePassed===false);
  });

test('Skill public provider metadata must match its explicit endpoint and model and cannot carry a key', () => {
  const options = skillE2eOptions(['--base-url', 'https://example.test/v1', '--model', 'example-model',
    '--provider-definition', 'public-provider.json']);
  const provider = { api: 'openai-completions', baseUrl: options.baseUrl, model: options.model,
    definition: { id: options.model, contextWindow: 128000, maxTokens: 32768 } };
  assert.equal(options.providerDefinition, 'public-provider.json');
  const selected=skillE2eProvider(options, provider);
  assert.equal(selected.baseUrl,provider.baseUrl);assert.equal(selected.model,provider.model);
  assert.equal(provider.definition.maxTokens,32768);
  assert.throws(() => skillE2eProvider({ ...options, model: 'other' }, provider), /must match/);
  assert.throws(() => skillE2eProvider(options, { ...provider, apiKey: 'dummy-only' }), /Credentials/);
});

test('configured original business timeout can exceed ten minutes but remains bounded by the case deadline', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-skill-budget-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [index, wallMs] of [1800000, 900000].entries()) {
    let submitted;
    const gateway = { config: { session: { store: 'fixture-store' } },
      runtime: { agent: { session: { async patchSessionEntry() {},
        async getSessionEntry() { return { sessionId: 'actual-fixture-session', spawnedCwd: root }; } } } },
      async request(method, args) {
        if (method === 'sessions.create') return { ok: true, key: args.key };
        assert.equal(method, 'agent'); submitted = args;
        return { runId: args.idempotencyKey, sessionKey: args.sessionKey };
      } };
    const deadlineAt = Date.now() + wallMs;
    await dispatchIntegratedOriginal({ gateway, fixture: { projectRoot: root, deadlineAt,
      businessTimeoutMs: 1200000, requirement: 'Run the Skill.' },
    bindingFile: path.join(root, `binding-${index}.json`), deadlineAt, signal: new AbortController().signal });
    assert(submitted.timeout > 600, JSON.stringify(submitted));
    assert(submitted.timeout <= Math.min(1200, wallMs / 1000));
  }
});

test('GLM Flash uses the explicit configured model and does not admit embedded credentials or unknown providers', () => {
  const provider = { api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3-flash' };
  assert.equal(nativeGatewayCodingProvider(provider, 128000, 1200000).definition.models[0].id, 'glm-5.3-flash');
  for (const candidate of [{ ...provider, apiKey: 'forbidden' }, { ...provider, baseUrl: 'https://example.invalid/v1' },
    { ...provider, model: 'unexpected-model' }]) assert.throws(() => nativeGatewayCodingProvider(candidate));
  assert.equal(skillE2eOptions([]).model, 'glm-5.3-flash');
  assert.equal(skillE2eOptions([]).maxWatchTurns, 1);
  assert.throws(() => skillE2eOptions(['--max-watch-turns', '0']));
  assert.throws(() => skillE2eOptions(['--check-interval-turns', '0']));
});

test('Skill fixture accepts native optional execution defaults while preserving the exact command and original strict mode', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-skill-exec-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await prepareIntegratedFixture({ projectRoot: path.join(root, 'project'), modelRef: 'openai/glm-5.3-flash' });
  const business = { sessionId: 'fixture-session', sessionKey: 'fixture-key' }, ctx = { ...business, runId: 'fixture-run' };
  const call = params => integratedFixtureFence({ fixture, business }, { toolName: 'exec', params }, ctx);
  assert.equal((await call({ command: fixture.command })).block, true, 'legacy exact-option contract remains unchanged');
  fixture.strictExecOptions = false;
  assert.equal(await call({ command: fixture.command }), undefined);
  assert.equal(await call({ command: fixture.command, workdir: fixture.projectRoot, timeout: 60 }), undefined);
  for (const args of [{ command: fixture.command + '; echo changed' }, { command: fixture.command, background: true },
    { command: fixture.command, workdir: root }, { command: fixture.command, timeout: 0 },
    { command: fixture.command, timeout: Infinity }, { command: fixture.command, yieldMs: 40000 }])
    assert.equal((await call(args)).block, true);
});
