import { promises as fs } from 'node:fs';
import path from 'node:path';
import { privateJson } from './controller-store.mjs';
import { readJson, sha256 } from '../runtime-v2/utils.mjs';
const directory = (root, taskId) => path.join(root, '.runtime-correction', 'openclaw', 'native-runs', sha256(taskId));
const runWrites=new Map();
export async function recordNativeRun(root,record){
  const file=path.join(directory(root,record.taskId),`${record.runId}.json`);
  const writing=(runWrites.get(file)??Promise.resolve()).catch(()=>{}).then(async()=>privateJson(file,{...await readJson(file),...record}));
  runWrites.set(file,writing);try{await writing;}finally{if(runWrites.get(file)===writing)runWrites.delete(file);}
}
export function closeUndispatchedNativeRun(root, { taskId, runId }) {
  return recordNativeRun(root, { taskId, runId, status: 'PRE_DISPATCH_CLOSED', closedAt: Date.now() });
}
export async function listNativeRuns(root, taskId) {
  const dir = directory(root, taskId);
  let files;
  try { files = await fs.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(files.filter(file => file.endsWith('.json')).map(file => readJson(path.join(dir, file))));
  // A cancelled intent is retained on disk but never owned a host invocation.
  return records.filter(record => record && record.status !== 'PRE_DISPATCH_CLOSED');
}
export const unsettledNativeRuns = async (root, taskId) => (await listNativeRuns(root, taskId)).filter(record => record.status !== 'SETTLED');

// A private review's temporary sources and host transcript must survive its
// lease cleanup. Shared reads permit Windows' active host writer; never copyFile.
export async function archiveNativeReview({projectRoot,taskId,sessionId,requestDirectory,traceId=sessionId,sessionFile=null,sessionOffset=0,secrets=[],retries=3,retryDelayMs=20}) {
  const source=path.resolve(requestDirectory),allowed=path.join(path.resolve(projectRoot),'.runtime-correction','.internal-requests');
  const relative=path.relative(allowed,source);
  if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error('Private review archive source is outside its task');
  if (!/^[a-zA-Z0-9_.-]+$/u.test(traceId)) throw new Error('Invalid native trace identity');
  const destination=path.join(projectRoot,'.runtime-correction','openclaw','review-traces',sha256(taskId),traceId);
  const manifestPath=path.join(destination,'trace.json'),files=[],missing=[],directoryFailures=[];
  const previous=await readJson(manifestPath);
  const redact=value=>secrets.filter(value=>typeof value==='string'&&value.length>7).reduce((text,secret)=>text.replaceAll(secret,'[REDACTED]'),value);
  const retry=async(operation,onError)=>{for(let attempt=0;;attempt++)try{return await operation();}catch(error){onError(error,attempt+1);
    if(!['EBUSY','EACCES','EPERM','ENOENT','SOURCE_CHANGED'].includes(error.code)||attempt>=retries)return null;
    await new Promise(resolve=>setTimeout(resolve,retryDelayMs));}};
  async function walk(directory,relative=''){
    let lastFailure;
    const entries=await retry(()=>fs.readdir(directory,{withFileTypes:true}),error=>{lastFailure={path:relative,code:error.code??'ERROR',phase:'list'};directoryFailures.push(lastFailure);});
    if(!entries){missing.push(lastFailure);return;}
    // Recovered directory attempts remain in diagnostics without counting as a gap.
    for(const entry of entries){
      const name=path.join(relative,entry.name),file=path.join(directory,entry.name);
      if(entry.name.endsWith('.lock'))continue;
      if(entry.isSymbolicLink()){missing.push({path:name,code:'LINKED_INPUT'});continue;}
      if(entry.isDirectory()){await walk(file,name);continue;}
      if(!entry.isFile())continue;
      const prior=previous?.files?.find(file=>file.path===name);
      const record={path:name,attempts:prior?.attempts??0,failures:[...prior?.failures??[]]};
      const bytes=await retry(async()=>{record.attempts++;const before=await fs.stat(file),bytes=await fs.readFile(file),after=await fs.stat(file);
        if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==after.size)throw Object.assign(new Error('Review evidence changed during capture'),{code:'SOURCE_CHANGED'});return bytes;},
      (error,attempt)=>record.failures.push({attempt,code:error.code??'ERROR'}));
      if(!bytes){missing.push({path:name,code:record.failures.at(-1)?.code});files.push({...record,status:'MISSING'});continue;}
      const text=bytes.toString('utf8'),archived=Buffer.from(bytes.equals(Buffer.from(text))?redact(text):bytes);
      const target=path.join(destination,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,archived);
      if(sha256(await fs.readFile(target))!==sha256(archived))throw new Error('Review archive checksum mismatch');
      files.push({...record,status:'CAPTURED',bytes:bytes.length,sourceSha256:sha256(bytes),sha256:sha256(archived),redacted:!bytes.equals(archived)});
    }
  }
  await fs.mkdir(destination,{recursive:true});await walk(source);
  if (sessionFile) {
    const base = path.join(path.resolve(projectRoot), '.runtime-correction', 'document-agent');
    const rel = path.relative(base, path.resolve(sessionFile));
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Invalid document transcript path');
    const bytes = await (async () => {
      let handle;
      try {
        handle = await fs.open(sessionFile, 'r'); const stat = await handle.stat();
        // A host compaction can replace the transcript with a shorter file.
        const offset = stat.size >= sessionOffset ? sessionOffset : 0;
        const bytes = Buffer.alloc(stat.size - offset); let position = 0;
        while (position < bytes.length) {
          const read = await handle.read(bytes, position, bytes.length - position, offset + position);
          if (!read.bytesRead) throw new Error('Document transcript changed during archive'); position += read.bytesRead;
        }
        return bytes;
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      finally { await handle?.close(); }
    })();
    if (bytes) { const saved = Buffer.from(redact(bytes.toString('utf8')));
      await fs.writeFile(path.join(destination, 'session.jsonl'), saved);
      files.push({ path: 'session.jsonl', status: 'CAPTURED', bytes: bytes.length, sourceSha256: sha256(bytes), sha256: sha256(saved) }); }
  }
  const stored=files.every(file=>file.status==='CAPTURED')&&!missing.length;
  const transcript=files.find(file=>file.path==='session.jsonl'&&file.status==='CAPTURED');
  if(!transcript)missing.push({path:'session.jsonl',code:'HOST_TRANSCRIPT_MISSING'});
  const record={sessionId,taskId,source,destination,manifestPath,stored,files,missing,directoryFailures:[...previous?.directoryFailures??[],...directoryFailures],status:missing.length?'EVIDENCE_INCOMPLETE':'COMPLETE',capturedAt:new Date().toISOString()};
  record.history=[...previous?.history??[],{at:record.capturedAt,status:record.status,missing}];
  await privateJson(manifestPath,record);
  for(const run of (await listNativeRuns(projectRoot,taskId)).filter(run=>run.sessionId===sessionId && (!sessionFile || !run.trace)))await recordNativeRun(projectRoot,{...run,trace:{status:record.status,manifestPath}});
  return record;
}
