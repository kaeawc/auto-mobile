import { describe, expect, test } from "bun:test";
import { checkOrphanedDaemons } from "../../../src/doctor/checks/orphanedDaemons";
import { checkForeignLeaseHolders } from "../../../src/doctor/checks/foreignLeaseHolders";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeDaemonProcessTable,
  namespaceDaemonProcess,
  unmarkedDaemonProcess,
} from "../../fakes/FakeDaemonProcessTable";

const active = { pid: 100, socketPath: "/tmp/auto-mobile-daemon-501.sock" };

function timerAt(now: number): FakeTimer {
  const timer = new FakeTimer();
  timer.setCurrentTime(now);
  return timer;
}

describe("checkOrphanedDaemons", () => {
  test("passes when only the active daemon is running", async () => {
    const table = new FakeDaemonProcessTable(() => [unmarkedDaemonProcess(100)]);
    const result = await checkOrphanedDaemons({
      processFinder: table,
      readActiveDaemon: () => active,
      platform: "darwin",
    });
    expect(result.status).toBe("pass");
  });

  test("warns naming PID, socket and age for a PID 1 daemon that is not the active one", async () => {
    const table = new FakeDaemonProcessTable(() => [
      unmarkedDaemonProcess(100),
      { ...namespaceDaemonProcess(200, "/tmp/private.sock"), startedAt: 40_000 },
    ]);
    const result = await checkOrphanedDaemons({
      processFinder: table,
      readActiveDaemon: () => active,
      timer: timerAt(100_000),
      platform: "darwin",
    });
    expect(result.status).toBe("warn");
    expect(result.value).toBe(1);
    expect(result.detail).toBe("- PID 200, socket /tmp/private.sock, running 60s");
    expect(result.recommendation).toContain("never stops processes");
  });

  test("ignores daemons with a live parent", async () => {
    const table = new FakeDaemonProcessTable(() => [{ ...unmarkedDaemonProcess(300), ppid: 4242 }]);
    const result = await checkOrphanedDaemons({
      processFinder: table,
      readActiveDaemon: () => active,
      platform: "linux",
    });
    expect(result.status).toBe("pass");
  });

  test("treats every PID 1 daemon as orphaned when no active record exists", async () => {
    const table = new FakeDaemonProcessTable(() => [unmarkedDaemonProcess(100)]);
    const result = await checkOrphanedDaemons({
      processFinder: table,
      readActiveDaemon: () => null,
      platform: "linux",
    });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("PID 100, socket unmarked, age unknown");
  });

  test("returns a typed warning when the process table scan fails", async () => {
    const table = new FakeDaemonProcessTable(() => {
      throw new Error("ps timed out");
    });
    const result = await checkOrphanedDaemons({
      processFinder: table,
      readActiveDaemon: () => active,
      platform: "linux",
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("ps timed out");
  });

  test("skips on Windows without scanning", async () => {
    const table = new FakeDaemonProcessTable();
    const result = await checkOrphanedDaemons({ processFinder: table, platform: "win32" });
    expect(result.status).toBe("skip");
    expect(table.scanCalls).toBe(0);
  });
});

describe("checkForeignLeaseHolders", () => {
  const holder = {
    deviceId: "emulator-5554",
    pid: 777,
    alive: true,
    socketPath: "/tmp/other.sock",
    acquiredAt: 10_000,
  };

  test("passes when only this process holds leases", async () => {
    const result = await checkForeignLeaseHolders({
      lister: { listHolders: () => [{ ...holder, pid: 1 }] },
      selfPid: 1,
    });
    expect(result.status).toBe("pass");
  });

  test("warns naming device, PID, socket, age and the remedy", async () => {
    const result = await checkForeignLeaseHolders({
      lister: { listHolders: async () => [holder, { deviceId: "d2", pid: 9, alive: false }] },
      selfPid: 1,
      timer: timerAt(70_000),
    });
    expect(result.status).toBe("warn");
    expect(result.detail).toBe(
      "- emulator-5554: PID 777, socket /tmp/other.sock, held 60s, process alive\n" +
        "- d2: PID 9, socket unknown, age unknown, process gone (reclaimable)",
    );
    expect(result.recommendation).toContain("idle release");
  });

  test("returns a typed warning when the lister throws", async () => {
    const result = await checkForeignLeaseHolders({
      lister: {
        listHolders: () => {
          throw new Error("EACCES");
        },
      },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("EACCES");
  });
});
