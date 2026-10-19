import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CommandAndroidCapacitySource } from "../../../src/features/bootAdmission/AndroidCapacitySource";
import {
  AndroidBootAdmissionGate,
  ANDROID_MAX_BOOTED_ENV,
} from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { DEFAULT_SAMPLE_TIMEOUT_MS } from "../../../src/features/bootAdmission/BootAdmissionGate";
import { ADMISSION_LOCK_MAX_AGE_MS } from "../../../src/features/bootAdmission/FileHostBootAdmissionRegistry";
import { describeBootCapacity } from "../../../src/features/bootAdmission/sharedBootAdmissionGates";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../../../src/models/BootedDeviceDiscoveryIncompleteError";
import { wrapCommandError } from "../../../src/utils/CommandError";
import type {
  HostCommandExecutor,
  HostCommandOptions,
} from "../../../src/utils/HostCommandExecutor";
import { logger } from "../../../src/utils/logger";
import { raceWithDeadline } from "../../../src/utils/raceWithDeadline";
import { FakeProcFs } from "../../fakes/FakeProcFs";
import { parsePsSnapshot } from "../../../src/devices/bootAdmission/psSnapshot";
import { ProcessTableReader } from "../../../src/devices/bootAdmission/processTableRetry";
import type { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeHostBootAdmissionRegistry,
  SharedBootAdmissionHostState,
} from "../../fakes/FakeHostBootAdmissionRegistry";
import { drainUntilQuiescent, settleByFakeEvents } from "../../helpers/fakeTimerStepping";

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
      await raceWithDeadline(() => this.timer.sleep(options.timeoutMs!), {
        timer: this.timer,
        signal: options.signal,
        label: "Scripted ps",
      });
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
  test.each([751, 1_000, 1_250])(
    "late backoff waking at %ims preserves the exhausted transient failure",
    async (wakeMs) => {
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const { source, executor, timer } = harness(
          [execError({ code: "EAGAIN" }), PS],
          undefined,
          false,
        );
        const result = source.sample({ deadlineMs: 1_000 });
        await drainUntilQuiescent(timer);
        expect(timer.getPendingSleeps()).toEqual([100]);
        timer.advanceTime(wakeMs);
        const sample = await result;
        expect(executor.calls.map((call) => call.timeoutMs)).toEqual([5_000]);
        expect(executor.calls).toHaveLength(1);
        expect(executor.calls.every((call) => call.timeoutMs! >= 250)).toBe(true);
        expect(sample.processTableFailure).toEqual({
          reason: "spawn-resources",
          transient: true,
          attempts: 1,
          detail: "EAGAIN: ps failed",
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain("spawn-resources, attempts=1: EAGAIN: ps failed");
      } finally {
        warn.mockRestore();
      }
    },
  );

  test.each([300, 1_000, 3_000])(
    "hung ps refuses discovery at a short %ims request timeout",
    async (timeoutMs) => {
      const { gate, executor, timer } = harness(["timeout"], undefined, false);
      const error = await settleByFakeEvents(
        timer,
        caught(gate.admit({ avdName: "sixth", timeoutMs })),
        { description: "short admission deadline" },
      );
      expect(error).toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
      expect(error).toMatchObject({ code: "discovery_incomplete", retryable: true });
      expect(timer.now()).toBe(timeoutMs);
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0].timeoutMs).toBe(5_000);
      await timer.advanceTimeAsync(20_000, () => drainUntilQuiescent(timer));
      expect(executor.calls).toHaveLength(1);
    },
  );

  test("abandoned capacity report aborts its ps and never retries", async () => {
    const { gate, executor, timer } = harness(["timeout"], undefined, false);
    const result = describeBootCapacity(["android"], { android: gate }, timer);
    await drainUntilQuiescent(timer);
    timer.advanceTime(3_000);
    expect(await result).toBeUndefined();
    expect(timer.now()).toBe(3_000);
    await timer.advanceTimeAsync(20_000, () => drainUntilQuiescent(timer));
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(executor.calls[0].signal?.aborted).toBe(true);
  });

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
      expect(timer.now()).toBe(14_500);
      expect(timer.now()).toBeLessThan(DEFAULT_SAMPLE_TIMEOUT_MS);
      expect(executor.calls).toHaveLength(3);
      expect(executor.calls.map((call) => call.timeoutMs)).toEqual([5_000, 5_000, 4_200]);
      const messages = warn.mock.calls.map(([message]) => message);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain("timeout");
      expect(messages[0]).toContain("3");
      expect(messages[0]).toContain("timed out after 4200ms");
      expect(messages[1]).toContain("sixth");
      admission.release();
      expect((await gate.describeCapacity()).processTable).toMatchObject({
        unavailable: true,
        reason: "timeout",
        attempts: 3,
        detail: "timed out after 4200ms",
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

  test("timeout detail uses the full first attempt timeout through the command wrapper", async () => {
    const { source, executor, timer } = harness(["timeout"], undefined, false);
    const sample = await settleByFakeEvents(timer, source.sample({ deadlineMs: 5_000 }), {
      description: "single timed-out ps",
    });
    expect(executor.calls[0].timeoutMs).toBe(5_000);
    expect(sample.processTableFailure?.detail).toBe("timed out after 5000ms");
    expect(sample.errors[0]).toStartWith("ps: Command failed: ps");
  });

  test.each([
    [
      { code: 1, stderr: "\n\r\nps: Operation not permitted\nsecond" },
      "denied",
      "exit 1: ps: Operation not permitted",
    ],
    [{ code: 1, stderr: "" }, "exit", "exit 1"],
    [
      { code: 1, stderr: Buffer.from("\nps: illegal option -- x\nusage: ps") },
      "unsupported-flags",
      "exit 1: ps: illegal option -- x",
    ],
    [{ code: 126 }, "denied", "exit 126"],
    [{ code: 127 }, "not-found", "exit 127"],
    [{ code: "ENOENT" }, "not-found", "ENOENT: ps failed"],
    [{ code: "EACCES" }, "denied", "EACCES: ps failed"],
    [{ code: "ENOMEM" }, "spawn-resources", "ENOMEM: ps failed"],
    [
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
      "output-too-large",
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER: ps failed",
    ],
    [{ killed: false, signal: "SIGKILL", code: null }, "killed", "killed by SIGKILL"],
  ] as const)("detail uses the raw exec cause for %j", async (fields, reason, detail) => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const raw = execError(fields, "ps failed\nsecond message line");
      const { source } = harness([new Error("outer wrapper", { cause: raw })]);
      const sample = await source.sample({ deadlineMs: 0 });
      expect(sample.processTableFailure).toMatchObject({ reason, detail, attempts: 1 });
      expect(sample.processTableFailure?.detail).not.toStartWith("Command failed: ps");
      expect(warn.mock.calls[0][0]).toContain(detail);
      expect(sample.errors[0]).toBe(
        `ps: ${wrapCommandError(new Error("outer wrapper", { cause: raw }), { command: "ps", args: ["-axo", "pid=,ppid=,rss=,pcpu=,command="] }).message}`,
      );
    } finally {
      warn.mockRestore();
    }
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
      expect(first.processTableFailure?.detail).toBe(`ENOENT: ${"x".repeat(192)}`);
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
    expect(await describeBootCapacity(["android"], { android: gate }, timer)).toEqual({
      android: { limit: 6, booted: 5, inFlight: 0 },
    });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(executor.calls[0].signal?.aborted).toBe(false);
    expect(timer.getSleepHistory()).toEqual([]);
  });
});

