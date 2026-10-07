import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileCtrlProxyForwardLease,
  ctrlProxyForwardLeaseFileName,
  deviceIdFromCtrlProxyForwardLeaseFileName,
} from "../../../../src/features/observe/android/CtrlProxyForwardLease";
import type {
  ForwardLeaseOwnerProbe,
  ForwardLeaseOwnerReport,
} from "../../../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import { readExclusiveLockContent } from "../../../../src/utils/fileLock";
import { FakeTimer } from "../../../fakes/FakeTimer";

const DEVICE = "emulator-5600";
// A live process that is not this one stands in for the foreign lease owner.
const FOREIGN_PID = process.ppid;

class FakeOwnerProbe implements ForwardLeaseOwnerProbe {
  readonly queries: Array<{ socketPath: string; deviceId: string }> = [];
  constructor(private readonly report: ForwardLeaseOwnerReport) {}
  async query(socketPath: string, deviceId: string): Promise<ForwardLeaseOwnerReport> {
    this.queries.push({ socketPath, deviceId });
    return this.report;
  }
}

describe("FileCtrlProxyForwardLease stale-owner reclaim (#10497)", () => {
  let dir: string;
  let timer: FakeTimer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctrlproxy-lease-"));
    timer = new FakeTimer();
    timer.setCurrentTime(100_000);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function lease(
    probe: ForwardLeaseOwnerProbe,
    options: { pid?: number; socket?: string } = {},
  ): FileCtrlProxyForwardLease {
    return new FileCtrlProxyForwardLease(DEVICE, {
      lockDir: () => dir,
      ownerProbe: probe,
      ownerSocketPath: () => options.socket,
      idleMs: 60_000,
      timer,
      pid: options.pid,
    });
  }

  function foreignOwner(socket: string | null = "/tmp/priv/daemon.sock") {
    const owner = lease(new FakeOwnerProbe({ kind: "unreachable", detail: "unused" }), {
      pid: FOREIGN_PID,
      socket: socket ?? undefined,
    });
    expect(owner.tryAcquire()).toBe(true);
    return owner;
  }

  test("records the daemon socket in the lease it takes", () => {
    foreignOwner();
    const content = readExclusiveLockContent(join(dir, ctrlProxyForwardLeaseFileName(DEVICE)));
    expect(content?.pid).toBe(FOREIGN_PID);
    expect(JSON.parse(content?.metadata ?? "{}")).toEqual({
      socketPath: "/tmp/priv/daemon.sock",
      acquiredAt: 100_000,
    });
  });

  test("takes over from an owner that reports no session or recent activity", async () => {
    const owner = foreignOwner();
    const probe = new FakeOwnerProbe({
      kind: "status",
      status: {
        pid: FOREIGN_PID,
        deviceId: DEVICE,
        sessionId: null,
        activeExecutions: 0,
        idleForMs: 120_000,
      },
    });
    const requester = lease(probe, { socket: "/tmp/resident.sock" });

    expect(requester.tryAcquire()).toBe(false);
    expect(requester.getLastOwnerPid()).toBe(FOREIGN_PID);
    const result = await requester.tryReclaimFromStaleOwner();

    expect(result.acquired).toBe(true);
    expect(probe.queries).toEqual([{ socketPath: "/tmp/priv/daemon.sock", deviceId: DEVICE }]);
    expect(requester.isHeld()).toBe(true);
    expect(readExclusiveLockContent(join(dir, ctrlProxyForwardLeaseFileName(DEVICE)))?.pid).toBe(
      process.pid,
    );
    // The displaced owner notices on its next acquire instead of trusting a stale claim.
    expect(owner.tryAcquire()).toBe(false);
    expect(owner.isHeld()).toBe(false);
  });

  test("takes over from an owner whose socket is unreachable", async () => {
    foreignOwner();
    const requester = lease(new FakeOwnerProbe({ kind: "unreachable", detail: "ENOENT" }));
    expect(requester.tryAcquire()).toBe(false);
    expect((await requester.tryReclaimFromStaleOwner()).acquired).toBe(true);
  });

  test("refuses an owner with a live session and names it", async () => {
    foreignOwner();
    const requester = lease(
      new FakeOwnerProbe({
        kind: "status",
        status: {
          pid: FOREIGN_PID,
          deviceId: DEVICE,
          sessionId: "session-abc",
          activeExecutions: 0,
          idleForMs: 120_000,
        },
      }),
    );
    expect(requester.tryAcquire()).toBe(false);
    const result = await requester.tryReclaimFromStaleOwner();
    expect(result).toEqual({
      acquired: false,
      ownerPid: FOREIGN_PID,
      ownerSocketPath: "/tmp/priv/daemon.sock",
      reason: "it has live session session-abc on emulator-5600",
    });
    expect(readExclusiveLockContent(join(dir, ctrlProxyForwardLeaseFileName(DEVICE)))?.pid).toBe(
      FOREIGN_PID,
    );
  });

  test("does not query an owner that recorded no socket", async () => {
    foreignOwner(null);
    const probe = new FakeOwnerProbe({ kind: "unreachable", detail: "unused" });
    const requester = lease(probe);
    expect(requester.tryAcquire()).toBe(false);
    const result = await requester.tryReclaimFromStaleOwner();
    expect(result.acquired).toBe(false);
    expect(probe.queries).toEqual([]);
  });

  test("never reclaims a lease held by this same process", async () => {
    const original = lease(new FakeOwnerProbe({ kind: "unreachable", detail: "unused" }));
    expect(original.tryAcquire()).toBe(true);
    const probe = new FakeOwnerProbe({ kind: "unreachable", detail: "ENOENT" });
    const replacement = lease(probe);
    expect(replacement.tryAcquire()).toBe(false);
    expect((await replacement.tryReclaimFromStaleOwner()).acquired).toBe(false);
    expect(probe.queries).toEqual([]);
  });

  test("refuses an owner that just took the lease as transient, using its acquire time", async () => {
    foreignOwner();
    timer.advanceTime(5_000);
    const requester = lease(
      new FakeOwnerProbe({
        kind: "status",
        status: {
          pid: FOREIGN_PID,
          deviceId: DEVICE,
          sessionId: null,
          activeExecutions: 0,
          idleForMs: null,
        },
      }),
    );
    expect(requester.tryAcquire()).toBe(false);
    const result = await requester.tryReclaimFromStaleOwner();
    expect(result.acquired).toBe(false);
    expect(result.transient).toBe(true);
    expect(result.reason).toContain("5s ago");
  });

  test("reports when this process took the lease, only while holding it", () => {
    const own = lease(new FakeOwnerProbe({ kind: "unreachable", detail: "unused" }));
    expect(own.getAcquiredAt()).toBeUndefined();
    expect(own.tryAcquire()).toBe(true);
    expect(own.getAcquiredAt()).toBe(100_000);
    own.release();
    expect(own.getAcquiredAt()).toBeUndefined();
  });

  test("decodes device ids from lease file names", () => {
    const name = ctrlProxyForwardLeaseFileName("192.168.1.5:5555");
    expect(deviceIdFromCtrlProxyForwardLeaseFileName(name)).toBe("192.168.1.5:5555");
    expect(deviceIdFromCtrlProxyForwardLeaseFileName("x.lock.1.reclaim")).toBeUndefined();
  });
});
