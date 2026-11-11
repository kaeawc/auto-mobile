import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { InstallAppCall } from "../../src/features/action/InstallApp";
import { ActionableError, type BootedDevice, type InstallAppResult } from "../../src/models";
import { installAppSchema } from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createAppToolsHarness } from "../helpers/appToolsHarness";

const appTools = createAppToolsHarness();

describe("installApp handler", () => {
  const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
  const artifactPath = "/tmp/app.apk";
  const forgotten: Array<{ deviceId: string; packageName?: string }> = [];
  const carAppTemplates = {
    forgetPackage(deviceId: string, packageName?: string): void {
      forgotten.push({ deviceId, packageName });
    },
  };

  beforeEach(() => {
    forgotten.length = 0;
    appTools.reset();
    appTools.configure("installApp", { carAppTemplates });
  });

  afterEach(() => {
    appTools.clear();
  });

  const stubInstall = (result: InstallAppResult) => {
    appTools.configure("installApp", { createInstallApp: () => ({ execute: async () => result }) });
  };

  test("a successful upgrade forgets the result package on the installed device for all users", async () => {
    stubInstall({ success: true, upgrade: true, packageName: "com.example.car", userId: 10 });
    await ToolRegistry.getTool("installApp")!.deviceAwareHandler!(device, { artifactPath });
    expect(forgotten).toEqual([{ deviceId: device.deviceId, packageName: "com.example.car" }]);
  });

  test("a failed result still forgets the result package in finally", async () => {
    stubInstall({ success: false, error: "install failed", packageName: "com.example.car" });
    await expect(
      ToolRegistry.getTool("installApp")!.deviceAwareHandler!(device, { artifactPath }),
    ).rejects.toThrow("install failed");
    expect(forgotten).toEqual([{ deviceId: device.deviceId, packageName: "com.example.car" }]);
  });

  test("a thrown install forgets the device when the package could not be determined", async () => {
    appTools.configure("installApp", {
      createInstallApp: () => ({
        execute: async () => {
          throw new Error("install threw");
        },
      }),
    });
    await expect(
      ToolRegistry.getTool("installApp")!.deviceAwareHandler!(device, { artifactPath }),
    ).rejects.toThrow("Failed to install app");
    expect(forgotten).toEqual([{ deviceId: device.deviceId, packageName: undefined }]);
  });

  test("a successful install without a package name forgets the device", async () => {
    stubInstall({ success: true });
    await ToolRegistry.getTool("installApp")!.deviceAwareHandler!(device, { artifactPath });
    expect(forgotten).toEqual([{ deviceId: device.deviceId, packageName: undefined }]);
  });

  test("an already cancelled install does not invalidate the reader", async () => {
    stubInstall({ success: true, packageName: "com.example.car" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      ToolRegistry.getTool("installApp")!.deviceAwareHandler!(
        device,
        { artifactPath },
        undefined,
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(forgotten).toEqual([]);
  });

  test("an iOS install does not invalidate Android route state", async () => {
    stubInstall({ success: true, packageName: "com.example.car" });
    await ToolRegistry.getTool("installApp")!.deviceAwareHandler!(
      { ...device, platform: "ios" },
      { artifactPath },
    );
    expect(forgotten).toEqual([]);
  });

  test("surfaces a failed install instead of claiming success", async () => {
    stubInstall({ success: false, error: "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]" });

    const pending = ToolRegistry.getTool("installApp")!.deviceAwareHandler!(device, {
      artifactPath,
    });
    await expect(pending).rejects.toBeInstanceOf(ActionableError);
    await expect(pending).rejects.toThrow("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]");
  });

  test("keeps the success message unchanged", async () => {
    stubInstall({ success: true, upgrade: false });

    const response = (await ToolRegistry.getTool("installApp")!.deviceAwareHandler!(device, {
      artifactPath,
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(response.content[0]!.text).message).toBe(
      `Installed app from ${artifactPath}`,
    );
  });

  const captureCalls = () => {
    const calls: Array<InstallAppCall | undefined> = [];
    appTools.configure("installApp", {
      createInstallApp: () => ({
        execute: async (_artifactPath: string, call?: InstallAppCall) => {
          calls.push(call);
          return { success: true };
        },
      }),
    });
    return calls;
  };

  test("forwards the Android bundle, split and flag options", async () => {
    const calls = captureCalls();
    const android = {
      splits: ["/tmp/split_config.arm64_v8a.apk"],
      bundle: {
        modules: ["feature"],
        localTesting: true,
        keystore: { path: "/k.jks", alias: "a", storePassword: "pw" },
      },
      grantAllPermissions: true,
      allowDowngrade: true,
    };

    await ToolRegistry.getTool("installApp")!.deviceAwareHandler!(device, {
      artifactPath,
      ...android,
    });

    expect(calls[0]?.android).toEqual(android);
  });

  test("a plain call carries no Android options", async () => {
    const calls = captureCalls();
    await ToolRegistry.getTool("installApp")!.deviceAwareHandler!(device, { artifactPath });
    expect(calls[0] && "android" in calls[0]).toBe(false);
  });

  test("the schema accepts bundle options and rejects unknown or empty keystore fields", () => {
    const keystore = { path: "/k.jks", alias: "a", storePassword: "pw" };
    expect(
      installAppSchema.safeParse({
        artifactPath: "/tmp/app.aab",
        bundle: { keystore, modules: ["feature"], localTesting: true },
        grantAllPermissions: true,
        allowDowngrade: true,
      }).success,
    ).toBe(true);
    expect(
      installAppSchema.safeParse({
        artifactPath: "/tmp/a.aab",
        bundle: { keystore: { ...keystore, storePassword: "" } },
      }).success,
    ).toBe(false);
    expect(
      installAppSchema.safeParse({
        artifactPath: "/tmp/a.aab",
        bundle: { keystore: { ...keystore, extra: 1 } },
      }).success,
    ).toBe(false);
    expect(installAppSchema.safeParse({ artifactPath: "/tmp/a.apk", splits: [] }).success).toBe(
      false,
    );
  });
});
