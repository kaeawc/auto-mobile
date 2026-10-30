import { describe, expect, test } from "bun:test";
import {
  AdbGuestAudioCapture,
  type GuestAudioCaptureOptions,
} from "../../../src/features/audio/GuestAudioCapture";
import { ActionableError } from "../../../src/models/ActionableError";
import { createExecResult } from "../../../src/utils/execResult";
import { CountingIdGenerator } from "../../../src/utils/CountingIdGenerator";
import type {
  EmulatorGrpcDiscovery,
  EmulatorGrpcEndpoint,
} from "../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { EmulatorAudioService } from "../../../src/features/audio/EmulatorAudioService";
import { FakeEmulatorAudioSession } from "../../fakes/FakeEmulatorAudioSession";

const COMPONENT = "dev.jasonpearson.automobile.ctrlproxy/.GuestAudioCaptureReceiver";
const ACTION = "dev.jasonpearson.automobile.GUEST_AUDIO_CAPTURE";
const reply = (state: string) =>
  createExecResult(`Broadcast completed: result=0, data="${state}"\n`, "");
function setup(options: GuestAudioCaptureOptions = {}) {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  adb.setCommandResponse("--es op start", reply("running"));
  adb.setCommandResponse("--es op status", reply("running"));
  adb.setCommandResponse("--es op stop", reply("stopped"));
  const emulator: EmulatorGrpcEndpoint = {
    pid: 123,
    consolePort: 5554,
    address: "localhost:8554",
    auth: { kind: "none" },
    descriptionFile: "pid_123.ini",
  };
  const discovery: EmulatorGrpcDiscovery = { findByConsolePort: async () => ({ ...emulator }) };
  const capture = new AdbGuestAudioCapture(
    () => adb,
    discovery,
    new CountingIdGenerator("capture"),
    timer,
    options,
  );
  return { adb, timer, capture, emulator, discovery };
}

