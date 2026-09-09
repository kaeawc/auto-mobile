import { describe, expect, test } from "bun:test";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";

describe("SimCtlClient pushNotification", () => {
  const device: BootedDevice = {
    deviceId: "ios-device-push",
    name: "iOS Device",
    platform: "ios",
    source: "local",
  };

  // Issue #6517: `simctl push` can exit 0 (delivered) while still writing
  // advisory/diagnostic text to stderr. Success must be driven by the exit
  // code (via executeCommandArgs throwing on non-zero exit), not by stderr
  // content.
  test("returns success when simctl push exits 0 with non-empty stderr", async () => {
    const execAsync = async (_file: string, args: string[]) => {
      if (args.join(" ") === "simctl --version") {
        return createExecResult("simctl version 1.0.0", "");
      }
      if (args[0] === "simctl" && args[1] === "push") {
        return createExecResult("", "warning: some advisory diagnostic text");
      }
      return createExecResult("", "");
    };

    const simctl = new SimCtlClient(device, execAsync);
    const result = await simctl.pushNotification(
      "ios-device-push",
      "com.example.app",
      JSON.stringify({ aps: { alert: "hi" } }),
    );

    expect(result).toEqual({ success: true });
  });

  test("returns failure when simctl push exits non-zero", async () => {
    const execAsync = async (_file: string, args: string[]) => {
      if (args.join(" ") === "simctl --version") {
        return createExecResult("simctl version 1.0.0", "");
      }
      if (args[0] === "simctl" && args[1] === "push") {
        throw new Error("Invalid device state");
      }
      return createExecResult("", "");
    };

    const simctl = new SimCtlClient(device, execAsync);
    const result = await simctl.pushNotification(
      "ios-device-push",
      "com.example.app",
      JSON.stringify({ aps: { alert: "hi" } }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid device state");
  });
});
