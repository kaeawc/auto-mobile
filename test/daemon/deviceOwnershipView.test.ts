import { describe, expect, test } from "bun:test";
import {
  DeviceOwnershipView,
  createDefaultDeviceOwnershipSources,
  judgeOwnership,
  type DeviceOwnerRecord,
  type DeviceOwnershipSources,
  type DeviceRef,
} from "../../src/daemon/deviceOwnershipView";
import { openSqliteBindingRegistry } from "../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { createBindingExecOwnerLiveness } from "../../src/daemon/sessionBroker/registry/ownerLiveness";
import { ctrlProxyForwardLeaseFileName } from "../../src/features/observe/android/CtrlProxyForwardLease";
import { FakeDeviceClaims } from "../fakes/FakeDeviceClaims";
import { SeededRandom } from "../fakes/SeededRandom";
import { assignBindingDevice } from "./sessionBroker/provisioning/bindingFixtures";

const phone: DeviceRef = { platform: "android", deviceId: "emulator-5554" };

class FakeSources implements DeviceOwnershipSources {
  readonly locks: DeviceOwnerRecord[] = [];
  exec: DeviceOwnerRecord | undefined;
  pool: string | null = null;
  manager: string | null = null;
  listDevices = () => Promise.resolve([phone]);
  lockFileOwners = () => [...this.locks];
  execOwner = () => Promise.resolve(this.exec);
  poolHolder = () => this.pool;
  sessionManagerHolder = () => this.manager;
}

describe("DeviceOwnershipView", () => {
  test("one live owner across sources agrees", async () => {
    const sources = new FakeSources();
    sources.locks.push({ source: "claim_file", pid: 10, alive: true });
    sources.locks.push({ source: "forward_lease", pid: 10, alive: true });
    sources.exec = { source: "exec_owner", pid: 10, sessionId: "s1", alive: true };
    sources.pool = "s1";
    sources.manager = "s1";

    const ownership = await new DeviceOwnershipView(sources).ownershipOf(phone);

    expect(ownership.liveOwnerPids).toEqual([10]);
    expect(ownership.disagreements).toEqual([]);
    expect(ownership.records).toHaveLength(5);
  });

  test("two live daemons on different sources are a disagreement", async () => {
    const sources = new FakeSources();
    sources.locks.push({ source: "claim_file", pid: 10, alive: true });
    sources.locks.push({ source: "legacy_claim_file", pid: 11, alive: true });

    const ownership = await new DeviceOwnershipView(sources).ownershipOf(phone);

    expect(ownership.disagreements.map((d) => d.kind)).toEqual(["conflicting_live_pids"]);
  });

  test("pool and exec owner naming different sessions disagree", async () => {
    const sources = new FakeSources();
    sources.exec = { source: "exec_owner", pid: 10, sessionId: "s1", alive: true };
    sources.pool = "s2";

    const ownership = await new DeviceOwnershipView(sources).ownershipOf(phone);

    expect(ownership.disagreements.map((d) => d.kind)).toEqual(["conflicting_sessions"]);
  });

  test("a dead owner alone is reclaimable, beside a live owner it is reported", () => {
    const dead: DeviceOwnerRecord = { source: "claim_file", pid: 9, alive: false };
    expect(judgeOwnership(phone, [dead]).disagreements).toEqual([]);
    const beside = judgeOwnership(phone, [dead, { source: "forward_lease", pid: 10, alive: true }]);
    expect(beside.disagreements.map((d) => d.kind)).toEqual(["stale_record_beside_live_owner"]);
  });

  test("snapshot walks every listed device", async () => {
    const sources = new FakeSources();
    sources.listDevices = () => Promise.resolve([phone, { platform: "ios", deviceId: "UDID-1" }]);
    expect(await new DeviceOwnershipView(sources).snapshot()).toHaveLength(2);
  });
});

