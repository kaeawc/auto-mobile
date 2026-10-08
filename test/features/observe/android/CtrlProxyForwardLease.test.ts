import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileCtrlProxyForwardLease,
  ctrlProxyForwardLeaseFileName,
  ctrlProxyOwnedForwardFileName,
  deviceIdFromCtrlProxyForwardLeaseFileName,
} from "../../../../src/features/observe/android/CtrlProxyForwardLease";
import type {
  DeviceLeaseRelinquishResult,
  ForwardLeaseRelinquishProbe,
  ForwardLeaseRelinquishReport,
} from "../../../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import { readExclusiveLockContent } from "../../../../src/utils/fileLock";
import { FakeTimer } from "../../../fakes/FakeTimer";

const DEVICE = "emulator-5600";
// A live process that is not this one stands in for the foreign lease owner.
const FOREIGN_PID = process.ppid;

class FakeOwnerProbe implements ForwardLeaseRelinquishProbe {
  readonly requests: Array<{ socketPath: string; deviceId: string }> = [];
  /** Runs inside the owner's handling of the request, e.g. to release its lease. */
  onRequest: () => void = () => {};
  constructor(private readonly report: ForwardLeaseRelinquishReport) {}
  async requestRelinquish(
    socketPath: string,
    deviceId: string,
  ): Promise<ForwardLeaseRelinquishReport> {
    this.requests.push({ socketPath, deviceId });
    this.onRequest();
    return this.report;
  }
}

