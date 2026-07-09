import { describe, expect, test } from "bun:test";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";

describe("SimCtlClient listApps", () => {
  test("pipes listapps through plutil and uses --all flag", async () => {
    const device: BootedDevice = {
      deviceId: "ios-device-123",
      name: "iOS Device",
      platform: "ios",
      source: "local"
    };
    const execCalls: string[] = [];
    const execAsync = async (file: string, args: string[]) => {
      const cmd = `${file} ${args.join(" ")}`;
      execCalls.push(cmd);
      if (args.join(" ") === "simctl --version") {
        return createExecResult("simctl version 1.0.0", "");
      }
      if (cmd.includes("listapps ios-device-123 --all | plutil")) {
        const payload = JSON.stringify({
          "com.apple.Preferences": { bundleName: "Settings" }
        });
        return createExecResult(payload, "");
      }
      return createExecResult("{}", "");
    };

    const simctl = new SimCtlClient(device, execAsync);
    const apps = await simctl.listApps();

    expect(execCalls.some(c => c.includes("listapps ios-device-123 --all | plutil"))).toBe(true);
    expect(apps).toEqual([{ bundleId: "com.apple.Preferences", bundleName: "Settings" }]);
  });

  test("falls back to listapps without --all when --all fails", async () => {
    const device: BootedDevice = {
      deviceId: "ios-device-456",
      name: "iOS Device",
      platform: "ios",
      source: "local"
    };
    const execCalls: string[] = [];
    const execAsync = async (file: string, args: string[]) => {
      const cmd = `${file} ${args.join(" ")}`;
      execCalls.push(cmd);
      if (args.join(" ") === "simctl --version") {
        return createExecResult("simctl version 1.0.0", "");
      }
      if (cmd.includes("listapps ios-device-456 --all | plutil")) {
        throw new Error("unknown option: --all");
      }
      if (cmd.includes("listapps ios-device-456 | plutil")) {
        const payload = JSON.stringify({
          "com.apple.Fitness": { bundleName: "Fitness" }
        });
        return createExecResult(payload, "");
      }
      return createExecResult("{}", "");
    };

    const simctl = new SimCtlClient(device, execAsync);
    const apps = await simctl.listApps();

    expect(execCalls.some(c => c.includes("listapps ios-device-456 --all | plutil"))).toBe(true);
    expect(execCalls.some(c => c.includes("listapps ios-device-456 | plutil") && !c.includes("--all"))).toBe(true);
    expect(apps).toEqual([{ bundleId: "com.apple.Fitness", bundleName: "Fitness" }]);
  });
});
