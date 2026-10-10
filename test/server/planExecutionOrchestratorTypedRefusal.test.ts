import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as planUtils from "../../src/utils/planUtils";
import {
  PlanExecutionOrchestrator,
  planRefusalFields,
} from "../../src/server/planExecutionOrchestrator";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeTimer } from "../fakes/FakeTimer";

// #11236: a typed retryable refusal that failed the plan was flattened into the `error` string,
// so a runner could not tell `capacity_exhausted` (wait and retry) from a terminal failure.

let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;

beforeEach(() => {
  execute = spyOn(planUtils, "executePlan");
});
afterEach(() => execute.mockRestore());

function run() {
  return new PlanExecutionOrchestrator(
    {
      device: { platform: "android", deviceId: "fake-device", name: "Fake" },
      request: {
        platform: "android",
        planContent: "name: refusal\nsteps:\n  - tool: observe\n    params: {}\n",
        startStep: 0,
        deviceAllocationTimeoutMs: 5000,
      },
    },
    {
      timer: new FakeTimer(),
      createSchemaValidator: () => ({
        loadSchema: async () => undefined,
        validateYaml: () => ({ valid: true }),
      }),
    },
  ).execute();
}

test("a capacity refusal keeps its typed fields on the failure result", async () => {
  execute.mockRejectedValue(
    new BootCapacityExhaustedError(
      { platform: "android", limit: 2, booted: 2, retryAfterMs: 5_000 },
      "Refused to boot: no Android capacity",
    ),
  );

  const result = await run();

  expect(result).toMatchObject({
    success: false,
    code: "capacity_exhausted",
    retryable: true,
    retryAfterMs: 5_000,
    details: { limit: 2, booted: 2, platform: "android" },
  });
  expect(result.error).toContain("Refused to boot");
});

test("an untyped failure carries no refusal fields", async () => {
  execute.mockRejectedValue(new ActionableError("plain failure"));

  const result = await run();

  expect(result.success).toBe(false);
  expect(result).not.toHaveProperty("code");
  expect(result).not.toHaveProperty("retryable");
});

test("planRefusalFields reads nextAction and ignores a code without a retryable flag", () => {
  const refusal = Object.assign(new Error("gone"), {
    code: "session_ownership_lost",
    retryable: false,
    nextAction: "acquire a new session",
  });
  expect(planRefusalFields(refusal)).toEqual({
    code: "session_ownership_lost",
    retryable: false,
    nextAction: "acquire a new session",
  });
  expect(planRefusalFields(Object.assign(new Error("enoent"), { code: "ENOENT" }))).toEqual({});
  expect(planRefusalFields("boom")).toEqual({});
});
