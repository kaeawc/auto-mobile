import { describe, expect, test } from "bun:test";
import {
  describeForeignForwardLeaseHolders,
  listForwardLeaseHolders,
  type ForwardLeaseHolderSource,
} from "../../src/daemon/forwardLeaseHolders";
import { ctrlProxyForwardLeaseFileName } from "../../src/features/observe/android/CtrlProxyForwardLease";
import type {
  ForwardLeaseOwnerProbe,
  ForwardLeaseOwnerReport,
} from "../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import type { LockContent } from "../../src/utils/fileLock";
import { FakeTimer } from "../fakes/FakeTimer";

function source(locks: Record<string, LockContent>, alive: Set<number>): ForwardLeaseHolderSource {
  return {
    lockDir: () => "/leases",
    listFiles: () => [...Object.keys(locks), "stray.lock.12.reclaim"],
    readLock: (path) => locks[path.slice("/leases/".length)],
    isProcessRunning: (pid) => alive.has(pid),
  };
}

class FakeProbe implements ForwardLeaseOwnerProbe {
  constructor(private readonly reports: Record<string, ForwardLeaseOwnerReport>) {}
  async query(_socketPath: string, deviceId: string): Promise<ForwardLeaseOwnerReport> {
    return this.reports[deviceId]!;
  }
}

const socketMeta = (socketPath: string, acquiredAt: number) =>
  JSON.stringify({ socketPath, acquiredAt });

describe("forwarding-lease holders for --daemon status (#10497)", () => {
  const locks: Record<string, LockContent> = {
    [ctrlProxyForwardLeaseFileName("emulator-5600")]: {
      pid: 15836,
      token: "t1",
      metadata: socketMeta("/tmp/ovl-priv/daemon.sock", 0),
    },
    [ctrlProxyForwardLeaseFileName("emulator-5554")]: { pid: 100, token: "t2" },
    [ctrlProxyForwardLeaseFileName("emulator-5556")]: {
      pid: 777,
      token: "t3",
      metadata: socketMeta("/tmp/dead.sock", 0),
    },
  };

  test("lists holders with decoded device ids and owner metadata", () => {
    expect(listForwardLeaseHolders(source(locks, new Set([15836, 100])))).toEqual([
      {
        deviceId: "emulator-5600",
        pid: 15836,
        alive: true,
        socketPath: "/tmp/ovl-priv/daemon.sock",
        acquiredAt: 0,
      },
      { deviceId: "emulator-5554", pid: 100, alive: true },
      {
        deviceId: "emulator-5556",
        pid: 777,
        alive: false,
        socketPath: "/tmp/dead.sock",
        acquiredAt: 0,
      },
    ]);
  });

  test("describes foreign holders with PID, socket, age and session state", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(90_000);
    const holders = listForwardLeaseHolders(source(locks, new Set([15836, 100])));
    const lines = await describeForeignForwardLeaseHolders(
      100,
      holders,
      new FakeProbe({
        "emulator-5600": {
          kind: "status",
          status: {
            pid: 15836,
            deviceId: "emulator-5600",
            sessionId: null,
            activeExecutions: 0,
            idleForMs: null,
          },
        },
      }),
      timer,
    );
    expect(lines).toEqual([
      "CtrlProxy forwarding leases held by other processes:",
      "  - emulator-5600: PID 15836, socket /tmp/ovl-priv/daemon.sock, held 90s, no live session",
      "  - emulator-5556: PID 777, socket /tmp/dead.sock, held 90s, process gone (reclaimable)",
    ]);
  });

  test("prints nothing when only this daemon holds leases", async () => {
    expect(
      await describeForeignForwardLeaseHolders(
        100,
        [{ deviceId: "emulator-5554", pid: 100, alive: true }],
        new FakeProbe({}),
      ),
    ).toEqual([]);
  });

  test("returns no holders when the lease directory cannot be listed", () => {
    expect(
      listForwardLeaseHolders({
        ...source({}, new Set()),
        listFiles: () => {
          throw new Error("EACCES");
        },
      }),
    ).toEqual([]);
  });
});
