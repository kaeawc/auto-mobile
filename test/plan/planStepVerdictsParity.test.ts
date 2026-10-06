import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PlanSchemaValidator } from "../../src/utils/plan/PlanSchemaValidator";

/**
 * Verdicts for the highlight / dragAndDrop / setDeviceState plan steps (#10124, #10125), one table
 * for both validators: `test/fixtures/plan-yaml/step-verdicts.json` is also read by the Kotlin
 * validator's `PlanStepVerdictsParityTest`, so the TypeScript validator and the Kotlin one (which
 * loads the same schema through a js-yaml-compatible SnakeYAML loader) cannot disagree on a snippet
 * without one of the two suites failing.
 */
interface VerdictRow {
  name: string;
  valid: boolean;
  yaml: string;
}

const rows = JSON.parse(
  readFileSync(join(import.meta.dir, "../fixtures/plan-yaml/step-verdicts.json"), "utf8"),
) as VerdictRow[];

describe("plan step verdicts (shared TypeScript / Kotlin table)", () => {
  let validator: PlanSchemaValidator;

  beforeAll(async () => {
    validator = new PlanSchemaValidator();
    await validator.loadSchema();
    validator.validateYaml("name: warmup\nsteps:\n  - tool: observe\n");
  });

  test("the table covers accepted and rejected snippets of all three tools", () => {
    expect(rows.some((row) => row.valid)).toBe(true);
    expect(rows.some((row) => !row.valid)).toBe(true);
    for (const tool of ["highlight", "dragAndDrop", "setDeviceState"]) {
      expect(rows.some((row) => row.yaml.includes(`tool: ${tool}`))).toBe(true);
    }
  });

  test.each(rows.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    const result = validator.validateYaml(row.yaml);
    expect(result.valid).toBe(row.valid);
  });
});
