import { describe, expect, test } from "bun:test";
import type { InstalledAppsStore, NewInstalledApp } from "../../src/models/InstalledAppsStore";

export interface InstalledAppsStoreHandle {
  repository: InstalledAppsStore;
  dispose?: () => Promise<void>;
}

function app(
  deviceId: string,
  userId: number,
  packageName: string,
  verifiedAt: number,
  overrides: Partial<NewInstalledApp> = {},
): NewInstalledApp {
  return {
    device_id: deviceId,
    user_id: userId,
    package_name: packageName,
    is_system: 0,
    installed_at: 1,
    last_verified_at: verifiedAt,
    ...overrides,
  };
}

/** The columns every store must agree on; the real table also carries defaulted extras. */
async function snapshot(repository: InstalledAppsStore, deviceId: string) {
  const rows = await repository.listInstalledApps(deviceId);
  return rows
    .map((row) => ({
      user: row.user_id,
      pkg: row.package_name,
      system: row.is_system,
      verified: Number(row.last_verified_at),
      session: row.daemon_session_id ?? null,
      start: row.device_session_start ?? null,
    }))
    .sort((a, b) => `${a.user}/${a.pkg}`.localeCompare(`${b.user}/${b.pkg}`));
}

/**
 * Shared behavioural contract for {@link InstalledAppsStore} (#11868): run it against the
 * in-memory fake and the SQLite repository over an in-memory database.
 */
