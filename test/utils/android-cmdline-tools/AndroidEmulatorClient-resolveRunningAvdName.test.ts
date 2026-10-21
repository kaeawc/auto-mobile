import { describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeEmulatorConsoleBusyRegistry } from "../../fakes/FakeEmulatorConsoleBusyRegistry";
import { resolveRunningAvdNameOnce } from "../../../src/utils/android-cmdline-tools/runningAvdName";
import { createExecResult } from "../../../src/utils/execResult";
import type { ExecResult } from "../../../src/models";
import {
  executeCommandOptionsOf,
  type ExecuteCommandRest,
} from "../../fakes/executeCommandOptionsOf";

/**
 * Burns wall-clock (fake) time on every adb command and then fails it, the way
 * a wedged emulator console does: the command sits until its own timeout and
 * reports nothing.
 */
class StallingAdbExecutor extends FakeAdbExecutor {
  readonly calls: Array<{ command: string; timeoutMs: number | undefined }> = [];

  constructor(
    private readonly timer: FakeTimer,
    private readonly elapsePerCommandMs: number,
  ) {
    super();
  }

  override async executeCommand(command: string, ...rest: ExecuteCommandRest): Promise<ExecResult> {
    const { timeoutMs } = executeCommandOptionsOf([command, ...rest]);
    this.calls.push({ command, timeoutMs });
    this.timer.advanceTime(this.elapsePerCommandMs);
    throw new Error("adb command timed out");
  }
}

const device: BootedDevice = {
  name: "Unknown (emulator-5554)",
  platform: "android",
  deviceId: "emulator-5554",
};

/**
 * `resolveRunningAvdName` is called by destructive actions that are already
 * holding a lifecycle lease against a deadline, so its budget is a TOTAL, not a
 * per-command allowance: `emu avd name` and the `getprop` fallback run
 * sequentially and must share it (#6863 review).
 */
describe("AndroidEmulatorClient.resolveRunningAvdName", () => {
  test.each(["empty", "error"])(
    "marks an unresolved %s property fallback at the shared deadline as timed out",
    async (outcome) => {
      const timer = new FakeTimer();
      const adb = new FakeAdbExecutor();
      const execute = adb.executeCommand.bind(adb);
      adb.executeCommand = async (command, options) => {
        timer.advanceTime(command === "emu avd name" ? 500 : 1_500);
        if (command === "emu avd name" || outcome === "error") {
          throw new Error("probe failed");
        }
        return await execute(command, options);
      };

      const result = await resolveRunningAvdNameOnce(
        {
          timer,
          adbFactory: new FakeAdbClientFactory(adb),
          consoleBusyRegistry: new FakeEmulatorConsoleBusyRegistry(),
        },
        device,
        2_000,
      );

      expect(result).toMatchObject({ name: "", nameProbeTimedOut: true });
      expect(result.diagnostic).toBeDefined();
    },
  );

  test("does not mark a resolved property fallback at the deadline as timed out", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.executeCommand = async (command) => {
      timer.advanceTime(1_000);
      return createExecResult(command === "emu avd name" ? "" : "Pixel_A", "");
    };

    expect(
      await resolveRunningAvdNameOnce(
        {
          timer,
          adbFactory: new FakeAdbClientFactory(adb),
          consoleBusyRegistry: new FakeEmulatorConsoleBusyRegistry(),
        },
        device,
        2_000,
      ),
    ).toEqual({ name: "Pixel_A" });
  });

  test("shares one deadline between the console probe and the property fallback", async () => {
    const timer = new FakeTimer();
    const adb = new StallingAdbExecutor(timer, 2_000);
    const client = new AndroidEmulatorClient({ timer, adbFactory: new FakeAdbClientFactory(adb) });

    await expect(client.resolveRunningAvdName(device, 3_000)).resolves.toBeUndefined();

    expect(adb.calls.map((call) => call.command)).toEqual([
      "emu avd name",
      "shell getprop ro.boot.qemu.avd_name",
    ]);
    expect(adb.calls[0].timeoutMs).toBe(3_000);
    // Only what is left of the shared budget, never a second full one.
    expect(adb.calls[1].timeoutMs).toBe(1_000);
  });

  test("skips the fallback entirely once the shared deadline is spent", async () => {
    const timer = new FakeTimer();
    const adb = new StallingAdbExecutor(timer, 3_500);
    const client = new AndroidEmulatorClient({ timer, adbFactory: new FakeAdbClientFactory(adb) });

    await expect(client.resolveRunningAvdName(device, 3_000)).resolves.toBeUndefined();

    expect(adb.calls).toHaveLength(1);
  });
});
