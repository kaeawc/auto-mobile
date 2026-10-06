import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { PlanSchemaValidator } from "../../../src/utils/plan/PlanSchemaValidator";
import { PLAN_YAML_LOAD_OPTIONS } from "../../../src/utils/plan/planYaml";

/**
 * Plain-scalar typing under the daemon's plan YAML schema (js-yaml core schema + merge, #10129).
 * `test/fixtures/plan-yaml/core-schema-scalars.json` is shared with the Kotlin validator's
 * `PlanYamlScalarsTest`, which asserts the same rows against SnakeYAML, so the two parsers are
 * pinned to each other through this one table. Regenerate a row by loading `v: <yaml>` here.
 */
interface ScalarRow {
  yaml: string;
  type: "null" | "boolean" | "number" | "string";
  value?: string;
}

const rows = JSON.parse(
  readFileSync(join(import.meta.dir, "../../fixtures/plan-yaml/core-schema-scalars.json"), "utf8"),
) as ScalarRow[];

function loadScalar(text: string): unknown {
  return (yaml.load(`v: ${text}`, PLAN_YAML_LOAD_OPTIONS) as { v: unknown }).v;
}

function describeValue(value: unknown): Pick<ScalarRow, "type" | "value"> {
  if (value === null) {
    return { type: "null" };
  }
  if (typeof value === "boolean") {
    return { type: "boolean", value: String(value) };
  }
  if (typeof value === "number") {
    return { type: "number", value: String(value) };
  }
  return { type: "string", value: String(value) };
}

describe("plan YAML scalars (shared js-yaml / SnakeYAML table)", () => {
  test("the table is broad and covers the issue's divergent forms", () => {
    expect(rows.length).toBeGreaterThan(60);
    const byYaml = new Map(rows.map((row) => [row.yaml, row]));
    expect(byYaml.get("2026-01-08T00:00:00Z")).toEqual({
      yaml: "2026-01-08T00:00:00Z",
      type: "string",
      value: "2026-01-08T00:00:00Z",
    });
    expect(byYaml.get("yes")?.type).toBe("string");
    expect(byYaml.get("True")).toEqual({ yaml: "True", type: "boolean", value: "true" });
  });

  test("js-yaml resolves every row to the recorded type and value", () => {
    const mismatches = rows
      .map((row) => ({ row, actual: describeValue(loadScalar(row.yaml)) }))
      .filter(
        ({ row, actual }) =>
          actual.type !== row.type || (actual.value ?? null) !== (row.value ?? null),
      )
      .map(({ row, actual }) => `${JSON.stringify(row.yaml)}: ${JSON.stringify(actual)}`);

    expect(mismatches).toEqual([]);
  });
});

describe("plan validity for unquoted scalars (daemon side of the Kotlin parity tests)", () => {
  let validator: PlanSchemaValidator;

  beforeAll(async () => {
    validator = new PlanSchemaValidator();
    await validator.loadSchema();
    // Compile the ajv schema in setup so no test body pays for it (100ms budget).
    validator.validateYaml("name: warmup\nsteps:\n  - tool: observe\n");
  });

  const unquotedPlan = `name: clock-plan
metadata:
  createdAt: 2026-01-08T00:00:00Z
steps:
  - tool: setDeviceState
    clock:
      mode: set
      instant: 2026-03-01T09:00:00Z
  - tool: observe
    label: yes
`;

  test("a plan with unquoted timestamps and a yes label is valid", () => {
    expect(validator.validateYaml(unquotedPlan)).toEqual({ valid: true });
  });

  test("an unquoted out-of-window clock instant reports the window error", () => {
    const result = validator.validateYaml(
      unquotedPlan.replace("2026-03-01T09:00:00Z", "1999-01-01T00:00:00Z"),
    );

    expect(result.valid).toBe(false);
    expect(result.errors?.map((error) => error.field)).toEqual(["steps[0].clock.instant"]);
  });

  test("an empty description is reported as an error naming the field", () => {
    const result = validator.validateYaml(
      "name: login\ndescription:\nsteps:\n  - tool: launchApp\n    appId: com.example.app\n",
    );

    expect(result.valid).toBe(false);
    expect(result.errors?.map((error) => error.field)).toEqual(["description"]);
  });
});