const PROC_STATUS = readFileSync(
  new URL(
    "../../fixtures/android-boot-admission/proc-status-upstream-man-proc_pid_status.txt",
    import.meta.url,
  ),
  "utf8",
);
// Source, not a capture: musl getopt.c and BusyBox procps/ps.c:
// https://git.musl-libc.org/cgit/musl/tree/src/misc/getopt.c
// https://git.busybox.net/busybox/tree/procps/ps.c
const BUSYBOX_ERROR = execError({ code: 1, stderr: "ps: unrecognized option: x" });

function sixProc(): FakeProcFs {
  const fs = new FakeProcFs();
  const qemu = parsePsSnapshot(PS).rows.find((row) => row.command.includes("qemu-system-"))!;
  fs.entries = Array.from({ length: 6 }, (_, i) => String(qemu.pid + i));
  for (const pid of fs.entries) {
    // Structured edits of the upstream status; argv from the captured qemu row.
    const status = PROC_STATUS.split("\n")
      .map((line) => {
        const key = line.slice(0, line.indexOf(":"));
        if (key === "Pid") {
          return `Pid:\t${pid}`;
        }
        if (key === "PPid") {
          return `PPid:\t${qemu.ppid}`;
        }
        return line;
      })
      .join("\n");
    fs.files.set(`/proc/${pid}/status`, status);
    fs.files.set(`/proc/${pid}/cmdline`, qemu.command.split(" ").join("\0") + "\0");
  }
  return fs;
}