describe("AdbGuestAudioCapture", () => {
  test("only the start broadcast carries the requested lease timeout", async () => {
    const { adb, capture } = setup();
    const handle = await capture.open("emulator-5554", { leaseMs: 3_720_000 });
    await handle.close();
    const commands = adb.getExecutedCommands();
    expect(commands[0]).toContain("--el leaseTimeoutMs 3720000");
    const subsequent = commands.slice(1);
    expect(subsequent.some((command) => command.includes("--es op status"))).toBe(true);
    expect(subsequent.some((command) => command.includes("--es op stop"))).toBe(true);
    expect(subsequent.every((command) => !command.includes("leaseTimeoutMs"))).toBe(true);
  });

  test("opens the explicit ordered broadcast and verifies the default settle window", async () => {
    const { adb, timer, capture } = setup();
    const handle = await capture.open("emulator-5554", { leaseMs: 60_000 });
    expect(adb.getExecutedCommands()[0]).toBe(
      `shell am broadcast -n ${COMPONENT} -a ${ACTION} --es op start --es lease capture-1 --el leaseTimeoutMs 60000`,
    );
    expect(timer.monotonicNow()).toBe(3_000);
    expect(
      adb.getExecutedCommands().filter((command) => command.includes("--es op status")),
    ).toHaveLength(30);
    for (const command of adb.getExecutedCommands()) {
      expect(command).not.toContain("tinycap");
      expect(command).not.toContain("/proc");
    }
    for (const call of adb.getCommandCalls()) {
      expect(call.noRetry).toBe(true);
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(2_000);
    }
    await handle.close();
    await handle.close();
    expect(adb.getExecutedCommands().filter((command) => command.includes("--es op stop"))).toEqual(
      [`shell am broadcast -n ${COMPONENT} -a ${ACTION} --es op stop --es lease capture-1`],
    );
  });

  for (const state of ["absent", "failed capture read returned -3", "stopped", "runningish"]) {
    test(`refuses immediately on status ${state}`, async () => {
      const { adb, capture, timer } = setup();
      adb.setCommandResponseSequence("--es op status", [
        reply("running"),
        reply(state),
        reply("running"),
      ]);
      await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toMatchObject({
        code: "audio_guest_capture_unavailable",
        message: expect.stringContaining(state),
      });
      expect(timer.monotonicNow()).toBe(200);
      expect(
        adb.getExecutedCommands().filter((command) => command.includes("--es op status")),
      ).toHaveLength(2);
      expect(adb.getExecutedCommands().at(-1)).toContain("--es op stop");
    });
  }

  for (const state of [
    "failed RECORD_AUDIO is not granted to CtrlProxy; reinstall the CtrlProxy APK",
    "failed another guest capture is open",
  ]) {
    test(`refuses start ${state} and stops its lease`, async () => {
      const { adb, capture } = setup();
      adb.setCommandResponse("--es op start", reply(state));
      await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toThrow(state);
      expect(adb.getExecutedCommands().at(-1)).toContain("--es op stop --es lease capture-1");
    });
  }

  for (const output of ["Error: receiver not found", "Broadcast completed: result=0\n"]) {
    test(`reports a missing receiver for ${output.trim()}`, async () => {
      const { adb, capture } = setup();
      adb.setCommandResponse("--es op start", createExecResult(output, ""));
      await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toThrow(
        "no guest capture receiver; reinstall the CtrlProxy APK",
      );
      expect(adb.getExecutedCommands().at(-1)).toContain("--es op stop");
    });
  }

  for (const { errorCode, output, detail } of [
    {
      errorCode: "permission_denied",
      output: "Permission Denial: receiver requires android.permission.DUMP",
      detail: "adb shell was refused the CtrlProxy receiver",
    },
    {
      errorCode: "no_matching_receiver",
      output: "Error: receiver not found",
      detail: "no guest capture receiver; reinstall the CtrlProxy APK",
    },
    {
      errorCode: "protected_broadcast",
      output: "SecurityException: not allowed to send broadcast dev.example.CAPTURE from shell",
      detail: "guest capture broadcast is protected",
    },
    {
      errorCode: "broadcast_failed",
      output: "Error: broadcast dispatch failed",
      detail: "guest capture broadcast failed",
    },
  ]) {
    test(`reports ${errorCode} distinctly with bounded reply text`, async () => {
      const { adb, capture } = setup();
      const diagnostic = `${output}: ${"x".repeat(4_000)}TAIL_MUST_BE_TRUNCATED`;
      adb.setCommandResponse("--es op start", createExecResult(diagnostic, ""));
      const error = await capture
        .open("emulator-5554", { leaseMs: 60_000 })
        .catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({ code: "audio_guest_capture_unavailable" });
      if (!(error instanceof Error)) {
        throw new Error("Expected a capture failure");
      }
      expect(error.message).toContain(detail);
      if (errorCode !== "no_matching_receiver") {
        expect(error.message).not.toContain("reinstall");
        expect(error.message).toContain(diagnostic.slice(0, 2_048));
        expect(error.message).not.toContain(`${diagnostic.slice(0, 2_048)}x`);
        expect(error.message).not.toContain("TAIL_MUST_BE_TRUNCATED");
      }
      if (errorCode === "permission_denied") {
        expect(error.message).toContain("android.permission.DUMP");
        expect(error.message).toContain("held by the adb shell");
      }
    });
  }

  test("refuses deadline expiry and still sends best-effort stop", async () => {
    const { capture, adb, timer } = setup({ timeoutMs: 400, settleMs: 300, pollMs: 250 });
    await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toThrow("deadline");
    expect(timer.monotonicNow()).toBe(400);
    expect(adb.getExecutedCommands().at(-1)).toContain("--es op stop");
    expect(
      adb.getCommandCalls().find((call) => call.command.includes("--es op status"))?.timeoutMs,
    ).toBe(150);
  });

  test("a running reply arriving at the deadline cannot authorize injection", async () => {
    const { timer, discovery } = setup();
    class SlowAdb extends FakeAdbExecutor {
      override async execute(...args: Parameters<FakeAdbExecutor["execute"]>) {
        const response = await super.execute(...args);
        if (args[0].includes("start")) {
          timer.advanceTime(8_000);
        }
        return response;
      }
    }
    const adb = new SlowAdb();
    adb.setCommandResponse("--es op start", reply("running"));
    adb.setCommandResponse("--es op stop", reply("stopped"));
    const capture = new AdbGuestAudioCapture(
      () => adb,
      discovery,
      new CountingIdGenerator("capture"),
      timer,
    );
    await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toThrow("deadline");
    expect(adb.getExecutedCommands().at(-1)).toContain("--es op stop");
  });

  test("refusal diagnostics are bounded and come from the broadcast reply", async () => {
    const { adb, capture } = setup();
    adb.setCommandResponse("--es op status", reply(`failed ${"x".repeat(4_000)}`));
    const error = await capture
      .open("emulator-5554", { leaseMs: 60_000 })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("Expected a capture failure");
    }
    expect(error.message).toContain(`failed ${"x".repeat(2_000)}`);
    expect(error.message.length).toBeLessThan(2_600);
    expect(adb.getExecutedCommands().every((command) => command.includes("am broadcast"))).toBe(
      true,
    );
  });

  test("transport failures clean up without replacing the original error", async () => {
    const { adb, capture } = setup();
    adb.setCommandError("--es op start", new Error("transport reset"));
    adb.setCommandError("--es op stop", new Error("cleanup failed"));
    await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toThrow(
      "transport reset",
    );
    expect(adb.getExecutedCommands().at(-1)).toContain("--es op stop");
  });

  test("executor failures without a broadcast reply preserve the transport reason", async () => {
    const { timer, discovery } = setup();
    class FailedStatusAdb extends FakeAdbExecutor {
      override async execute(...args: Parameters<FakeAdbExecutor["execute"]>) {
        const response = await super.execute(...args);
        return args[0].includes("status")
          ? { ...response, error: "cannot query capture" }
          : response;
      }
    }
    const adb = new FailedStatusAdb();
    adb.setCommandResponse("--es op start", reply("running"));
    adb.setCommandResponse("--es op stop", reply("stopped"));
    const capture = new AdbGuestAudioCapture(
      () => adb,
      discovery,
      new CountingIdGenerator("capture"),
      timer,
    );
    await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toThrow(
      "cannot query capture",
    );
    expect(adb.getExecutedCommands().at(-1)).toContain("--es op stop");
  });

  for (const state of ["stopped", "absent"]) {
    test(`close accepts ${state}`, async () => {
      const { adb, capture } = setup();
      const handle = await capture.open("emulator-5554", { leaseMs: 60_000 });
      adb.setCommandResponse("--es op stop", reply(state));
      await handle.close();
    });
  }
  for (const state of ["running", "failed cannot stop"]) {
    test(`close rejects ${state} with an actionable error and runs once`, async () => {
      const { adb, capture } = setup();
      const handle = await capture.open("emulator-5554", { leaseMs: 60_000 });
      adb.setCommandResponse("--es op stop", reply(state));
      await expect(handle.close()).rejects.toBeInstanceOf(ActionableError);
      await handle.close();
      expect(
        adb.getExecutedCommands().filter((command) => command.includes("--es op stop")),
      ).toHaveLength(1);
    });
  }
  test("close transport errors are actionable", async () => {
    const { adb, capture } = setup();
    const handle = await capture.open("emulator-5554", { leaseMs: 60_000 });
    adb.setCommandError("--es op stop", new Error("transport reset"));
    await expect(handle.close()).rejects.toBeInstanceOf(ActionableError);
  });
  for (const identity of ["changed", "missing", "unreadable"]) {
    test(`close skips an emulator identity that is ${identity}`, async () => {
      const { adb, capture, emulator, discovery } = setup();
      const handle = await capture.open("emulator-5554", { leaseMs: 60_000 });
      adb.clearHistory();
      if (identity === "changed") {
        emulator.pid = 456;
      } else if (identity === "missing") {
        discovery.findByConsolePort = async () => undefined;
      } else {
        discovery.findByConsolePort = async () => {
          throw new Error("discovery failed");
        };
      }
      await handle.close();
      expect(adb.getExecutedCommands()).toEqual([]);
    });
  }
  test("a missing emulator identity refuses before start", async () => {
    const { capture, adb, discovery } = setup();
    discovery.findByConsolePort = async () => undefined;
    await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toThrow(
      "incarnation could not be identified",
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });
  test("injection cannot start before the capture settles and replacement cleanup sends nothing", async () => {
    const { capture, adb, emulator, discovery, timer } = setup();
    const session = new FakeEmulatorAudioSession({ ...emulator });
    let sessionCreatedAt = -1;
    const service = new EmulatorAudioService({
      discovery,
      guestCapture: capture,
      createSession: () => {
        sessionCreatedAt = timer.monotonicNow();
        return session;
      },
      ids: new CountingIdGenerator("injection"),
      readFile: async () => new Uint8Array(),
    });
    const started = await service.startInjection("emulator-5554", {
      source: { kind: "tone", durationMs: 10 },
    });
    expect(sessionCreatedAt).toBeGreaterThanOrEqual(3_000);
    emulator.pid = 456;
    adb.clearHistory();
    session.failInjection?.(new Error("connection reset"));
    await expect(service.stopInjection(started.injectionId)).rejects.toMatchObject({
      code: "audio_emulator_exited",
    });
    expect(adb.getExecutedCommands()).toEqual([]);
  });
  for (const options of [
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: NaN },
    { timeoutMs: Infinity },
    { pollMs: 0 },
    { pollMs: -1 },
    { pollMs: NaN },
    { pollMs: Infinity },
    { settleMs: -1 },
    { settleMs: NaN },
    { settleMs: Infinity },
    { settleMs: 8_000 },
  ]) {
    test(`rejects invalid options ${JSON.stringify(options)}`, () => {
      expect(() => setup(options)).toThrow("Invalid guest capture polling or settle deadline");
    });
  }
});
