import { describe, expect, spyOn, test } from "bun:test";
import { ensureAndroidRoot } from "../../../src/utils/android-cmdline-tools/ensureAndroidRoot";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";
import { logger } from "../../../src/utils/logger";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

describe("ensureAndroidRoot", () => {
  test("rejects a pre-aborted signal without issuing ADB commands", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    controller.abort();

    await expect(ensureAndroidRoot(adb, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("propagates cancellation raised during adb root without issuing further commands", async () => {
    const controller = new AbortController();
    const commands: string[] = [];
    const adb: Pick<AdbExecutor, "executeCommand"> = {
      executeCommand: async (command, _timeoutMs, _maxBuffer, _noRetry, signal) => {
        commands.push(command);
        expect(signal).toBe(controller.signal);
        controller.abort(new Error("root request cancelled"));
        throw new Error("ADB interrupted");
      },
    };

    await expect(ensureAndroidRoot(adb, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(commands).toEqual(["root"]);
  });

  test("logs a genuine root command failure at warn and returns a typed failure", async () => {
    const adb = new FakeAdbExecutor();
    const error = new Error("adbd cannot run as root in production builds");
    adb.setCommandError("root", error);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(ensureAndroidRoot(adb, new AbortController().signal)).resolves.toEqual({
        success: false,
        error:
          "Failed to run adb root or verify root shell; the target emulator is not root-capable or does not allow root ADB: adbd cannot run as root in production builds",
      });
      expect(warn).toHaveBeenCalledWith("Failed to establish root ADB shell", error);
      expect(adb.getExecutedCommands()).toEqual(["root"]);
    } finally {
      warn.mockRestore();
    }
  });

  test("returns a typed failure when shell id is not root", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell id", createExecResult("uid=2000(shell)\n", ""));

    await expect(ensureAndroidRoot(adb)).resolves.toEqual({
      success: false,
      error:
        "adb root completed, but ADB shell is still not root; the target emulator is not root-capable. shell id: uid=2000(shell)",
    });
    expect(adb.getExecutedCommands()).toEqual(["root", "wait-for-device", "shell id"]);
  });

  test("returns success after verifying a root shell with a live signal", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell id", createExecResult("uid=0(root)\n", ""));

    await expect(ensureAndroidRoot(adb, new AbortController().signal)).resolves.toEqual({
      success: true,
    });
    expect(adb.getExecutedCommands()).toEqual(["root", "wait-for-device", "shell id"]);
  });
});
