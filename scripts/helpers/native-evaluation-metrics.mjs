// Derive experiment counters from actual host transcripts and committed Stop
// evaluations. This never calls a model and does not infer billing from prices.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function inspectNativeReviewArtifacts(directories) {
  const transcripts = new Set(), visited = new Set(), taskRoots = new Set();
  async function walk(root) {
    const real = await fs.realpath(root); if (visited.has(real)) return; visited.add(real);
    for (const entry of await fs.readdir(real, { withFileTypes: true })) {
      const file = path.join(real, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name === 'host-session.jsonl') transcripts.add(file);
    }
  }
  for (const root of directories) {
    await walk(root);
    let candidate = root;
    for (let depth = 0; depth < 5; depth++, candidate = path.dirname(candidate)) {
      if (await fs.stat(path.join(candidate, 'task.json')).then(() => true, () => false)) { taskRoots.add(candidate); break; }
    }
  }
  const tools = new Map(), toolErrors = new Set(), models = new Set(), messages = new Map(), observations = [];
  for (const file of transcripts) for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
    let frame; try { frame = JSON.parse(line); } catch { continue; }
    const message = frame.message;
    if (message?.role === 'toolResult' && message.isError === true) toolErrors.add(`${file}:${message.toolCallId ?? frame.id}`);
    if (message?.role !== 'assistant') continue;
    if (message.model) models.add(`${message.provider}/${message.model}`);
    if (message.usage && !messages.has(`${file}:${frame.id}`)) {
      messages.set(`${file}:${frame.id}`, message.usage);
      observations.push({ transcript: file, messageId: frame.id, usage: message.usage });
    }
    for (const block of message.content ?? []) if (block.type === 'toolCall') tools.set(`${file}:${block.id}`, block.name);
  }
  const assessments = [];
  for (const root of taskRoots) {
    const evaluationRoot = path.join(root, 'evaluations');
    for (const name of await fs.readdir(evaluationRoot).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(evaluationRoot, name), evaluation = JSON.parse(await fs.readFile(file, 'utf8'));
      const stop = evaluation.core?.stop;
      assessments.push({ file, evaluationId: evaluation.evaluationId, status: evaluation.outcome?.status,
        reasonCode: evaluation.outcome?.reasonCode ?? null,
        elapsedMs: stop?.assessmentFinishedAt && stop?.startedAt ? stop.assessmentFinishedAt - stop.startedAt : null,
        objectCount: evaluation.review?.metricObjectJudgements?.length ?? 0,
        rows: evaluation.review?.metricObjectJudgements?.map(row => ({ objectId: row.objectId, judgement: row.judgement })) ?? [] });
    }
  }
  return { transcripts: [...transcripts], actualModels: [...models], transcriptCount: transcripts.size,
    assistantMessages: messages.size, toolCalls: tools.size, toolErrors: toolErrors.size, sourceReads: [...tools.values()].filter(name => name === 'source_read').length,
    toolNames: [...tools.values()],
    usageTotals: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
      .map(key => [key, [...messages.values()].reduce((sum, usage) => sum + (usage[key] ?? 0), 0)])),
    usageSource: 'Actual native transcript counters supplied by the host; not independently verified billing. Custom provider prices are unset.',
    observations, assessments };
}
