import { expect, test, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { parsePsSnapshot } from "../../../src/features/iosSimFleet/psSnapshot";
import {
  EMULATOR_TERM_GRACE_MS,
  EMULATOR_MIN_TERM_GRACE_MS,
  EMULATOR_KILL_WAIT_MS,
  EMULATOR_STOP_RESULT_MARGIN_MS,
  ProcessTableEmulatorProcessStopper,
} from "../../../src/utils/android-cmdline-tools/EmulatorProcessStop";
import {
  FakeEmulatorProcessSignaler,
  FakeEmulatorProcessTableSource,
} from "../../fakes/FakeEmulatorProcessStopper";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";
import { FakeLockOwnerGenerationProbe } from "../../fakes/FakeLockOwnerGenerationProbe";

const rows = parsePsSnapshot(
  readFileSync(
    new URL(
      "../../fixtures/android-boot-admission/ps-snapshot-two-emulators-with-ports.txt",
      import.meta.url,
    ),
    "utf8",
  ),
).rows;
const target = { serial: "emulator-5556", avdName: "amslot-39454b14-0-g1-e20c22a0" };
function fixture() {
  const table = new FakeEmulatorProcessTableSource();
  table.rows = rows;
  const signaler = new FakeEmulatorProcessSignaler();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const stopper = new ProcessTableEmulatorProcessStopper(table, signaler, timer);
  return { table, signaler, timer, stopper, options: { deadlineMs: 30_000 } };
}

test.each([
  "after-term",
  "before-read",
  "before-kill",
  "after-kill",
  "unknown",
  "unavailable",
] as const)("emulator stop generation fence handles %s", async (stage) => {
  const f = fixture();
  const generation = new FakeLockOwnerGenerationProbe();
  f.signaler.exitOn = stage === "unknown" || stage === "unavailable" ? "SIGKILL" : undefined;
  if (stage === "unavailable") {
    generation.token = undefined;
  }
  generation.onCompare = () => {
    if (stage === "unknown") {
      return "unknown";
    }
    if (stage === "after-term") {
      return "different";
    }
    return (stage === "before-kill" && f.table.calls.length === 2) ||
      (stage === "after-kill" && f.signaler.signals.length === 2)
      ? "different"
      : "same";
  };
  // Change identity in the final wait's liveness probe, after its generation check.
  if (stage === "before-read") {
    const running = f.signaler.isRunning.bind(f.signaler);
    f.signaler.isRunning = (pid) => {
      if (f.timer.now() >= EMULATOR_TERM_GRACE_MS) {
        generation.onCompare = () => "different";
      }
      return running(pid);
    };
  }
  const stopper = new ProcessTableEmulatorProcessStopper(f.table, f.signaler, f.timer, {
    processGeneration: generation,
  });
  const killed = ["after-kill", "unknown", "unavailable"].includes(stage);
  expect(await stopper.stop(target, f.options)).toEqual({
    kind: "stopped",
    pid: 75134,
    signal: killed ? "SIGKILL" : "SIGTERM",
  });
  expect(generation.currentCalls).toEqual([75134]);
  expect(f.signaler.signals).toEqual(
    killed
      ? [
          { pid: 75134, signal: "SIGTERM" },
          { pid: 75134, signal: "SIGKILL" },
        ]
      : [{ pid: 75134, signal: "SIGTERM" }],
  );
  expect(f.table.calls).toHaveLength(["after-term", "before-read"].includes(stage) ? 1 : 2);
});

test("captured windowed and headless qemu rows prove identity; adb and helpers are decoys", async () => {
  const f = fixture();
  expect(await f.stopper.identify(target, f.options)).toMatchObject({
    kind: "match",
    pid: 75134,
    port: 5556,
  });
  expect(
    await f.stopper.identify(
      { serial: "emulator-5554", avdName: "amslot-039fd12f-0-g1-5e7e5f80" },
      f.options,
    ),
  ).toMatchObject({ kind: "match", pid: 83205, port: 5554 });
  expect(await f.stopper.describeSerial(target.serial, f.options)).toMatchObject({
    kind: "read",
    candidates: [{ pid: 75134 }],
  });
  expect(f.table.calls).toHaveLength(3);
});

for (const form of ["-ports 5556,5557", "-port=5556", "-ports=5556,5557"]) {
  test(`derived capture supports ${form} and @AVD launcher spelling`, async () => {
    const f = fixture();
    // Derived from the captured qemu row; no synthetic ps output.
    f.table.rows = rows.map((row) => ({
      ...row,
      command: row.command
        .replace("-port 5556", form)
        .replace(`-avd ${target.avdName}`, `@${target.avdName}`),
    }));
    expect(await f.stopper.identify(target, f.options)).toMatchObject({
      kind: "match",
      pid: 75134,
    });
  });
}

test("wrong AVD is mismatch and signals nothing", async () => {
  const f = fixture();
  const wrong = { ...target, avdName: "other" };
  expect(await f.stopper.identify(wrong, f.options)).toMatchObject({
    kind: "mismatch",
    pid: 75134,
    runningAvdName: target.avdName,
  });
  expect(await f.stopper.stop(wrong, f.options)).toMatchObject({ kind: "identity-mismatch" });
  expect(f.signaler.signals).toEqual([]);
});

test("unused port and a derived row without an explicit port are absent", async () => {
  const f = fixture();
  expect(await f.stopper.identify({ ...target, serial: "emulator-5558" }, f.options)).toEqual({
    kind: "absent",
  });
  f.table.rows = rows.map((row) => ({ ...row, command: row.command.replace("-port 5556", "") }));
  expect(await f.stopper.stop(target, f.options)).toEqual({
    kind: "unidentified",
    identity: { kind: "absent" },
  });
  expect(await f.stopper.identify({ ...target, serial: "127.0.0.1:5557" }, f.options)).toEqual({
    kind: "absent",
  });
  expect(f.signaler.signals).toEqual([]);
});

test("derived duplicate port and unnamed port are ambiguous and signal nothing", async () => {
  const f = fixture();
  f.table.rows = rows.map((row) => ({
    ...row,
    command: row.command.replace("-port 5554", "-port 5556"),
  }));
  expect(await f.stopper.identify(target, f.options)).toMatchObject({
    kind: "ambiguous",
    candidates: [{ pid: 75134 }, { pid: 83205 }],
  });
  expect(await f.stopper.stop(target, f.options)).toMatchObject({ kind: "unidentified" });
  f.table.rows = rows.map((row) => ({
    ...row,
    command: row.command.replace(`-avd ${target.avdName}`, ""),
  }));
  expect(await f.stopper.identify(target, f.options)).toMatchObject({ kind: "ambiguous" });
  expect(f.signaler.signals).toEqual([]);
});

test("failed and pending reads are unreadable inside the caller bound", async () => {
  const f = fixture();
  f.table.results = [{ error: "ps unavailable" }];
  expect(await f.stopper.identify(target, f.options)).toEqual({
    kind: "unreadable",
    detail: "ps unavailable",
  });
  f.table.pending = true;
  expect(await f.stopper.stop(target, { deadlineMs: 2100 })).toMatchObject({
    kind: "unidentified",
    identity: { kind: "unreadable" },
  });
  expect(f.timer.now()).toBe(100);
  expect(f.table.calls.at(-1)?.signal?.aborted).toBe(true);
  expect(f.signaler.signals).toEqual([]);
});

test("TERM followed by exit is stopped without another read", async () => {
  const f = fixture();
  const generation = new FakeLockOwnerGenerationProbe();
  const stopper = new ProcessTableEmulatorProcessStopper(f.table, f.signaler, f.timer, {
    processGeneration: generation,
  });
  expect(await stopper.stop(target, f.options)).toEqual({
    kind: "stopped",
    pid: 75134,
    signal: "SIGTERM",
  });
  expect(f.signaler.signals).toEqual([{ pid: 75134, signal: "SIGTERM" }]);
  expect(f.table.calls).toHaveLength(1);
  expect(f.timer.getSleepHistory()).toEqual([]);
  expect(generation.compareCalls).toEqual([]);
});

test("TERM exit is observed through FakeTimer polling", async () => {
  const f = fixture();
  f.signaler.exitOn = undefined;
  f.timer.setTimeout(() => {
    f.signaler.running = false;
  }, 125);
  expect(await f.stopper.stop(target, f.options)).toMatchObject({
    kind: "stopped",
    signal: "SIGTERM",
  });
  expect(f.timer.getSleepHistory()).toEqual([50, 100]);
  expect(f.table.calls).toHaveLength(1);
});

test("deadline shorter than TERM grace leaves no time for re-read or KILL", async () => {
  const f = fixture();
  f.signaler.exitOn = undefined;
  const read = f.table.read.bind(f.table);
  f.table.read = async (options) => {
    const result = await read(options);
    // The identity read consumes all the budget reserved for process waits.
    f.timer.setCurrentTime(1000);
    return result;
  };
  expect(await f.stopper.stop(target, { deadlineMs: 3000 })).toMatchObject({
    kind: "still-running",
    pid: 75134,
  });
  expect(f.signaler.signals).toEqual([{ pid: 75134, signal: "SIGTERM" }]);
  expect(f.table.calls).toHaveLength(1);
  expect(f.timer.getSleepHistory()).toEqual([]);
  expect(f.timer.now()).toBe(1000);
});

test("caller abort during TERM grace propagates without escalating", async () => {
  const f = fixture();
  f.signaler.exitOn = undefined;
  const abort = new AbortController();
  const reason = new Error("caller cancelled during polling");
  f.timer.setTimeout(() => abort.abort(reason), 100);
  await expect(f.stopper.stop(target, { ...f.options, signal: abort.signal })).rejects.toBe(reason);
  expect(f.signaler.signals).toEqual([{ pid: 75134, signal: "SIGTERM" }]);
  expect(f.table.calls).toHaveLength(1);
});

test("ignoring TERM re-reads the same pid and identity before KILL", async () => {
  const f = fixture();
  f.signaler.exitOn = "SIGKILL";
  expect(await f.stopper.stop(target, f.options)).toEqual({
    kind: "stopped",
    pid: 75134,
    signal: "SIGKILL",
  });
  expect(f.table.calls).toHaveLength(2);
  expect(f.signaler.signals).toEqual([
    { pid: 75134, signal: "SIGTERM" },
    { pid: 75134, signal: "SIGKILL" },
  ]);
  expect(f.timer.getSleepHistory().reduce((a, b) => a + b, 0)).toBe(EMULATOR_TERM_GRACE_MS);
});

for (const change of ["reused", "gone", "unreadable"]) {
  test(`no KILL after TERM when the re-read is ${change}`, async () => {
    const f = fixture();
    f.signaler.exitOn = undefined;
    // Derived from capture: original pid's AVD changes, or the row is removed.
    f.table.results = [
      { value: rows },
      change === "unreadable"
        ? { error: "ps failed" }
        : {
            value:
              change === "gone"
                ? rows.filter((row) => row.pid !== 75134)
                : rows.map((row) => ({
                    ...row,
                    command: row.command.replace(target.avdName, "replacement"),
                  })),
          },
    ];
    expect(await f.stopper.stop(target, f.options)).toMatchObject({
      kind: change === "unreadable" ? "still-running" : "stopped",
      pid: 75134,
    });
    expect(f.signaler.signals).toEqual([{ pid: 75134, signal: "SIGTERM" }]);
  });
}

test("survives KILL until a clipped deadline and reports pid and command", async () => {
  const f = fixture();
  f.signaler.exitOn = undefined;
  expect(await f.stopper.stop(target, { deadlineMs: 8500 })).toMatchObject({
    kind: "still-running",
    pid: 75134,
    command: rows[0].command,
  });
  expect(f.timer.now()).toBe(6500);
  expect(f.timer.getSleepHistory().reduce((a, b) => a + b, 0)).toBe(6500);
  expect(f.signaler.signals).toHaveLength(2);
});

test("already spent deadline signals nothing and does not read", async () => {
  const f = fixture();
  expect(await f.stopper.stop(target, { deadlineMs: 0 })).toMatchObject({ kind: "unidentified" });
  expect(f.signaler.signals).toEqual([]);
  expect(f.table.calls).toEqual([]);
});

for (const code of ["ESRCH", "EPERM"]) {
  test(`${code} from signaling is a typed outcome`, async () => {
    const f = fixture();
    f.signaler.errorCode = code;
    expect(await f.stopper.stop(target, f.options)).toMatchObject({
      kind: code === "ESRCH" ? "stopped" : "still-running",
      pid: 75134,
    });
    expect(f.table.calls).toHaveLength(1);
  });
}

test("caller abort propagates unchanged before reading and during a pending read", async () => {
  const f = fixture();
  const abort = new AbortController();
  const reason = new Error("caller stopped");
  f.table.pending = true;
  const pending = f.stopper.stop(target, { ...f.options, signal: abort.signal });
  abort.abort(reason);
  await expect(pending).rejects.toBe(reason);
  await expect(f.stopper.stop(target, { ...f.options, signal: abort.signal })).rejects.toBe(reason);
  expect(f.signaler.signals).toEqual([]);
});

for (const command of [
  "sudo /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel -port 5556",
  "env FOO=1 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel -port 5556",
  "grep /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel -port 5556",
  "tail /tmp/qemu/x/qemu-system-log -avd Pixel -port 5556",
  "/usr/bin/sudo /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel -port 5556",
  "sh -c /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel -port 5556",
  "grep -- /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel -port 5556",
  "tail -f /tmp/qemu/x/qemu-system-log -avd Pixel -port 5556",
  "/sdk/ - odd/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel -port 5556",
]) {
  test(`signalling rejects a wrapper or unparseable executable: ${command}`, async () => {
    const f = fixture();
    // Wrapper and unparseable-path decoys derived from the captured row's pid and port.
    const decoy = { ...rows[0], pid: 90001, command };
    f.table.rows = [decoy];
    expect(await f.stopper.identify(target, f.options)).toEqual({ kind: "absent" });
    expect(await f.stopper.describeSerial(target.serial, f.options)).toEqual({
      kind: "read",
      candidates: [],
    });
    expect(await f.stopper.stop(target, f.options)).toEqual({
      kind: "unidentified",
      identity: { kind: "absent" },
    });
    expect(f.signaler.signals).toEqual([]);
    f.table.rows = [decoy, rows[0]];
    expect(await f.stopper.identify(target, f.options)).toMatchObject({
      kind: "match",
      pid: 75134,
    });
  });
}

for (const pid of [0, 1, 90002, -1, 2.5, Number.NaN]) {
  test(`signalling rejects unsafe candidate pid ${pid}`, async () => {
    const f = fixture();
    f.table.rows = [{ ...rows[0], pid }];
    const stopper = new ProcessTableEmulatorProcessStopper(f.table, f.signaler, f.timer, {
      ownPid: 90002,
    });
    expect(await stopper.identify(target, f.options)).toEqual({ kind: "absent" });
    expect(await stopper.describeSerial(target.serial, f.options)).toEqual({
      kind: "read",
      candidates: [],
    });
    expect(await stopper.stop(target, f.options)).toEqual({
      kind: "unidentified",
      identity: { kind: "absent" },
    });
    expect(f.signaler.signals).toEqual([]);
  });
}

test("TERM has a fifteen-second snapshot grace with a far deadline", async () => {
  const f = fixture();
  f.signaler.exitOn = "SIGKILL";
  expect(await f.stopper.stop(target, { deadlineMs: 60_000 })).toMatchObject({
    kind: "stopped",
    signal: "SIGKILL",
  });
  expect(f.timer.getSleepHistory().reduce((a, b) => a + b, 0)).toBe(15_000);
});

test("a pending escalation read returns the pid before the result margin", async () => {
  const f = fixture();
  f.signaler.exitOn = undefined;
  const read = f.table.read.bind(f.table);
  f.table.read = async (options) => {
    if (f.table.calls.length === 1) {
      f.table.pending = true;
    }
    return read(options);
  };
  expect(await f.stopper.stop(target, f.options)).toMatchObject({
    kind: "still-running",
    pid: 75134,
  });
  expect(f.timer.now()).toBe(28_000);
  expect(f.table.calls.at(-1)?.signal?.aborted).toBe(true);
  expect(f.signaler.signals).toEqual([{ pid: 75134, signal: "SIGTERM" }]);
});

test("default own pid is excluded without signalling", async () => {
  const f = fixture();
  f.table.rows = [{ ...rows[0], pid: process.pid }];
  expect(await f.stopper.stop(target, f.options)).toEqual({
    kind: "unidentified",
    identity: { kind: "absent" },
  });
  expect(f.signaler.signals).toEqual([]);
});

test("an escalation read exhausting the wait budget leaves TERM sent and logs the pid", async () => {
  const f = fixture();
  f.signaler.exitOn = undefined;
  const read = f.table.read.bind(f.table);
  f.table.read = async (options) => {
    const result = await read(options);
    if (f.table.calls.length === 2) {
      f.timer.setCurrentTime(options.deadlineMs!);
    }
    return result;
  };
  const warn = spyOn(logger, "warn");
  try {
    expect(await f.stopper.stop(target, f.options)).toMatchObject({
      kind: "still-running",
      pid: 75134,
    });
    expect(f.signaler.signals).toEqual([{ pid: 75134, signal: "SIGTERM" }]);
    expect(f.timer.now()).toBe(28_000);
    expect(warn).toHaveBeenCalledWith(
      "[EmulatorProcessStop] no budget for SIGKILL wait for pid 75134; SIGTERM was sent",
    );
  } finally {
    warn.mockRestore();
  }
});

test("derived captured SDK path with spaces remains signalable", async () => {
  const f = fixture();
  // Derived from the captured row: only the SDK owner's directory changes.
  f.table.rows = rows.map((row) => ({
    ...row,
    command: row.command.replace("/Users/dev/", "/Users/My Name/"),
  }));
  expect(await f.stopper.identify(target, f.options)).toMatchObject({ kind: "match", pid: 75134 });
  expect(await f.stopper.stop(target, f.options)).toMatchObject({
    kind: "stopped",
    signal: "SIGTERM",
  });
});

for (const deadlineMs of [2500, 3500]) {
  test(`withholds KILL without minimum TERM grace at ${deadlineMs}ms`, async () => {
    const f = fixture();
    f.signaler.exitOn = undefined;
    const warn = spyOn(logger, "warn");
    try {
      expect(await f.stopper.stop(target, { deadlineMs })).toMatchObject({
        kind: "still-running",
        signalled: true,
      });
      expect(f.signaler.signals).toEqual([{ pid: 75134, signal: "SIGTERM" }]);
      expect(f.timer.now()).toBe(Math.max(0, deadlineMs - 3000));
      expect(f.table.calls).toHaveLength(1);
      expect(
        warn.mock.calls.some(([message]) => String(message).includes("SIGKILL withheld")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
}

test("EPERM from TERM reports no delivered signal", async () => {
  const f = fixture();
  f.signaler.errorCode = "EPERM";
  expect(await f.stopper.stop(target, f.options)).toMatchObject({
    kind: "still-running",
    signalled: false,
  });
  expect(f.signaler.signals).toEqual([{ pid: 75134, signal: "SIGTERM" }]);
  expect(f.signaler.deliveredSignals).toEqual([]);
});

test("identity read spending the caller deadline reports no delivered signal", async () => {
  const f = fixture();
  const identify = f.stopper.identify.bind(f.stopper);
  f.stopper.identify = async (target, options) => {
    const identity = await identify(target, options);
    f.timer.setCurrentTime(f.options.deadlineMs);
    return identity;
  };
  expect(await f.stopper.stop(target, f.options)).toMatchObject({
    kind: "still-running",
    signalled: false,
  });
  expect(f.signaler.signals).toEqual([]);
});

test("exact minimum TERM grace plus kill wait and margin permits KILL", async () => {
  const f = fixture();
  f.signaler.exitOn = "SIGKILL";
  const signal = f.signaler.signal.bind(f.signaler);
  const signalTimes: number[] = [];
  f.signaler.signal = (pid, kind) => {
    signalTimes.push(f.timer.now());
    if (kind === "SIGKILL") {
      expect(f.table.calls).toHaveLength(2);
    }
    signal(pid, kind);
  };
  expect(
    await f.stopper.stop(target, {
      deadlineMs:
        EMULATOR_MIN_TERM_GRACE_MS + EMULATOR_KILL_WAIT_MS + EMULATOR_STOP_RESULT_MARGIN_MS,
    }),
  ).toMatchObject({ kind: "stopped", signal: "SIGKILL" });
  expect(signalTimes).toEqual([0, EMULATOR_MIN_TERM_GRACE_MS]);
  expect(f.signaler.signals).toEqual([
    { pid: 75134, signal: "SIGTERM" },
    { pid: 75134, signal: "SIGKILL" },
  ]);
});

test("failed KILL retains the successful TERM dispatch", async () => {
  const f = fixture();
  f.signaler.exitOn = undefined;
  const signal = f.signaler.signal.bind(f.signaler);
  f.signaler.signal = (pid, kind) => {
    if (kind === "SIGKILL") {
      f.signaler.errorCode = "EPERM";
    }
    signal(pid, kind);
  };
  expect(await f.stopper.stop(target, f.options)).toMatchObject({
    kind: "still-running",
    signalled: true,
  });
  expect(f.signaler.signals).toHaveLength(2);
});

test("describeSerial reports an unreadable table instead of an empty read", async () => {
  const f = fixture();
  f.table.results = [{ error: "ps exited 1" }];
  expect(await f.stopper.describeSerial(target.serial, f.options)).toEqual({
    kind: "unreadable",
    detail: "ps exited 1",
  });
});

test("describeSerial reports an unreadable table when the deadline is already spent", async () => {
  const f = fixture();
  const spent = { ...f.options, deadlineMs: f.timer.now() };
  expect(await f.stopper.describeSerial(target.serial, spent)).toMatchObject({
    kind: "unreadable",
  });
});
