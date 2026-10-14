import { describe, expect, it } from "vitest";
import { diffConfigs, diffSteps } from "../src/compare.ts";

const run = (number: number, steps: Array<[string, string, string, number?]>) => {
  const workflows = new Map<string, Array<{ id: number; name: string; state: string; exit_code?: number }>>();
  steps.forEach(([workflow, name, state, exit_code], i) => {
    if (!workflows.has(workflow)) workflows.set(workflow, []);
    workflows.get(workflow)!.push({ id: number * 100 + i, name, state, exit_code });
  });
  return { id: number, number, workflows: [...workflows].map(([name, children], i) => ({ id: i, name, children })) };
};

describe("diffSteps", () => {
  it("keeps only steps whose state changed, plus added and removed ones", () => {
    const good = run(1, [["api", "lint", "success"], ["api", "test", "success"], ["api", "old", "success"]]);
    const bad = run(2, [["api", "lint", "success"], ["api", "test", "failure", 1], ["api", "new", "skipped"]]);
    expect(diffSteps(good, bad)).toEqual([
      { workflow: "api", step: "test", good: "success", bad: "failure", exit_code: 1 },
      { workflow: "api", step: "new", bad: "skipped", change: "added" },
      { workflow: "api", step: "old", good: "success", change: "removed" },
    ]);
  });

  it("tells repeated step names apart by position", () => {
    const good = run(1, [["matrix", "test", "success"], ["matrix", "test", "success"]]);
    const bad = run(2, [["matrix", "test", "success"], ["matrix", "test", "failure", 2]]);
    expect(diffSteps(good, bad)).toEqual([
      { workflow: "matrix", step: "test", good: "success", bad: "failure", exit_code: 2 },
    ]);
  });
});

describe("diffConfigs", () => {
  it("names changed, added and removed files without their content", () => {
    expect(
      diffConfigs(
        [{ name: "a.yaml", hash: "1" }, { name: "b.yaml", hash: "2" }, { name: "gone.yaml", hash: "3" }],
        [{ name: "a.yaml", hash: "1" }, { name: "b.yaml", hash: "9" }, { name: "new.yaml", hash: "4" }],
      ),
    ).toEqual(["b.yaml", "new.yaml (added)", "gone.yaml (removed)"]);
    expect(diffConfigs(null, null)).toEqual([]);
  });
});
