import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerAppTools,
  resetLaunchAppToolDependencies,
  setLaunchAppToolDependencies,
} from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, LaunchAppResult, ObserveResult } from "../../src/models";

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
    registerAppTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetLaunchAppToolDependencies();
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
