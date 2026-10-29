import { describe, expect, test } from "bun:test";
import {
  AdbGuestAudioCapture,
  type GuestAudioCaptureOptions,
} from "../../../src/features/audio/GuestAudioCapture";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const STATUS = "/proc/asound/card2/pcm3c/sub0/status";
const RUNNING = "state: RUNNING\nowner_pid   : 4242\n";
function result(stdout: string, error?: string): ExecResult {
  return {
    stdout,
    stderr: "",
    error,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (value) => stdout.includes(value),
  };
}
function setup(options: GuestAudioCaptureOptions = {}) {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  adb.setCommandResponse("for status in", result(`${STATUS}\n`));
  adb.setCommandResponse("nohup tinycap", result("4242\n"));
  adb.setCommandResponse(`cat ${STATUS}`, result(RUNNING));
  const devices: string[] = [];
  const capture = new AdbGuestAudioCapture(
    (deviceId) => {
      devices.push(deviceId);
      return adb;
    },
    timer,
    options,
  );
  return { adb, timer, capture, devices };
}

describe("AdbGuestAudioCapture", () => {
  test("selects the capture card/device, verifies its PID through the default settle window, and closes once", async () => {
    const { capture, adb, timer, devices } = setup();
    const handle = await capture.open("emulator-5554");
    expect(devices).toEqual(["emulator-5554"]);
    expect(timer.monotonicNow()).toBe(3_000);
    const commands = adb.getExecutedCommands();
    expect(commands[1]).toContain("tinycap /dev/null -D 2 -d 3 -c 1 -r 48000 -b 16");
    expect(commands.filter((command) => command.includes(`cat ${STATUS}`))).toHaveLength(31);
    await handle.close();
    await handle.close();
    expect(adb.getExecutedCommands().filter((command) => command.includes("kill "))).toEqual([
      "shell sh -c 'if kill -0 4242 2>/dev/null; then kill 4242; fi'",
    ]);
  });

  for (const status of [
    "closed\n",
    "state: PREPARED\nowner_pid: 4242\n",
    "state: RUNNING\nowner_pid: 9999\n",
    "state: RUNNING\n",
  ]) {
    test(`refuses unverified capture ${status.trim()} and kills only the launched PID`, async () => {
      const { capture, adb, timer } = setup({ timeoutMs: 400, settleMs: 200 });
      adb.setCommandResponse(`cat ${STATUS}`, result(status));
      await expect(capture.open("emulator-5554")).rejects.toMatchObject({
        code: "audio_guest_capture_unavailable",
      });
      expect(timer.monotonicNow()).toBe(400);
      expect(adb.getExecutedCommands().at(-1)).toContain("then kill 4242;");
      expect(adb.getExecutedCommands().at(-1)).not.toContain("9999");
    });
  }

  test("requires a continuous RUNNING settle window and rechecks after the delay", async () => {
    const { capture, adb, timer } = setup({ timeoutMs: 1_000, settleMs: 200 });
    adb.setCommandResponseSequence(`cat ${STATUS}`, [
      result(RUNNING),
      result("closed\n"),
      result(RUNNING),
    ]);
    const handle = await capture.open("emulator-5554");
    expect(timer.monotonicNow()).toBe(400);
    await handle.close();
  });

  test("executor creation failures use the bracketed guard error", async () => {
    const capture = new AdbGuestAudioCapture(() => {
      throw new Error("ADB unavailable");
    }, new FakeTimer());
    await expect(capture.open("emulator-5554")).rejects.toThrow(
      "[audio_guest_capture_unavailable]",
    );
  });

  test("does not launch without a readable capture status path", async () => {
    const { capture, adb } = setup();
    adb.setCommandResponse("for status in", result(""));
    await expect(capture.open("emulator-5554")).rejects.toThrow("no readable ALSA capture status");
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });

  test("read failures after launch refuse injection and clean up", async () => {
    const { capture, adb } = setup();
    adb.setCommandError(`cat ${STATUS}`, new Error("Permission denied"));
    await expect(capture.open("emulator-5554")).rejects.toThrow("Permission denied");
    expect(adb.getExecutedCommands().at(-1)).toContain("then kill 4242;");
    expect(adb.getExecutedCommands().some((command) => command.includes("root"))).toBe(false);
  });

  test("a failed launch cleans up a PID streamed before the failure", async () => {
    const { capture, adb } = setup();
    adb.setCommandError("nohup tinycap", new Error("transport reset"));
    adb.setCommandStdoutChunks("nohup tinycap", ["42", "42\n"]);
    await expect(capture.open("emulator-5554")).rejects.toThrow("transport reset");
    expect(adb.getExecutedCommands().at(-1)).toContain("then kill 4242;");
  });

  test("cleanup failures are actionable and never target another PID", async () => {
    const { capture, adb } = setup();
    const handle = await capture.open("emulator-5554");
    adb.setCommandError("then kill 4242;", new Error("Permission denied"));
    await expect(handle.close()).rejects.toThrow(
      "Failed to close guest audio capture PID 4242 on emulator-5554",
    );
    expect(adb.getExecutedCommands().at(-1)).toContain("then kill 4242;");
  });

  test("an invalid launch PID is refused without issuing a kill", async () => {
    const { capture, adb } = setup();
    adb.setCommandResponse("nohup tinycap", result("1; kill 9999\n"));
    await expect(capture.open("emulator-5554")).rejects.toThrow("valid PID");
    expect(adb.getExecutedCommands()).toHaveLength(2);
  });

  test("an executor typed failure is refused and cleaned up", async () => {
    const { adb, timer } = setup();
    const failingAdb: Pick<AdbExecutor, "execute"> = {
      execute: async (args, options) =>
        args.join(" ").includes(`cat ${STATUS}`)
          ? result("", "cannot read status")
          : adb.execute(args, options),
    };
    const capture = new AdbGuestAudioCapture(() => failingAdb, timer);
    await expect(capture.open("emulator-5554")).rejects.toThrow("cannot read status");
    expect(adb.getExecutedCommands().at(-1)).toContain("then kill 4242;");
  });
});
