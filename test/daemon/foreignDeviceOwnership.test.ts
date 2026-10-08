import { describe, expect, spyOn, test } from "bun:test";
import {
  ForwardLeaseForeignDeviceOwnership,
  type DeviceOwnershipFileSource,
} from "../../src/daemon/foreignDeviceOwnership";
import type {
  ForwardLeaseOwnerProbe,
  ForwardLeaseOwnerReport,
} from "../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import type { LockContent } from "../../src/utils/fileLock";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

const SELF_PID = 100;
const FOREIGN_PID = 4242;
const SELF_SOCKET = "/sockets/self.sock";

const metadata = (socketPath: string) => JSON.stringify({ socketPath, acquiredAt: 1 });

/** In-memory lock files keyed by path, with fileLock's acquire and take-over semantics. */
class FakeOwnershipFiles implements DeviceOwnershipFileSource {
  readonly files = new Map<string, LockContent>();
  readonly alive = new Set<number>([SELF_PID, FOREIGN_PID]);
  leasePath(deviceId: string): string {
    return `/leases/${deviceId}.lock`;
  }
  claimPath(deviceId: string): string {
    return `/claims/${deviceId}.lock`;
  }
  read(path: string): LockContent | undefined {
    return this.files.get(path);
  }
  isProcessRunning(pid: number): boolean {
    return this.alive.has(pid);
  }
  tryAcquire(path: string, owner: { pid: number; ownerToken: string; metadata?: string }): boolean {
    const held = this.files.get(path);
    if (held && !Number.isNaN(held.pid) && this.alive.has(held.pid)) {
      return false;
    }
    this.files.set(path, { pid: owner.pid, token: owner.ownerToken, metadata: owner.metadata });
    return true;
  }
  takeOver(
    path: string,
    observed: Pick<LockContent, "pid" | "token">,
    owner: { pid: number; ownerToken: string; metadata?: string },
  ): boolean {
    const held = this.files.get(path);
    if (held?.pid !== observed.pid || held.token !== observed.token) {
      return false;
    }
    this.files.set(path, { pid: owner.pid, token: owner.ownerToken, metadata: owner.metadata });
    return true;
  }
}

class FakeOwnerProbe implements ForwardLeaseOwnerProbe {
  readonly reports = new Map<string, ForwardLeaseOwnerReport>();
  async query(socketPath: string): Promise<ForwardLeaseOwnerReport> {
    return this.reports.get(socketPath) ?? { kind: "unreachable", detail: "ECONNREFUSED" };
  }
}

const status = (
  pid: number,
  sessionId: string | null,
  activeExecutions = 0,
): ForwardLeaseOwnerReport => ({
  kind: "status",
  status: { pid, deviceId: "d", sessionId, activeExecutions, idleForMs: null },
});

function harness() {
  const files = new FakeOwnershipFiles();
  const probe = new FakeOwnerProbe();
  const ownership = new ForwardLeaseForeignDeviceOwnership(
    SELF_PID,
    files,
    probe,
    () => SELF_SOCKET,
    new FakeTimer(),
  );
  const ownerOf = async (deviceId: string) => {
    await ownership.refresh([deviceId]);
    return ownership.foreignOwnerPid(deviceId);
  };
  return { files, probe, ownership, ownerOf };
}

