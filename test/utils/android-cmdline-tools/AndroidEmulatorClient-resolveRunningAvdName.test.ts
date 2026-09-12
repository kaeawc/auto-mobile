import { describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { ExecResult } from "../../../src/models";

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

  override async executeCommand(command: string, timeoutMs?: number): Promise<ExecResult> {
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
  test("shares one deadline between the console probe and the property fallback", async () => {
    const timer = new FakeTimer();
    const adb = new StallingAdbExecutor(timer, 2_000);
    const client = new AndroidEmulatorClient(null, null, timer, new FakeAdbClientFactory(adb));

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
    const client = new AndroidEmulatorClient(null, null, timer, new FakeAdbClientFactory(adb));

    await expect(client.resolveRunningAvdName(device, 3_000)).resolves.toBeUndefined();

    expect(adb.calls).toHaveLength(1);
  });
});
