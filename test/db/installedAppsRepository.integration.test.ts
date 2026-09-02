import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { InstalledAppsRepository } from "../../src/db/installedAppsRepository";
import { createTestDatabase } from "./testDbHelper";

describe("InstalledAppsRepository", () => {
  let db: Kysely<Database>;
  let repo: InstalledAppsRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new InstalledAppsRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("upsertInstalledApp and listInstalledApps", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.example.app", false, 1000);

    const apps = await repo.listInstalledApps("device-1");
    expect(apps).toHaveLength(1);
    expect(apps[0].device_id).toBe("device-1");
    expect(apps[0].user_id).toBe(0);
    expect(apps[0].package_name).toBe("com.example.app");
    expect(apps[0].is_system).toBe(0);
    expect(apps[0].installed_at).toBe(1000);
    expect(apps[0].last_verified_at).toBe(1000);
  });

  test("upsertInstalledApp updates existing entry on conflict", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.example.app", false, 1000);
    await repo.upsertInstalledApp("device-1", 0, "com.example.app", true, 2000);

    const apps = await repo.listInstalledApps("device-1");
    expect(apps).toHaveLength(1);
    expect(apps[0].is_system).toBe(1);
    expect(apps[0].last_verified_at).toBe(2000);
    // installed_at should remain unchanged from original insert
    expect(apps[0].installed_at).toBe(1000);
  });

  test("listInstalledApps returns empty for unknown device", async () => {
    const apps = await repo.listInstalledApps("unknown-device");
    expect(apps).toHaveLength(0);
  });

  test("replaceInstalledApps replaces all apps for a device", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.old.app", false, 1000);
    await repo.upsertInstalledApp("device-1", 0, "com.another.app", false, 1000);

    await repo.replaceInstalledApps("device-1", [
      {
        device_id: "device-1",
        user_id: 0,
        package_name: "com.new.app",
        is_system: 0,
        installed_at: 2000,
        last_verified_at: 2000,
      },
    ]);

    const apps = await repo.listInstalledApps("device-1");
    expect(apps).toHaveLength(1);
    expect(apps[0].package_name).toBe("com.new.app");
  });

  test("replaceInstalledApps with empty array clears all apps", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.example.app", false, 1000);

    await repo.replaceInstalledApps("device-1", []);

    const apps = await repo.listInstalledApps("device-1");
    expect(apps).toHaveLength(0);
  });

  test("replaceInstalledApps does not affect other devices", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.app1", false, 1000);
    await repo.upsertInstalledApp("device-2", 0, "com.app2", false, 1000);

    await repo.replaceInstalledApps("device-1", []);

    const device1Apps = await repo.listInstalledApps("device-1");
    const device2Apps = await repo.listInstalledApps("device-2");
    expect(device1Apps).toHaveLength(0);
    expect(device2Apps).toHaveLength(1);
  });

  test("removeInstalledApp removes specific app", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.app1", false, 1000);
    await repo.upsertInstalledApp("device-1", 0, "com.app2", false, 1000);

    await repo.removeInstalledApp("device-1", 0, "com.app1");

    const apps = await repo.listInstalledApps("device-1");
    expect(apps).toHaveLength(1);
    expect(apps[0].package_name).toBe("com.app2");
  });

  test("removeInstalledAppForDevice removes app across all users", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.app1", false, 1000);
    await repo.upsertInstalledApp("device-1", 10, "com.app1", false, 1000);

    await repo.removeInstalledAppForDevice("device-1", "com.app1");

    const apps = await repo.listInstalledApps("device-1");
    expect(apps).toHaveLength(0);
  });

  test("getLatestVerification returns max last_verified_at", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.app1", false, 1000);
    await repo.upsertInstalledApp("device-1", 0, "com.app2", false, 2000);

    const latest = await repo.getLatestVerification("device-1");
    expect(latest).toBe(2000);
  });

  test("getLatestVerification returns null for unknown device", async () => {
    const latest = await repo.getLatestVerification("unknown");
    expect(latest).toBeNull();
  });

  test("getLatestVerificationForProfile filters by userId", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.app1", false, 1000);
    await repo.upsertInstalledApp("device-1", 10, "com.app2", false, 3000);

    const latest = await repo.getLatestVerificationForProfile("device-1", 0);
    expect(latest).toBe(1000);
  });

  test("markDeviceStale sets last_verified_at to 0 for all apps on device", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.app1", false, 1000);
    await repo.upsertInstalledApp("device-1", 0, "com.app2", false, 2000);

    await repo.markDeviceStale("device-1");

    const apps = await repo.listInstalledApps("device-1");
    for (const app of apps) {
      expect(app.last_verified_at).toBe(0);
    }
  });

  test("markProfileStale only affects the specified user", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.app1", false, 1000);
    await repo.upsertInstalledApp("device-1", 10, "com.app2", false, 2000);

    await repo.markProfileStale("device-1", 0);

    const apps = await repo.listInstalledApps("device-1");
    const user0App = apps.find((a) => a.user_id === 0);
    const user10App = apps.find((a) => a.user_id === 10);
    expect(user0App!.last_verified_at).toBe(0);
    expect(user10App!.last_verified_at).toBe(2000);
  });

  test("touchDevice updates last_verified_at for all apps on device", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.app1", false, 1000);
    await repo.upsertInstalledApp("device-1", 0, "com.app2", false, 1000);

    await repo.touchDevice("device-1", 5000);

    const apps = await repo.listInstalledApps("device-1");
    for (const app of apps) {
      expect(app.last_verified_at).toBe(5000);
    }
  });

  test("clearDeviceSession deletes all apps for device", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.app1", false, 1000);
    await repo.upsertInstalledApp("device-1", 0, "com.app2", false, 1000);

    await repo.clearDeviceSession("device-1");

    const apps = await repo.listInstalledApps("device-1");
    expect(apps).toHaveLength(0);
  });

  test("clearDeviceSession does not affect other devices", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.app1", false, 1000);
    await repo.upsertInstalledApp("device-2", 0, "com.app2", false, 1000);

    await repo.clearDeviceSession("device-1");

    const device2Apps = await repo.listInstalledApps("device-2");
    expect(device2Apps).toHaveLength(1);
  });

  test("setSessionTracking and clearOldDaemonSessions", async () => {
    await repo.upsertInstalledApp("device-1", 0, "com.app1", false, 1000);
    await repo.upsertInstalledApp("device-2", 0, "com.app2", false, 1000);

    // Set session tracking for device-1
    await repo.setSessionTracking("session-A", "device-1", 1000);

    // Set session tracking for device-2 with different session
    await repo.setSessionTracking("session-B", "device-2", 2000);

    // Clear old sessions, keeping only session-A
    await repo.clearOldDaemonSessions("session-A");

    const device1Apps = await repo.listInstalledApps("device-1");
    const device2Apps = await repo.listInstalledApps("device-2");
    expect(device1Apps).toHaveLength(1);
    expect(device2Apps).toHaveLength(0);
  });

  test("setSessionTracking claims only unowned rows and never rebinds another daemon's rows", async () => {
    // Row already owned by daemon-A, and a second unowned row on the same device.
    await db
      .insertInto("installed_apps")
      .values({
        device_id: "device-1",
        user_id: 0,
        package_name: "com.owned",
        is_system: 0,
        installed_at: 1000,
        last_verified_at: 1000,
        daemon_session_id: "daemon-A",
        device_session_start: 500,
      })
      .execute();
    await db
      .insertInto("installed_apps")
      .values({
        device_id: "device-1",
        user_id: 0,
        package_name: "com.unowned",
        is_system: 0,
        installed_at: 1000,
        last_verified_at: 1000,
      })
      .execute();

    await repo.setSessionTracking("daemon-B", "device-1", 999);

    const rows = await repo.listInstalledApps("device-1");
    const owned = rows.find((r) => r.package_name === "com.owned");
    const unowned = rows.find((r) => r.package_name === "com.unowned");

    // daemon-A's row must be left untouched; only the unowned row is claimed.
    expect(owned!.daemon_session_id).toBe("daemon-A");
    expect(owned!.device_session_start).toBe(500);
    expect(unowned!.daemon_session_id).toBe("daemon-B");
    expect(unowned!.device_session_start).toBe(999);
  });
});
