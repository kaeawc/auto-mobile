import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { DeviceState } from "../../src/features/utility/DeviceState";
import type {
  BootedDevice,
  LaunchAppResult,
  TerminateAppResult,
  PressButtonResult,
  ObserveResult,
} from "../../src/models";
import type { WakeAndUnlockResult } from "../../src/features/action/WakeAndUnlock";
import {
  registerInteractionTools,
  setPressButtonFactory,
  resetPressButtonFactory,
  setWakeAndUnlockFactory,
  resetWakeAndUnlockFactory,
} from "../../src/server/interactionTools";
import {
  registerAppTools,
  buildLaunchAppResponse,
  setLaunchAppToolDependencies,
  resetLaunchAppToolDependencies,
  setTerminateAppToolDependencies,
  resetTerminateAppToolDependencies,
  setInstalledAppResourceRefresh,
  resetInstalledAppResourceRefresh,
} from "../../src/server/appTools";
import { registerDeviceTools } from "../../src/server/deviceTools";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createJSONToolResponse } from "../../src/utils/toolUtils";
const createObserveResult = (): ObserveResult => ({
  timestamp: 1,
  screenSize: { width: 1080, height: 1920 },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  viewHierarchy: { node: {} },
});

const device: BootedDevice = { name: "fake", deviceId: "emulator-5554", platform: "android" };

beforeEach(() => {
  ToolRegistry.clearTools();
  registerInteractionTools();
  registerAppTools();
  registerUtilityTools();
  setInstalledAppResourceRefresh(async () => {});
});
afterEach(() => {
  resetPressButtonFactory();
  resetWakeAndUnlockFactory();
  resetLaunchAppToolDependencies();
  resetTerminateAppToolDependencies();
  resetInstalledAppResourceRefresh();
  ToolRegistry.clearTools();
});

async function checkResponse(
  name: string,
  args: Record<string, unknown>,
  payload: Record<string, unknown>,
  isError?: boolean,
) {
  const tool = ToolRegistry.getTool(name)!;
  const response = await tool.deviceAwareHandler!(device, args);
  expect(response.structuredContent).toEqual(payload);
  expect(response.content).toEqual(createJSONToolResponse(payload).content);
  expect(response.isError).toBe(isError);
  expect(tool.outputSchema!.parse(response.structuredContent)).toBeDefined();
}

for (const success of [true, false]) {
  test(`pressButton preserves ${success ? "success" : "failure"} text and error flag`, async () => {
    const result: PressButtonResult = {
      success,
      button: "home",
      keyCode: 3,
      observation: createObserveResult(),
      ...(success ? {} : { error: "failed" }),
    };
    setPressButtonFactory(() => ({ execute: async () => result }));
    await checkResponse(
      "pressButton",
      { button: "home" },
      {
        message: success ? "Pressed button home" : "Failed to press button home: failed",
        observation: result.observation,
        ...result,
      },
      success ? undefined : true,
    );
  });
  test(`wakeAndUnlock preserves ${success ? "success" : "failure"} text including warning`, async () => {
    const result: WakeAndUnlockResult = {
      success,
      platform: "android",
      wasAsleep: true,
      wasLocked: true,
      unlocked: success,
      ...(success ? { warning: "runner recovering" } : { error: "failed" }),
    };
    setWakeAndUnlockFactory(() => ({ execute: async () => result }));
    await checkResponse(
      "wakeAndUnlock",
      {},
      {
        message: success
          ? "Device unlocked. Warning: runner recovering"
          : "Failed to unlock device: failed",
        ...result,
      },
      success ? undefined : true,
    );
  });
  for (const name of ["getDeviceState", "setDeviceState"] as const) {
    test(`${name} preserves ${success ? "success" : "failure"} text`, async () => {
      const result = {
        success,
        deviceId: device.deviceId,
        platform: device.platform,
        ...(success ? {} : { error: "failed" }),
      };
      const method = name === "getDeviceState" ? "getState" : "setState";
      const stateSpy = spyOn(DeviceState.prototype, method).mockResolvedValue(result);
      try {
        const response = await ToolRegistry.getTool(name)!.deviceAwareHandler!(
          device,
          name === "getDeviceState" ? {} : { doNotDisturb: { enabled: true } },
        );
        // Messages are deliberately kept under the existing handler's control.
        const payload = {
          message: success
            ? name === "getDeviceState"
              ? "Read device state"
              : "Applied device state"
            : "failed",
          ...result,
        };
        expect(response.structuredContent).toEqual(payload);
        expect(response.content).toEqual(createJSONToolResponse(payload).content);
        expect(ToolRegistry.getTool(name)!.outputSchema!.parse(payload)).toBeDefined();
        expect(response.isError).toBeUndefined();
      } finally {
        stateSpy.mockRestore();
      }
    });
  }
}

