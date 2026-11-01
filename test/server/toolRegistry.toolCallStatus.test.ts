import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistryClass } from "../../src/server/toolRegistry";
import { ActionableError, type BootedDevice } from "../../src/models";
import type { ToolCallRecord } from "../../src/db/toolCallRepository";
import { AdbDeviceTransportUnavailableError } from "../../src/utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeLogger } from "../fakes/FakeLogger";

function setup(
  handler: () => Promise<unknown>,
  options: { device?: BootedDevice; resolutionError?: unknown } = {},
) {
  const registry = new ToolRegistryClass(new FakeTimer(), new FakeLogger());
  const records: ToolCallRecord[] = [];
  registry.setToolCallRepositoryForTesting({
    async recordToolCall(record) {
      records.push(record);
    },
  });
  registry.setPipelineOverridesForTesting({
    executionTargetResolver: {
      async resolveExecutionTarget({ args }) {
        if (options.resolutionError !== undefined) {
          throw options.resolutionError;
        }
        return {
          args,
          device: options.device,
          baseSessionUuid: undefined,
          sessionUuid: undefined,
          internalCall: false,
          shouldResolveDevice: false,
        };
      },
    },
    afterToolCall: {
      async handle({ response }) {
        return { durationMs: 0, finalizedResponse: response };
      },
    },
    planLifecycleManager: { async afterExecution() {} },
  });
  registry.registerDeviceAware("statusProbe", "Records status", z.object({}), {
    handler,
    shouldEnsureDevice: () => false,
    nonDeviceHandler: handler,
  });
  return { records, call: () => registry.getTool("statusProbe")!.handler({}) };
}

describe("ToolRegistry tool call status", () => {
  test("records thrown ActionableError", async () => {
    const { call, records } = setup(async () => {
      throw new ActionableError("Target missing");
    });
    await expect(call()).rejects.toThrow("Target missing");
    expect(records).toEqual([
      expect.objectContaining({
        status: "failure",
        errorType: "ActionableError",
        errorMessage: "Target missing",
      }),
    ]);
  });
  test.each([false, "unknown"] as const)(
    "preserves a wrapped transport error with dispatch %s",
    async (dispatched) => {
      const typed = new AdbDeviceTransportUnavailableError(
        "emulator-5554",
        new Error("adb: device 'emulator-5554' not found"),
        1000,
        dispatched,
      );
      const { call, records } = setup(async () => {
        throw new Error("Failed to launch app", { cause: typed });
      });
      await expect(call()).rejects.toBe(typed);
      expect(records).toEqual([
        expect.objectContaining({ status: "failure", errorType: "device_transport_unavailable" }),
      ]);
    },
  );
  test("records MCP error text", async () => {
    const response = { isError: true, content: [{ type: "text", text: "Cannot tap\n target" }] };
    const { call, records } = setup(async () => response);
    expect(await call()).toEqual(response);
    expect(records).toEqual([
      expect.objectContaining({
        status: "failure",
        errorType: "ToolResultError",
        errorMessage: "Cannot tap\n target",
      }),
    ]);
  });
  test("records structured failure", async () => {
    const { call, records } = setup(async () => ({
      success: false,
      error: { code: "missing", message: "Target missing" },
    }));
    await call();
    expect(records).toEqual([
      expect.objectContaining({
        status: "failure",
        errorType: "ToolResultError",
        errorMessage: "missing: Target missing",
      }),
    ]);
  });
  test("records success and resolved device identity", async () => {
    const device: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
    const { call, records } = setup(async () => ({ success: true }), { device });
    await call();
    expect(records).toEqual([
      expect.objectContaining({ status: "success", deviceId: device.deviceId }),
    ]);
    expect(records[0]?.errorType).toBeUndefined();
    expect(records[0]?.errorMessage).toBeUndefined();
  });
  test("records target-resolution failures with typed code", async () => {
    const failure = Object.assign(new Error("No session"), { code: "SESSION_MISSING" });
    const { call, records } = setup(async () => ({ success: true }), { resolutionError: failure });
    await expect(call()).rejects.toThrow("No session");
    expect(records).toEqual([
      expect.objectContaining({
        status: "failure",
        errorType: "SESSION_MISSING",
        errorMessage: "No session",
      }),
    ]);
  });
  test("retains original error code through actionable wrapping", async () => {
    const { call, records } = setup(async () => {
      throw Object.assign(new Error("Transport failed"), { code: "EIO" });
    });
    await expect(call()).rejects.toThrow("Failed to execute tool statusProbe");
    expect(records).toEqual([
      expect.objectContaining({
        status: "failure",
        errorType: "EIO",
        errorMessage: "Transport failed",
      }),
    ]);
  });
  test("formats unknown thrown values", async () => {
    const { call, records } = setup(async () => {
      throw "plain failure";
    });
    await expect(call()).rejects.toThrow("plain failure");
    expect(records).toEqual([
      expect.objectContaining({
        status: "failure",
        errorType: "UnknownError",
        errorMessage: "plain failure",
      }),
    ]);
  });
});
