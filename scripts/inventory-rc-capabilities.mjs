// Static source evidence plus declared production dispatch. Lexical detections
// are labelled candidates; shipping and execution reachability are separate.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createSourceTools } from '../lib/review-task/source-tools.mjs';
import { createLiveSourceTools } from '../lib/review-task/live-source-tools.mjs';
import { SKILL_CARE_PARAMETERS } from '../lib/runtime-v2/skill-care.mjs';
const baseline = 'c33bae6', tracked = execFileSync('git', ['ls-files', 'lib', 'skills', 'knowledge', 'packaging', 'config'], { encoding: 'utf8' }).trim().split('\n');
const modules = JSON.parse(await fs.readFile('packaging/runtime-modules.json', 'utf8'));
const hosts = ['claude', 'codeagent', 'openclaw'];
const sha = value => createHash('sha256').update(value).digest('hex');
const records = [];
for (const file of tracked) {
  if (!/\.(?:mjs|md|json)$/u.test(file)) continue;
  const bytes = await fs.readFile(file), text = bytes.toString('utf8');
  const exports = [...text.matchAll(/^export (?:async )?(?:function|class|const) (\w+)/gmu)].map(m => m[1]);
  const toolCandidates = [...text.matchAll(/(?:\bname\s*:\s*|\btool\s*\(\s*)['"]([a-z][a-z0-9_]+)['"]/gu)].map(m => m[1]);
  const promptCandidates = [...text.matchAll(/(?:systemPrompt|extraSystemPrompt|promptAppend|instructions)\s*[:=]/gu)].length;
  if (!file.endsWith('/SKILL.md') && !toolCandidates.length && !promptCandidates && !/agent|session|source-tools|reviewer|evidence/iu.test(file)) continue;
  records.push({ file, bytes: bytes.length, sha256: sha(bytes), exports, toolNameCandidates: [...new Set(toolCandidates)], promptConstructionSites: promptCandidates,
    packagedHosts: hosts.filter(host => [...modules.common, ...modules[host]].includes(file)),
    type: file.endsWith('/SKILL.md') ? 'skill' : 'source',
    ...(file.endsWith('/SKILL.md') ? { hostDiscoverable: file.startsWith('skills/') || file.startsWith('packaging/hosts/'), name: /^name:\s*(.+)$/mu.exec(text)?.[1] } : {}) });
}
const sourceSchemas = Object.fromEntries(createSourceTools('.', new Map()).map(tool => [tool.name, tool.parameters]));
const liveSchemas = Object.fromEntries(createLiveSourceTools('.').map(tool => [tool.name, tool.parameters]));
const report = { baseline, generatedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  records, sourceSchemas, liveSchemas, skillCareSchema: SKILL_CARE_PARAMETERS,
  registeredContract: JSON.parse(await fs.readFile('config/openclaw-tool-contracts.json', 'utf8')),
  roles: [
    { role: 'ground-truth-extractor', dispatch: 'bounded baseline → runtime-v2/baseline-task → review-task/baseline-task → native task session; other extraction → reviewer transport', memory: 'project identity, baseline_notes, review_history', scope: 'complete original requirement basis' },
    { role: 'artifact-reviewer', dispatch: 'openclaw/reviewer + semantic-review + document-corrector when semantic request exists', memory: 'document project session, rc_document notes', scope: 'current declared artifact/edge/criteria' },
    { role: 'skill-reviewer', dispatch: 'openclaw/reviewer + private skill-care + rc_skill_care', memory: 'task/Skill notes and source revision', scope: 'activated original Skill obligations and execution' },
    { role: 'stop-reviewer', dispatch: 'runtime-v2/stop-workspace-review → protocol-task → task session', memory: 'one isolated review per Stop, review_history/plan/notes', scope: 'scope selection plus original checklist, current workspace and process proof' },
    { role: 'implementation-reviewer', dispatch: 'scoped stop task or generic reviewer by input', memory: 'task evidence/receipts', scope: 'assigned implementation proof owner' },
    { role: 'onboarding-extractor/onboarding-adjudicator', dispatch: 'generic reviewer transport', memory: 'frozen onboarding request', scope: 'initial configured baseline' },
  ],
  constraints: ['One tool name does not imply one permission or proof contract.', 'Packaged source is not sufficient evidence of production reachability.',
    'Lexical tool/prompt sites include records and compatibility code; inspect dispatch before optimizing.',
    'Private document-corrector is currently also discoverable as a host skill; measure/consider a private resource with compatibility explicitly assessed.',
    'prompts.json/prompt-profile are retained development paths, not in current production module allowlist; do not claim trimming them improves production Stop.'] };
await fs.writeFile('docs/rc-capability-inventory.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ records: records.length, skills: records.filter(row => row.type === 'skill').map(({ file, bytes, hostDiscoverable }) => ({ file, bytes, hostDiscoverable })),
  roleFamilies: report.roles.length, contractTools: Object.fromEntries(Object.entries(report.registeredContract).map(([key, names]) => [key, names.length])) }));