class NeverReportingPs implements HostCommandExecutor {
  readonly calls: HostCommandOptions[] = [];
  async executeCommand(
    _command: string,
    _args: string[] = [],
    options: HostCommandOptions = {},
  ): Promise<ExecResult> {
    this.calls.push(options);
    return new Promise(() => {}); // Models exec whose kill/callback never arrives, even after abort.
  }
}

test("proc fallback counts six emulators, refuses the sixth slot and latches without another ps", async () => {
  const info = spyOn(logger, "info").mockImplementation(() => undefined);
  try {
    const { timer, executor } = harness([BUSYBOX_ERROR]);
    const source = new CommandAndroidCapacitySource(async () => SERIALS, executor, HOST, {
      timer,
      procFs: sixProc(),
    });
    const sample = await source.sample();
    expect(sample.emulatorProcessIds).toHaveLength(6);
    expect(sample.emulatorProcessRssBytes).toEqual(Array(6).fill(13484 * 1024));
    expect(sample.processTableFailure).toBeUndefined();
    expect(sample.errors).toEqual([]);
    const gate = new AndroidBootAdmissionGate(source, timer, {
      env: { [ANDROID_MAX_BOOTED_ENV]: "6" },
    });
    expect(await caught(gate.admit({ avdName: "sixth", timeoutMs: 60_000 }))).toMatchObject({
      details: { code: "capacity_exhausted", booted: 6 },
    });
    expect(executor.calls).toHaveLength(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain("unsupported-flags");
    expect(info.mock.calls[0][0]).toContain("ps: unrecognized option: x");
    expect(info.mock.calls[0][0]).toContain("/proc");
  } finally {
    info.mockRestore();
  }
});

test.each(["EACCES", "EPERM", "empty"])(
  "proc fallback failure %s stays adb-only, warns once and does not latch",
  async (code) => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { timer, executor } = harness([BUSYBOX_ERROR]);
      const fs = new FakeProcFs();
      if (code !== "empty") {
        fs.listError = execError({ code }, "denied");
      }
      const source = new CommandAndroidCapacitySource(async () => SERIALS, executor, HOST, {
        timer,
        procFs: fs,
      });
      const sample = await source.sample();
      expect(sample.processTableFailure).toMatchObject({
        reason: code === "empty" ? "unparseable" : "denied",
        attempts: 1,
      });
      expect(sample.processTableFailure?.detail).toStartWith("/proc: ");
      expect(sample.processTableFailure?.detail).toContain("unsupported-flags");
      expect(sample.processTableFailure!.detail.length).toBeLessThanOrEqual(200);
      await source.sample();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(executor.calls).toHaveLength(2);
      const gate = new AndroidBootAdmissionGate(source, timer, {
        env: { [ANDROID_MAX_BOOTED_ENV]: "6" },
      });
      (await gate.admit({ avdName: "sixth", timeoutMs: 60_000 })).release();
    } finally {
      warn.mockRestore();
    }
  },
);

