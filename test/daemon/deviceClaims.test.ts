import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import {
  lazyDeviceClaims,
  StoreDeviceClaimMirror,
  type DeviceClaim,
  type DeviceClaims,
} from "../../src/daemon/deviceClaims";
import { BINDING_REGISTRY_MIGRATIONS } from "../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import * as migration from "../../src/daemon/sessionBroker/registry/migrations/2026_10_26_014_device_claims";
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
    db = (await createTestDatabase()).withTables<DeviceClaimTables>();
    await migration.up(db as Kysely<unknown>);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await db.deleteFrom("device_claims").execute();
    claims = new SqliteDeviceClaims(db);
  });

  test("the migration belongs to the host binding registry", () => {
    expect(BINDING_REGISTRY_MIGRATIONS["2026_10_26_014_device_claims"]).toBe(migration);
  });

  test("an upsert replaces the row for the device and reads back unchanged", async () => {
    await claims.upsert(CLAIM);
    expect(await claims.get("android", "emulator-5554")).toEqual(CLAIM);
    const taken = { ...CLAIM, pid: 200, ownerToken: "token-b", updatedAtMs: 20 };
    delete taken.processGenerationToken;
    await claims.upsert(taken);
    expect(await claims.list()).toEqual([taken]);
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
