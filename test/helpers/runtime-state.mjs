import fs from "node:fs/promises";
import path from "node:path";

async function files(root) {
  const found = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await files(target)); else if (entry.isFile()) found.push(target);
  }
  return found;
}
async function json(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
export async function runtimeState(projectRoot) {
  const tasks = [], journals = [], records = [], evaluations = [];
  for (const file of await files(path.join(projectRoot, ".runtime-correction"))) {
    const portable = file.replaceAll("\\", "/");
    if (portable.endsWith("/task.json")) tasks.push(await json(file));
    else if (portable.endsWith("/journal/events.jsonl")) for (const row of (await fs.readFile(file, "utf8")).split("\n").filter(Boolean)) journals.push(JSON.parse(row));
    else if (/\/native-(?:runs|followups|stop-reviews)\/.+\.json$/u.test(portable)) records.push({ file: portable, ...await json(file) });
    else if (/\/evaluations\/stop-.+\.json$/u.test(portable)) evaluations.push({ file: portable, ...await json(file) });
  }
  return { tasks, journals, records, evaluations };
}
