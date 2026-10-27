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
export type AppLifecycleMechanism =
  | "home"
  | "am-kill"
  | "am-send-trim-memory"
  | "ios-sigkill"
  | "unsupported";
export type AppLifecycleErrorCode =
  | "app_not_running"
  | "app_in_foreground"
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
  /** The `onTrimMemory` level that was sent, for the trimMemory action. */
  trimLevel?: AppTrimMemoryLevel;
  message?: string;
  errorCode?: AppLifecycleErrorCode;
  error?: string;
}