test.each([false, true])(
  "launchApp preserves attached/omitted observation text (%s)",
  async (omitted) => {
    const result: LaunchAppResult = {
      success: true,
      packageName: "com.example",
      ...(omitted
        ? {
            observationOmitted: {
              reason: "stale_launch_observation",
              expectedPackage: "com.example",
              reportedPackages: "com.other",
            },
          }
        : { observation: createObserveResult() }),
    };
    setLaunchAppToolDependencies({ createLaunchApp: () => ({ execute: async () => result }) });
    await checkResponse(
      "launchApp",
      { appId: "com.example" },
      buildLaunchAppResponse("com.example", result),
    );
  },
);

test("terminateApp preserves attached observation text", async () => {
  const result: TerminateAppResult = {
    success: true,
    packageName: "com.example",
    wasForeground: true,
    wasInstalled: true,
    wasRunning: true,
    observation: createObserveResult(),
  };
  setTerminateAppToolDependencies({ createTerminateApp: () => ({ execute: async () => result }) });
  await checkResponse(
    "terminateApp",
    { appId: "com.example" },
    { message: "Terminated app com.example", observation: result.observation, ...result },
  );
});

for (const target of [
  device,
  { name: "simulator", deviceId: "12345678-1234-1234-1234-123456789ABC", platform: "ios" },
  { name: "physical", deviceId: "00008110-001234567890ABCD", platform: "ios" },
] satisfies BootedDevice[]) {
  test.each([
    {
      state: "not installed",
      fields: { wasInstalled: false, wasRunning: false },
      message: "App com.example is not installed; nothing to terminate",
    },
    {
      state: "not running",
      fields: { wasInstalled: true, wasRunning: false },
      message: "App com.example was not running",
    },
    {
      state: "running",
      fields: { wasInstalled: true, wasRunning: true },
      message: "Terminated app com.example",
    },
    {
      state: "unknown",
      fields: {},
      message: "Terminated app com.example",
    },
    {
      state: "running state unknown",
      fields: { wasInstalled: true },
      message: "Terminated app com.example",
    },
  ])(
    `terminateApp on ${target.name} reports $state without changing fields`,
    async ({ fields, message }) => {
      const result: TerminateAppResult = {
        success: true,
        packageName: "com.example",
        wasForeground: false,
        ...(target.platform === "android" ? { userId: 0 } : {}),
        ...fields,
      };
      setTerminateAppToolDependencies({
        createTerminateApp: () => ({ execute: async () => result }),
      });
      const tool = ToolRegistry.getTool("terminateApp")!;
      const response = await tool.deviceAwareHandler!(target, { appId: "com.example" });
      const payload = { message, observation: result.observation, ...result };
      expect(response.structuredContent).toEqual(payload);
      expect(response.content).toEqual(createJSONToolResponse(payload).content);
      expect(response.isError).toBeUndefined();
      expect(tool.outputSchema!.parse(response.structuredContent)).toBeDefined();
    },
  );
}

for (const name of ["launchApp", "terminateApp"] as const) {
  test(`${name} failures still throw without manufacturing a text payload`, async () => {
    setLaunchAppToolDependencies({
      createLaunchApp: () => ({
        execute: async () => ({ success: false, packageName: "com.example", error: "failed" }),
      }),
    });
    setTerminateAppToolDependencies({
      createTerminateApp: () => ({
        execute: async () => ({
          success: false,
          packageName: "com.example",
          wasForeground: false,
          error: "failed",
        }),
      }),
    });
    await expect(
      ToolRegistry.getTool(name)!.deviceAwareHandler!(device, { appId: "com.example" }),
    ).rejects.toThrow("failed");
  });
}

test("hidden startDevice registers an output schema with closed readiness checks", () => {
  registerDeviceTools();
  const tool = ToolRegistry.getTool("startDevice")!;
  expect(tool.hidden).toBe(true);
  // Hidden from tools/list but still a valid plan step (#10153 review): the Kotlin plan
  // validator's tool names come from the catalog, which therefore lists it.
  expect(ToolRegistry.getToolForPlan("startDevice")).toBe(tool);
  expect(tool.outputSchema).toBeDefined();
  const readiness = {
    level: "automationReady",
    checks: ["bootCompleted", "runnerReady", "sessionBound"],
    elapsedMs: 37,
    recovered: false,
  };
  expect(tool.outputSchema!.safeParse({ message: "Ready", readiness }).success).toBe(true);
  for (const invalid of [
    { ...readiness, checks: ["unknownCheck"] },
    { ...readiness, level: "bootReady" },
    { ...readiness, elapsedMs: -1 },
    { ...readiness, recovered: "yes" },
  ]) {
    expect(tool.outputSchema!.safeParse({ message: "Ready", readiness: invalid }).success).toBe(
      false,
    );
  }
});
