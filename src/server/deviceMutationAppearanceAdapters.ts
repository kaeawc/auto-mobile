import type { Platform } from "../models";
import type { ToolMutation } from "./deviceMutationAdapters";

/** The status-bar override a session leaves behind: one row per device, restored on reset. */
export const STATUS_BAR_MUTATION: ToolMutation = { kind: "status-bar", key: "device" };

/**
 * Appearance tools (#14359):
 * - `statusBar override` turns on Android SystemUI demo mode (`sysui_demo_allowed` plus the demo
 *   broadcasts) or an iOS Simulator `status_bar` override. `clear` and `get` leave nothing behind
 *   (the clear is the revert itself; the session-release cleanup that also clears it is in-memory
 *   and best effort, so the journal row stays the durable record).
 * - `manufacturerProfile apply` composes the keyboard, kill and display profile executors on
 *   Android, each backed by a session-owned restore receipt (`PersonaRestoreRegistry`). Those
 *   executors bypass the recorded dispatcher, so the call records the keyboard profile row that
 *   `keyboard setProfile` records, plus a breadcrumb for the kill and display facets. `list`,
 *   `describe`, `reset`, iOS calls and a call that cannot apply change nothing.
 */
export function appearanceToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] | undefined {
  switch (name) {
    case "statusBar":
      return args.action === "override" ? [STATUS_BAR_MUTATION] : [];
    case "manufacturerProfile":
      return args.action === "apply" && platform === "android"
        ? [
            { kind: "keyboard", key: "profile" },
            { kind: "opaque", key: "tool:manufacturerProfile" },
          ]
        : [];
    default:
      return undefined;
  }
}
