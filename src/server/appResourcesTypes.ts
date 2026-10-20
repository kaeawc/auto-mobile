import type { Platform } from "../models";

export type InstalledAppType = "user" | "system";
/**
 * `launchable` is a cross-cutting filter, not a fourth classification: an app
 * keeps its "user"/"system" type and is additionally selected by whether it has
 * a launcher entry point. It is the default because the previous "user" default
 * hid every system app a human names in a task — Contacts, Clock, Settings —
 * while still returning providers and RRO overlays under type=all (#6798).
 */
export type AppsQueryType = InstalledAppType | "all" | "launchable";

export interface AppsQueryOptions {
  platform?: Platform;
  search?: string;
  type?: AppsQueryType;
  profile?: number;
  deviceId?: string;
}

export interface AppsQueryAppInfo {
  packageName: string;
  type: InstalledAppType;
  foreground: boolean;
  recent: boolean;
  userId?: number;
  userProfile?: "personal" | "work" | "secondary" | "unknown";
  userIds?: number[];
  /**
   * Launcher label as a human sees it ("Contacts"). Absent when no source
   * reported one — on Android that means CtrlProxy was unavailable, since adb
   * cannot resolve a package's label resource (#6798).
   */
  label?: string;
  /**
   * iOS-only legacy alias for client compatibility; `label` is canonical
   * going forward (#6798).
   */
  displayName?: string;
  /**
   * Whether the app has a launchable entry point. For a deduplicated Android
   * system app this summarizes "launches for at least one of `userIds`".
   * `undefined` means "not reported", never "no" (#6798).
   */
  launchable?: boolean;
  /**
   * Launchability per Android user id, where it was reported. A launcher
   * activity can be disabled for the owner and enabled in a work profile, so a
   * profile-scoped query reads this rather than the scalar (#6798 review).
   */
  launchableByUserId?: Record<number, boolean>;
}

export interface AppsQueryDeviceContent {
  deviceId: string;
  platform: Platform;
  totalCount: number;
  lastUpdated: string;
  apps: AppsQueryAppInfo[];
}

export interface AppsQueryResourceContent {
  query: AppsQueryOptions;
  observationComplete: boolean;
  totalCount: number;
  /**
   * Apps installed on the device before any filter was applied. Lets a caller
   * see that a small result is a filter effect rather than a short device
   * inventory, so the default no longer hides apps silently (#6798).
   */
  installedCount: number;
  deviceCount: number;
  lastUpdated: string;
  devices: AppsQueryDeviceContent[];
  /**
   * Android user ids whose apps carried no launchability signal at all (their
   * launcher probe failed while another profile's succeeded). Present only when
   * non-empty: the `launchable` filter cannot judge those profiles, so naming
   * them keeps a device-wide query from dropping them silently (#6798 review).
   */
  launchabilityUnknownProfiles?: number[];
  /**
   * Apps matching this query's profile and search filters whose launchability
   * was not reported. Present only when non-empty: the `launchable` filter
   * excludes them until they are proven launchable rather than silently
   * presenting missing metadata as a negative answer (#6798 review).
   */
  launchabilityUnknownApps?: string[];
}

// Resource content schema
export interface AppsResourceContent {
  deviceId: string;
  platform: Platform;
  observationComplete: boolean;
  apps: InstalledAppInfo[];
  totalCount: number;
  foregroundApp: string | null;
  lastUpdated: string; // ISO 8601
  message?: string;
}

export interface AndroidInstalledAppInfo {
  packageName: string;
  userId: number;
  userProfile: "personal" | "work" | "secondary" | "unknown";
  foreground: boolean;
  recent: boolean;
  label?: string;
  launchable?: boolean;
}

export interface IosInstalledAppInfo {
  bundleId: string;
  type: InstalledAppType;
  displayName?: string;
  version?: string;
  path?: string;
  launchable?: boolean;
}

export type InstalledAppInfo = AndroidInstalledAppInfo | IosInstalledAppInfo;

export interface AppsCacheEntry {
  expiresAt: number;
  content: AppsResourceContent;
  appsByPackage: Map<string, InstalledAppInfo[]>;
  queryApps: AppsQueryAppInfo[];
  /**
   * True when at least one iOS app on this (physical) device could not be
   * reliably classified user/system (#6216 review, round 5). Gates whether an
   * explicit type=system/type=user filter is honored or rejected — see
   * queryInstalledApps. Always false/undefined for Android and the simulator.
   */
  iosTypeClassificationUnreliable?: boolean;
  /**
   * True when this device reported apps but none of them carried a
   * launchability signal, so the `launchable` filter (the documented default)
   * cannot be applied honestly and degrades to "user" (#6798).
   */
  launchabilityUnknown?: boolean;
  /**
   * The subset of profiles for which that is true. A launcher probe is issued
   * per Android user, so one can fail while another succeeds; a device-wide
   * boolean would then report the failed profile's apps as "not launchable"
   * (#6798 review).
   */
  launchabilityUnknownProfiles?: number[];
}
