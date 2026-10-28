import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type { Kysely } from "kysely";
import {
  DEVICE_CLAIM_MIRROR_RETRY_DELAYS_MS,
  lazyDeviceClaims,
  StoreDeviceClaimMirror,
  type DeviceClaim,
  type DeviceClaims,
} from "../../src/daemon/deviceClaims";
import { DeviceClaimMirrorHub } from "../../src/daemon/deviceClaimMirrorHub";
import { BINDING_REGISTRY_MIGRATIONS } from "../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import * as migration from "../../src/daemon/sessionBroker/registry/migrations/2026_10_26_014_device_claims";
import * as metadataMigration from "../../src/daemon/sessionBroker/registry/migrations/2026_10_27_015_device_claims_metadata";
import {
  SqliteDeviceClaims,
  type DeviceClaimTables,
} from "../../src/daemon/sessionBroker/registry/sqliteDeviceClaims";
import { logger } from "../../src/utils/logger";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeDeviceClaims } from "../fakes/FakeDeviceClaims";
import { FakeTimer } from "../fakes/FakeTimer";

const OWNER = { pid: 100, ownerToken: "token-a" };
const CLAIM: DeviceClaim = {
  platform: "android",
  deviceId: "emulator-5554",
  kind: "allocation",
  daemonSessionId: "daemon-1",
  pid: OWNER.pid,
  ownerToken: OWNER.ownerToken,
  processGenerationToken: "boot-1:start-9",
  claimedAtMs: 10,
  updatedAtMs: 10,
};

describe("the device_claims table", () => {
  let db: Kysely<DeviceClaimTables>;
  let claims: SqliteDeviceClaims;

  beforeAll(async () => {
    db = (await createTestDatabase()).withTables<{
      [Table in keyof DeviceClaimTables]: DeviceClaimTables[Table];
    }>();
    await migration.up(db as Kysely<unknown>);
    await metadataMigration.up(db as Kysely<unknown>);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await db.deleteFrom("device_claims").execute();
    claims = new SqliteDeviceClaims(db);
  });

  test("the migrations belong to the host binding registry", () => {
    expect(BINDING_REGISTRY_MIGRATIONS["2026_10_26_014_device_claims"]).toBe(migration);
    expect(BINDING_REGISTRY_MIGRATIONS["2026_10_27_015_device_claims_metadata"]).toBe(
      metadataMigration,
    );
  });

  test("the owner's control-socket record survives a round trip", async () => {
    const withSocket = { ...CLAIM, metadata: '{"socketPath":"/s.sock","acquiredAt":1}' };
    await claims.upsert(withSocket);
    expect(await claims.get("android", "emulator-5554")).toEqual(withSocket);
  });

  test("an upsert replaces the row for the device and reads back unchanged", async () => {
    await claims.upsert(CLAIM);
    expect(await claims.get("android", "emulator-5554")).toEqual(CLAIM);
    const taken = { ...CLAIM, pid: 200, ownerToken: "token-b", updatedAtMs: 20 };
    delete taken.processGenerationToken;
    await claims.upsert(taken);
    expect(await claims.list()).toEqual([taken]);
  });

  test("re-claiming keeps when the same owner first claimed; a new owner restarts it", async () => {
    await claims.upsert(CLAIM);
    await claims.upsert({ ...CLAIM, updatedAtMs: 50 });
    expect(await claims.get("android", "emulator-5554")).toEqual({ ...CLAIM, updatedAtMs: 50 });
    await claims.upsert({
      ...CLAIM,
      pid: 200,
      ownerToken: "token-b",
      claimedAtMs: 60,
      updatedAtMs: 60,
    });
    expect((await claims.get("android", "emulator-5554"))?.claimedAtMs).toBe(60);
  });

  test("a delayed write from a daemon that lost the claim does not replace the winner's row", async () => {
    const winner = { ...CLAIM, pid: 200, ownerToken: "token-b", claimedAtMs: 30, updatedAtMs: 30 };
    await claims.upsert(winner);
    await claims.upsert(CLAIM);
    expect(await claims.get("android", "emulator-5554")).toEqual(winner);
    await claims.release("android", "emulator-5554", OWNER);
    expect(await claims.get("android", "emulator-5554")).toEqual(winner);
  });

  test("a clean shutdown removes every row its process owns and no other", async () => {
    await claims.upsert(CLAIM);
    await claims.upsert({ ...CLAIM, deviceId: "emulator-5556" });
    await claims.upsert({ ...CLAIM, deviceId: "emulator-5558", pid: 200, ownerToken: "token-b" });
    await claims.releaseOwnedBy(OWNER.pid);
    expect((await claims.list()).map((claim) => claim.deviceId)).toEqual(["emulator-5558"]);
  });

  test("a platform keeps its own row for the same id", async () => {
    await claims.upsert(CLAIM);
    await claims.upsert({ ...CLAIM, platform: "ios", pid: 300, ownerToken: "token-c" });
    expect((await claims.list()).map((claim) => [claim.platform, claim.pid])).toEqual([
      ["android", 100],
      ["ios", 300],
    ]);
  });

  test("a release removes the row only while the named owner still holds it", async () => {
    await claims.upsert(CLAIM);
    await claims.release("android", "emulator-5554", { pid: 100, ownerToken: "other-token" });
    await claims.release("android", "emulator-5554", { pid: 999, ownerToken: "token-a" });
    expect(await claims.get("android", "emulator-5554")).toEqual(CLAIM);
    await claims.release("android", "emulator-5554", OWNER);
    expect(await claims.get("android", "emulator-5554")).toBeUndefined();
  });

  test("the schema refuses an unknown kind, platform or empty owner", async () => {
    await expect(
      claims.upsert({ ...CLAIM, kind: "lease" as DeviceClaim["kind"] }),
    ).rejects.toThrow();
    await expect(
      claims.upsert({ ...CLAIM, platform: "desktop" as DeviceClaim["platform"] }),
    ).rejects.toThrow();
    await expect(claims.upsert({ ...CLAIM, ownerToken: " " })).rejects.toThrow();
  });
});

