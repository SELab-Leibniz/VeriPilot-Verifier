import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTree, json, writeJson, manifest, redact } from '../../lib/files.mjs';

export const correctionFixture = {
  async beforeStart(record) {
    const pluginRoot = path.join(record.runDir, 'runtime/correction-fixture');
    await copyTree(fileURLToPath(new URL('./correction-fixture', import.meta.url)), pluginRoot);
    const cfg = await json(record.configPath);
    cfg.plugins.allow.push('rc-correction-fixture'); cfg.plugins.load.paths.push(pluginRoot);
    cfg.plugins.entries['rc-correction-fixture'] = { enabled: true, config: { runDir: record.runDir },
      hooks: { allowConversationAccess: true, allowPromptInjection: true } };
    await writeJson(record.configPath, cfg);
    await writeJson(path.join(record.runDir, 'config/host.redacted.json'), redact(cfg));
    record.fixture = { kind: 'single controlled defect', pluginRoot, files: await manifest(pluginRoot) };
  },
  async beforeDispatch(record) {
    const loaded = await json(path.join(record.runDir, 'rc-status/fault-fixture-loaded.json'));
    if (loaded.pid !== record.gatewayPid) throw new Error('Fixture not loaded by the actual Gateway; no model task submitted');
  }
};
