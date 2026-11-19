import type { Platform } from "./Platform";

export type AppLifecycleAction = "background" | "killBackgrounded" | "trimMemory";
/** `ComponentCallbacks2` trim levels `am send-trim-memory` can deliver (#14090). */
export const APP_TRIM_MEMORY_LEVELS = [
  "RUNNING_MODERATE",
  "RUNNING_LOW",
  "RUNNING_CRITICAL",
  "UI_HIDDEN",
  "BACKGROUND",
  "MODERATE",
  "COMPLETE",
] as const;
export type AppTrimMemoryLevel = (typeof APP_TRIM_MEMORY_LEVELS)[number];
/** iOS simulators: a simulated `didReceiveMemoryWarning` for the foreground app (#18754). */
export const IOS_MEMORY_WARNING_LEVEL = "memoryWarning";
/** Every level appLifecycle trimMemory accepts: the Android trim levels and the iOS one. */
export const APP_LIFECYCLE_TRIM_LEVELS = [
  ...APP_TRIM_MEMORY_LEVELS,
  IOS_MEMORY_WARNING_LEVEL,
] as const;
export type AppLifecycleTrimLevel = (typeof APP_LIFECYCLE_TRIM_LEVELS)[number];

export function isAndroidTrimMemoryLevel(
  level: AppLifecycleTrimLevel,
): level is AppTrimMemoryLevel {
  return level !== IOS_MEMORY_WARNING_LEVEL;
}
export type AppLifecycleMechanism =
  | "home"
  | "am-kill"
  | "am-send-trim-memory"
  | "ios-sigkill"
  | "simulator-memory-warning-file"
  | "unsupported";
export type AppLifecycleErrorCode =
  | "app_not_running"
  | "app_in_foreground"
  | "app_not_foreground"
  | "background_not_verified"
  | "kill_failed"
  | "ambiguous_user"
  | "invalid_app_id"
  | "trim_level_required"
  | "trim_level_not_applicable"
  | "trim_failed";

/** State-preserving lifecycle outcome; reclaim requires observed disappearance of the old PID. */
export interface AppLifecycleResult {
  success: boolean;
  supported: boolean;
  action: AppLifecycleAction;
  platform: Platform;
  appId: string;
  mechanism: AppLifecycleMechanism;
  userId?: number;
  pid?: number;
  pidBefore?: number;
  /** Latest verified main PID, or null when no package process was observed. */
  pidAfter?: number | null;
  processReclaimed?: boolean;
  /** The trim level that was sent, for the trimMemory action. */
  trimLevel?: AppLifecycleTrimLevel;
  message?: string;
  errorCode?: AppLifecycleErrorCode;
  error?: string;
}
