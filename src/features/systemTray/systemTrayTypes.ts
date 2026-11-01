import type { Platform } from "../../models";
import type { ActionCall } from "../action/ActionCall";

export interface SystemTrayNotificationArgs {
  title?: string;
  body?: string;
  appId?: string;
  tapActionLabel?: string;
}

export interface SystemTrayArgs {
  action: "open" | "close" | "list" | "find" | "tap" | "dismiss" | "clearAll";
  notification?: SystemTrayNotificationArgs;
  awaitTimeout?: number;
  platform?: Platform;
}

/** The caller's progress sink and abort signal, threaded through the tray helpers. */
export type SystemTrayCall = Pick<ActionCall, "progress" | "signal">;
