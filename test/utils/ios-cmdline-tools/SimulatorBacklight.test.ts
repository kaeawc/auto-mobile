import { describe, expect, test } from "bun:test";
import {
  OsascriptSimulatorBacklight,
  SIMULATOR_DEVICE_JXA,
  resolveDeveloperDirectory,
} from "../../../src/utils/ios-cmdline-tools/SimulatorBacklight";
import type { ExecFileAsync } from "../../../src/utils/HostCommandExecutor";

const UDID = "FC885A06-01A2-48D1-A78E-8B7F433F6B90";
const DEVELOPER_DIR = "/Applications/Xcode-27.2.0.app/Contents/Developer";

function rig(stdout: string | Error) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec: ExecFileAsync = async (file, args) => {
    calls.push({ file, args });
    if (stdout instanceof Error) {
      throw stdout;
    }
    return { stdout, stderr: "" };
  };
  return { bridge: new OsascriptSimulatorBacklight(exec, async () => DEVELOPER_DIR), calls };
}

describe("OsascriptSimulatorBacklight (#19018)", () => {
  test("runs the CoreSimulator bridge with the developer directory, UDID and state", async () => {
    const { bridge, calls } = rig('{"ok":true}\n');

    await bridge.setActive(UDID, false);

    expect(calls).toEqual([
      {
        file: "osascript",
        args: [
          "-l",
          "JavaScript",
          "-e",
          SIMULATOR_DEVICE_JXA,
          DEVELOPER_DIR,
          UDID,
          "backlight",
          "0",
        ],
      },
    ]);
  });

  test("the script passes null error out-parameters, never an NSError reference", () => {
    expect(SIMULATOR_DEVICE_JXA).toContain('setDisplayBacklightActiveError(argv[3] === "1", null)');
    expect(SIMULATOR_DEVICE_JXA).not.toContain("Ref()");
  });

  test("CoreSimulator answering NO is an actionable error naming the state", async () => {
    const { bridge } = rig('{"ok":false}');

    await expect(bridge.setActive(UDID, true)).rejects.toThrow(
      `CoreSimulator refused to turn the Simulator ${UDID} backlight on.`,
    );
  });

  test("a shut-down Simulator is reported as not booted", async () => {
    const { bridge } = rig('{"error":"device-not-booted"}');

    await expect(bridge.setActive(UDID, false)).rejects.toThrow("is not booted");
  });

  test("an unknown UDID and an unavailable framework have their own messages", async () => {
    await expect(rig('{"error":"device-not-found"}').bridge.setActive(UDID, false)).rejects.toThrow(
      "is not in the default CoreSimulator device set",
    );
    await expect(
      rig('{"error":"private-api-unavailable"}').bridge.setActive(UDID, false),
    ).rejects.toThrow("SimDevice API is unavailable");
  });

  test("unexpected output and a failed osascript are actionable errors", async () => {
    await expect(rig("Segmentation fault").bridge.setActive(UDID, false)).rejects.toThrow(
      "printed unexpected output: Segmentation fault",
    );
    await expect(
      rig(new Error("osascript exited 139")).bridge.setActive(UDID, false),
    ).rejects.toThrow(`Simulator backlight call failed on ${UDID}`);
  });

  test("reads the device type's Dynamic Island capability", async () => {
    const { bridge, calls } = rig('{"ok":false}');

    expect(await bridge.supportsDynamicIsland(UDID)).toBe(false);
    expect(calls[0]!.args.slice(-2)).toEqual([UDID, "island-support"]);
  });
});

describe("resolveDeveloperDirectory", () => {
  test("an Xcode .app DEVELOPER_DIR means its Contents/Developer", async () => {
    const dir = await resolveDeveloperDirectory(
      { DEVELOPER_DIR: "/Applications/Xcode-27.2.0.app" },
      async (target) => target,
    );
    expect(dir).toBe(DEVELOPER_DIR);
  });

  test("without DEVELOPER_DIR the xcode-select link is resolved", async () => {
    const dir = await resolveDeveloperDirectory({}, async (target) =>
      target === "/var/db/xcode_select_link" ? DEVELOPER_DIR : "unexpected",
    );
    expect(dir).toBe(DEVELOPER_DIR);
  });
});