describe("default sources", () => {
  test("read lock files and the in-memory binding registry exec owner", async () => {
    const registry = await openSqliteBindingRegistry({ dbPath: ":memory:" });
    try {
      await assignBindingDevice(registry, "android", "Pixel_8", "runner-a", "sess-1");
      const files = new Map([[`claim/${ctrlProxyForwardLeaseFileName("Pixel_8")}`, 4242]]);
      const sources = createDefaultDeviceOwnershipSources({
        registry,
        readers: {
          readLock: (path) => {
            const pid = [...files].find(([key]) => path.endsWith(key))?.[1];
            return pid === undefined ? undefined : { pid, token: "t" };
          },
          isProcessRunning: (pid) => pid === 4242,
          listFiles: () => [],
        },
      });
      const exec = await sources.execOwner({ platform: "android", deviceId: "Pixel_8" });
      expect(exec).toMatchObject({ source: "exec_owner", sessionId: "sess-1" });
      expect(await sources.execOwner({ platform: "android", deviceId: "other" })).toBeUndefined();
      expect(createBindingExecOwnerLiveness()({ daemonId: "d", pid: 0 })).toBe(false);
    } finally {
      await registry.close?.();
    }
  });
});

describe("default sources lock liveness (#13279)", () => {
  const claim = ctrlProxyForwardLeaseFileName("Pixel_8");
  const phone8: DeviceRef = { platform: "android", deviceId: "Pixel_8" };
  const sourcesWith = (verdict: "same" | "different" | "unknown", generation?: string) =>
    createDefaultDeviceOwnershipSources({
      readers: {
        readLock: (path) =>
          path.endsWith(claim) ? { pid: 77, token: "t", generation } : undefined,
        isProcessRunning: () => true,
        listFiles: () => [],
        generationVerdict: () => verdict,
      },
    });

  test("a reused PID with a different generation is not a live owner", () => {
    const [owner] = sourcesWith("different", "linux:1")
      .lockFileOwners(phone8)
      .filter((r) => r.source === "claim_file");
    expect(owner).toMatchObject({ source: "claim_file", pid: 77, alive: false });
  });

  test("the same generation, an unknown one or no recorded generation stays live", () => {
    expect(
      sourcesWith("same", "linux:1")
        .lockFileOwners(phone8)
        .every((r) => r.alive),
    ).toBe(true);
    expect(
      sourcesWith("unknown", "linux:1")
        .lockFileOwners(phone8)
        .every((r) => r.alive),
    ).toBe(true);
    expect(
      sourcesWith("different")
        .lockFileOwners(phone8)
        .every((r) => r.alive),
    ).toBe(true);
  });
});

describe("default sources listing failures", () => {
  const sourcesWith = (listFiles: () => string[]) =>
    createDefaultDeviceOwnershipSources({
      readers: { readLock: () => undefined, isProcessRunning: () => false, listFiles },
    });

  test("a missing ownership directory means no claimed devices", async () => {
    const missing = Object.assign(new Error("no such dir"), { code: "ENOENT" });
    expect(
      await sourcesWith(() => {
        throw missing;
      }).listDevices(),
    ).toEqual([]);
  });

  test("an unreadable ownership directory fails instead of reporting no devices", async () => {
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    await expect(
      sourcesWith(() => {
        throw denied;
      }).listDevices(),
    ).rejects.toThrow(/permission denied/);
  });
});

/** A tiny model of the claim protocol: acquire only when free or the holder is dead. */
class ClaimModel {
  readonly alive = new Map<number, boolean>();
  holder: number | undefined;
  private nextPid = 100;

  spawn(): number {
    const pid = this.nextPid++;
    this.alive.set(pid, true);
    return pid;
  }
  claim(pid: number): void {
    if (!this.alive.get(pid)) {
      return;
    }
    if (this.holder === undefined || !this.alive.get(this.holder) || this.holder === pid) {
      this.holder = pid;
    }
  }
  release(pid: number): void {
    if (this.holder === pid) {
      this.holder = undefined;
    }
  }
  crash(pid: number): void {
    this.alive.set(pid, false);
  }
  sources(): DeviceOwnershipSources {
    const fake = new FakeSources();
    const model = this;
    fake.lockFileOwners = () =>
      model.holder === undefined
        ? []
        : [{ source: "claim_file", pid: model.holder, alive: model.alive.get(model.holder) }];
    return fake;
  }
}

