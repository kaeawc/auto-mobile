import type { Generated, Insertable, Selectable } from "kysely";

// Installed apps cache table
export interface InstalledAppsTable {
  device_id: string;
  user_id: number;
  package_name: string;
  is_system: number; // SQLite boolean (0/1)
  installed_at: number;
  last_verified_at: number;
  profile_type: Generated<"primary" | "managed" | "secondary" | "unknown" | null>;
  daemon_session_id: string | null;
  device_session_start: number | null;
}

export type InstalledApp = Selectable<InstalledAppsTable>;
export type NewInstalledApp = Insertable<InstalledAppsTable>;

export interface InstalledAppsStore {
  getCacheVerifiedAt(deviceId: string): Promise<number | null>;
  getProfileCacheVerifiedAt(deviceId: string, userId: number): Promise<number | null>;
  listInstalledApps(deviceId: string): Promise<InstalledApp[]>;
  replaceInstalledApps(deviceId: string, apps: NewInstalledApp[]): Promise<void>;
  /** Patches a row of an existing snapshot; a no-op on a device with no rows (#10041). */
  upsertInstalledApp(
    deviceId: string,
    userId: number,
    packageName: string,
    isSystem: boolean,
    timestampMs: number,
  ): Promise<void>;
  removeInstalledApp(deviceId: string, userId: number, packageName: string): Promise<void>;
  removeInstalledAppForDevice(deviceId: string, packageName: string): Promise<void>;
  markDeviceStale(deviceId: string): Promise<void>;
  markProfileStale(deviceId: string, userId: number): Promise<void>;
  touchDevice(deviceId: string, timestampMs: number): Promise<void>;
  clearDeviceSession(deviceId: string): Promise<void>;
  /**
   * Drop cache rows tagged by a previous daemon. Rows owned by the current
   * daemon or by any id in `liveDaemonSessionIds` (a live peer sharing this
   * data dir) are kept (issue #11158).
   */
  clearOldDaemonSessions(
    currentDaemonSessionId: string,
    liveDaemonSessionIds?: ReadonlySet<string>,
  ): Promise<void>;
  setSessionTracking(
    daemonSessionId: string,
    deviceId: string,
    deviceSessionStart: number,
  ): Promise<void>;
}
