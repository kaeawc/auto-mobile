import type { Platform } from "./Platform";

export type AppLifecycleAction = "background" | "killBackgrounded";
export type AppLifecycleMechanism = "home" | "am-kill" | "unsupported";
export type AppLifecycleErrorCode =
  | "app_not_running"
  | "app_in_foreground"
  | "background_not_verified"
  | "kill_failed"
  | "ambiguous_user"
  | "invalid_app_id";

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
  message?: string;
  errorCode?: AppLifecycleErrorCode;
  error?: string;
}
