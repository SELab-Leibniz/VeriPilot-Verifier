import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runStopTaskReview, canUseStopTaskReview } from "./stop-task-review.mjs";
import { taskDirectory } from "./task-store.mjs";
import { sha256 } from "./utils.mjs";

const objectsOf = input => Object.values(input.request?.population?.metrics ?? {}).flat();
const memberInput = (input, object) => ({ ...input, request: { ...input.request,
  population: { ...input.request.population, metrics: { [object.metricId]: [object] } },
  reviewScope: { ...input.request.reviewScope, objectIds: [object.objectId], sourceIds: [object.sourceId] } } });

export function canUseStopTaskGroup(input) {
  const objects = objectsOf(input);
  return objects.length > 0 && new Set(objects.map(object => object.metricId)).size === 1
    && objects.every(object => canUseStopTaskReview(memberInput(input, object)));
}

/** Freeze each original obligation with its existing proof rules, share source
 * bodies, and launch exactly one SDK session. Each callback completes the
 * original item's evidence adapter before acknowledging plugin persistence. */
export async function runStopTaskGroup(input, { runTask, modelRuntime, model } = {}) {
  if (!canUseStopTaskGroup(input)) throw Object.assign(new Error("Unsupported Stop group scope."), { code: "STOP_GROUP_UNSUPPORTED" });
  const directory = path.join(taskDirectory(input.projectRoot, input.taskId), "review-task-runs", `group-${randomUUID()}`);
  const root = path.join(directory, "input"), outputDir = path.join(directory, "review");
  await fs.mkdir(root, { recursive: true });
  const prepared = [], reports = new Map(), taskMap = new Map(), sharedHashes = new Map();
  try {
    for (const object of objectsOf(input)) {
      input.abortSignal?.throwIfAborted();
      const member = await runStopTaskReview(memberInput(input, object), { modelRuntime, model, prepareOnly: true });
      if (!member.task) {
        reports.set(object.objectId, member);
        await input.onItemResult?.(member);
        continue;
      }
      prepared.push(member);
      const prefix = `members/${String(prepared.length).padStart(4, "0")}/`;
      const forward = file => /^(project|process)\//u.test(file) ? file : `${prefix}${file}`;
      const reverse = file => file.startsWith(prefix) ? file.slice(prefix.length) : file;
      const copy = async (source, relative = "") => {
        for (const entry of await fs.readdir(source, { withFileTypes: true })) {
          input.abortSignal?.throwIfAborted();
          const name = relative ? `${relative}/${entry.name}` : entry.name, file = path.join(source, entry.name);
          if (entry.isSymbolicLink()) throw new Error("Linked group input is forbidden.");
          if (entry.isDirectory()) await copy(file, name);
          else {
            const destination = forward(name), bytes = await fs.readFile(file), hash = sha256(bytes);
            if (sharedHashes.has(destination)) {
              if (sharedHashes.get(destination) !== hash) throw Object.assign(new Error("Shared evidence changed while freezing the group."), { code: "REVIEW_COLLECTION_STALE" });
              continue;
            }
            sharedHashes.set(destination, hash);
            await fs.mkdir(path.dirname(path.join(root, destination)), { recursive: true });
            await fs.writeFile(path.join(root, destination), bytes, { flag: "wx" });
          }
        }
      };
      await copy(member.root);
      const task = { ...member.task, basisFiles: member.task.basisFiles.map(forward), targetFiles: member.task.targetFiles.map(forward),
        requirement: `${member.task.requirement}\nMember-specific reviewer rules: ${member.profile.promptAppend}\nUse this member's exact basisFiles; common project/ and process/ bodies are shared without sharing verdicts.` };
      taskMap.set(task.id, { member, task, forward, reverse });
    }
    if (taskMap.size) {
      const tasks = [...taskMap.values()].map(value => value.task);
      const task = { id: input.request.reviewGroupId ?? `group-${randomUUID()}`, requirement: "Review every unchanged original member and persist its independent verdict.",
        basisFiles: [...new Set(tasks.flatMap(item => item.basisFiles))], targetFiles: [...new Set(tasks.flatMap(item => item.targetFiles))],
        targetPrefixes: [...new Set(tasks.flatMap(item => item.targetPrefixes ?? []))] };
      runTask ??= (await import("../review-task/review-task.mjs")).runReviewTask;
      const worker = await runTask({ task, tasks, root, outputDir, modelRuntime, model, signal: input.abortSignal,
        maxAttempts: 2, maxTurns: 100, maxTokens: 8192, onEvent: input.onReviewEvent ?? (() => {}),
        onItemResult: async result => {
          const binding = taskMap.get(result.taskId);
          if (!binding) throw new Error("A group submitted an unassigned item.");
          const mapped = { ...result, completed: true, refs: (result.refs ?? []).map(ref => ({ ...ref, path: binding.reverse(ref.path) })),
            basis: (result.basis ?? []).map(ref => ({ ...ref, path: binding.reverse(ref.path) })),
            snapshotPaths: Object.fromEntries((result.refs ?? []).map(ref => [binding.reverse(ref.path), path.join(outputDir, "frozen-source", ref.path)])) };
          const handle = await binding.member.finalize(mapped);
          const receipt = await input.onItemResult?.(handle);
          reports.set(result.taskId, handle);
          return receipt;
        } });
      if (!worker.completed) throw Object.assign(new Error("The group ended before every member had a valid submission."), { code: "REVIEW_ITEM_INCOMPLETE" });
    }
    return { result: { summary: `Saved ${reports.size}/${objectsOf(input).length} group members.`,
      ...input.request.fixedStopClassification, findings: [], fileAssessments: [],
      metricObjectJudgements: [...reports.values()].flatMap(handle => handle.result.metricObjectJudgements) },
      sourceCitations: [...reports.values()].flatMap(handle => handle.sourceCitations ?? []),
      itemResults: [...reports.values()], artifacts: directory, close: async () => {} };
  } finally { for (const member of prepared) member.close(); }
}
