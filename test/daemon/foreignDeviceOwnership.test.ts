import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  adbServerScope,
  deviceAllocationClaimPath,
  ForwardLeaseForeignDeviceOwnership,
  type DeviceOwnershipFileSource,
} from "../../src/daemon/foreignDeviceOwnership";
import type {
  ForwardLeaseOwnerProbe,
  ForwardLeaseOwnerReport,
} from "../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import {
  readExclusiveLockContent,
  takeOverExclusiveLock,
  tryAcquireExclusiveLock,
  type LockContent,
} from "../../src/utils/fileLock";
import { ensureSecureDirectorySync } from "../../src/utils/tempDir";
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

describe("adbServerScope", () => {
  test.each([
    ["no adb variables", {}],
    ["the default port", { ANDROID_ADB_SERVER_PORT: "5037" }],
    ["a loopback address", { ANDROID_ADB_SERVER_ADDRESS: "127.0.0.1" }],
    ["a port-only socket spec", { ADB_SERVER_SOCKET: "tcp:5037" }],
    ["a loopback socket spec", { ADB_SERVER_SOCKET: "tcp:127.0.0.1:5037" }],
  ])("keys %s as the default local server", (_label, env) => {
    expect(adbServerScope(env)).toBe("tcp-localhost-5037");
  });

  test("distinguishes servers by port and host", () => {
    expect(adbServerScope({ ANDROID_ADB_SERVER_PORT: "5038" })).toBe("tcp-localhost-5038");
    expect(adbServerScope({ ADB_SERVER_SOCKET: "tcp:build-host:5037" })).toBe(
      "tcp-build-host-5037",
    );
    // ADB_SERVER_SOCKET wins over the address/port pair, as it does for adb.
    expect(adbServerScope({ ADB_SERVER_SOCKET: "tcp:5039", ANDROID_ADB_SERVER_PORT: "5038" })).toBe(
      "tcp-localhost-5039",
    );
  });

  test("keys a non-TCP socket spec without path separators", () => {
    const scope = adbServerScope({ ADB_SERVER_SOCKET: "localfilesystem:/tmp/adb.sock" });
    expect(scope.startsWith("socket-")).toBe(true);
    expect(scope).not.toContain("/");
  });
});

describe("deviceAllocationClaimPath", () => {
  test("ignores the coordination directory and follows the ADB server (#10708)", () => {
    const a = deviceAllocationClaimPath(
      "emulator-5554",
      { AUTOMOBILE_COORDINATION_DIR: "/a" },
      "/h",
    );
    const b = deviceAllocationClaimPath(
      "emulator-5554",
      { AUTOMOBILE_COORDINATION_DIR: "/b" },
      "/h",
    );
    expect(a).toBe(b);
    expect(a.startsWith(join("/h", ".auto-mobile", "adb-servers", "tcp-localhost-5037"))).toBe(
      true,
    );
    expect(
      deviceAllocationClaimPath("emulator-5554", { ANDROID_ADB_SERVER_PORT: "5038" }, "/h"),
    ).not.toBe(a);
  });
});

describe("daemons in different coordination directories on one adb server (#10708)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** Real lock files: each daemon's lease lives in its own coordination dir, claims are shared. */
  function daemon(home: string, coordinationDir: string, alive: Set<number>) {
    const env = { AUTOMOBILE_COORDINATION_DIR: coordinationDir };
    const isProcessRunning = (pid: number) => alive.has(pid);
    const source: DeviceOwnershipFileSource = {
      leasePath: (deviceId) => join(coordinationDir, "ctrl-proxy-forwards", `${deviceId}.lock`),
      claimPath: (deviceId) => deviceAllocationClaimPath(deviceId, env, home),
      read: (path) => readExclusiveLockContent(path),
      isProcessRunning,
      tryAcquire: (path, owner) => {
        ensureSecureDirectorySync(dirname(path));
        return tryAcquireExclusiveLock(path, { ...owner, isProcessRunning });
      },
      takeOver: (path, observed, owner) => takeOverExclusiveLock(path, observed, owner),
    };
    return source;
  }

  test("a second daemon sees and loses to the first daemon's claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "foreign-ownership-10708-"));
    roots.push(root);
    const home = join(root, "home");
    const alive = new Set<number>([SELF_PID, FOREIGN_PID]);
    const probe = new FakeOwnerProbe();
    probe.reports.set("/sockets/first.sock", status(FOREIGN_PID, "first-session"));

    const first = new ForwardLeaseForeignDeviceOwnership(
      FOREIGN_PID,
      daemon(home, join(root, "coord-a"), alive),
      probe,
      () => "/sockets/first.sock",
      new FakeTimer(),
    );
    const second = new ForwardLeaseForeignDeviceOwnership(
      SELF_PID,
      daemon(home, join(root, "coord-b"), alive),
      probe,
      () => SELF_SOCKET,
      new FakeTimer(),
    );

    expect(await first.claim("emulator-5554")).toBe(true);

    await second.refresh(["emulator-5554"]);
    expect(second.foreignOwnerPid("emulator-5554")).toBe(FOREIGN_PID);
    expect(await second.claim("emulator-5554")).toBe(false);

    // Once the first daemon stops using the device, the second takes the claim over.
    probe.reports.set("/sockets/first.sock", status(FOREIGN_PID, null));
    expect(await second.claim("emulator-5554")).toBe(true);
    await first.refresh(["emulator-5554"]);
    expect(first.foreignOwnerPid("emulator-5554")).toBeUndefined();
  });

  test("an unwritable claim directory is logged and does not block allocation", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const files = new FakeOwnershipFiles();
      files.tryAcquire = () => {
        throw new Error("EACCES: permission denied");
      };
      const ownership = new ForwardLeaseForeignDeviceOwnership(
        SELF_PID,
        files,
        new FakeOwnerProbe(),
      );
      expect(await ownership.claim("emulator-5554")).toBe(true);
      expect(String(warn.mock.calls[0]?.[0])).toContain("EACCES");
    } finally {
      warn.mockRestore();
    }
  });
});