describe("ForwardLeaseForeignDeviceOwnership", () => {
  test("reports the live PID of an older-build lease holder that records no socket", async () => {
    const { files, ownerOf } = harness();
    files.files.set("/leases/d.lock", { pid: FOREIGN_PID, token: "t" });
    expect(await ownerOf("d")).toBe(FOREIGN_PID);
  });

  test.each([
    ["own", SELF_PID],
    ["dead", 5151],
    ["corrupt", Number.NaN],
  ])("reports no foreign owner for a %s lease holder", async (_label, pid) => {
    const { files, ownerOf } = harness();
    files.files.set("/leases/d.lock", { pid, token: "t" });
    expect(await ownerOf("d")).toBeUndefined();
  });

  test("reports no owner for a device with neither a lease nor a claim", async () => {
    expect(await harness().ownerOf("d")).toBeUndefined();
  });

  test("a live lease holder whose socket answers is foreign", async () => {
    const { files, probe, ownerOf } = harness();
    files.files.set("/leases/d.lock", { pid: FOREIGN_PID, token: "t", metadata: metadata("/s") });
    probe.reports.set("/s", status(FOREIGN_PID, null));
    expect(await ownerOf("d")).toBe(FOREIGN_PID);
  });

  test("a busy owner that cannot answer keeps the device", async () => {
    const { files, probe, ownerOf } = harness();
    files.files.set("/leases/d.lock", { pid: FOREIGN_PID, token: "t", metadata: metadata("/s") });
    probe.reports.set("/s", { kind: "no-response", detail: "timeout" });
    expect(await ownerOf("d")).toBe(FOREIGN_PID);
  });

  test("a reused PID whose recorded socket is unreachable does not own the device", async () => {
    // After a crash or reboot the lease's PID names an unrelated live process.
    const { files, ownerOf } = harness();
    files.files.set("/leases/d.lock", { pid: FOREIGN_PID, token: "t", metadata: metadata("/s") });
    expect(await ownerOf("d")).toBeUndefined();
  });

  test("an owner whose socket another daemon now serves does not own the device", async () => {
    const { files, probe, ownerOf } = harness();
    files.files.set("/leases/d.lock", { pid: FOREIGN_PID, token: "t", metadata: metadata("/s") });
    probe.reports.set("/s", status(7777, null));
    expect(await ownerOf("d")).toBeUndefined();
  });

  test("an allocation claim counts only while its owner uses the device", async () => {
    const { files, probe, ownerOf } = harness();
    files.files.set("/claims/d.lock", { pid: FOREIGN_PID, token: "t", metadata: metadata("/s") });

    probe.reports.set("/s", status(FOREIGN_PID, "their-session"));
    expect(await ownerOf("d")).toBe(FOREIGN_PID);

    probe.reports.set("/s", status(FOREIGN_PID, null, 1));
    expect(await ownerOf("d")).toBe(FOREIGN_PID);

    probe.reports.set("/s", status(FOREIGN_PID, null));
    expect(await ownerOf("d")).toBeUndefined();
  });

  test("answers from each device's latest refresh only", async () => {
    const { files, ownership } = harness();
    files.files.set("/leases/a.lock", { pid: FOREIGN_PID, token: "t" });
    files.files.set("/leases/b.lock", { pid: FOREIGN_PID, token: "t" });
    expect(ownership.foreignOwnerPid("a")).toBeUndefined();

    await ownership.refresh(["a", "b"]);
    files.files.delete("/leases/a.lock");
    await ownership.refresh(["a"]);

    expect(ownership.foreignOwnerPid("a")).toBeUndefined();
    expect(ownership.foreignOwnerPid("b")).toBe(FOREIGN_PID);
  });

  describe("claim", () => {
    test("publishes this daemon's claim with its control socket", async () => {
      const { files, ownership } = harness();
      expect(await ownership.claim("d")).toBe(true);
      const claim = files.files.get("/claims/d.lock");
      expect(claim?.pid).toBe(SELF_PID);
      expect(JSON.parse(claim?.metadata ?? "{}").socketPath).toBe(SELF_SOCKET);
      // Claiming again keeps this daemon's claim.
      expect(await ownership.claim("d")).toBe(true);
    });

    test("loses to another daemon that claimed the device and still uses it", async () => {
      const { files, probe, ownership } = harness();
      files.files.set("/claims/d.lock", { pid: FOREIGN_PID, token: "t", metadata: metadata("/s") });
      probe.reports.set("/s", status(FOREIGN_PID, "their-session"));

      expect(await ownership.claim("d")).toBe(false);
      expect(files.files.get("/claims/d.lock")?.pid).toBe(FOREIGN_PID);
    });

    test("takes over a claim whose owner no longer uses the device or is gone", async () => {
      const { files, probe, ownership } = harness();
      files.files.set("/claims/a.lock", { pid: FOREIGN_PID, token: "t", metadata: metadata("/s") });
      files.files.set("/claims/b.lock", { pid: FOREIGN_PID, token: "t", metadata: metadata("/x") });
      probe.reports.set("/s", status(FOREIGN_PID, null));

      expect(await ownership.claim("a")).toBe(true);
      expect(await ownership.claim("b")).toBe(true);
      expect(files.files.get("/claims/a.lock")?.pid).toBe(SELF_PID);
      expect(files.files.get("/claims/b.lock")?.pid).toBe(SELF_PID);
    });
  });

  test("logs and reports no owner when the ownership paths cannot be resolved", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const files = new FakeOwnershipFiles();
      files.leasePath = () => {
        throw new Error("no home directory");
      };
      const ownership = new ForwardLeaseForeignDeviceOwnership(
        SELF_PID,
        files,
        new FakeOwnerProbe(),
      );
      await ownership.refresh(["emulator-5554"]);
      expect(ownership.foreignOwnerPid("emulator-5554")).toBeUndefined();
      expect(String(warn.mock.calls[0]?.[0])).toContain("no home directory");
    } finally {
      warn.mockRestore();
    }
  });
});
