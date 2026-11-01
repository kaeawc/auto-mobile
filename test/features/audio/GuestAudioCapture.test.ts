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
import { settleWithFakeTime } from "../../helpers/fakeTimerStepping";
import { EmulatorAudioService } from "../../../src/features/audio/EmulatorAudioService";
import { FakeEmulatorAudioSession } from "../../fakes/FakeEmulatorAudioSession";
import { EmulatorAudioError } from "../../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioError";

const PACKAGE = "dev.jasonpearson.automobile.ctrlproxy";
const PERMISSION = "android.permission.RECORD_AUDIO";
const DUMP_COMMAND = `shell dumpsys package ${PACKAGE}`;
const GRANT_COMMAND = `shell pm grant ${PACKAGE} ${PERMISSION}`;
const permissionDump = (granted: boolean, user = 0) =>
  createExecResult(
    `Packages:
  Package [${PACKAGE}] (123):
    User ${user}: installed=true
      runtime permissions:
        ${PERMISSION}: granted=${granted}, flags=[]
`,
    "",
  );
const COMPONENT = "dev.jasonpearson.automobile.ctrlproxy/.GuestAudioCaptureReceiver";
const ACTION = "dev.jasonpearson.automobile.GUEST_AUDIO_CAPTURE";
const reply = (state: string) =>
  createExecResult(`Broadcast completed: result=0, data="${state}"\n`, "");
function setup(options: GuestAudioCaptureOptions = {}) {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  adb.setCommandResponse(DUMP_COMMAND, permissionDump(true));
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
    { timer, ...options },
  );
  return { adb, timer, capture, emulator, discovery };
}