test("reader timer ends never-reporting ps attempts before the gate race", async () => {
  const timer = new FakeTimer();
  const executor = new NeverReportingPs();
  const source = new CommandAndroidCapacitySource(async () => SERIALS, executor, HOST, { timer });
  const gate = new AndroidBootAdmissionGate(source, timer, {
    env: { [ANDROID_MAX_BOOTED_ENV]: "6" },
  });
  const result = await settleByFakeEvents(
    timer,
    gate.admit({ avdName: "sixth", timeoutMs: 60_000 }).then(
      (admission) => admission,
      (error: unknown) => error,
    ),
    { description: "timer-decided ps deadline" },
  );
  expect(result).toMatchObject({ release: expect.any(Function) });
  expect(executor.calls.map((call) => call.timeoutMs)).toEqual([5_000, 5_000, 4_200]);
  expect(executor.calls.every((call) => call.signal?.aborted)).toBe(true);
  const report = await settleByFakeEvents(timer, gate.describeCapacity(), {
    description: "timer-decided report",
  });
  expect(report.processTable).toMatchObject({
    reason: "timeout",
    admissionsWithoutProcessTable: 1,
  });
});

test("proc fallback uses the reader deadline and preserves caller abort", async () => {
  const { timer, executor } = harness([BUSYBOX_ERROR], undefined, false);
  const fs = sixProc();
  fs.onRead = () => new Promise(() => {});
  const reader = new ProcessTableReader(executor, { timer, procFs: fs, attemptTimeoutMs: 1_000 });
  const result = await settleByFakeEvents(timer, reader.read({}), { description: "proc deadline" });
  expect(result.failure).toMatchObject({
    reason: "timeout",
    detail: expect.stringContaining("/proc: timed out after 1000ms"),
  });
  const controller = new AbortController();
  const reason = new Error("caller cancelled proc");
  const pending = caught(reader.read({ signal: controller.signal }));
  await drainUntilQuiescent(timer);
  controller.abort(reason);
  expect(await pending).toBe(reason);
});

test("unknown exit latches after three exhausted samples and success resets retries", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  const debug = spyOn(logger, "debug").mockImplementation(() => undefined);
  try {
    const { timer, executor } = harness([execError({ code: 2, stderr: "ps: something odd" })]);
    const reader = new ProcessTableReader(executor, { timer });
    for (let sample = 1; sample <= 3; sample++) {
      expect((await reader.read({})).failure).toMatchObject({
        reason: "exit",
        transient: true,
        attempts: 4,
      });
      expect(executor.calls).toHaveLength(sample * 4);
    }
    expect((await reader.read({})).failure).toMatchObject({
      reason: "exit",
      transient: false,
      attempts: 1,
    });
    expect(executor.calls).toHaveLength(13);
    expect(warn.mock.calls.filter(([message]) => message.includes("retries stop"))).toHaveLength(1);
    expect(debug.mock.calls.some(([message]) => message.includes("exit"))).toBe(true);
    executor.steps = [PS];
    expect((await reader.read({})).failure).toBeUndefined();
    executor.steps = [execError({ code: 2, stderr: "ps: something odd" })];
    expect((await reader.read({})).failure).toMatchObject({
      reason: "exit",
      transient: true,
      attempts: 4,
    });
    for (let i = 0; i < 2; i++) {
      await reader.read({});
    }
    expect(warn.mock.calls.filter(([message]) => message.includes("retries stop"))).toHaveLength(2);
  } finally {
    warn.mockRestore();
    debug.mockRestore();
  }
});