function ownerAnswer(
  overrides: Partial<DeviceLeaseRelinquishResult> = {},
): ForwardLeaseRelinquishReport {
  return {
    kind: "relinquish",
    result: {
      pid: FOREIGN_PID,
      deviceId: DEVICE,
      sessionId: null,
      activeExecutions: 0,
      idleForMs: 120_000,
      released: true,
      reason: "it reports no live session or recent activity",
      ...overrides,
    },
  };
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
    probe: ForwardLeaseRelinquishProbe,
    options: { pid?: number; socket?: string } = {},
  ): FileCtrlProxyForwardLease {
    return new FileCtrlProxyForwardLease(DEVICE, {
      lockDir: () => dir,
      ownerProbe: probe,
      ownerSocketPath: () => options.socket,
      timer,
      pid: options.pid,
    });
  }

  function lockPid(): number | undefined {
    return readExclusiveLockContent(join(dir, ctrlProxyForwardLeaseFileName(DEVICE)))?.pid;
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

  test("acquires once an idle owner releases the lease itself (#10506 review)", async () => {
    const owner = foreignOwner();
    const probe = new FakeOwnerProbe(ownerAnswer());
    probe.onRequest = () => owner.release();
    const requester = lease(probe, { socket: "/tmp/resident.sock" });

    expect(requester.tryAcquire()).toBe(false);
    expect(requester.getLastOwnerPid()).toBe(FOREIGN_PID);
    const result = await requester.tryReclaimFromStaleOwner();

    expect(result.acquired).toBe(true);
    expect(probe.requests).toEqual([{ socketPath: "/tmp/priv/daemon.sock", deviceId: DEVICE }]);
    expect(requester.isHeld()).toBe(true);
    expect(lockPid()).toBe(process.pid);
    expect(owner.tryAcquire()).toBe(false);
  });

  test("never takes the lock from an owner that answered released but still holds it", async () => {
    // The owner's new activity re-took the lease, or its close is still running:
    // the requester only competes with an ordinary acquire, so the owner keeps it.
    const owner = foreignOwner();
    const requester = lease(new FakeOwnerProbe(ownerAnswer()));
    expect(requester.tryAcquire()).toBe(false);

    const result = await requester.tryReclaimFromStaleOwner();

    expect(result).toMatchObject({
      acquired: false,
      reason: "another process claimed the lease first",
      transient: true,
    });
    expect(lockPid()).toBe(FOREIGN_PID);
    expect(owner.tryAcquire()).toBe(true);
  });

  test("takes over from an owner whose socket is unreachable", async () => {
    foreignOwner();
    const requester = lease(new FakeOwnerProbe({ kind: "unreachable", detail: "ENOENT" }));
    expect(requester.tryAcquire()).toBe(false);
    expect((await requester.tryReclaimFromStaleOwner()).acquired).toBe(true);
    expect(lockPid()).toBe(process.pid);
  });

  test("takes over when the owner's socket is now served by another daemon", async () => {
    foreignOwner();
    const requester = lease(
      new FakeOwnerProbe(ownerAnswer({ pid: FOREIGN_PID + 100_000, released: false })),
    );
    expect(requester.tryAcquire()).toBe(false);
    const result = await requester.tryReclaimFromStaleOwner();
    expect(result.acquired).toBe(true);
    expect(result.reason).toContain("so the owner is orphaned");
  });

  test("refuses an owner that keeps the lease and names it", async () => {
    foreignOwner();
    const requester = lease(
      new FakeOwnerProbe(
        ownerAnswer({
          released: false,
          sessionId: "session-abc",
          reason: "it has live session session-abc on emulator-5600",
        }),
      ),
    );
    expect(requester.tryAcquire()).toBe(false);
    const result = await requester.tryReclaimFromStaleOwner();
    expect(result).toEqual({
      acquired: false,
      ownerPid: FOREIGN_PID,
      ownerSocketPath: "/tmp/priv/daemon.sock",
      reason: "it has live session session-abc on emulator-5600",
    });
    expect(lockPid()).toBe(FOREIGN_PID);
  });

  test("passes an owner's transient refusal through", async () => {
    foreignOwner();
    const requester = lease(
      new FakeOwnerProbe(
        ownerAnswer({ released: false, reason: "it used emulator-5600 5s ago", transient: true }),
      ),
    );
    expect(requester.tryAcquire()).toBe(false);
    const result = await requester.tryReclaimFromStaleOwner();
    expect(result.acquired).toBe(false);
    expect(result.transient).toBe(true);
    expect(result.reason).toContain("5s ago");
  });

  test("does not ask an owner that recorded no socket", async () => {
    foreignOwner(null);
    const probe = new FakeOwnerProbe({ kind: "unreachable", detail: "unused" });
    const requester = lease(probe);
    expect(requester.tryAcquire()).toBe(false);
    const result = await requester.tryReclaimFromStaleOwner();
    expect(result.acquired).toBe(false);
    expect(probe.requests).toEqual([]);
  });

  test("never reclaims a lease held by this same process", async () => {
    const original = lease(new FakeOwnerProbe({ kind: "unreachable", detail: "unused" }));
    expect(original.tryAcquire()).toBe(true);
    const probe = new FakeOwnerProbe({ kind: "unreachable", detail: "ENOENT" });
    const replacement = lease(probe);
    expect(replacement.tryAcquire()).toBe(false);
    expect((await replacement.tryReclaimFromStaleOwner()).acquired).toBe(false);
    expect(probe.requests).toEqual([]);
  });

  test("a forked observer can reclaim and holds only its own claim (#10506 review)", async () => {
    foreignOwner();
    const singleton = lease(new FakeOwnerProbe({ kind: "unreachable", detail: "ENOENT" }));
    const fork = singleton.fork();
    expect(fork.tryAcquire()).toBe(false);

    expect((await fork.tryReclaimFromStaleOwner!()).acquired).toBe(true);
    expect(lockPid()).toBe(process.pid);
    expect(fork.tryAcquire()).toBe(true);
    // The singleton shares the process lease but made no claim of its own.
    expect(singleton.isHeld()).toBe(true);
    singleton.release();
    expect(lockPid()).toBe(process.pid);

    fork.release();
    expect(singleton.isHeld()).toBe(false);
    expect(lockPid()).toBeUndefined();
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

  test("records forward ownership for its coordination directory only (#10690)", () => {
    const probe = new FakeOwnerProbe({ kind: "unreachable", detail: "unused" });
    const creator = lease(probe, { pid: FOREIGN_PID });
    creator.recordOwnedForward(8767);

    const record = JSON.parse(
      readFileSync(join(dir, ctrlProxyOwnedForwardFileName(DEVICE, 8767)), "utf8"),
    );
    expect(record).toEqual({
      pid: FOREIGN_PID,
      deviceId: DEVICE,
      localPort: 8767,
      createdAt: 100_000,
    });
    // A later daemon sharing the directory may reclaim it; other ports stay foreign.
    const successor = lease(probe);
    expect(successor.ownsForward(8767)).toBe(true);
    expect(successor.ownsForward(8765)).toBe(false);
    expect(successor.ownershipDirectory()).toBe(dir);

    const otherDir = mkdtempSync(join(tmpdir(), "ctrlproxy-lease-other-"));
    try {
      const isolated = new FileCtrlProxyForwardLease(DEVICE, {
        lockDir: () => otherDir,
        ownerProbe: probe,
        ownerSocketPath: () => undefined,
        timer,
      });
      expect(isolated.ownsForward(8767)).toBe(false);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }

    successor.forgetOwnedForward(8767);
    expect(creator.ownsForward(8767)).toBe(true);
    expect(successor.ownsForward(8767)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("forks share forward records, and records stay out of the lease listing", () => {
    const own = lease(new FakeOwnerProbe({ kind: "unreachable", detail: "unused" }));
    const fork = own.fork();
    fork.recordOwnedForward!(8768);
    expect(own.ownsForward(8768)).toBe(true);

    const name = ctrlProxyOwnedForwardFileName(DEVICE, 8768);
    expect(readdirSync(dir)).toEqual([name]);
    expect(deviceIdFromCtrlProxyForwardLeaseFileName(name)).toBeUndefined();

    own.forgetOwnedForward(8768);
    expect(fork.ownsForward!(8768)).toBe(false);
  });
});
