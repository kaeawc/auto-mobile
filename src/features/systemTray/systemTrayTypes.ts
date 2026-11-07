import type { Platform } from "../../models";
import type { ActionCall } from "../action/ActionCall";
import type { PostedNotificationContent } from "../utility/postedNotificationLedger";

export interface SystemTrayNotificationArgs {
  title?: string;
  body?: string;
  appId?: string;
  tapActionLabel?: string;
  /**
   * Content `appId` posted through `postNotification`, filled in by systemTray on
   * iOS and never taken from tool input: the only evidence that attributes a lone
   * banner, whose row names no app (#17445).
   */
  postedContents?: readonly PostedNotificationContent[];
}

export interface SystemTrayArgs {
  action: "open" | "close" | "list" | "find" | "tap" | "dismiss" | "clearAll";
  notification?: SystemTrayNotificationArgs;
  awaitTimeout?: number;
  platform?: Platform;
}

/** The caller's progress sink and abort signal, threaded through the tray helpers. */
export type SystemTrayCall = Pick<ActionCall, "progress" | "signal">;
