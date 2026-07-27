import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

const actionPath = join(import.meta.dir, "../../.github/actions/gradle-task-run/action.yml");

interface CompositeAction {
  runs?: { using?: string; steps?: Array<{ uses?: string }> };
}

function usesRefs(action: CompositeAction): string[] {
  return (action.runs?.steps ?? []).flatMap(step => step.uses ? [step.uses] : []);
}

function majorVersion(ref: string): number | undefined {
  const match = /@v(\d+)(?:\.|$)/.exec(ref);
  return match ? Number(match[1]) : undefined;
}

describe("gradle-task-run action", () => {
  test("uses action versions at or above the supported Node runtime floor", () => {
    const action = load(readFileSync(actionPath, "utf8")) as CompositeAction;
    const refs = usesRefs(action);
    const minimumMajorByAction: Record<string, number> = {
      "actions/setup-java": 5,
      "gradle/actions/setup-gradle": 5,
      "actions/cache/restore": 5,
      "actions/cache/save": 5,
      "actions/upload-artifact": 7,
    };

    expect(action.runs?.using).toBe("composite");
    for (const [actionName, minimumMajor] of Object.entries(minimumMajorByAction)) {
      const ref = refs.find(candidate => candidate.startsWith(`${actionName}@`));
      expect(ref).toBeDefined();
      expect(majorVersion(ref!)).toBeGreaterThanOrEqual(minimumMajor);
    }
  });
});