test("a different final reason resets consecutive exit samples", async () => {
  const { timer, executor } = harness([execError({ code: 2, stderr: "ps: something odd" })]);
  const reader = new ProcessTableReader(executor, { timer });
  await reader.read({});
  await reader.read({});
  executor.steps = [execError({ code: "ENOENT" })];
  expect((await reader.read({})).failure?.reason).toBe("not-found");
  executor.steps = [execError({ code: 2, stderr: "ps: something odd" })];
  for (let i = 0; i < 3; i++) {
    expect((await reader.read({})).failure?.attempts).toBe(4);
  }
  expect((await reader.read({})).failure).toMatchObject({ attempts: 1, transient: false });
});

test("deterministic exit latch enables proc fallback on the next sample", async () => {
  const { timer, executor } = harness([execError({ code: 2, stderr: "ps: something odd" })]);
  const reader = new ProcessTableReader(executor, { timer, procFs: sixProc() });
  for (let i = 0; i < 3; i++) {
    expect((await reader.read({})).failure?.attempts).toBe(4);
  }
  expect((await reader.read({})).value).toHaveLength(6);
  expect(executor.calls).toHaveLength(13);
  expect((await reader.read({})).value).toHaveLength(6);
  expect(executor.calls).toHaveLength(13);
});

test("exit latch threshold is configurable", async () => {
  const { timer, executor } = harness([execError({ code: 2, stderr: "ps: something odd" })]);
  const reader = new ProcessTableReader(executor, { timer, exitDeterministicAfterSamples: 1 });
  expect((await reader.read({})).failure).toMatchObject({
    reason: "exit",
    attempts: 4,
    transient: true,
  });
  expect((await reader.read({})).failure).toMatchObject({
    reason: "exit",
    attempts: 1,
    transient: false,
  });
});

test("long proc failure retains the ps reason within its one-line detail bound", async () => {
  const { timer, executor } = harness([BUSYBOX_ERROR]);
  const fs = new FakeProcFs();
  fs.listError = execError({ code: "EACCES" }, "x".repeat(300) + "\nsecond line");
  const reader = new ProcessTableReader(executor, { timer, procFs: fs });
  const result = await reader.read({});
  expect(result.failure?.detail).toStartWith("/proc: ");
  expect(result.failure?.detail).toContain("ps unsupported-flags");
  expect(result.failure!.detail.length).toBeLessThanOrEqual(200);
  expect(result.failure?.detail).not.toContain("\n");
});

test("caller abort between exhausted exit samples breaks their consecutive sequence", async () => {
  const { timer, executor } = harness([execError({ code: 2, stderr: "ps: something odd" })]);
  const reader = new ProcessTableReader(executor, { timer });
  await reader.read({});
  await reader.read({});
  const controller = new AbortController();
  const reason = new Error("cancel intervening sample");
  controller.abort(reason);
  expect(await caught(reader.read({ signal: controller.signal }))).toBe(reason);
  for (let i = 0; i < 3; i++) {
    expect((await reader.read({})).failure).toMatchObject({
      reason: "exit",
      attempts: 4,
      transient: true,
    });
  }
  expect((await reader.read({})).failure).toMatchObject({
    reason: "exit",
    attempts: 1,
    transient: false,
  });
});

test.each(["EACCES", "EPERM"])(
  "proc fallback retains six emulator pids when pid 1 status rejects %s",
  async (code) => {
    const { timer, executor } = harness([BUSYBOX_ERROR]);
    const fs = sixProc();
    fs.entries.unshift("1");
    fs.onRead = async (path) => {
      if (path === "/proc/1/status") {
        throw { code };
      }
    };
    const source = new CommandAndroidCapacitySource(async () => SERIALS, executor, HOST, {
      timer,
      procFs: fs,
    });
    const sample = await source.sample();
    expect(sample.emulatorProcessIds?.map(({ pid }) => pid)).toEqual(
      fs.entries.slice(1).map(Number),
    );
    expect(sample.processTableFailure).toBeUndefined();
    expect(sample.errors).toEqual([]);
    expect(executor.calls).toHaveLength(1);
  },
);

