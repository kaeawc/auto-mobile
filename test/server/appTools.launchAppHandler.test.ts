import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerAppTools,
  resetLaunchAppToolDependencies,
  resetTerminateAppToolDependencies,
  setLaunchAppToolDependencies,
  setTerminateAppToolDependencies,
} from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, LaunchAppResult, ObserveResult } from "../../src/models";
import { ActionableError } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { iosMutationTokens } from "../../src/features/storage/IosMutationTokens";

// #6868: exercise the REGISTERED launchApp handler (not just the response
// builder) through an injected fake, so an already-foreground launch can never
// regress back into a response carrying "App is already in foreground" as an
// error a client has to string-match.
describe("launchApp handler (registered handler wiring, #6868)", () => {
  const device: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel 8",
    platform: "android",
  };

  const appId = "com.android.settings";

  const observationForApp = (observedAppId: string): ObserveResult =>
    ({
      activeWindow: { appId: observedAppId, activityName: "MainActivity", layoutSeqSum: 1 },
    }) as ObserveResult;

  type ToolResponse = { isError?: true; content: Array<{ type: string; text: string }> };

  const parsePayload = (response: ToolResponse) =>
    JSON.parse(response.content[0].text) as {
      message: string;
      success: boolean;
      alreadyForeground?: boolean;
      error?: string;
      verified?: boolean;
      observedAppId?: string;
      observation?: ObserveResult;
    };

  const stubLaunch = (result: LaunchAppResult): void => {
    setLaunchAppToolDependencies({
      createLaunchApp: () => ({ execute: async () => result }),
    });
  };

  beforeEach(() => {
    ToolRegistry.clearTools();
    resetLaunchAppToolDependencies();
    resetTerminateAppToolDependencies();
    registerAppTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetLaunchAppToolDependencies();
    resetTerminateAppToolDependencies();
  });

  test("an already-foreground app is a success with alreadyForeground, not an error", async () => {
    stubLaunch({
      success: true,
      alreadyForeground: true,
      packageName: appId,
      observation: observationForApp(appId),
    });

    const response = (await ToolRegistry.getTool("launchApp")!.deviceAwareHandler!(device, {
      appId,
    })) as ToolResponse;

    expect(response.isError).toBeUndefined();
    const payload = parsePayload(response);
    expect(payload.success).toBe(true);
    expect(payload.alreadyForeground).toBe(true);
    expect(payload.error).toBeUndefined();
    // The observation a client would otherwise burn an extra `observe` on.
    expect(payload.observation).toBeDefined();
    expect(payload.verified).toBe(true);
    expect(payload.observedAppId).toBe(appId);
    expect(payload.message).toBe(
      `App ${appId} was already in the foreground (foreground verified)`,
    );
  });

  test("a genuinely failed launch still surfaces as an error", async () => {
    stubLaunch({
      success: false,
      packageName: appId,
      error: "App is not installed",
    });

    await expect(
      ToolRegistry.getTool("launchApp")!.deviceAwareHandler!(device, { appId }),
    ).rejects.toThrow("App is not installed");
  });

  test("an existing actionable error is rethrown without another launch prefix", async () => {
    const original = new ActionableError("permission prompt could not be dismissed");
    setLaunchAppToolDependencies({
      createLaunchApp: () => ({
        execute: async () => {
          throw original;
        },
      }),
    });

    await expect(
      ToolRegistry.getTool("launchApp")!.deviceAwareHandler!(device, { appId }),
    ).rejects.toMatchObject({ message: "permission prompt could not be dismissed" });
  });

  test("an ordinary cold launch is unchanged and carries no alreadyForeground flag", async () => {
    stubLaunch({
      success: true,
      packageName: appId,
      observation: observationForApp(appId),
    });

    const response = (await ToolRegistry.getTool("launchApp")!.deviceAwareHandler!(device, {
      appId,
    })) as ToolResponse;

    expect(response.isError).toBeUndefined();
    const payload = parsePayload(response);
    expect(payload.alreadyForeground).toBeUndefined();
    expect(payload.message).toBe(`Launched app ${appId} (foreground verified)`);
  });

  test("passes launch arguments to the launch action", async () => {
    let received: string[] | undefined;
    setLaunchAppToolDependencies({
      createLaunchApp: () => ({
        execute: async (_appId, _clear, _cold, _activity, _user, _stability, _signal, args) => {
          received = args;
          return { success: true, packageName: appId, observation: observationForApp(appId) };
        },
      }),
    });
    await ToolRegistry.getTool("launchApp")!.deviceAwareHandler!(device, {
      appId,
      launchArguments: ["--allow-storage-mutations"],
    });
    expect(received).toEqual(["--allow-storage-mutations"]);
  });

  test("iOS launch token stays in memory and out of tool responses", async () => {
    const iosDevice = { ...device, deviceId: "ios-device", platform: "ios" as const };
    const launches: Array<string[] | undefined> = [];
    setLaunchAppToolDependencies({
      idGenerator: new CountingIdGenerator("secret"),
      createLaunchApp: () => ({
        execute: async (_appId, _clear, _cold, _activity, _user, _stability, _signal, args) => {
          launches.push(args);
          return { success: true, packageName: appId };
        },
      }),
    });
    try {
      const response = await ToolRegistry.getTool("launchApp")!.deviceAwareHandler!(iosDevice, {
        appId,
        launchArguments: ["--allow-storage-mutations"],
      });
      expect(launches[0]).toEqual([
        "--allow-storage-mutations",
        "--automobile-mutation-token",
        "secret-1",
      ]);
      expect(iosMutationTokens.get(iosDevice.deviceId, appId)).toBe("secret-1");
      expect(JSON.stringify(response)).not.toContain("secret-1");

      await ToolRegistry.getTool("launchApp")!.deviceAwareHandler!(iosDevice, { appId });
      expect(iosMutationTokens.get(iosDevice.deviceId, appId)).toBeUndefined();
      expect(launches[1]).toBeUndefined();
    } finally {
      iosMutationTokens.clear(iosDevice.deviceId, appId);
    }
  });

  test("iOS launch errors redact and clear the token", async () => {
    const iosDevice = { ...device, deviceId: "ios-device", platform: "ios" as const };
    setLaunchAppToolDependencies({
      idGenerator: new CountingIdGenerator("secret"),
      createLaunchApp: () => ({
        execute: async () => {
          throw new Error("launch failed: secret-1");
        },
      }),
    });
    try {
      await ToolRegistry.getTool("launchApp")!.deviceAwareHandler!(iosDevice, {
        appId,
        launchArguments: ["--allow-storage-mutations"],
      });
      throw new Error("Expected launch failure");
    } catch (error) {
      expect(String(error)).toContain("[REDACTED]");
      expect(String(error)).not.toContain("secret-1");
    }
    expect(iosMutationTokens.get(iosDevice.deviceId, appId)).toBeUndefined();
  });

  test("iOS termination clears the launch token", async () => {
    const iosDevice = { ...device, deviceId: "ios-device", platform: "ios" as const };
    iosMutationTokens.set(iosDevice.deviceId, appId, "secret");
    setTerminateAppToolDependencies({
      createTerminateApp: () => ({
        execute: async () => ({ success: true, packageName: appId }),
      }),
    });
    try {
      const response = await ToolRegistry.getTool("terminateApp")!.deviceAwareHandler!(iosDevice, {
        appId,
      });
      expect(JSON.stringify(response)).not.toContain("secret");
      expect(iosMutationTokens.get(iosDevice.deviceId, appId)).toBeUndefined();
    } finally {
      iosMutationTokens.clear(iosDevice.deviceId, appId);
    }
  });

  // The `alreadyForeground` marker is produced by the ANDROID path only — the iOS
  // warm path still invokes simctl/devicectl and returns an ordinary success
  // without it. A cross-platform tool description that promises the marker
  // unqualified (and propagates that promise into the generated schema and docs)
  // leaves an iOS client unable to tell the two cases apart.
  test("the tool description qualifies the already-foreground contract as Android-only", () => {
    const description = ToolRegistry.getTool("launchApp")?.description ?? "";

    expect(description).toContain("alreadyForeground");
    expect(description).toContain("Android");
  });
});
