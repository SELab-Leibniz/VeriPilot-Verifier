#!/usr/bin/env node

import path from "node:path";



// Most of the host's one-second teardown budget can be spent starting the
// shell/Node under concurrent load. Wait only briefly for a missing stdin EOF.
const STDIN_DEADLINE_MS = 100;
const MAX_STDIN_BYTES = 256 * 1024;


async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_STDIN_BYTES) {
      process.stdin.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}


const watchdog = setTimeout(() => process.exit(0), STDIN_DEADLINE_MS);
let rawInput = null;
try {
  rawInput = await readStdin();
} catch {
  // Session teardown is always silent and fail-open.
} finally {
  // The watchdog protects only an unterminated stdin stream. Once a bounded
  // payload has reached EOF, let the journal append finish normally.
  clearTimeout(watchdog);
}
try {
  if (rawInput !== null) {
    // EOF closes the input clock before decoder imports or journal I/O. A
    // complete bounded event must not be killed by the missing-input timer.
    const { decodeHookInput } = await import('../lib/protocol/core-hooks.mjs');
    const input = decodeHookInput(rawInput);
    if (input.hook_event_name !== "SessionEnd") {
      throw new RangeError(`Expected SessionEnd, received ${input.hook_event_name}`);
    }
    const { handleRuntimeV2SessionEnd } = await import('../lib/runtime-v2/session-end.mjs');
    await handleRuntimeV2SessionEnd({
      input,
      projectRoot: path.resolve(input.cwd ?? process.cwd()),
      env: process.env,
    });
  }
} catch {
  // Session teardown is always silent and fail-open.
}