test.each([
  ["EACCES", "denied"],
  ["EPERM", "denied"],
  ["ENOENT", "unparseable"],
  ["EIO", "unknown"],
])("proc fallback with every pid rejecting %s reports %s", async (code, reason) => {
  const { timer, executor } = harness([BUSYBOX_ERROR]);
  const fs = sixProc();
  for (const pid of fs.entries) {
    fs.files.set(
      `/proc/${pid}/status`,
      execError({ code }, code === "EIO" ? "I/O failure" : "unreadable pid"),
    );
  }
  const reader = new ProcessTableReader(executor, { timer, procFs: fs });
  const result = await reader.read({});
  expect(result.value).toBeUndefined();
  expect(result.failure).toMatchObject({ reason, attempts: 1, transient: false });
  if (code === "EIO") {
    expect(result.failure?.detail).toContain("I/O");
  }
});

test("proc fallback with an exited pid and a denied pid reports denied", async () => {
  const { timer, executor } = harness([BUSYBOX_ERROR]);
  const fs = new FakeProcFs();
  fs.entries = ["1", "2"];
  fs.files.set("/proc/2/status", execError({ code: "EACCES" }, "restricted pid"));
  const reader = new ProcessTableReader(executor, { timer, procFs: fs });
  expect((await reader.read({})).failure?.reason).toBe("denied");
});

test("proc timeout never silences exhausted ps WARNs and repeats at DEBUG", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  const debug = spyOn(logger, "debug").mockImplementation(() => undefined);
  try {
    const { timer, executor } = harness([BUSYBOX_ERROR], undefined, false);
    const fs = sixProc();
    fs.onRead = () => new Promise(() => {});
    const reader = new ProcessTableReader(executor, {
      timer,
      procFs: fs,
      attemptTimeoutMs: 1_000,
    });
    const first = await settleByFakeEvents(timer, reader.read({}), {
      description: "first proc timeout",
    });
    expect(first.failure).toMatchObject({ reason: "timeout", attempts: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("/proc: timed out");
    executor.steps = ["timeout"];
    for (let sample = 0; sample < 2; sample++) {
      const result = await settleByFakeEvents(timer, reader.read({}), {
        description: "exhausted ps timeout",
      });
      expect(result.failure).toMatchObject({ reason: "timeout", attempts: 4, transient: true });
    }
    expect(executor.calls).toHaveLength(9);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(debug).not.toHaveBeenCalled();
    executor.steps = [BUSYBOX_ERROR];
    expect(
      (await settleByFakeEvents(timer, reader.read({}), { description: "repeated proc timeout" }))
        .failure?.reason,
    ).toBe("timeout");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0][0]).toContain("/proc: timed out");
  } finally {
    warn.mockRestore();
    debug.mockRestore();
  }
});

test("ps timeout never silences the first proc timeout WARN", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  const debug = spyOn(logger, "debug").mockImplementation(() => undefined);
  try {
    const { timer, executor } = harness(["timeout"], undefined, false);
    const fs = sixProc();
    fs.onRead = () => new Promise(() => {});
    const reader = new ProcessTableReader(executor, { timer, procFs: fs, attemptTimeoutMs: 1_000 });
    expect(
      (await settleByFakeEvents(timer, reader.read({}), { description: "initial ps timeout" }))
        .failure?.attempts,
    ).toBe(4);
    executor.steps = [BUSYBOX_ERROR];
    expect(
      (
        await settleByFakeEvents(timer, reader.read({}), {
          description: "first proc timeout after ps",
        })
      ).failure?.reason,
    ).toBe("timeout");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain("/proc: timed out");
    expect(debug).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    debug.mockRestore();
  }
});
