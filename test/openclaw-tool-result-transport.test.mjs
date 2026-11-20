import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMessages} from '../lib/openclaw/transcript.mjs';

// Result fixtures were read back from pinned stock OpenClaw2026.7.1-2 pure
// foreground/running/poll/kill return expressions. No SDK process is imported.
// These tests assert transport only, never acceptance or required terminal state.
const results = {
  "completed": {
    "content": [
      {
        "type": "text",
        "text": "Recorded output."
      }
    ],
    "details": {
      "status": "completed",
      "exitCode": 0,
      "exitSignal": null,
      "durationMs": 1,
      "aggregated": "Recorded output.",
      "cwd": "/generic/project"
    }
  },
  "failed": {
    "content": [
      {
        "type": "text",
        "text": "Recorded failure."
      }
    ],
    "details": {
      "status": "failed",
      "exitCode": 7,
      "exitSignal": null,
      "durationMs": 1,
      "aggregated": "Recorded output.",
      "cwd": "/generic/project"
    }
  },
  "signal": {
    "content": [
      {
        "type": "text",
        "text": "Recorded failure."
      }
    ],
    "details": {
      "status": "failed",
      "exitCode": null,
      "exitSignal": "SIGTERM",
      "durationMs": 1,
      "aggregated": "Recorded output.",
      "cwd": "/generic/project"
    }
  },
  "running": {
    "content": [
      {
        "type": "text",
        "text": "Command still running (session native-process-a, pid 123). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up."
      }
    ],
    "details": {
      "status": "running",
      "sessionId": "native-process-a",
      "pid": 123,
      "startedAt": 1000,
      "cwd": "/generic/project",
      "tail": "Recorded output."
    }
  },
  "poll": {
    "content": [
      {
        "type": "text",
        "text": "Recorded output.\n\nProcess exited with code 0."
      }
    ],
    "details": {
      "status": "completed",
      "sessionId": "native-process-a",
      "exitCode": 0,
      "aggregated": "Recorded output.",
      "name": "generic"
    }
  },
  "kill": {
    "content": [
      {
        "type": "text",
        "text": "Termination requested for session native-process-a."
      }
    ],
    "details": {
      "status": "failed",
      "name": "generic"
    }
  }
};
const expected = {
 completed: {status:'completed',exitCode:0,exitSignal:null},
 failed: {status:'failed',exitCode:7,exitSignal:null},
 signal: {status:'failed',exitCode:null,exitSignal:'SIGTERM'},
 running: {status:'running',sessionId:'native-process-a'},
 poll: {status:'completed',sessionId:'native-process-a',exitCode:0},
 kill: {status:'failed'},
};
const message=(name,result,extra={})=>({id:'result',message:{role:'toolResult',toolCallId:'call',toolName:name,...structuredClone(result),...extra}});
const block=records=>normalizeMessages(records).find(x=>x.uuid==='result').message.content[0];
for(const name of Object.keys(results))test(`native ${name} state is retained without changing original result bytes`,()=>{
 const raw=message(['poll','kill'].includes(name)?'process':'exec',results[name],name==='kill'?{isError:true}:{});
 const before=JSON.stringify(raw),value=block([raw]);
 assert.deepEqual(value.hostToolResult,{version:1,host:'openclaw',toolName:raw.message.toolName,details:expected[name]});
 assert.equal(value.tool_use_id,'call');assert.deepEqual(value.content,raw.message.content);
 assert.equal(value.is_error,raw.message.isError===true);assert.equal(JSON.stringify(raw),before);
 assert.notStrictEqual(value.hostToolResult.details,raw.message.details);
});

test('a legitimate background-start observation remains running without an invented exit',()=>{
 const raw=message('exec',results.running),value=block([raw]);
 assert.equal(value.hostToolResult.details.status,'running');
 assert.equal(value.hostToolResult.details.sessionId,'native-process-a');
 assert.equal(Object.hasOwn(value.hostToolResult.details,'exitCode'),false);
 assert.equal(Object.hasOwn(value.hostToolResult.details,'exitSignal'),false);
});

