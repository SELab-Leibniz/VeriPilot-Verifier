#!/usr/bin/env node

import path from "node:path";

import { decodeHookInput } from "../lib/protocol/claude-core-hooks.mjs";
import { handleRuntimeV2SessionEnd } from "../lib/runtime-v2/session-end.mjs";


const HARD_DEADLINE_MS = 800;
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
  return decodeHookInput(Buffer.concat(chunks, bytes).toString("utf8"));
}


const watchdog = setTimeout(() => process.exit(0), HARD_DEADLINE_MS);
let input = null;
try {
  input = await readStdin();
} catch {
  // Session teardown is always silent and fail-open.
} finally {
  // The watchdog protects only an unterminated stdin stream. Once a bounded
  // payload has reached EOF, let the journal append finish normally.
  clearTimeout(watchdog);
}
try {
  if (input) {
    if (input.hook_event_name !== "SessionEnd") {
      throw new RangeError(`Expected SessionEnd, received ${input.hook_event_name}`);
    }
    await handleRuntimeV2SessionEnd({
      input,
      projectRoot: path.resolve(input.cwd ?? process.cwd()),
      env: process.env,
    });
  }
} catch {
  // Session teardown is always silent and fail-open.
}
