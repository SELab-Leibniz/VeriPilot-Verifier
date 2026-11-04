import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createNativeGatewayEvaluation } from './native-gateway-evaluation.mjs';

export const simplifyProviderUrl = 'https://open.bigmodel.cn/api/coding/paas/v4';
const arkAnthropicUrl = 'https://ark.cn-beijing.volces.com/api/coding';

export const loadPackaged = (root, file) => import(pathToFileURL(path.join(root, file)).href);

export function requireSimplifyStopSwitches(compileRuntimeV2Config) {
  const { stopCorrection } = compileRuntimeV2Config({ version: 2, stopCorrection: {
    enabled: true, originalRequirementsBasis: true, deviationOnly: true,
  } });
  if (stopCorrection.originalRequirementsBasis !== true || stopCorrection.deviationOnly !== true)
    throw new Error('Prebuilt package does not expose both approved Stop switches.');
}

export function redactEvaluationText(value) {
  let text = String(value ?? '');
  for (const key of ['RC_EVAL_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    if (process.env[key]) text = text.replaceAll(process.env[key], '[REDACTED_CREDENTIAL]');
  }
  return text;
}

export function summarizeProviderUsage(observedCalls, observations) {
  const complete = observations.filter(value => ['input', 'output', 'totalTokens'].every(key =>
    Number.isSafeInteger(value?.[key]) && value[key] >= 0) && value.totalTokens > 0);
  const count = Number.isSafeInteger(observedCalls) && observedCalls >= 0 ? observedCalls : 0;
  const consistent = complete.length <= count;
  return { observedCalls: count, completeCalls: consistent ? complete.length : 0,
    tokens: consistent && complete.length ? complete.reduce((total, value) => total + value.totalTokens, 0) : null,
    ...(consistent ? {} : { unexpectedUsageRecords: complete.length }) };
}

export async function readProviderTiming(root, name = 'provider-fetch-timing.jsonl') {
  const text = await fs.readFile(path.join(root, name), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

export function simplifyProviderIdentity(provider, model, env = process.env) {
  let endpoint;
  if (provider === 'coding-plan') {
    if (!env.RC_EVAL_API_KEY?.trim()) throw new Error('Set RC_EVAL_API_KEY in the evaluation process environment.');
    endpoint = simplifyProviderUrl;
  } else if (provider === 'anthropic-environment') {
    if (!env.ANTHROPIC_AUTH_TOKEN?.trim() || ![arkAnthropicUrl, `${arkAnthropicUrl}/`].includes(env.ANTHROPIC_BASE_URL)
      || env.ANTHROPIC_MODEL !== model || env.RC_EVAL_NATIVE_MODEL && env.RC_EVAL_NATIVE_MODEL !== model)
      throw new Error('Use the existing Ark Anthropic-compatible endpoint, its process credential and matching configured model.');
    endpoint = env.ANTHROPIC_BASE_URL;
  } else throw new Error('Choose coding-plan or anthropic-environment.');
  return { kind: provider, origin: new URL(endpoint).origin, endpointSha256: createHash('sha256').update(endpoint).digest('hex'), model };
}

export async function createSimplifyGateway({ model, providerKind = 'coding-plan', ...options }) {
  const providerIdentity = simplifyProviderIdentity(providerKind, model);
  const gateway = await createNativeGatewayEvaluation({ ...options, skipBootstrap: true, confineBusinessFiles: true,
    ...(providerKind === 'coding-plan' ? { provider: { api: 'openai-completions', baseUrl: simplifyProviderUrl, model },
      providerGuard: { kind: 'authorized_simplify_experiment', credential: () => process.env.RC_EVAL_API_KEY } } : {}) });
  return { ...gateway, providerIdentity };
}

export async function createSimplifyStopNative(options) {
  const { projectRoot, prebuiltPluginRoot } = options;
  const gateway = await createSimplifyGateway(options);
  try {
    const { createOpenClawReviewerFactory } = await loadPackaged(prebuiltPluginRoot, 'lib/openclaw/reviewer.mjs');
    const api = { id: 'runtime-corrector', runtime: gateway.runtime, config: gateway.config, logger: { warn() {} } };
    const run = createOpenClawReviewerFactory(api, { pluginRoot: gateway.pluginRoot,
      runEmbeddedAgent: params => gateway.runtime.agent.runEmbeddedAgent(params) });
    return { model: gateway.model, modelRef: gateway.modelRef, providerIdentity: gateway.providerIdentity, run, close: gateway.close,
      metrics: () => gateway.metrics(), root: gateway.root, projectRoot };
  } catch (error) {
    await gateway.close();
    throw error;
  }
}
