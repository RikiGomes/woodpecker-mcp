import type { Pipeline, PipelineConfig } from "./client.ts";

export interface StepChange {
  workflow?: string;
  step?: string;
  good?: string;
  bad?: string;
  exit_code?: number;
  change?: "added" | "removed";
}

/** workflow/step keys, with a #n suffix when a name repeats (matrix builds). */
function stepsByKey(pipeline: Pipeline) {
  const out = new Map<string, { workflow?: string; step?: string; state?: string; exit_code?: number }>();
  for (const workflow of pipeline.workflows ?? []) {
    for (const step of workflow.children ?? []) {
      const base = `${workflow.name ?? ""}/${step.name ?? ""}`;
      let key = base;
      for (let n = 2; out.has(key); n++) key = `${base}#${n}`;
      out.set(key, { workflow: workflow.name, step: step.name, state: step.state, exit_code: step.exit_code });
    }
  }
  return out;
}

/** Steps whose state differs between two runs, matched by workflow and step name, in `bad` order. */
export function diffSteps(good: Pipeline, bad: Pipeline): StepChange[] {
  const before = stepsByKey(good);
  const after = stepsByKey(bad);
  const changes: StepChange[] = [];
  for (const [key, step] of after) {
    const old = before.get(key);
    if (!old) changes.push({ workflow: step.workflow, step: step.step, bad: step.state, exit_code: step.exit_code, change: "added" });
    else if (old.state !== step.state)
      changes.push({ workflow: step.workflow, step: step.step, good: old.state, bad: step.state, exit_code: step.exit_code });
  }
  for (const [key, step] of before) {
    if (!after.has(key)) changes.push({ workflow: step.workflow, step: step.step, good: step.state, change: "removed" });
  }
  return changes;
}

/** Names of config files that differ between two runs; content is never returned. */
export function diffConfigs(good: PipelineConfig[] | null, bad: PipelineConfig[] | null): string[] {
  const fingerprint = (file: PipelineConfig) => file.hash || file.data || "";
  const before = new Map((good ?? []).map((file) => [file.name ?? "", fingerprint(file)]));
  const after = new Map((bad ?? []).map((file) => [file.name ?? "", fingerprint(file)]));
  const changed: string[] = [];
  for (const [name, print] of after) {
    if (!before.has(name)) changed.push(`${name} (added)`);
    else if (before.get(name) !== print) changed.push(name);
  }
  for (const name of before.keys()) if (!after.has(name)) changed.push(`${name} (removed)`);
  return changed;
}
