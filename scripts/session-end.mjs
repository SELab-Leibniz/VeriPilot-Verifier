#!/usr/bin/env node

import path from "node:path";

import { decodeHookInput } from "../lib/protocol/claude-core-hooks.mjs";
import { handleRuntimeV2SessionEnd } from "../lib/runtime-v2/session-end.mjs";


const HARD_DEADLINE_MS = 800;


async function readStdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return decodeHookInput(raw);
}


const watchdog = setTimeout(() => process.exit(0), HARD_DEADLINE_MS);
try {
  const input = await readStdin();
  if (input.hook_event_name !== "SessionEnd") {
    throw new RangeError(`Expected SessionEnd, received ${input.hook_event_name}`);
  }
  await handleRuntimeV2SessionEnd({
    input,
    projectRoot: path.resolve(input.cwd ?? process.cwd()),
    env: process.env,
  });
} catch {
  // Session teardown is always silent and fail-open.
} finally {
  clearTimeout(watchdog);
}
