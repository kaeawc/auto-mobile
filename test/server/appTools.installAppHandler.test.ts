import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ActionableError, type BootedDevice, type InstallAppResult } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createAppToolsHarness } from "../helpers/appToolsHarness";

const appTools = createAppToolsHarness();

describe("installApp handler", () => {
  const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
  const artifactPath = "/tmp/app.apk";

  beforeEach(() => {
    appTools.reset();
  });

  afterEach(() => {
    appTools.clear();
  });

  const stubInstall = (result: InstallAppResult) => {
    appTools.configure("installApp", { createInstallApp: () => ({ execute: async () => result }) });
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
