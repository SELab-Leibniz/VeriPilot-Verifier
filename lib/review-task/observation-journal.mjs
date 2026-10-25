// Durable RC observations, independent of the host's JSONL/SQLite transcript.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ObservationJournal {
  constructor(outputDir) {
    this.id = randomUUID(); this.entries = [];
    this.file = path.join(outputDir, 'observations.jsonl');
    fs.writeFileSync(this.file, JSON.stringify({ type: 'review_session', id: this.id }) + '\n', { flag: 'wx' });
  }
  appendMessage(message) { return this.append({ type: 'review_observation', message }); }
  appendCustomMessageEntry(label, content, _display, details = {}) {
    return this.appendMessage({ role: 'historical_observation', content, details: { ...details, label } });
  }
  append(entry) {
    const value = { ...entry, id: randomUUID() };
    const handle = fs.openSync(this.file, 'a');
    try { fs.writeSync(handle, JSON.stringify(value) + '\n'); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    this.entries.push(value); return value.id;
  }
  getEntries() { return this.entries; }
  getSessionId() { return this.id; }
  getSessionFile() { return this.file; }
  getLeafId() { return this.entries.at(-1)?.id ?? null; }
}
