import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parsePsSnapshot } from "../../../src/features/iosSimFleet/psSnapshot";
import {
  EMULATOR_TERM_GRACE_MS,
  ProcessTableEmulatorProcessStopper,
} from "../../../src/utils/android-cmdline-tools/EmulatorProcessStop";
import {
  FakeEmulatorProcessSignaler,
  FakeEmulatorProcessTableSource,
} from "../../fakes/FakeEmulatorProcessStopper";
import { FakeTimer } from "../../fakes/FakeTimer";

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
  expect((await f.stopper.describeSerial(target.serial, f.options)).map(({ pid }) => pid)).toEqual([
    75134,
  ]);
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
  expect(await f.stopper.stop(target, { deadlineMs: 100 })).toMatchObject({
    kind: "unidentified",
    identity: { kind: "unreadable" },
  });
  expect(f.timer.now()).toBe(100);
  expect(f.table.calls.at(-1)?.signal?.aborted).toBe(true);
  expect(f.signaler.signals).toEqual([]);
});

test("TERM followed by exit is stopped without another read", async () => {
  const f = fixture();
  expect(await f.stopper.stop(target, f.options)).toEqual({
    kind: "stopped",
    pid: 75134,
    signal: "SIGTERM",
  });
  expect(f.signaler.signals).toEqual([{ pid: 75134, signal: "SIGTERM" }]);
  expect(f.table.calls).toHaveLength(1);
  expect(f.timer.getSleepHistory()).toEqual([]);
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
  expect(await f.stopper.stop(target, { deadlineMs: 1000 })).toMatchObject({
    kind: "still-running",
    pid: 75134,
  });
  expect(f.signaler.signals).toEqual([{ pid: 75134, signal: "SIGTERM" }]);
  expect(f.table.calls).toHaveLength(1);
  expect(f.timer.getSleepHistory().reduce((a, b) => a + b, 0)).toBe(1000);
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
  expect(await f.stopper.stop(target, { deadlineMs: 5500 })).toMatchObject({
    kind: "still-running",
    pid: 75134,
    command: rows[0].command,
  });
  expect(f.timer.now()).toBe(5500);
  expect(f.timer.getSleepHistory().reduce((a, b) => a + b, 0)).toBe(5500);
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
