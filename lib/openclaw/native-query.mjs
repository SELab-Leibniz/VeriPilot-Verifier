import { isInternalExecution, isManagedExecution } from './internal-context.mjs';
import { splitUserActions } from './interaction-router.mjs';
import { recordSourceActions } from './transcript.mjs';
import { readReport } from './report.mjs';

const guidance = '请使用 /plugins/runtime-corrector/ 状态页或 openclaw runtime-corrector 命令查看状态及操作回执。本入口没有可靠的历史写入回执。';
function canRead(scopes) { return scopes?.includes('operator.read') || scopes?.includes('operator.admin'); }
export function registerNativeQueries(api, service) {
  if (typeof api.registerCommand !== 'function') throw new Error('OpenClaw plugin command capability unavailable.');
  api.registerCommand({ name: 'runtime-corrector', description: '查看纠偏状态或反馈（只读）', acceptsArgs: true,
    requireAuth: true, requiredScopes: ['operator.read'], async handler(ctx) {
      if (isInternalExecution() || isManagedExecution() || !ctx.isAuthorizedSender || !canRead(ctx.gatewayClientScopes)) return { text: '需要已认证的 Gateway 读取权限。' };
      if (!['status', 'feedback', 'help', ''].includes(ctx.args?.trim() ?? '')) return { text: guidance };
      if (!ctx.sessionKey || ctx.args?.trim() === 'help') return { text: guidance };
      try { return { text: `${(await readReport(await service.bindingFor(ctx.sessionKey))).text}\n${guidance}` }; }
      catch (error) { return { text: `状态记录暂不可用：${error.message}\n${guidance}` }; }
    } });
  api.on('reply_dispatch', async (event, ctx) => {
    if (isInternalExecution() || isManagedExecution() || event.isTailDispatch) return;
    const source = event.ctx;
    if (!source || source.InputProvenance?.kind && source.InputProvenance.kind !== 'external_user') return;
    if (!canRead(source.GatewayClientScopes)) return;
    const text = source.RawBody ?? source.BodyForCommands;
    if (typeof text !== 'string') return;
    const actions = splitUserActions(source.MessageSid ?? 'unresolved', text);
    if (!actions.some(action => action.purpose === 'control_query')) return;
    let binding;
    try {
      if (!source.MessageSid || !source.SessionKey) throw new Error('Native identity unavailable.');
      binding = await service.bindingFor(source.SessionKey);
      await recordSourceActions(binding, source.MessageSid, actions);
    } catch { /* No trusted binding means no task or baseline may be guessed. */ }
    if (actions.some(action => action.purpose === 'requirement')) return;
    if (event.sendPolicy === 'deny' || event.suppressUserDelivery || ctx.abortSignal?.aborted) return { handled: true, queuedFinal: false, counts: ctx.dispatcher.getQueuedCounts() };
    let report;
    try { report = binding ? (await readReport(binding)).text : '尚无可读取的可信任务绑定。'; }
    catch (error) { report = `状态记录暂不可用：${error.message}`; }
    if (ctx.abortSignal?.aborted) return { handled: true, queuedFinal: false, counts: ctx.dispatcher.getQueuedCounts() };
    const queuedFinal = ctx.dispatcher.sendFinalReply({ text: `${report}\n${guidance}` });
    // Queue counts are never promoted to delivery/history ACKs.
    ctx.recordProcessed(queuedFinal ? 'completed' : 'skipped'); ctx.markIdle('runtime-corrector-query');
    return { handled: true, queuedFinal, counts: ctx.dispatcher.getQueuedCounts() };
  }, { timeoutMs: 1000 });
}