export function runInstalledAppsStoreContract(
  name: string,
  make: () => Promise<InstalledAppsStoreHandle>,
): void {
  const withStore = async (body: (store: InstalledAppsStore) => Promise<void>): Promise<void> => {
    const handle = await make();
    try {
      await body(handle.repository);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`InstalledAppsStore contract: ${name}`, () => {
    test("an empty store has no rows and no verification time", () =>
      withStore(async (store) => {
        expect(await store.listInstalledApps("d1")).toEqual([]);
        expect(await store.getCacheVerifiedAt("d1")).toBeNull();
        expect(await store.getProfileCacheVerifiedAt("d1", 0)).toBeNull();
      }));

    test("replaceInstalledApps replaces only the named device's rows", () =>
      withStore(async (store) => {
        await store.replaceInstalledApps("d1", [app("d1", 0, "a", 10), app("d1", 0, "b", 10)]);
        await store.replaceInstalledApps("d2", [app("d2", 0, "x", 10)]);
        await store.replaceInstalledApps("d1", [app("d1", 0, "c", 20)]);
        expect((await snapshot(store, "d1")).map((row) => row.pkg)).toEqual(["c"]);
        expect((await snapshot(store, "d2")).map((row) => row.pkg)).toEqual(["x"]);
        await store.replaceInstalledApps("d1", []);
        expect(await store.listInstalledApps("d1")).toEqual([]);
      }));

    test("freshness is the minimum across the device and across a profile", () =>
      withStore(async (store) => {
        await store.replaceInstalledApps("d1", [
          app("d1", 0, "a", 50),
          app("d1", 0, "b", 30),
          app("d1", 10, "w", 70),
        ]);
        expect(await store.getCacheVerifiedAt("d1")).toBe(30);
        expect(await store.getProfileCacheVerifiedAt("d1", 0)).toBe(30);
        expect(await store.getProfileCacheVerifiedAt("d1", 10)).toBe(70);
        expect(await store.getProfileCacheVerifiedAt("d1", 99)).toBeNull();
      }));

    test("upsertInstalledApp patches an existing snapshot and never creates the first row", () =>
      withStore(async (store) => {
        await store.upsertInstalledApp("d1", 0, "a", { isSystem: false, timestampMs: 5 });
        expect(await store.listInstalledApps("d1")).toEqual([]);

        await store.replaceInstalledApps("d1", [app("d1", 0, "a", 10)]);
        await store.upsertInstalledApp("d1", 0, "a", { isSystem: true, timestampMs: 40 });
        await store.upsertInstalledApp("d1", 0, "new", { isSystem: false, timestampMs: 40 });
        expect(await snapshot(store, "d1")).toEqual([
          { user: 0, pkg: "a", system: 1, verified: 40, session: null, start: null },
          { user: 0, pkg: "new", system: 0, verified: 40, session: null, start: null },
        ]);
      }));

    test("removal is scoped to the profile, or to every profile of the device", () =>
      withStore(async (store) => {
        await store.replaceInstalledApps("d1", [
          app("d1", 0, "a", 1),
          app("d1", 10, "a", 1),
          app("d1", 0, "b", 1),
        ]);
        await store.removeInstalledApp("d1", 10, "a");
        expect((await snapshot(store, "d1")).map((row) => `${row.user}/${row.pkg}`)).toEqual([
          "0/a",
          "0/b",
        ]);
        await store.removeInstalledAppForDevice("d1", "a");
        expect((await snapshot(store, "d1")).map((row) => row.pkg)).toEqual(["b"]);
      }));

    test("stale marks and touches reset verification for the device or profile only", () =>
      withStore(async (store) => {
        await store.replaceInstalledApps("d1", [app("d1", 0, "a", 50), app("d1", 10, "w", 60)]);
        await store.replaceInstalledApps("d2", [app("d2", 0, "x", 80)]);
        await store.markProfileStale("d1", 10);
        expect(await store.getProfileCacheVerifiedAt("d1", 10)).toBe(0);
        expect(await store.getProfileCacheVerifiedAt("d1", 0)).toBe(50);
        await store.touchDevice("d1", 90);
        expect(await store.getCacheVerifiedAt("d1")).toBe(90);
        await store.markDeviceStale("d1");
        expect(await store.getCacheVerifiedAt("d1")).toBe(0);
        expect(await store.getCacheVerifiedAt("d2")).toBe(80);
      }));

    test("session tracking stamps only untracked rows and old sessions are cleared", () =>
      withStore(async (store) => {
        await store.replaceInstalledApps("d1", [app("d1", 0, "a", 1)]);
        await store.setSessionTracking("s-old", "d1", 100);
        await store.replaceInstalledApps("d1", [
          app("d1", 0, "a", 1, { daemon_session_id: "s-old", device_session_start: 100 }),
          app("d1", 0, "b", 1),
        ]);
        await store.setSessionTracking("s-new", "d1", 200);
        expect(await snapshot(store, "d1")).toEqual([
          { user: 0, pkg: "a", system: 0, verified: 1, session: "s-old", start: 100 },
          { user: 0, pkg: "b", system: 0, verified: 1, session: "s-new", start: 200 },
        ]);

        await store.clearOldDaemonSessions("s-new");
        expect((await snapshot(store, "d1")).map((row) => row.pkg)).toEqual(["b"]);

        await store.replaceInstalledApps("d2", [
          app("d2", 0, "x", 1, { daemon_session_id: "s-live", device_session_start: 1 }),
          app("d2", 0, "y", 1),
        ]);
        await store.clearOldDaemonSessions("s-new", new Set(["s-live"]));
        expect((await snapshot(store, "d2")).map((row) => row.pkg)).toEqual(["x", "y"]);
        await store.clearOldDaemonSessions("s-new");
        expect((await snapshot(store, "d2")).map((row) => row.pkg)).toEqual(["y"]);
      }));

    test("clearDeviceSession drops every row of the device", () =>
      withStore(async (store) => {
        await store.replaceInstalledApps("d1", [app("d1", 0, "a", 1)]);
        await store.replaceInstalledApps("d2", [app("d2", 0, "x", 1)]);
        await store.clearDeviceSession("d1");
        expect(await store.listInstalledApps("d1")).toEqual([]);
        expect((await store.listInstalledApps("d2")).length).toBe(1);
      }));
  });
}
