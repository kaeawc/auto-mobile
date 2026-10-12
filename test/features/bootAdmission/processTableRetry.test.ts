import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CommandAndroidCapacitySource } from "../../../src/features/bootAdmission/AndroidCapacitySource";
import {
  AndroidBootAdmissionGate,
  ANDROID_MAX_BOOTED_ENV,
} from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { DEFAULT_SAMPLE_TIMEOUT_MS } from "../../../src/features/bootAdmission/BootAdmissionGate";
import { ADMISSION_LOCK_MAX_AGE_MS } from "../../../src/features/bootAdmission/FileHostBootAdmissionRegistry";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { wrapCommandError } from "../../../src/utils/CommandError";
import type {
  HostCommandExecutor,
  HostCommandOptions,
} from "../../../src/utils/HostCommandExecutor";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeHostBootAdmissionRegistry,
  SharedBootAdmissionHostState,
} from "../../fakes/FakeHostBootAdmissionRegistry";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";

const PS = readFileSync(
  new URL(
    "../../fixtures/android-boot-admission/ps-snapshot-one-running-emulator.txt",
    import.meta.url,
  ),
  "utf8",
);
const QEMU = PS.split("\n").find((row) => row.includes("qemu-system-"))!;
const SIX_PS = Array.from({ length: 6 }, (_, index) =>
  QEMU.replace("67978", String(67978 + index)).replace("-port 5554", `-port ${5554 + index * 2}`),
).join("\n");
const HOST = { totalMemoryBytes: () => 64 * 1024 ** 3, cpuCount: () => 16 };
const SERIALS = Array.from({ length: 5 }, (_, index) => `emulator-${5554 + index * 2}`);
type Step = "timeout" | string | Error;

class ScriptedPs implements HostCommandExecutor {
  readonly calls: HostCommandOptions[] = [];
  constructor(
    readonly timer: FakeTimer,
    public steps: Step[],
  ) {}

  async executeCommand(command: string, args: string[] = [], options: HostCommandOptions = {}) {
    expect(command).toBe("ps");
    this.calls.push(options);
    const step = this.steps[Math.min(this.calls.length - 1, this.steps.length - 1)];
    if (step === "timeout") {
      await this.timer.sleep(options.timeoutMs!);
      throw wrapCommandError(
        Object.assign(new Error("Command failed: ps ..."), {
          killed: true,
          signal: "SIGTERM",
          code: null,
        }),
        { command: "ps", args },
      );
    }
    if (step instanceof Error) {
      throw wrapCommandError(step, { command: "ps", args });
    }
    const stdout = step ?? PS;
    return {
      stdout,
      stderr: "",
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (value: string) => stdout.includes(value),
    };
  }
}

