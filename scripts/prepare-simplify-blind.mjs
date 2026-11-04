import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, grades: { type: 'string' }, index: { type: 'string' } } });
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const save = (file, data) => fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
if (!values.input || !values.output) throw new Error('Supply scored-run observations and a new output.');
const observations = await read(values.input);
if (!Array.isArray(observations.records) || new Set(observations.records.map(row => row.id)).size !== observations.records.length)
  throw new Error('Blind scoring requires one retained record per run ID.');

if (!values.grades) {
  await fs.mkdir(values.output);
  const blind = observations.records.map(record => ({
    runId: record.id, blindId: randomUUID(), sample: record.sample, state: record.state,
    ...(record.compaction ? { answer: record.compaction.answer ?? null } : {
      repairFeedback: record.repairFeedback ?? null, feedback: record.feedback ?? null,
    }),
  })).sort((left, right) => left.blindId.localeCompare(right.blindId));
  await save(path.join(values.output, 'blind.json'), blind.map(({ runId, ...row }) => row));
  await save(path.join(values.output, 'index.json'), blind.map(({ blindId, runId }) => ({ blindId, runId })));
} else {
  if (!values.index) throw new Error('Supply the separate blind index to join completed grades.');
  const index = await read(values.index), grades = await read(values.grades);
  const blindByRun = new Map(index.map(row => [row.runId, row.blindId]));
  const gradeByBlind = new Map(grades.map(row => [row.blindId, row]));
  if (index.length !== observations.records.length || blindByRun.size !== index.length || gradeByBlind.size !== grades.length
    || grades.length !== index.length) throw new Error('Every retained run must have exactly one blind grade.');
  const records = observations.records.map(record => {
    const grade = gradeByBlind.get(blindByRun.get(record.id));
    if (!grade) throw new Error('Missing blind grade.');
    if (record.compaction) {
      if (record.compaction.answer && grade.assessment?.answer !== record.compaction.answer)
        throw new Error('C assessment must quote the exact blinded answer.');
      return { ...record, compaction: { ...record.compaction, assessment: grade.assessment ?? null }, blindId: grade.blindId };
    }
    const { matchesDefect, ungroundedFeedback, rationale, evidenceRequest } = grade;
    if (typeof rationale !== 'string' || !rationale.trim() || ![matchesDefect, ungroundedFeedback].every(value => typeof value === 'boolean' || value === null)
      || record.repairFeedback === false && (matchesDefect !== false || ungroundedFeedback !== false)
      || record.repairFeedback === true && (matchesDefect === null || ungroundedFeedback === null || !record.feedback))
      throw new Error('Blind Stop grade must explain both hit and false-alarm labels.');
    return { ...record, matchesDefect, ungroundedFeedback, gradingRationale: rationale, evidenceRequest, blindId: grade.blindId };
  });
  await save(values.output, { ...observations, records });
}
