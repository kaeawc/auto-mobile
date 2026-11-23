import { describe, expect, test } from "bun:test";
import { OsascriptSimulatorBacklight } from "../../../src/utils/ios-cmdline-tools/SimulatorBacklight";
import type { ExecFileAsync } from "../../../src/utils/HostCommandExecutor";

describe("OsascriptSimulatorBacklight (#19018)", () => {
  test("runs the JavaScript for Automation bridge with the UDID and state", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec: ExecFileAsync = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "ok\n", stderr: "" };
    };

    await new OsascriptSimulatorBacklight(exec).setActive("UDID", false);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("osascript");
    expect(calls[0]!.args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(calls[0]!.args[3]).toContain("setDisplayBacklightActiveError");
    expect(calls[0]!.args.slice(4)).toEqual(["UDID", "false"]);
  });

  test("a bridge failure names the Simulator and the requested state", async () => {
    const exec: ExecFileAsync = async () => {
      throw new Error("execution error: Error: Simulator UDID is not in the default device set");
    };

    const call = new OsascriptSimulatorBacklight(exec).setActive("UDID", true);

    await expect(call).rejects.toThrow("Failed to turn the Simulator UDID backlight on");
  });
});
