import * as acquisitionRefusals from "../../src/models/deviceAcquisitionRefusals";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as planUtils from "../../src/server/planExecutorFactory";
import {
  PlanExecutionOrchestrator,
  planRefusalFields,
} from "../../src/server/planExecutionOrchestrator";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import { ActionableError } from "../../src/models/ActionableError";
import { DeviceOutsideBrokerGrantError } from "../../src/daemon/sessionBroker/connectionRefusal";
import { FakePlanVideoRecorder } from "../fakes/FakePlanVideoRecorder";
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
      videoRecorder: new FakePlanVideoRecorder(),
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

// #11421: a refusal that builds its own wire payload keeps that evidence on the plan result.
test("planRefusalFields carries a self-described refusal's payload evidence", () => {
  expect(
    planRefusalFields(
      new DeviceOutsideBrokerGrantError("executePlan", "tool", "scope-1", { deviceLabel: "B" }),
    ),
  ).toEqual({
    code: "device_outside_broker_grant",
    retryable: false,
    action: "executePlan",
    reason: "tool",
    scopeKey: "scope-1",
    deviceLabel: "B",
  });
});

test("planRefusalFields does not repeat a refusal's details beside them", () => {
  const details = { platform: "android" as const, limit: 2, booted: 2, retryAfterMs: 5_000 };
  expect(planRefusalFields(new BootCapacityExhaustedError(details, "no capacity"))).toEqual({
    code: "capacity_exhausted",
    retryable: true,
    retryAfterMs: 5_000,
    details: { ...details, code: "capacity_exhausted", retryable: true },
  });
});

for (const recovering of [true, false]) {
  test(`#12112 planRefusalFields preserves unhealthy evidence (recovering=${recovering})`, async () => {
    const devices = [
      {
        deviceId: "emulator-5554",
        reason: "new-health-reason",
        recovering,
        ...(recovering ? { retryAfterMs: 12345 } : {}),
      },
    ];
    const error = new acquisitionRefusals.DeviceUnhealthyError(devices, "unhealthy");
    const expected = {
      code: "device_unhealthy",
      deviceId: "emulator-5554",
      reason: "new-health-reason",
      recovering,
      retryable: recovering,
      ...(recovering ? { retryAfterMs: 12345 } : {}),
      devices,
    };
    expect(planRefusalFields(error)).toEqual(expected);
    execute.mockRejectedValue(error);
    expect(await run()).toMatchObject({
      success: false,
      error: "DeviceUnhealthyError: unhealthy",
      ...expected,
      deviceId: "fake-device",
    });
  });
}

test("#12112 a cleanup refusal keeps the plan deviceId at top level", async () => {
  execute.mockRejectedValue(
    new acquisitionRefusals.DeviceCleanupInProgressError("emulator-9999", 1000),
  );
  expect(await run()).toMatchObject({
    success: false,
    code: "device_cleanup_in_progress",
    retryable: true,
    retryAfterMs: 1000,
    deviceId: "fake-device",
    platform: "android",
  });
});
