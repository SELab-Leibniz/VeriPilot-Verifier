// Durable RC observations, independent of the host's JSONL/SQLite transcript.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class ObservationJournal {
  constructor(outputDir) {
    this.id = randomUUID(); this.entries = []; this.failure = null;
    this.bytes = 0; this.hash = createHash('sha256');
    this.file = path.join(outputDir, 'observations.jsonl');
    this.write({ type: 'review_session', id: this.id }, 'wx');
  }
  assertHealthy() {
    if (this.failure) throw Object.assign(new Error('Observation journal is uncertain; resumption is not supported', { cause: this.failure }), { code: 'JOURNAL_UNCERTAIN' });
  }
  write(value, flag = 'a') {
    this.assertHealthy();
    const bytes = Buffer.from(JSON.stringify(value) + '\n', 'utf8');
    let handle;
    try {
      handle = fs.openSync(this.file, flag);
      if (fs.fstatSync(handle).size !== this.bytes) throw new Error('Observation journal length changed');
      if (fs.writeSync(handle, bytes, 0, bytes.length) !== bytes.length) throw new Error('Observation journal short write');
      fs.fsyncSync(handle);
    } catch (error) { this.failure = error; throw Object.assign(new Error('Observation journal write failed', { cause: error }), { code: 'JOURNAL_UNCERTAIN' }); }
    finally {
      if (handle !== undefined) try { fs.closeSync(handle); }
      catch (error) { this.failure = error; this.assertHealthy(); }
    }
    this.bytes += bytes.length; this.hash.update(bytes);
  }
  verify() {
    this.assertHealthy();
    try {
      const bytes = fs.readFileSync(this.file), digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== this.bytes || digest !== this.hash.copy().digest('hex')) throw new Error('Observation journal bytes changed');
      return { path: this.file, sha256: digest, bytes: bytes.length, sessionId: this.id };
    } catch (error) { this.failure = error; this.assertHealthy(); }
  }
  appendMessage(message) { return this.append({ type: 'review_observation', message }); }
  appendCustomMessageEntry(label, content, _display, details = {}) {
    return this.appendMessage({ role: 'historical_observation', content, details: { ...details, label } });
  }
  append(entry) {
    const value = { ...entry, id: randomUUID() };
    this.write(value);
    this.entries.push(value); return value.id;
  }
  getEntries() { return this.entries; }
  getSessionId() { return this.id; }
  getSessionFile() { return this.file; }
  getLeafId() { return this.entries.at(-1)?.id ?? null; }
}