test('tool error flag is preserved separately from a nonterminal running observation',()=>{
 const raw=message('exec',results.running,{isError:true}),value=block([raw]);
 assert.equal(value.is_error,true);assert.deepEqual(value.hostToolResult.details,expected.running);
});

test('stdout that says completed cannot replace structured running state',()=>{
 const raw=message('exec',results.running);raw.message.content=[{type:'text',text:'completed exit code 0'}];
 assert.deepEqual(block([raw]).hostToolResult.details,expected.running);
});

test('only own selected result fields are retained and projected details are independent',()=>{
 const details=Object.assign(Object.create({exitCode:0,exitSignal:null}),{status:'running',sessionId:'native-process-a',aggregated:'not metadata',name:'not metadata'});
 const raw=message('exec',results.running);raw.message.details=details;
 const value=block([raw]);assert.deepEqual(value.hostToolResult.details,expected.running);
 value.hostToolResult.details.status='changed private projection';assert.equal(details.status,'running');
});

test('missing raw tool name and details remain unavailable instead of guessed from call text',()=>{
 const raw=message('exec',results.running);delete raw.message.toolName;delete raw.message.details;
 const records=[{id:'call',message:{role:'assistant',content:[{type:'toolCall',id:'call',name:'exec',arguments:{command:'verifier'}}]}},raw];
 assert.deepEqual(block(records).hostToolResult,{version:1,host:'openclaw',toolName:null,details:{}});
});

test('poll session metadata and invocation arguments remain separate without identity rewriting',()=>{
 const call={id:'poll-call',message:{role:'assistant',content:[{type:'toolCall',id:'call',name:'process',arguments:{action:'poll',sessionId:'different-process',timeout:0}}]}};
 const raw=message('process',results.poll),records=[call,raw],before=JSON.stringify(records),normalized=normalizeMessages(records);
 assert.equal(normalized[0].message.content[0].input.sessionId,'different-process');
 assert.equal(normalized[1].message.content[0].hostToolResult.details.sessionId,'native-process-a');
 assert.equal(JSON.stringify(records),before);
});

test('duplicate native invocation identities stay visible to a later ownership check',()=>{
 const call=n=>({id:'a'+n,message:{role:'assistant',content:[{type:'toolCall',id:'same-id',name:'exec',arguments:{command:'verifier '+n}}]}});
 const raw=message('exec',results.completed);raw.message.toolCallId='same-id';
 const normalized=normalizeMessages([call(1),call(2),raw]);
 assert.equal(normalized.filter(x=>x.type==='assistant').length,2);
 assert.equal(normalized[0].message.content[0].id,'same-id');assert.equal(normalized[1].message.content[0].id,'same-id');
 assert.equal(normalized[2].message.content[0].tool_use_id,'same-id');
 assert.deepEqual(normalized[2].message.content[0].hostToolResult.details,expected.completed);
});

test('legacy one-shot Bash and source-read envelopes keep their original core blocks',()=>{
 const call={type:'tool_use',id:'legacy-call',name:'Bash',input:{command:'verifier'}};
 const result={type:'tool_result',tool_use_id:'legacy-call',content:'Original one-shot response.',is_error:false};
 const normalized=normalizeMessages([{type:'assistant',uuid:'a',message:{content:[call]}},{type:'user',uuid:'r',message:{content:[result]}}]);
 assert.deepEqual(normalized[0].message.content,[call]);assert.deepEqual(normalized[1].message.content,[result]);
 assert.equal(Object.hasOwn(normalized[1].message.content[0],'hostToolResult'),false);
 const read=message('read',{content:[{type:'text',text:'Current source bytes.'}]});
 const before=JSON.stringify(read),value=block([read]);
 assert.deepEqual(value.content,read.message.content);assert.equal(JSON.stringify(read),before);
});
