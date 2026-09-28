import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerAppTools,
  resetInstallAppToolDependencies,
  setInstallAppToolDependencies,
} from "../../src/server/appTools";
import { ActionableError, type BootedDevice, type InstallAppResult } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("installApp handler", () => {
  const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
  const artifactPath = "/tmp/app.apk";

  beforeEach(() => {
    ToolRegistry.clearTools();
    resetInstallAppToolDependencies();
    registerAppTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetInstallAppToolDependencies();
  });

  const stubInstall = (result: InstallAppResult) => {
    setInstallAppToolDependencies({ createInstallApp: () => ({ execute: async () => result }) });
  };

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
});