describe("the claims mirror", () => {
  function mirrorOver(store: () => DeviceClaims | undefined) {
    const timer = new FakeTimer();
    timer.setCurrentTime(10);
    return new StoreDeviceClaimMirror({
      platform: "android",
      store,
      timer,
      daemonSessionId: "daemon-1",
      generationOf: () => "boot-1:start-9",
    });
  }

  test("a claim is recorded with the owner and its process generation, then withdrawn", async () => {
    const store = new FakeDeviceClaims();
    const mirror = mirrorOver(() => store);
    mirror.claimed("emulator-5554", OWNER);
    await mirror.idle();
    expect(await store.get("android", "emulator-5554")).toEqual(CLAIM);
    mirror.released("emulator-5554", OWNER);
    await mirror.idle();
    expect(store.rows.size).toBe(0);
  });

  test("the owner's control-socket record reaches the table, and a reused PID reads as no row", async () => {
    const store = new FakeDeviceClaims();
    const mirror = mirrorOver(() => store);
    mirror.claimed("emulator-5554", { ...OWNER, metadata: "socket-record" });
    await mirror.idle();
    expect((await store.get("android", "emulator-5554"))?.metadata).toBe("socket-record");
    expect((await mirror.read("emulator-5554"))?.pid).toBe(OWNER.pid);
    const reused = new StoreDeviceClaimMirror({
      platform: "android",
      store: () => store,
      timer: new FakeTimer(),
      generationVerdict: () => "different",
    });
    expect(await reused.read("emulator-5554")).toBeUndefined();
    expect(await mirrorOver(() => undefined).read("emulator-5554")).toBeUndefined();
  });

  test("a store that is not open yet records nothing and never throws", async () => {
    const mirror = mirrorOver(() => undefined);
    mirror.claimed("emulator-5554", OWNER);
    mirror.released("emulator-5554", OWNER);
    await mirror.idle();
  });

  test("a failed write is traced and does not escape", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const store = new FakeDeviceClaims();
      store.failWrites = 1;
      const mirror = mirrorOver(() => store);
      mirror.claimed("emulator-5554", OWNER);
      await mirror.idle();
      expect(store.rows.size).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      mirror.claimed("emulator-5554", OWNER);
      await mirror.idle();
      expect(store.rows.size).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("lazyDeviceClaims", () => {
  test("serves the table only once the registry open settled, and follows a replaced open", async () => {
    const first = new FakeDeviceClaims();
    const second = new FakeDeviceClaims();
    const open = Promise.withResolvers<{ deviceClaims(): DeviceClaims }>();
    let opening: Promise<{ deviceClaims(): DeviceClaims }> | undefined = open.promise;
    const claims = lazyDeviceClaims(() => opening);

    expect(claims()).toBeUndefined();
    open.resolve({ deviceClaims: () => first });
    await open.promise;
    expect(claims()).toBe(first);

    opening = Promise.resolve({ deviceClaims: () => second });
    expect(claims()).toBeUndefined();
    await opening;
    expect(claims()).toBe(second);

    opening = undefined;
    expect(claims()).toBeUndefined();
  });

  test("a registry open that fails leaves the mirror idle", async () => {
    const opening = Promise.reject<{ deviceClaims(): DeviceClaims }>(new Error("busy"));
    const claims = lazyDeviceClaims(() => opening);
    expect(claims()).toBeUndefined();
    await opening.catch(() => undefined);
    expect(claims()).toBeUndefined();
  });
});

describe("the claims mirror: backfill, retries and shutdown (#11811 c)", () => {
  const RETRIES = DEVICE_CLAIM_MIRROR_RETRY_DELAYS_MS;
  let timer: FakeTimer;
  let store: FakeDeviceClaims;
  let available: DeviceClaims | undefined;
  let mirror: StoreDeviceClaimMirror;
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(10);
    store = new FakeDeviceClaims();
    available = store;
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    mirror = new StoreDeviceClaimMirror({
      platform: "android",
      store: () => available,
      timer,
      daemonSessionId: "daemon-1",
      generationOf: () => "boot-1:start-9",
    });
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const settle = async (): Promise<void> => {
    await mirror.idle();
    await Promise.resolve();
    await mirror.idle();
  };

  test("claims taken before a registry opens reach the table when it opens", async () => {
    available = undefined;
    mirror.claimed("emulator-5554", OWNER);
    mirror.claimed("emulator-5556", { pid: 100, ownerToken: "token-b" });
    await settle();
    expect(store.rows.size).toBe(0);

    timer.setCurrentTime(500);
    const hub = new DeviceClaimMirrorHub();
    hub.register(mirror);
    available = store;
    hub.registryOpened(store);
    await settle();

    expect([...store.rows.keys()].sort()).toEqual([
      "android:emulator-5554",
      "android:emulator-5556",
    ]);
    // The claim keeps the time it was taken, not the time it was backfilled.
    expect((await store.get("android", "emulator-5554"))?.claimedAtMs).toBe(10);
  });

  test("a registry that reopens empty gets the held claims again, and not the released ones", async () => {
    mirror.claimed("emulator-5554", OWNER);
    mirror.claimed("emulator-5556", { pid: 100, ownerToken: "token-b" });
    await settle();
    mirror.released("emulator-5556", { pid: 100, ownerToken: "token-b" });
    await settle();
    store.rows.clear();

    mirror.reconcile(store);
    await settle();

    expect([...store.rows.keys()]).toEqual(["android:emulator-5554"]);
  });

  test("a write that finds no registry is retried on the backoff until one opens", async () => {
    available = undefined;
    mirror.claimed("emulator-5554", OWNER);
    await settle();
    available = store;
    await timer.advanceTimeAsync(RETRIES[0]!);
    await settle();
    expect(store.rows.size).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a failed release write is retried until it lands, then nothing is left armed", async () => {
    mirror.claimed("emulator-5554", OWNER);
    await settle();
    store.failWrites = 2;
    mirror.released("emulator-5554", OWNER);
    await settle();
    expect(store.rows.size).toBe(1);

    await timer.advanceTimeAsync(RETRIES[0]!);
    await settle();
    expect(store.rows.size).toBe(1);
    await timer.advanceTimeAsync(RETRIES[1]!);
    await settle();

    expect(store.rows.size).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("retries are bounded, and the registry opening starts them over", async () => {
    store.failWrites = Number.POSITIVE_INFINITY;
    mirror.claimed("emulator-5554", OWNER);
    await settle();
    for (const delay of RETRIES) {
      await timer.advanceTimeAsync(delay);
      await settle();
    }
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(RETRIES.length + 1);

    store.failWrites = 0;
    mirror.reconcile(store);
    await settle();
    expect(store.rows.size).toBe(1);
  });

  test("a newer intent made while a write is in flight is written after it", async () => {
    const gate = Promise.withResolvers<void>();
    const upsert = store.upsert.bind(store);
    let first = true;
    store.upsert = async (claim) => {
      if (first) {
        first = false;
        await gate.promise;
      }
      await upsert(claim);
    };
    mirror.claimed("emulator-5554", OWNER);
    await Promise.resolve();
    mirror.released("emulator-5554", OWNER);
    gate.resolve();
    await settle();
    expect(store.rows.size).toBe(0);
  });

  test("re-claiming by the same owner keeps when it first claimed", async () => {
    mirror.claimed("emulator-5554", OWNER);
    await settle();
    timer.setCurrentTime(900);
    mirror.claimed("emulator-5554", OWNER);
    await settle();
    expect((await store.get("android", "emulator-5554"))?.claimedAtMs).toBe(10);
    expect((await store.get("android", "emulator-5554"))?.updatedAtMs).toBe(900);
  });

  test("a claim the file no longer names is dropped, not written over its new owner's row", async () => {
    let held = true;
    available = undefined;
    mirror.claimed("emulator-5554", OWNER, () => held);
    await settle();
    held = false;
    await store.upsert({ ...CLAIM, pid: 200, ownerToken: "token-b", updatedAtMs: 5 });
    available = store;
    await timer.advanceTimeAsync(RETRIES[0]!);
    await settle();
    mirror.reconcile(store);
    await settle();
    expect((await store.get("android", "emulator-5554"))?.pid).toBe(200);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a claim file that cannot be re-read keeps the claim and writes it", async () => {
    mirror.claimed("emulator-5554", OWNER, () => {
      throw new Error("EACCES");
    });
    await settle();
    expect(store.rows.size).toBe(1);
  });

  test("a reconcile while a write is in flight writes again to the registry it names", async () => {
    const gate = Promise.withResolvers<void>();
    const stale = new FakeDeviceClaims();
    const upsert = stale.upsert.bind(stale);
    stale.upsert = async (claim) => {
      await gate.promise;
      await upsert(claim);
    };
    available = stale;
    mirror.claimed("emulator-5554", OWNER);
    await Promise.resolve();
    available = store;
    mirror.reconcile(store);
    gate.resolve();
    await settle();
    expect(store.rows.size).toBe(1);
  });

  test("after dispose nothing is written or retried", async () => {
    store.failWrites = 1;
    mirror.claimed("emulator-5554", OWNER);
    await settle();
    expect(timer.getPendingTimeoutCount()).toBe(1);
    mirror.dispose();
    expect(timer.getPendingTimeoutCount()).toBe(0);
    mirror.claimed("emulator-5556", OWNER);
    mirror.reconcile(store);
    await settle();
    expect(store.rows.size).toBe(0);
  });
});

describe("DeviceClaimMirrorHub", () => {
  test("tells every registered mirror when a registry opens and when to stop", async () => {
    const timer = new FakeTimer();
    const store = new FakeDeviceClaims();
    const hub = new DeviceClaimMirrorHub();
    const mirrors = (["android", "ios"] as const).map((platform) =>
      hub.register(
        new StoreDeviceClaimMirror({
          platform,
          store: () => undefined,
          timer,
          generationOf: () => undefined,
        }),
      ),
    );
    mirrors[0]!.claimed("emulator-5554", OWNER);
    mirrors[1]!.claimed("UDID-1", OWNER);

    hub.registryOpened(store);
    await Promise.all(mirrors.map((mirror) => mirror.idle()));
    expect([...store.rows.keys()].sort()).toEqual(["android:emulator-5554", "ios:UDID-1"]);

    hub.dispose();
    mirrors[0]!.released("emulator-5554", OWNER);
    await mirrors[0]!.idle();
    expect(store.rows.size).toBe(2);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});

describe("the claims mirror: late registry discovery", () => {
  function harness() {
    const timer = new FakeTimer();
    timer.setCurrentTime(10);
    const store = new FakeDeviceClaims();
    const hub = new DeviceClaimMirrorHub();
    const pending = Promise.withResolvers<{ deviceClaims(): DeviceClaims }>();
    let opening: typeof pending.promise | undefined;
    let fileExists = false;
    const probe = mock(() => fileExists);
    const open = mock(() => {
      opening = pending.promise;
      return true;
    });
    const mirror = hub.register(
      new StoreDeviceClaimMirror({
        platform: "android",
        timer,
        store: lazyDeviceClaims(() => opening),
        registryFileExists: probe,
        openRegistry: open,
        generationOf: () => undefined,
      }),
    );
    return { timer, store, hub, pending, probe, open, mirror, appear: () => (fileExists = true) };
  }

  test("one ladder step discovers the registry; its opening backfills original times and owed releases", async () => {
    const { timer, store, hub, pending, probe, open, mirror, appear } = harness();
    await store.upsert({ ...CLAIM, deviceId: "emulator-5556" });
    mirror.claimed("emulator-5554", OWNER);
    mirror.released("emulator-5556", OWNER);
    expect(open).not.toHaveBeenCalled();
    appear();
    timer.advanceTime(DEVICE_CLAIM_MIRROR_RETRY_DELAYS_MS[0]!);
    expect(open).toHaveBeenCalledTimes(1);
    expect(await store.get("android", "emulator-5554")).toBeUndefined();
    const probes = probe.mock.calls.length;
    // Opening is already handled: another device write and ladder step ask neither hook again.
    mirror.claimed("emulator-5558", OWNER);
    timer.advanceTime(DEVICE_CLAIM_MIRROR_RETRY_DELAYS_MS[1]!);
    expect(probe).toHaveBeenCalledTimes(probes);
    expect(open).toHaveBeenCalledTimes(1);

    pending.resolve({ deviceClaims: () => store });
    const registry = await pending.promise;
    hub.registryOpened(registry.deviceClaims());
    await hub.idle();
    expect((await store.get("android", "emulator-5554"))?.claimedAtMs).toBe(10);
    expect((await store.get("android", "emulator-5554"))?.updatedAtMs).toBe(timer.now());
    expect(await store.get("android", "emulator-5556")).toBeUndefined();
    expect(timer.getPendingTimeoutCount()).toBe(0);
    hub.dispose();
  });

  test("an absent file is probed only on the write and its five retry steps", () => {
    const { timer, probe, open, mirror, hub } = harness();
    mirror.claimed("emulator-5554", OWNER);
    for (const delay of DEVICE_CLAIM_MIRROR_RETRY_DELAYS_MS) {
      expect(timer.getPendingTimeouts()).toEqual([delay]);
      timer.advanceTime(delay);
    }
    expect(probe).toHaveBeenCalledTimes(DEVICE_CLAIM_MIRROR_RETRY_DELAYS_MS.length + 1);
    timer.advanceTime(1_000_000);
    expect(probe).toHaveBeenCalledTimes(DEVICE_CLAIM_MIRROR_RETRY_DELAYS_MS.length + 1);
    expect(open).not.toHaveBeenCalled();
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
    expect(timer.getPendingSleepCount()).toBe(0);
    hub.dispose();
  });

  test.each(["mirror", "hub"] as const)("%s disposal stops both hooks", (target) => {
    const { timer, probe, open, mirror, hub, appear } = harness();
    mirror.claimed("emulator-5554", OWNER);
    if (target === "hub") {
      hub.dispose();
    } else {
      mirror.dispose();
    }
    appear();
    timer.advanceTime(1_000_000);
    mirror.released("emulator-5554", OWNER);
    hub.registryOpened(new FakeDeviceClaims());
    expect(probe).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a file appearing after exhaustion is discovered by the next release", () => {
    const { timer, open, mirror, hub, appear } = harness();
    mirror.claimed("emulator-5554", OWNER);
    for (const delay of DEVICE_CLAIM_MIRROR_RETRY_DELAYS_MS) {
      timer.advanceTime(delay);
    }
    appear();
    timer.advanceTime(1_000_000);
    expect(open).not.toHaveBeenCalled();
    mirror.released("emulator-5554", OWNER);
    expect(open).toHaveBeenCalledTimes(1);
    hub.dispose();
  });

  test.each(["probe", "open"] as const)("a thrown %s is logged and retried", (target) => {
    const { timer, probe, open, mirror, hub, appear } = harness();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    appear();
    const hook = target === "probe" ? probe : open;
    hook.mockImplementationOnce(() => {
      throw new Error("probe/open unavailable");
    });
    try {
      mirror.claimed("emulator-5554", OWNER);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("Cannot start registry opening");
      timer.advanceTime(DEVICE_CLAIM_MIRROR_RETRY_DELAYS_MS[0]!);
      expect(open).toHaveBeenCalledTimes(target === "probe" ? 1 : 2);
    } finally {
      hub.dispose();
      warn.mockRestore();
    }
  });
});
