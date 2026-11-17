import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { optionalJson } from './files.mjs';

const execute = promisify(execFile);
export async function inspectEnvironment(input, { network = false, request = fetch } = {}) {
  const checks = [], add = (status, name, detail) => checks.push({ status, name, detail });
  add('PASS', 'Node', input.fingerprint.nodeVersion);
  add('PASS', 'Git', input.fingerprint.gitVersion);
  add('PASS', 'OpenClaw', input.fingerprint.hostVersion);
  add('INFO', 'RC archive SHA256', input.fingerprint.pluginSha256 + '; package contents are validated by --prepare-only');
  add('PASS', 'Agent/models', `${input.models.agentId}: ${input.models.business}; reviewer: ${input.models.reviewer}`);
  if (input.paths.python) {
    try {
      const { stdout, stderr } = await execute(input.paths.python, ['--version'], { windowsHide: true, timeout: 10000 });
      const version = (stdout || stderr).trim();
      if (!/^Python 3\.(\d+)/.test(version) || Number(/^Python 3\.(\d+)/.exec(version)[1]) < 9) throw new Error('Expected Python 3.9+');
      add('PASS', 'Python', version);
    } catch { add('FAIL', 'Python', 'A working Python 3.9+ is required; use its real executable, not the Windows Store alias'); }
  } else add('WARN', 'Python', 'Not configured; the Python examples require a usable Python 3 on PATH');
  for (const [name, dir] of Object.entries(input.harmony)) add('PASS', `Harmony ${name}`, dir);
  add('INFO', 'Harmony build', 'Directory checks only; SDK/API compatibility and builds are not tested by doctor');
  const modelFile = await optionalJson(path.join(input.paths.hostState, 'agents', input.models.agentId, 'agent/models.json'));
  const profiles = await optionalJson(path.join(input.paths.hostState, 'agents', input.models.agentId, 'agent/auth-profiles.json'));
  const auth = await optionalJson(path.join(input.paths.hostState, 'agents', input.models.agentId, 'agent/auth.json'));
  const names = [...new Set([input.models.business, input.models.reviewer].map(model => model.slice(0, model.indexOf('/'))))];
  for (const name of names) {
    const provider = input.source.models.providers[name];
    const key = provider.apiKey ?? modelFile?.providers?.[name]?.apiKey;
    let keyPresent = Boolean(key);
    if (typeof key === 'string') {
      const refs = [...key.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)];
      if (refs.length) keyPresent = refs.every(([, k]) => Boolean(input.environment[k] ?? process.env[k]));
    } else if (key?.source === 'env') keyPresent = Boolean(input.environment[key.id] ?? process.env[key.id]);
    add(keyPresent || profiles || auth ? 'INFO' : 'WARN', `Credential ${name}`,
      keyPresent ? 'A configured credential/reference was found; value omitted, authentication not verified'
        : profiles || auth ? 'Agent auth profile exists; provider authentication not verified'
          : 'No key found at the supported locations; confirm the selected Agent can chat in the host');
    if (network) {
      if (!provider.baseUrl) { add('WARN', `Network ${name}`, 'No explicit baseUrl; this provider uses host defaults, check it in the host'); continue; }
      try {
        const base = String(provider.baseUrl).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => input.environment[k] ?? process.env[k] ?? '');
        const url = new URL(base);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported URL');
        url.search = ''; url.hash = '';
        const response = await request(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10000) });
        await response.body?.cancel();
        add('PASS', `Network ${name}`, `${url.origin}: HTTP ${response.status}; reachability only, no credential/model request sent`);
      } catch (error) {
        add('FAIL', `Network ${name}`, `Connection failed (${error.cause?.code ?? error.code ?? error.name}); check DNS, VPN/proxy, TLS and endpoint settings`);
      }
    }
  }
  if (!network) add('INFO', 'Network', 'Skipped; add --network for an unauthenticated HTTP reachability check');
  return { ok: !checks.some(c => c.status === 'FAIL'), checks, note: 'No Gateway/session/model allocation. Credential validity, model availability and Harmony builds require separate host/native tests.' };
}
