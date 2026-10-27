import { opaqueIntentKey } from "../daemon/sessionBroker/mutations/types";
import { isManufacturerProfileId } from "../devices/sessionRequirements/parsing";
import { OEM_PERSONAS, personaFacets } from "../features/utility/OemPersonas";
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
 *   `keyboard setProfile` records, plus a fallback intent for kill/display facets or an unknown
 *   or missing persona (defensive: the tool schema enum normally rejects invalid ids). Their
 *   in-memory restore receipts cannot prove a clean reset. Intent is recorded before the handler
 *   runs, so even an apply later refused (e.g. route_to_real_device) falls back; an accepted cost.
 *   `list`, `describe`, `reset` and iOS calls change nothing.
 */
export function appearanceToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] | undefined {
  switch (name) {
    case "statusBar":
      return args.action === "override" ? [STATUS_BAR_MUTATION] : [];
    case "manufacturerProfile": {
      if (args.action !== "apply" || platform !== "android") {
        return [];
      }
      const id = args.manufacturerProfile;
      const persona = isManufacturerProfileId(id) ? OEM_PERSONAS[id] : undefined;
      const mutations: ToolMutation[] = [{ kind: "keyboard", key: "profile" }];
      if (
        !persona ||
        personaFacets(persona).some((facet) => facet === "kill" || facet === "display")
      ) {
        mutations.push({ kind: "opaque", key: opaqueIntentKey("manufacturerProfile", "apply") });
      }
      return mutations;
    }
    default:
      return undefined;
  }
}