describe("AdbGuestAudioCapture", () => {
  test("only the start broadcast carries the requested lease timeout", async () => {
    const { adb, capture } = setup();
    const handle = await capture.open("emulator-5554", { leaseMs: 3_720_000 });
    await handle.close();
    const commands = adb.getExecutedCommands();
    expect(commands[1]).toContain("--el leaseTimeoutMs 3720000");
    const subsequent = commands.slice(2);
    expect(subsequent.some((command) => command.includes("--es op status"))).toBe(true);
    expect(subsequent.some((command) => command.includes("--es op stop"))).toBe(true);
    expect(subsequent.every((command) => !command.includes("leaseTimeoutMs"))).toBe(true);
  });

  test("already granted RECORD_AUDIO is checked before start without a grant command", async () => {
    const { adb, capture } = setup();
    const handle = await capture.open("emulator-5554", { leaseMs: 60_000 });
    expect(adb.getExecutedCommands()[0]).toBe(DUMP_COMMAND);
    expect(adb.getExecutedCommands()[1]).toContain("--es op start");
    expect(adb.wasCommandExecuted(GRANT_COMMAND)).toBe(false);
    await handle.close();
  });

  test("grants missing RECORD_AUDIO and verifies it again before start", async () => {
    const { adb, capture } = setup();
    adb.setCommandResponseSequence(DUMP_COMMAND, [permissionDump(false), permissionDump(true)]);
    const handle = await capture.open("emulator-5554", { leaseMs: 60_000 });
    expect(adb.getExecutedCommands().slice(0, 3)).toEqual([
      DUMP_COMMAND,
      GRANT_COMMAND,
      DUMP_COMMAND,
    ]);
    expect(adb.getExecutedCommands()[3]).toContain("--es op start");
    for (const call of adb.getCommandCalls().slice(0, 3)) {
      expect(call.noRetry).toBe(true);
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(2_000);
    }
    await handle.close();
  });

  test.each(["unknown permission", "still denied", "missing runtime row"])(
    "%s refuses injection with a typed RECORD_AUDIO error before any broadcast",
    async (failure) => {
      const { adb, capture } = setup();
      adb.setCommandResponse(DUMP_COMMAND, permissionDump(false));
      if (failure === "unknown permission") {
        adb.setCommandResponse(GRANT_COMMAND, createExecResult("", "Unknown permission"));
        // A failed command must refuse even if a later read would report a grant.
        adb.setCommandResponseSequence(DUMP_COMMAND, [permissionDump(false), permissionDump(true)]);
      } else if (failure === "missing runtime row") {
        adb.setCommandResponse(
          DUMP_COMMAND,
          createExecResult(
            `Packages:\n  Package [${PACKAGE}] (123):\n    User 0: installed=true`,
            "",
          ),
        );
      }
      const opening = capture.open("emulator-5554", { leaseMs: 60_000 });
      await expect(opening).rejects.toBeInstanceOf(EmulatorAudioError);
      await expect(opening).rejects.toMatchObject({
        code: "audio_record_permission_not_granted",
        message: expect.stringContaining(`adb shell pm grant ${PACKAGE} ${PERMISSION}`),
      });
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    },
  );

  test("rejected pm grant refusal reports the permission code before any broadcast", async () => {
    const { adb, capture } = setup();
    adb.setCommandResponse(DUMP_COMMAND, permissionDump(false));
    const refusal = "java.lang.SecurityException: permission cannot be granted";
    adb.setCommandError(
      GRANT_COMMAND,
      new Error("Command failed", {
        cause: Object.assign(new Error("exit code 1"), { stderr: refusal }),
      }),
    );
    await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toMatchObject({
      code: "audio_record_permission_not_granted",
      message: expect.stringContaining(refusal),
    });
    expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
  });

  test.each([
    "read result",
    "read throw",
    "read timeout",
    "grant result",
    "grant throw",
    "grant timeout",
  ])("%s transport failure is unavailable before any broadcast", async (failure) => {
    const { adb, capture } = setup();
    adb.setCommandResponse(DUMP_COMMAND, permissionDump(false));
    const command = failure.startsWith("read") ? DUMP_COMMAND : GRANT_COMMAND;
    if (failure.endsWith("result")) {
      adb.setCommandResponse(command, { ...createExecResult("", ""), error: "transport reset" });
    } else {
      adb.setCommandError(
        command,
        new Error(failure.endsWith("timeout") ? "Command timed out" : "transport reset"),
      );
    }
    await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toMatchObject({
      code: "audio_guest_capture_unavailable",
      message: expect.stringContaining(
        `RECORD_AUDIO check could not ${failure.startsWith("read") ? "read" : "grant"}`,
      ),
    });
    expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
  });

  test("emulator pid lookup failure keeps the existing unavailable classification", async () => {
    const { adb, capture, discovery } = setup();
    discovery.findByConsolePort = async () => {
      throw new Error("emulator gone");
    };
    await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toMatchObject({
      code: "audio_guest_capture_unavailable",
    });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test.each([
    "audio_emulator_exited",
    "audio_injection_busy",
    "audio_guest_capture_unavailable",
  ] as const)(
    "inner %s is preserved unchanged during permission reads and grants",
    async (code) => {
      for (const command of [DUMP_COMMAND, GRANT_COMMAND]) {
        const { adb, capture } = setup();
        adb.setCommandResponse(DUMP_COMMAND, permissionDump(false));
        const error = new EmulatorAudioError(code, "original detail");
        adb.setCommandError(command, error);
        await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toBe(error);
        expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
      }
    },
  );

  test("automotive permission reads select user 10 and the grant targets user 10", async () => {
    const resolved: string[] = [];
    const { adb, capture } = setup({
      resolveSetupUser: async (deviceId) => {
        resolved.push(deviceId);
        return 10;
      },
    });
    // dumpsys includes every user; match the existing per-user package-read convention.
    adb.setCommandResponseSequence(DUMP_COMMAND, [
      permissionDump(false, 10),
      permissionDump(true, 10),
    ]);
    const handle = await capture.open("emulator-5554", { leaseMs: 60_000 });
    expect(resolved).toEqual(["emulator-5554"]);
    expect(adb.getExecutedCommands().slice(0, 3)).toEqual([
      DUMP_COMMAND,
      `shell pm grant --user 10 ${PACKAGE} ${PERMISSION}`,
      DUMP_COMMAND,
    ]);
    await handle.close();
  });

  test("undefined setup user preserves the default permission commands", async () => {
    const resolved: string[] = [];
    const { adb, capture } = setup({
      resolveSetupUser: async (deviceId) => {
        resolved.push(deviceId);
        return undefined;
      },
    });
    adb.setCommandResponseSequence(DUMP_COMMAND, [permissionDump(false), permissionDump(true)]);
    const handle = await capture.open("emulator-5554", { leaseMs: 60_000 });
    expect(resolved).toEqual(["emulator-5554"]);
    expect(adb.getExecutedCommands().slice(0, 3)).toEqual([
      DUMP_COMMAND,
      GRANT_COMMAND,
      DUMP_COMMAND,
    ]);
    await handle.close();
  });

  test("setup user resolution failure is unavailable", async () => {
    const { adb, capture } = setup({
      resolveSetupUser: async () => {
        throw new Error("cannot resolve user");
      },
    });
    await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toMatchObject({
      code: "audio_guest_capture_unavailable",
    });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("permission retry cannot exceed the capture deadline", async () => {
    const { adb, timer, capture } = setup();
    adb.setCommandResponse(DUMP_COMMAND, permissionDump(false));
    adb.setCommandResponse(GRANT_COMMAND, {
      ...createExecResult("", ""),
      error: "Command timed out",
    });
    const execute = adb.execute.bind(adb);
    adb.execute = async (args, options) => {
      const result = await execute(args, options);
      if (args.includes("grant")) {
        await timer.sleep(8_000);
      }
      return result;
    };
    await expect(capture.open("emulator-5554", { leaseMs: 60_000 })).rejects.toMatchObject({
      code: "audio_guest_capture_unavailable",
      message: expect.stringContaining("capture verification deadline expired"),
    });
    expect(adb.getExecutedCommands().filter((command) => command === GRANT_COMMAND)).toHaveLength(
      1,
    );
    expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
  });

  test("unresolved setup user cannot exceed the capture deadline", async () => {
    const { adb, discovery } = setup();
    const timer = new FakeTimer();
    const capture = new AdbGuestAudioCapture(
      () => adb,
      discovery,
      new CountingIdGenerator("capture"),
      { timer, resolveSetupUser: () => new Promise<number | undefined>(() => {}) },
    );
    const opening = capture.open("emulator-5554", { leaseMs: 60_000 });
    await expect(
      settleWithFakeTime(timer, opening, {
        stepMs: 1_000,
        maxSteps: 8,
        description: "setup user resolution deadline",
      }),
    ).rejects.toMatchObject({
      code: "audio_guest_capture_unavailable",
      message: expect.stringContaining("capture verification deadline expired"),
    });
    expect(timer.monotonicNow()).toBe(8_000);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("permission retry uses the reduced remaining deadline budget", async () => {
    const { adb, timer, capture } = setup({ timeoutMs: 2_000, settleMs: 0 });
    adb.setCommandResponseSequence(DUMP_COMMAND, [permissionDump(false), permissionDump(true)]);
    adb.setCommandResponseSequence(GRANT_COMMAND, [
      { ...createExecResult("", ""), error: "Command timed out" },
      createExecResult("", ""),
    ]);
    const execute = adb.execute.bind(adb);
    let attempts = 0;
    adb.execute = async (args, options) => {
      const result = await execute(args, options);
      if (args.includes("grant") && attempts++ === 0) {
        await timer.sleep(1_500);
      }
      return result;
    };
    const handle = await capture.open("emulator-5554", { leaseMs: 60_000 });
    expect(
      adb
        .getCommandCalls()
        .filter((call) => call.command === GRANT_COMMAND)
        .map((call) => call.timeoutMs),
    ).toEqual([2_000, 500]);
    await handle.close();
  });

  test("opens the explicit ordered broadcast and verifies the default settle window", async () => {
    const { adb, timer, capture } = setup();
    const handle = await capture.open("emulator-5554", { leaseMs: 60_000 });
    expect(adb.getExecutedCommands()[1]).toBe(
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
    adb.setCommandResponse(DUMP_COMMAND, permissionDump(true));
    adb.setCommandResponse("--es op start", reply("running"));
    adb.setCommandResponse("--es op stop", reply("stopped"));
    const capture = new AdbGuestAudioCapture(
      () => adb,
      discovery,
      new CountingIdGenerator("capture"),
      { timer },
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
    expect(
      adb
        .getExecutedCommands()
        .every((command) => command === DUMP_COMMAND || command.includes("am broadcast")),
    ).toBe(true);
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
    adb.setCommandResponse(DUMP_COMMAND, permissionDump(true));
    adb.setCommandResponse("--es op start", reply("running"));
    adb.setCommandResponse("--es op stop", reply("stopped"));
    const capture = new AdbGuestAudioCapture(
      () => adb,
      discovery,
      new CountingIdGenerator("capture"),
      { timer },
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