function harness(steps: Step[], list = async () => SERIALS, autoAdvance = true) {
  const timer = new FakeTimer();
  if (autoAdvance) {
    timer.enableAutoAdvance();
  }
  const executor = new ScriptedPs(timer, steps);
  const source = new CommandAndroidCapacitySource(list, executor, HOST, { timer });
  const gate = new AndroidBootAdmissionGate(source, timer, {
    env: { [ANDROID_MAX_BOOTED_ENV]: "6" },
  });
  return { timer, executor, source, gate };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function execError(fields: object, message = "ps failed"): Error {
  return Object.assign(new Error(message), fields);
}

describe("process table retries within Android admission (#11941)", () => {
  test("7-of-6: retries a timeout and refuses the unlisted sixth emulator", async () => {
    const { gate, executor, timer } = harness(["timeout", SIX_PS]);
    const error = await caught(gate.admit({ avdName: "seventh", timeoutMs: 60_000 }));
    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
    expect((error as BootCapacityExhaustedError).details).toMatchObject({
      code: "capacity_exhausted",
      booted: 6,
      limit: 6,
    });
    expect(executor.calls).toHaveLength(2);
    expect(timer.getSleepHistory()).toEqual([5_000, 100]);
  });

  test("persistent timeout admits on adb and records two warnings and report diagnostics", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { gate, executor, timer } = harness(["timeout"]);
      const admission = await gate.admit({ avdName: "sixth", timeoutMs: 60_000 });
      expect(timer.now()).toBeLessThan(DEFAULT_SAMPLE_TIMEOUT_MS);
      expect(executor.calls).toHaveLength(3);
      expect(executor.calls.map((call) => call.timeoutMs)).toEqual([5_000, 5_000, 4_200]);
      const messages = warn.mock.calls.map(([message]) => message);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain("timeout");
      expect(messages[0]).toContain("3");
      expect(messages[1]).toContain("sixth");
      admission.release();
      expect((await gate.describeCapacity()).processTable).toMatchObject({
        unavailable: true,
        reason: "timeout",
        attempts: 3,
        admissionsWithoutProcessTable: 1,
        lastAdmissionWithoutProcessTableAtMs: 14_500,
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("persistent timeout holds the host lock below both sample and stale-lock bounds", async () => {
    const { source, timer, executor } = harness(["timeout"]);
    const registry = new FakeHostBootAdmissionRegistry(
      new SharedBootAdmissionHostState(),
      42,
      timer,
    );
    const original = registry.withAdmissionLock.bind(registry);
    let heldMs = 0;
    registry.withAdmissionLock = (options, fn) =>
      original(options, async () => {
        const start = timer.now();
        try {
          return await fn();
        } finally {
          heldMs = timer.now() - start;
        }
      });
    const gate = new AndroidBootAdmissionGate(source, timer, {
      hostRegistry: registry,
      env: { [ANDROID_MAX_BOOTED_ENV]: "6" },
    });
    const admission = await gate.admit({ avdName: "sixth", timeoutMs: 60_000 });
    expect(executor.calls).toHaveLength(3);
    expect(heldMs).toBe(14_500);
    expect(heldMs).toBeLessThan(DEFAULT_SAMPLE_TIMEOUT_MS);
    expect(heldMs).toBeLessThan(ADMISSION_LOCK_MAX_AGE_MS);
    admission.release();
  });

  test("ENOENT is not retried and the adb count still admits", async () => {
    const { source, gate, executor, timer } = harness([execError({ code: "ENOENT" })]);
    const sample = await source.sample();
    expect(sample.processTableFailure).toMatchObject({
      reason: "not-found",
      transient: false,
      attempts: 1,
    });
    expect(sample.errors[0]).toStartWith("ps: ");
    expect(executor.calls).toHaveLength(1);
    expect(timer.getSleepHistory()).toEqual([]);
    (await gate.admit({ avdName: "sixth", timeoutMs: 60_000 })).release();
  });

  test.each(["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"])(
    "%s retries then returns the table",
    async (code) => {
      const { source, executor, timer } = harness([execError({ code }), PS]);
      const sample = await source.sample();
      expect(sample.emulatorProcessRssBytes).toHaveLength(1);
      expect(sample.processTableFailure).toBeUndefined();
      expect(executor.calls).toHaveLength(2);
      expect(timer.getSleepHistory()).toEqual([100]);
    },
  );

  test.each([
    [{ code: 1, signal: null, stderr: "" }, true, "exit"],
    [{ code: 1, stderr: "ps: illegal option -- x\nusage: ps ..." }, false, "unsupported-flags"],
    [{ code: 1, stderr: "ps: INVALID OPTION" }, false, "unsupported-flags"],
    [{ code: 1, stderr: "ps: unrecognized option" }, false, "unsupported-flags"],
    [{ code: 1, stderr: "ps: Operation not permitted" }, false, "denied"],
    [{ code: 1, stderr: "Permission denied" }, false, "denied"],
    [{ code: 126 }, false, "denied"],
    [{ code: 127 }, false, "not-found"],
    [{ code: "EACCES" }, false, "denied"],
    [{ code: "EPERM" }, false, "denied"],
    [{ code: "ENOTDIR" }, false, "not-found"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, false, "output-too-large"],
    [{ killed: false, signal: "SIGKILL", code: null }, true, "killed"],
    [{ code: 0 }, false, "unknown"],
    [{ code: "toString" }, false, "unknown"],
    [{}, false, "unknown"],
  ] as const)("classifies exec failure %j", async (fields, retry, reason) => {
    const { source, executor, timer } = harness([execError(fields), PS]);
    const sample = await source.sample();
    expect(executor.calls).toHaveLength(retry ? 2 : 1);
    expect(timer.getSleepHistory()).toEqual(retry ? [100] : []);
    if (retry) {
      expect(sample.processTableFailure).toBeUndefined();
    } else {
      expect(sample.processTableFailure).toMatchObject({ reason, transient: false, attempts: 1 });
    }
  });

  test("unparseable output is deterministic", async () => {
    const { source, executor, timer } = harness(["garbage"]);
    expect((await source.sample()).processTableFailure).toMatchObject({
      reason: "unparseable",
      attempts: 1,
    });
    expect(executor.calls).toHaveLength(1);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("warns once per deterministic reason, then debug; detail stays one line and bounded", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const debug = spyOn(logger, "debug").mockImplementation(() => undefined);
    try {
      const { source } = harness([execError({ code: "ENOENT" }, "x".repeat(300) + "\nsecond")]);
      const first = await source.sample();
      await source.sample();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(first.processTableFailure?.detail.length).toBeLessThanOrEqual(200);
      expect(first.processTableFailure?.detail).not.toContain("\n");
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });

  test("abort mid-backoff rejects with the reason and never issues a second ps", async () => {
    const { source, executor, timer } = harness(
      [execError({ code: "EAGAIN" }), PS],
      undefined,
      false,
    );
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    const result = caught(source.sample({ signal: controller.signal }));
    await drainUntilQuiescent(timer);
    expect(timer.getPendingSleeps()).toEqual([100]);
    controller.abort(reason);
    expect(await result).toBe(reason);
    timer.advanceTime(100);
    await drainUntilQuiescent(timer);
    expect(executor.calls).toHaveLength(1);
  });

  test("abort through the gate leaves no admission, even when backoff later wakes", async () => {
    const { gate, executor, timer } = harness(
      [execError({ code: "EAGAIN" }), PS],
      undefined,
      false,
    );
    const controller = new AbortController();
    const reason = new Error("cancelled boot");
    const result = caught(
      gate.admit({ avdName: "sixth", timeoutMs: 60_000, signal: controller.signal }),
    );
    await drainUntilQuiescent(timer);
    expect(timer.getPendingSleeps()).toEqual([100]);
    controller.abort(reason);
    expect(await result).toBe(reason);
    timer.advanceTime(100);
    await drainUntilQuiescent(timer);
    expect(executor.calls).toHaveLength(1);
    executor.steps = [PS];
    expect((await gate.describeCapacity()).inFlight).toBe(0);
  });

  test("an AbortError from the executor is rethrown without retry or fallback", async () => {
    const { source, executor, timer } = harness([new DOMException("aborted", "AbortError")]);
    const error = await caught(source.sample());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(executor.calls).toHaveLength(1);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("failed adb plus exhausted ps still refuses discovery_incomplete", async () => {
    const { gate } = harness(["timeout"], async () => {
      throw new Error("adb failed");
    });
    expect(await caught(gate.admit({ avdName: "sixth", timeoutMs: 60_000 }))).toMatchObject({
      code: "discovery_incomplete",
    });
  });

  test("Windows skips ps and still refuses at the adb limit", async () => {
    const timer = new FakeTimer();
    const executor = new ScriptedPs(timer, [PS]);
    const source = new CommandAndroidCapacitySource(async () => SERIALS, executor, HOST, {
      timer,
      processTableSupported: false,
    });
    const sample = await source.sample();
    expect(sample.processTableFailure).toMatchObject({
      reason: "unsupported-platform",
      transient: false,
      attempts: 0,
    });
    expect(sample.emulatorProcessIds).toBeUndefined();
    expect(sample.emulatorProcessRssBytes).toBeUndefined();
    const gate = new AndroidBootAdmissionGate(source, timer, {
      env: { [ANDROID_MAX_BOOTED_ENV]: "5" },
    });
    expect(await caught(gate.admit({ avdName: "sixth", timeoutMs: 60_000 }))).toBeInstanceOf(
      BootCapacityExhaustedError,
    );
    expect(executor.calls).toHaveLength(0);
  });

  test("Windows fallback admissions are counted and logged at DEBUG", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const debug = spyOn(logger, "debug").mockImplementation(() => undefined);
    try {
      const timer = new FakeTimer();
      const executor = new ScriptedPs(timer, [PS]);
      const source = new CommandAndroidCapacitySource(async () => SERIALS, executor, HOST, {
        timer,
        processTableSupported: false,
      });
      const gate = new AndroidBootAdmissionGate(source, timer, {
        env: { [ANDROID_MAX_BOOTED_ENV]: "6" },
      });
      (await gate.admit({ avdName: "sixth", timeoutMs: 60_000 })).release();
      expect(warn).not.toHaveBeenCalled();
      expect(debug.mock.calls.some(([message]) => message.includes("Admitted AVD 'sixth'"))).toBe(
        true,
      );
      expect((await gate.describeCapacity()).processTable).toMatchObject({
        reason: "unsupported-platform",
        attempts: 0,
        admissionsWithoutProcessTable: 1,
      });
      expect(executor.calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });

  test("successful reports retain fallback admission history with unavailable false", async () => {
    const { gate, executor } = harness([execError({ code: "ENOENT" })]);
    (await gate.admit({ avdName: "sixth", timeoutMs: 60_000 })).release();
    executor.steps = [PS];
    expect((await gate.describeCapacity()).processTable).toMatchObject({
      unavailable: false,
      reason: "not-found",
      attempts: 1,
      admissionsWithoutProcessTable: 1,
    });
  });

  test("standalone sampling stops at its default 9000ms budget", async () => {
    const { source, executor, timer } = harness(["timeout"]);
    const sample = await source.sample();
    expect(sample.processTableFailure).toMatchObject({
      reason: "timeout",
      transient: true,
      attempts: 2,
    });
    expect(timer.now()).toBe(9_000);
    expect(executor.calls.map((call) => call.timeoutMs)).toEqual([5_000, 3_900]);
  });

  test("immediate transient failures stop at four attempts with exponential backoff", async () => {
    const { source, executor, timer } = harness([execError({ code: "EAGAIN" })]);
    expect((await source.sample()).processTableFailure).toMatchObject({
      reason: "spawn-resources",
      transient: true,
      attempts: 4,
    });
    expect(executor.calls).toHaveLength(4);
    expect(timer.getSleepHistory()).toEqual([100, 200, 400]);
  });

  test("logs recovery attempt and reason, including through an extra cause wrapper", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => undefined);
    try {
      const { source } = harness([
        new Error("outer", { cause: execError({ code: "ENOMEM" }) }),
        PS,
      ]);
      expect((await source.sample()).processTableFailure).toBeUndefined();
      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0][0]).toContain("attempt 2");
      expect(info.mock.calls[0][0]).toContain("spawn-resources");
    } finally {
      info.mockRestore();
    }
  });

  test("admission retries share the sample budget after a slow adb listing", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const executor = new ScriptedPs(timer, ["timeout"]);
    const source = new CommandAndroidCapacitySource(
      async () => {
        await timer.sleep(5_000);
        return SERIALS;
      },
      executor,
      HOST,
      { timer },
    );
    const gate = new AndroidBootAdmissionGate(source, timer, {
      env: { [ANDROID_MAX_BOOTED_ENV]: "6" },
    });
    (await gate.admit({ avdName: "sixth", timeoutMs: 60_000 })).release();
    expect(timer.now()).toBe(14_500);
    expect(executor.calls.map((call) => call.timeoutMs)).toEqual([5_000, 4_400]);
  });

  test("healthy report uses one ps, no sleeps, and no processTable diagnostic", async () => {
    const { gate, executor, timer } = harness([PS]);
    expect(await gate.describeCapacity()).toEqual({ limit: 6, booted: 5, inFlight: 0 });
    expect(executor.calls).toHaveLength(1);
    expect(timer.getSleepHistory()).toEqual([]);
  });
});
