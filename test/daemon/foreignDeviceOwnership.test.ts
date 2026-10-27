import { describe, expect, spyOn, test } from "bun:test";
import { useScratchRoot } from "../helpers/scratchRoot";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  adbServerScope,
  DEVICE_CLAIM_OWNER_STARTUP_GRACE_MS,
  DEVICE_OWNER_UNANSWERED_LAPSE_MS,
  DEVICE_OWNER_UNANSWERED_MAX_SAMPLE_GAP_MS,
  deviceAllocationClaimPath,
  ForwardLeaseForeignDeviceOwnership,
  type DeviceOwnershipFileSource,
} from "../../src/daemon/foreignDeviceOwnership";
import type {
  ForwardLeaseOwnerProbe,
  ForwardLeaseOwnerReport,
} from "../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import type {
  ForeignCtrlProxyForwardEvidence,
  ForeignCtrlProxyForwardVerdict,
} from "../../src/features/observe/android/foreignCtrlProxyForwardEvidence";
import {
  readExclusiveLockContent,
  releaseExclusiveLock,
  takeOverExclusiveLock,
  tryAcquireExclusiveLock,
  type LockContent,
} from "../../src/utils/fileLock";
import { ensureSecureDirectorySync } from "../../src/utils/tempDir";
import { logger } from "../../src/utils/logger";
import {
  DefaultForeignCtrlProxyForwardEvidence,
  resetForeignCtrlProxyForwardEvidenceForTesting,
} from "../../src/features/observe/android/foreignCtrlProxyForwardEvidence";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceClaims } from "../fakes/FakeDeviceClaims";
import { SeededRandom } from "../fakes/SeededRandom";
import { StoreDeviceClaimMirror } from "../../src/daemon/deviceClaims";
import { createExecResult } from "../../src/utils/execResult";

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
  legacyClaimPath(deviceId: string): string {
    return `/coord/device-allocations/${deviceId}.lock`;
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
  release(path: string, owner: { pid: number; ownerToken: string }): void {
    const held = this.files.get(path);
    if (held?.pid === owner.pid && held.token === owner.ownerToken) {
      this.files.delete(path);
    }
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

function harness(
  forwardVerdict?: ForeignCtrlProxyForwardVerdict | ForeignCtrlProxyForwardEvidence,
) {
  const files = new FakeOwnershipFiles();
  const probe = new FakeOwnerProbe();
  const timer = new FakeTimer();
  // Claims recorded at `acquiredAt: 1` are past their owner's startup grace (#11158).
  timer.setCurrentTime(1 + DEVICE_CLAIM_OWNER_STARTUP_GRACE_MS);
  const ownership = new ForwardLeaseForeignDeviceOwnership(
    SELF_PID,
    files,
    probe,
    () => SELF_SOCKET,
    timer,
    forwardVerdict === undefined
      ? undefined
      : "read" in forwardVerdict
        ? forwardVerdict
        : ({ read: async () => forwardVerdict } satisfies ForeignCtrlProxyForwardEvidence),
  );
  const ownerOf = async (deviceId: string) => {
    await ownership.refresh([deviceId]);
    return ownership.foreignOwnerPid(deviceId);
  };
  return { files, probe, ownership, ownerOf, timer };
}

describe("ForwardLeaseForeignDeviceOwnership", () => {
  test("inventory refresh forwards cancellation and never publishes a late verdict", async () => {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<ForeignCtrlProxyForwardVerdict>();
    let forwardedSignal: AbortSignal | undefined;
    const { ownership } = harness({
      read: (_id, signal) => {
        forwardedSignal = signal;
        started.resolve();
        return pending.promise;
      },
    });
    const controller = new AbortController();
    const refresh = ownership.refresh(["emulator-5556"], controller.signal);
    await started.promise;
    expect(forwardedSignal).toBe(controller.signal);
    controller.abort(new Error("request expired"));
    await expect(refresh).rejects.toThrow("request expired");
    pending.resolve({ kind: "foreign", ports: [8767], clientPids: [FOREIGN_PID], message: "peer" });
    await Promise.resolve();
    expect(ownership.foreignOwnerPid("emulator-5556")).toBeUndefined();
  });

  test("F4c refresh shares one forward listing across all Android devices", async () => {
    const adb = new FakeAdbExecutor();
    const ids = ["a", "b", "c", "d"];
    adb.setCommandResponse(
      "forward --list",
      createExecResult(ids.map((id) => `${id} tcp:8767 tcp:8765`).join("\n"), ""),
    );
    const evidence = new DefaultForeignCtrlProxyForwardEvidence({
      adbFactory: { create: () => adb },
      clientProbe: { findClientPids: async () => [FOREIGN_PID] },
      ownership: () => ({ ownsForward: () => false }),
      isProcessRunning: () => true,
      timer: new FakeTimer(),
    });
    const { ownership } = harness(evidence);
    try {
      await ownership.refresh(ids);
      expect(adb.getExecutedCommands()).toEqual(["forward --list"]);
      for (const id of ids) {
        expect(ownership.foreignOwnerPid(id)).toBe(FOREIGN_PID);
      }
      await ownership.refresh(ids);
      expect(adb.getExecutedCommands()).toEqual(["forward --list", "forward --list"]);
    } finally {
      resetForeignCtrlProxyForwardEvidenceForTesting();
    }
  });

  test("#12220 retains a live foreign forward PID with no claim or lease", async () => {
    const { ownership, ownerOf } = harness({
      kind: "foreign",
      ports: [19001],
      clientPids: [FOREIGN_PID],
      message: "foreign forward",
    });
    expect(await ownerOf("d")).toBe(FOREIGN_PID);
    expect(ownership.foreignClaimUnreadable("d")).toBe(false);
  });

  test("#12220 keeps a file owner's PID without probing host forwards", async () => {
    let forwardReads = 0;
    const { files, ownerOf } = harness({
      read: async () => {
        forwardReads++;
        return { kind: "foreign", ports: [19001], clientPids: [5151], message: "forward" };
      },
    });
    files.files.set("/leases/d.lock", { pid: FOREIGN_PID, token: "lease" });
    expect(await ownerOf("d")).toBe(FOREIGN_PID);
    expect(forwardReads).toBe(0);
  });

  test("#12220 leaves direct claim behavior independent of forward evidence", async () => {
    let forwardReads = 0;
    const { ownership } = harness({
      read: async () => {
        forwardReads++;
        return { kind: "foreign", ports: [19001], clientPids: [FOREIGN_PID], message: "forward" };
      },
    });
    expect(await ownership.claim("d")).toBe(true);
    expect(forwardReads).toBe(0);
  });

  test("#12220 clears the forward owner after a fresh no-forward verdict", async () => {
    let verdict: ForeignCtrlProxyForwardVerdict = {
      kind: "foreign",
      ports: [19001],
      clientPids: [FOREIGN_PID],
      message: "foreign forward",
    };
    const { ownerOf } = harness({ read: async () => verdict });
    expect(await ownerOf("d")).toBe(FOREIGN_PID);
    verdict = { kind: "none" };
    expect(await ownerOf("d")).toBeUndefined();
  });

  test("#12220 treats a forward with unknown ownership as unreadable", async () => {
    const { ownership, ownerOf } = harness({
      kind: "unknown",
      ports: [19001],
      reason: "process identity unavailable",
      message: "unknown forward",
    });
    expect(await ownerOf("d")).toBeUndefined();
    expect(ownership.foreignClaimUnreadable("d")).toBe(true);
  });

  test("#12220 allows an unknown verdict without ports to leave the device free", async () => {
    const { ownership, ownerOf } = harness({
      kind: "unknown",
      ports: [],
      reason: "adb list unavailable",
      message: "could not inspect forwards",
    });
    expect(await ownerOf("d")).toBeUndefined();
    expect(ownership.foreignClaimUnreadable("d")).toBe(false);
  });

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

  describe("a wedged-but-alive owner (#11349)", () => {
    const SWEEP_MS = 30_000;
    const noResponse: ForwardLeaseOwnerReport = { kind: "no-response", detail: "timeout" };

    /** A peer holding the device's lease and claim whose socket accepts but never answers. */
    function wedgedPeer() {
      const h = harness();
      const lock = { pid: FOREIGN_PID, token: "t", metadata: metadata("/s") };
      h.files.files.set("/leases/d.lock", lock);
      h.files.files.set("/claims/d.lock", lock);
      h.probe.reports.set("/s", noResponse);
      /** Sweep every {@link SWEEP_MS} until `ms` have passed; the owner seen by the last sweep. */
      const sweepFor = async (ms: number) => {
        let owner = await h.ownerOf("d");
        for (let elapsed = 0; elapsed < ms; elapsed += SWEEP_MS) {
          h.timer.advanceTime(SWEEP_MS);
          owner = await h.ownerOf("d");
        }
        return owner;
      };
      return { ...h, sweepFor };
    }

    const lapseWarnings = (warn: { mock: { calls: unknown[][] } }) =>
      warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("lapsed"));

    test("still holds after 4 minutes of no answers, and has lapsed at 5 minutes plus one sweep, with one warning", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const { sweepFor, ownerOf, timer } = wedgedPeer();

        expect(await sweepFor(4 * 60_000)).toBe(FOREIGN_PID);
        expect(lapseWarnings(warn)).toEqual([]);

        // Up to just short of the lapse window, then one more sweep.
        expect(await sweepFor(60_000 - SWEEP_MS)).toBe(FOREIGN_PID);
        expect(DEVICE_OWNER_UNANSWERED_LAPSE_MS).toBe(5 * 60_000);
        timer.advanceTime(SWEEP_MS);
        expect(await ownerOf("d")).toBeUndefined();

        // Later sweeps keep the device free without repeating the warning.
        expect(await sweepFor(2 * SWEEP_MS)).toBeUndefined();
        const warnings = lapseWarnings(warn);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(`PID ${FOREIGN_PID}`);
        expect(warnings[0]).toContain(" of d ");
      } finally {
        warn.mockRestore();
      }
    });

    test("its lapsed claim can be taken over", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const { sweepFor, ownership, files } = wedgedPeer();
        expect(await ownership.claim("d")).toBe(false);

        await sweepFor(DEVICE_OWNER_UNANSWERED_LAPSE_MS);

        expect(await ownership.claim("d")).toBe(true);
        expect(files.files.get("/claims/d.lock")?.pid).toBe(SELF_PID);
      } finally {
        warn.mockRestore();
      }
    });

    test("any answer ends the run: a busy owner that answers in between keeps the device", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const { sweepFor, probe, ownerOf } = wedgedPeer();
        expect(await sweepFor(4 * 60_000)).toBe(FOREIGN_PID);

        probe.reports.set("/s", status(FOREIGN_PID, "session"));
        expect(await ownerOf("d")).toBe(FOREIGN_PID);

        probe.reports.set("/s", noResponse);
        expect(await sweepFor(4 * 60_000)).toBe(FOREIGN_PID);
        expect(lapseWarnings(warn)).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    test("two isolated timeouts hours apart never lapse a live owner's claim", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const { ownerOf, ownership, timer, files } = wedgedPeer();
        expect(await ownerOf("d")).toBe(FOREIGN_PID);

        timer.advanceTime(3 * 60 * 60_000);

        expect(await ownerOf("d")).toBe(FOREIGN_PID);
        expect(await ownership.claim("d")).toBe(false);
        expect(files.files.get("/claims/d.lock")?.pid).toBe(FOREIGN_PID);
        expect(lapseWarnings(warn)).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    test("samples further apart than the maximum gap never add up to a lapse", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const { ownerOf, timer } = wedgedPeer();
        for (let elapsed = 0; elapsed < 4 * DEVICE_OWNER_UNANSWERED_LAPSE_MS;) {
          expect(await ownerOf("d")).toBe(FOREIGN_PID);
          timer.advanceTime(DEVICE_OWNER_UNANSWERED_MAX_SAMPLE_GAP_MS + 1);
          elapsed += DEVICE_OWNER_UNANSWERED_MAX_SAMPLE_GAP_MS + 1;
        }
        expect(lapseWarnings(warn)).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    test("a dense run interrupted by a sampling gap starts over", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const { sweepFor, timer } = wedgedPeer();
        expect(await sweepFor(4 * 60_000)).toBe(FOREIGN_PID);

        timer.advanceTime(10 * 60_000);

        // Elapsed time since the first timeout is far past the window, but it was not observed.
        expect(await sweepFor(4 * 60_000)).toBe(FOREIGN_PID);
        expect(await sweepFor(60_000)).toBeUndefined();
        expect(lapseWarnings(warn)).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    test("time the host spent suspended is not unanswered time", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const { ownerOf, timer } = wedgedPeer();
        expect(await ownerOf("d")).toBe(FOREIGN_PID);

        timer.simulateHostSleep(2 * DEVICE_OWNER_UNANSWERED_LAPSE_MS);

        expect(await ownerOf("d")).toBe(FOREIGN_PID);
        expect(lapseWarnings(warn)).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
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

  test("a live owner's fresh claim survives its socket not being bound yet (#11158)", async () => {
    // A restarting daemon republishes rehydrated sessions' claims before its socket binds.
    const { files, ownership, ownerOf, timer } = harness();
    const fresh = JSON.stringify({ socketPath: "/s", acquiredAt: timer.now() - 1_000 });
    files.files.set("/claims/d.lock", { pid: FOREIGN_PID, token: "t", metadata: fresh });

    expect(await ownerOf("d")).toBe(FOREIGN_PID);
    expect(await ownership.claim("d")).toBe(false);
    expect(files.files.get("/claims/d.lock")?.pid).toBe(FOREIGN_PID);

    // Once the grace has passed, an owner still unreachable is gone.
    timer.advanceTime(DEVICE_CLAIM_OWNER_STARTUP_GRACE_MS);
    expect(await ownerOf("d")).toBeUndefined();
  });

  test("a dead owner's fresh claim lapses without waiting out the grace", async () => {
    const { files, ownerOf, timer } = harness();
    const fresh = JSON.stringify({ socketPath: "/s", acquiredAt: timer.now() });
    files.files.set("/claims/d.lock", { pid: 5151, token: "t", metadata: fresh });
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

    test("release withdraws this daemon's claim but never another daemon's", async () => {
      const { files, ownership } = harness();
      expect(await ownership.claim("d")).toBe(true);
      ownership.release("d");
      expect(files.files.has("/claims/d.lock")).toBe(false);

      files.files.set("/claims/e.lock", { pid: FOREIGN_PID, token: "t", metadata: metadata("/s") });
      ownership.release("e");
      expect(files.files.get("/claims/e.lock")?.pid).toBe(FOREIGN_PID);
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

describe("legacy 0.0.84 coordination-directory claims (#10708)", () => {
  test("a live legacy claim is a foreign owner while its owner uses the device", async () => {
    const { files, probe, ownerOf } = harness();
    files.files.set("/coord/device-allocations/d.lock", {
      pid: FOREIGN_PID,
      token: "t",
      metadata: metadata("/old"),
    });
    probe.reports.set("/old", status(FOREIGN_PID, "old-session"));
    expect(await ownerOf("d")).toBe(FOREIGN_PID);

    probe.reports.set("/old", status(FOREIGN_PID, null));
    expect(await ownerOf("d")).toBeUndefined();
  });

  test("claim loses to a live legacy claim and never writes the legacy location", async () => {
    const { files, probe, ownership } = harness();
    files.files.set("/coord/device-allocations/d.lock", {
      pid: FOREIGN_PID,
      token: "t",
      metadata: metadata("/old"),
    });
    probe.reports.set("/old", status(FOREIGN_PID, "old-session"));
    expect(await ownership.claim("d")).toBe(false);
    expect(files.files.has("/claims/d.lock")).toBe(false);

    // Once the older daemon lets the device go, the claim goes to the new location only.
    probe.reports.set("/old", status(FOREIGN_PID, null));
    expect(await ownership.claim("d")).toBe(true);
    expect(files.files.get("/claims/d.lock")?.pid).toBe(SELF_PID);
    expect(files.files.get("/coord/device-allocations/d.lock")?.pid).toBe(FOREIGN_PID);
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
    // The home directory is resolved to an absolute path, which on Windows adds a drive letter.
    expect(
      a.startsWith(join(resolve("/h"), ".auto-mobile", "adb-servers", "tcp-localhost-5037")),
    ).toBe(true);
    expect(
      deviceAllocationClaimPath("emulator-5554", { ANDROID_ADB_SERVER_PORT: "5038" }, "/h"),
    ).not.toBe(a);
  });

  test("an explicit ADB-server coordination root replaces the account home", () => {
    const path = deviceAllocationClaimPath(
      "emulator-5554",
      { AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: "/shared/claims" },
      "/h",
    );
    expect(
      path.startsWith(join("/shared/claims", "tcp-localhost-5037", "device-allocations")),
    ).toBe(true);
  });

  test("the test preload keeps the default claim path off the real home", () => {
    expect(process.env.AUTOMOBILE_ADB_SERVER_COORDINATION_DIR?.trim()).toBeTruthy();
    const real = join(userInfo().homedir, ".auto-mobile");
    expect(deviceAllocationClaimPath("emulator-5554").startsWith(real)).toBe(false);
  });
});

describe("daemons in different coordination directories on one adb server (#10708)", () => {
  const scratch = useScratchRoot("foreign-ownership-");

  /** Real lock files: each daemon's lease lives in its own coordination dir, claims are shared. */
  function daemon(home: string, coordinationDir: string, alive: Set<number>) {
    const env = { AUTOMOBILE_COORDINATION_DIR: coordinationDir };
    const isProcessRunning = (pid: number) => alive.has(pid);
    const source: DeviceOwnershipFileSource = {
      leasePath: (deviceId) => join(coordinationDir, "ctrl-proxy-forwards", `${deviceId}.lock`),
      claimPath: (deviceId) => deviceAllocationClaimPath(deviceId, env, home),
      legacyClaimPath: (deviceId) =>
        join(coordinationDir, "device-allocations", `${deviceId}.lock`),
      read: (path) => readExclusiveLockContent(path),
      isProcessRunning,
      tryAcquire: (path, owner) => {
        ensureSecureDirectorySync(dirname(path));
        return tryAcquireExclusiveLock(path, { ...owner, isProcessRunning });
      },
      takeOver: (path, observed, owner) => takeOverExclusiveLock(path, observed, owner),
      release: (path, owner) => releaseExclusiveLock(path, owner.pid, owner.ownerToken),
    };
    return source;
  }

  test("a second daemon sees and loses to the first daemon's claim", async () => {
    const root = scratch.next();
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
    probe.reports.set(SELF_SOCKET, status(SELF_PID, "second-session"));
    await first.refresh(["emulator-5554"]);
    expect(first.foreignOwnerPid("emulator-5554")).toBe(SELF_PID);
  });

  test("a session claim is written and withdrawn at the ADB-server location, never the legacy one (#10708, #10709)", async () => {
    const root = scratch.next();
    const home = join(root, "home");
    const coordinationDir = join(root, "coord");
    const ownership = new ForwardLeaseForeignDeviceOwnership(
      SELF_PID,
      daemon(home, coordinationDir, new Set([SELF_PID])),
      new FakeOwnerProbe(),
      () => SELF_SOCKET,
      new FakeTimer(),
    );
    const claimPath = deviceAllocationClaimPath(
      "emulator-5554",
      { AUTOMOBILE_COORDINATION_DIR: coordinationDir },
      home,
    );
    const legacyPath = join(coordinationDir, "device-allocations", "emulator-5554.lock");

    expect(await ownership.claim("emulator-5554")).toBe(true);
    expect(readExclusiveLockContent(claimPath)?.pid).toBe(SELF_PID);
    expect(existsSync(legacyPath)).toBe(false);

    ownership.release("emulator-5554");
    expect(existsSync(claimPath)).toBe(false);
    expect(existsSync(legacyPath)).toBe(false);
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

describe("the host-wide claims mirror (#11811 b)", () => {
  const DEVICE = "emulator-5554";
  const PEER_PID = FOREIGN_PID;

  function mirroredDaemon(
    files: FakeOwnershipFiles,
    store: FakeDeviceClaims,
    pid: number,
  ): { ownership: ForwardLeaseForeignDeviceOwnership; mirror: StoreDeviceClaimMirror } {
    const timer = new FakeTimer();
    // No control socket is recorded, so a live PID alone decides ownership.
    const ownership = new ForwardLeaseForeignDeviceOwnership(
      pid,
      files,
      new FakeOwnerProbe(),
      () => undefined,
      timer,
    );
    const mirror = new StoreDeviceClaimMirror({
      platform: "android",
      store: () => store,
      timer,
      generationOf: () => undefined,
    });
    ownership.attachClaimMirror(mirror);
    return { ownership, mirror };
  }

  const fileOwner = (files: FakeOwnershipFiles) => {
    const held = files.files.get(files.claimPath(DEVICE));
    return held ? { pid: held.pid, ownerToken: held.token } : undefined;
  };
  const tableOwner = async (store: FakeDeviceClaims) => {
    const row = await store.get("android", DEVICE);
    return row ? { pid: row.pid, ownerToken: row.ownerToken } : undefined;
  };

  test("a won claim is mirrored with the token its claim file names, and a release withdraws it", async () => {
    const files = new FakeOwnershipFiles();
    const store = new FakeDeviceClaims();
    const { ownership, mirror } = mirroredDaemon(files, store, SELF_PID);

    expect(await ownership.claim(DEVICE)).toBe(true);
    await mirror.idle();
    expect(await tableOwner(store)).toEqual(fileOwner(files)!);
    expect((await store.get("android", DEVICE))?.pid).toBe(SELF_PID);

    ownership.release(DEVICE);
    await mirror.idle();
    expect(fileOwner(files)).toBeUndefined();
    expect(store.rows.size).toBe(0);
  });

  test("a claim another live daemon holds is refused and leaves the table untouched", async () => {
    const files = new FakeOwnershipFiles();
    const store = new FakeDeviceClaims();
    const peer = mirroredDaemon(files, store, PEER_PID);
    const self = mirroredDaemon(files, store, SELF_PID);
    expect(await peer.ownership.claim(DEVICE)).toBe(true);
    await peer.mirror.idle();

    expect(await self.ownership.claim(DEVICE)).toBe(false);
    self.ownership.release(DEVICE);
    await self.mirror.idle();

    expect((await store.get("android", DEVICE))?.pid).toBe(PEER_PID);
  });

  test("taking over a dead owner's claim replaces its row", async () => {
    const files = new FakeOwnershipFiles();
    const store = new FakeDeviceClaims();
    const peer = mirroredDaemon(files, store, PEER_PID);
    const self = mirroredDaemon(files, store, SELF_PID);
    expect(await peer.ownership.claim(DEVICE)).toBe(true);
    await peer.mirror.idle();
    files.alive.delete(PEER_PID);

    expect(await self.ownership.claim(DEVICE)).toBe(true);
    await self.mirror.idle();

    expect(await tableOwner(store)).toEqual(fileOwner(files)!);
    expect((await store.get("android", DEVICE))?.pid).toBe(SELF_PID);
  });

  test("a busy table never changes the claim's outcome", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const files = new FakeOwnershipFiles();
      const store = new FakeDeviceClaims();
      store.failWrites = 1;
      const { ownership, mirror } = mirroredDaemon(files, store, SELF_PID);
      expect(await ownership.claim(DEVICE)).toBe(true);
      await mirror.idle();
      expect(fileOwner(files)?.pid).toBe(SELF_PID);
      expect(store.rows.size).toBe(0);
      // The next claim by the same daemon (already ours) catches the table up.
      expect(await ownership.claim(DEVICE)).toBe(true);
      await mirror.idle();
      expect(await tableOwner(store)).toEqual(fileOwner(files)!);
    } finally {
      warn.mockRestore();
    }
  });

  // The table follows the file: after any interleaving of claims, releases and crashes by two
  // daemons the row names exactly the owner the claim file does, or both are absent.
  test.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "claim, release and crash interleavings keep the table equal to the claim file (seed %i)",
    async (seed) => {
      const files = new FakeOwnershipFiles();
      const store = new FakeDeviceClaims();
      const daemons = [
        mirroredDaemon(files, store, SELF_PID),
        mirroredDaemon(files, store, PEER_PID),
      ];
      const random = new SeededRandom(seed);
      for (let step = 0; step < 120; step++) {
        const index = random.next() < 0.5 ? 0 : 1;
        const daemon = daemons[index];
        const pid = index === 0 ? SELF_PID : PEER_PID;
        const roll = random.next();
        if (roll < 0.45) {
          files.alive.add(pid);
          await daemon.ownership.claim(DEVICE);
        } else if (roll < 0.8) {
          daemon.ownership.release(DEVICE);
        } else {
          // A crash: the process disappears without releasing anything.
          files.alive.delete(pid);
        }
        await Promise.all(daemons.map((d) => d.mirror.idle()));
        expect({ step, table: await tableOwner(store) }).toEqual({
          step,
          table: fileOwner(files),
        });
      }
    },
  );
});
