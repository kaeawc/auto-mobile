import { describe, expect, test } from "bun:test";
import {
  AdbGuestAudioCapture,
  type GuestAudioCaptureOptions,
} from "../../../src/features/audio/GuestAudioCapture";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { EmulatorAudioService } from "../../../src/features/audio/EmulatorAudioService";
import { CountingIdGenerator } from "../../../src/utils/CountingIdGenerator";
import { FakeEmulatorAudioSession } from "../../fakes/FakeEmulatorAudioSession";
import type {
  EmulatorGrpcDiscovery,
  EmulatorGrpcEndpoint,
} from "../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";

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
  adb.setCommandResponse("then echo matched;", result("matched\n"));
  const devices: string[] = [];
  const emulator: EmulatorGrpcEndpoint = {
    pid: 123,
    consolePort: 5554,
    address: "localhost:8554",
    auth: { kind: "none" },
    descriptionFile: "pid_123.ini",
  };
  const discovery: EmulatorGrpcDiscovery = { findByConsolePort: async () => ({ ...emulator }) };
  const capture = new AdbGuestAudioCapture(
    (deviceId) => {
      devices.push(deviceId);
      return adb;
    },
    discovery,
    new CountingIdGenerator("recorder"),
    timer,
    options,
  );
  return { adb, timer, capture, devices, emulator, discovery };
}

describe("AdbGuestAudioCapture", () => {
  test("does not send a kill to a replacement emulator on the same serial after injection fails", async () => {
    const { capture, adb, emulator, discovery } = setup();
    const session = new FakeEmulatorAudioSession({ ...emulator });
    const service = new EmulatorAudioService({
      discovery,
      guestCapture: capture,
      createSession: () => session,
      ids: new CountingIdGenerator("injection"),
      readFile: async () => new Uint8Array(),
    });
    const started = await service.startInjection("emulator-5554", {
      source: { kind: "tone", durationMs: 10 },
    });
    emulator.pid = 456;
    session.failInjection?.(new Error("connection reset after emulator restart"));
    await expect(service.stopInjection(started.injectionId)).rejects.toMatchObject({
      code: "audio_emulator_exited",
    });
    expect(adb.getExecutedCommands().filter((command) => command.includes("kill "))).toEqual([]);
  });

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
    const kills = adb.getExecutedCommands().filter((command) => command.includes("kill "));
    expect(kills).toHaveLength(1);
    expect(kills[0]).toContain("/proc/4242/environ");
    expect(kills[0]).toContain("AUTOMOBILE_GUEST_AUDIO_CAPTURE_ID=recorder-1");
    expect(kills[0]).toContain("then kill 4242;");
  });

  test("skips a recorder PID whose unique process marker no longer matches", async () => {
    const { capture, adb } = setup();
    const handle = await capture.open("emulator-5554");
    expect(adb.getExecutedCommands()[1]).toContain("AUTOMOBILE_GUEST_AUDIO_CAPTURE_ID=recorder-1");
    adb.setCommandResponse("then echo matched;", result(""));
    await handle.close();
    expect(adb.getExecutedCommands().filter((command) => command.includes("kill "))).toEqual([]);
  });

  for (const failure of ["missing emulator", "discovery failed", "recorder unreadable"]) {
    test(`skips cleanup when identity cannot be verified: ${failure}`, async () => {
      const { capture, adb, discovery } = setup();
      const handle = await capture.open("emulator-5554");
      if (failure === "missing emulator") {
        discovery.findByConsolePort = async () => undefined;
      } else if (failure === "discovery failed") {
        discovery.findByConsolePort = async () => {
          throw new Error("cannot discover emulator");
        };
      } else {
        adb.setCommandError("then echo matched;", new Error("cannot read recorder identity"));
      }
      await handle.close();
      expect(adb.getExecutedCommands().filter((command) => command.includes("kill "))).toEqual([]);
    });
  }

  test("refuses to launch when the original emulator cannot be identified", async () => {
    const { capture, adb, discovery } = setup();
    discovery.findByConsolePort = async () => undefined;
    await expect(capture.open("emulator-5554")).rejects.toThrow(
      "incarnation could not be identified",
    );
    expect(adb.getExecutedCommands()).toEqual([]);
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
    const { discovery } = setup();
    const capture = new AdbGuestAudioCapture(
      () => {
        throw new Error("ADB unavailable");
      },
      discovery,
      new CountingIdGenerator("recorder"),
      new FakeTimer(),
    );
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
    const { adb, timer, discovery } = setup();
    const failingAdb: Pick<AdbExecutor, "execute"> = {
      execute: async (args, options) =>
        args.join(" ").includes(`cat ${STATUS}`)
          ? result("", "cannot read status")
          : adb.execute(args, options),
    };
    const capture = new AdbGuestAudioCapture(
      () => failingAdb,
      discovery,
      new CountingIdGenerator("recorder"),
      timer,
    );
    await expect(capture.open("emulator-5554")).rejects.toThrow("cannot read status");
    expect(adb.getExecutedCommands().at(-1)).toContain("then kill 4242;");
  });
});