describe("claim / release / crash interleavings", () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %d never shows two live owners", async (seed) => {
    const random = new SeededRandom(seed);
    const model = new ClaimModel();
    const pids = [model.spawn(), model.spawn(), model.spawn()];
    const view = new DeviceOwnershipView(model.sources());
    for (let step = 0; step < 60; step++) {
      const pid = random.pick(pids);
      const op = random.pick(["claim", "claim", "release", "crash", "respawn"] as const);
      if (op === "claim") {
        model.claim(pid);
      } else if (op === "release") {
        model.release(pid);
      } else if (op === "crash") {
        model.crash(pid);
      } else {
        pids.push(model.spawn());
      }
      const ownership = await view.ownershipOf(phone);
      expect(ownership.liveOwnerPids.length).toBeLessThanOrEqual(1);
      expect(ownership.disagreements).toEqual([]);
    }
  });

  test("the view does flag a second live claimant forced past the protocol", async () => {
    const model = new ClaimModel();
    const a = model.spawn();
    const b = model.spawn();
    model.claim(a);
    const sources = model.sources();
    sources.lockFileOwners = () => [
      { source: "claim_file", pid: a, alive: true },
      { source: "forward_lease", pid: b, alive: true },
    ];
    const ownership = await new DeviceOwnershipView(sources).ownershipOf(phone);
    expect(ownership.liveOwnerPids).toEqual([a, b]);
    expect(ownership.disagreements[0]?.kind).toBe("conflicting_live_pids");
  });
});

describe("default sources: the host-wide claims table (#11811 b)", () => {
  const row = {
    platform: "android" as const,
    deviceId: "Pixel_8",
    kind: "allocation" as const,
    pid: 77,
    ownerToken: "t",
    processGenerationToken: "linux:1",
    claimedAtMs: 1,
    updatedAtMs: 1,
  };
  const claim = ctrlProxyForwardLeaseFileName("Pixel_8");
  const sourcesFor = (
    running: boolean,
    verdict: "same" | "different" | "unknown",
    filePid?: number,
  ) => {
    const claims = new FakeDeviceClaims();
    void claims.upsert(row);
    return createDefaultDeviceOwnershipSources({
      claims,
      readers: {
        readLock: (path) =>
          filePid !== undefined && path.endsWith(claim) ? { pid: filePid, token: "t" } : undefined,
        isProcessRunning: () => running,
        listFiles: () => [],
        generationVerdict: () => verdict,
      },
    });
  };
  const device: DeviceRef = { platform: "android", deviceId: "Pixel_8" };

  test("a row is a record with its owner and liveness, and its device is listed", async () => {
    const sources = sourcesFor(true, "same");
    expect(await sources.tableClaim?.(device)).toEqual({
      source: "device_claims",
      pid: 77,
      alive: true,
    });
    expect(await sources.listDevices()).toEqual([device]);
  });

  test("a reused PID or a gone process is not a live owner", async () => {
    expect((await sourcesFor(true, "different").tableClaim?.(device))?.alive).toBe(false);
    expect((await sourcesFor(false, "same").tableClaim?.(device))?.alive).toBe(false);
  });

  test("a row naming a live owner other than the claim file's is a disagreement", async () => {
    const view = new DeviceOwnershipView(sourcesFor(true, "same", 88));
    const ownership = await view.ownershipOf(device);
    expect(ownership.liveOwnerPids).toEqual([77, 88]);
    expect(ownership.disagreements.map((d) => d.kind)).toEqual(["conflicting_live_pids"]);
  });

  test("a row that matches the claim file agrees", async () => {
    const view = new DeviceOwnershipView(sourcesFor(true, "same", 77));
    expect((await view.ownershipOf(device)).disagreements).toEqual([]);
  });

  test("a live table row with no claim file agrees: step (d) writes no file (#11811 d)", async () => {
    const view = new DeviceOwnershipView(sourcesFor(true, "same"));
    const ownership = await view.ownershipOf(device);
    expect(ownership.liveOwnerPids).toEqual([77]);
    expect(ownership.disagreements).toEqual([]);
  });

  test("no table means no table records", async () => {
    const sources = createDefaultDeviceOwnershipSources({
      readers: { readLock: () => undefined, isProcessRunning: () => false, listFiles: () => [] },
    });
    expect(await sources.tableClaim?.(device)).toBeUndefined();
  });
});
