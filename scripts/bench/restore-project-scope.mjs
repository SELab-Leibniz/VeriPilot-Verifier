import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readSessionSetting, setSessionSetting } from '../../lib/openclaw/session-settings.mjs';

/** Preserve the exact native task binding and existing enable/disable choice.
 * Live post-run queues and unfinished worker ownership are not relocated. */
export async function restoreNativeProjectScope({ sourceRun, targetStateDirectory, identity, projectRoot }) {
  const manifest = JSON.parse(await fs.readFile(path.join(sourceRun, 'manifest.json'), 'utf8'));
  const result = JSON.parse(await fs.readFile(path.join(sourceRun, 'result.json'), 'utf8'));
  if (result.actualBusinessStart !== true || result.sessionId !== identity.sessionId || result.sessionKey !== identity.sessionKey
    || path.relative(path.resolve(projectRoot), path.resolve(manifest.projectRoot)) !== '') throw new Error('Native project scope authority mismatch');
  const sourceState = path.join(sourceRun, 'native-host/state');
  const sourceSetting = await readSessionSetting({ projectRoot, namespace: sourceState, identity });
  if (sourceSetting.registered) {
    const targetSetting = await readSessionSetting({ projectRoot, namespace: targetStateDirectory, identity });
    if (targetSetting.registered && targetSetting.enabled !== sourceSetting.enabled) throw new Error('Refuse to replace a different session enable/disable choice');
    if (!targetSetting.registered) await setSessionSetting({ projectRoot, namespace: targetStateDirectory, identity, enabled: sourceSetting.enabled });
  }
  const canonicalIdentity = { agentId: identity.agentId, sessionId: identity.sessionId, sessionKey: identity.sessionKey };
  const hash = createHash('sha256').update(JSON.stringify(canonicalIdentity)).digest('hex');
  const relative = path.join('plugins/runtime-corrector/session-projects', hash, 'scope.json');
  const source = path.join(sourceState, relative), target = path.join(targetStateDirectory, relative);
  const bytes = await fs.readFile(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!bytes) return { status: 'NO_NATIVE_SCOPE_FOUND', sessionEnabled: sourceSetting.enabled };
  const scope = JSON.parse(bytes);
  if (scope.inactive) return { status: 'SOURCE_INACTIVE_NO_REACTIVATION', sessionEnabled: sourceSetting.enabled };
  if (scope.source !== 'host' || scope.taskId !== result.taskId || !scope.taskId
    || path.relative(path.resolve(projectRoot), path.resolve(scope.projectRoot)) !== '') throw new Error('Native task binding changed');
  const existing = await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && !existing.equals(bytes)) throw new Error('Refuse to overwrite a different native task scope');
  if (!existing) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' }); }
  return { status: existing ? 'ALREADY_IDENTICAL' : 'RESTORED_AUTHENTIC_SCOPE', source, target, taskId: scope.taskId,
    sessionEnabled: sourceSetting.enabled, sourceSettingRegistered: sourceSetting.registered,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
