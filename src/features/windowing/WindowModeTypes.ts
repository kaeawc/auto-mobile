import type { ElementBounds } from "../../models";

/**
 * Global settings `windowMode` may turn on before entering freeform (#14115). Nothing else
 * can be written through a restore receipt.
 */
export const FREEFORM_SETTING_KEYS = [
  "enable_freeform_support",
  "force_resizable_activities",
] as const;
export type FreeformSettingKey = (typeof FREEFORM_SETTING_KEYS)[number];

/** Which side the app takes in split screen: primary is top (portrait) or left (landscape). */
export const SPLIT_POSITIONS = ["primary", "secondary"] as const;
export type SplitPosition = (typeof SPLIT_POSITIONS)[number];

/** The window mode a `windowMode` call asks for. */
export type WindowModeTarget =
  | "fullscreen"
  | { pip: "enter" | "exit" }
  | { freeform: { bounds?: ElementBounds } }
  | { splitScreen: { with?: string; position?: SplitPosition } };

/** Prior values of the freeform settings this call changed, bound to one device boot. */
export interface WindowSettingsReceipt {
  deviceId: string;
  bootId: string;
  entries: Array<{ key: FreeformSettingKey; value: string | null }>;
}

/** Pass back as `restore` to put the app's window and the device settings back. */
export interface WindowModeRestore {
  mode?: WindowModeTarget;
  settings?: WindowSettingsReceipt;
}

/** One task's window, read back from `dumpsys activity activities`. */
export interface TaskWindowState {
  taskId: number;
  windowingMode: string;
  bounds?: ElementBounds;
}

/** One command a call ran to change the window mode, and what the read-back showed. */
export interface WindowModeAttempt {
  command: string;
  outcome: "reached" | "not_reached" | "failed";
  error?: string;
}

export interface WindowModeResult {
  appId: string;
  /** The read-back state satisfies the request (mode, and bounds or side when given). */
  matched: boolean;
  /** Why `matched` is false. */
  reason?: string;
  /** The app's task before the call; absent when the app had no task. */
  previous?: TaskWindowState;
  /** The app's task after the call; absent when the app has no task. */
  current?: TaskWindowState;
  /** The split-screen partner task, for split-screen requests. */
  partner?: TaskWindowState & { appId: string };
  /** The command whose read-back reached the requested state. */
  method?: string;
  attempts: WindowModeAttempt[];
  settingsChanged: FreeformSettingKey[];
  /** Settings a `restore` call wrote back from its receipt. */
  settingsRestored?: FreeformSettingKey[];
  restore?: WindowModeRestore;
}
