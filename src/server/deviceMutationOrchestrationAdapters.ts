import type { Platform } from "../models";
import { opaqueIntentKey } from "../daemon/sessionBroker/mutations/types";
import { isRecord } from "./pipeline/isRecord";
import type { ToolMutation } from "./deviceMutationAdapters";

function fallback(...parts: readonly unknown[]): ToolMutation {
  return { kind: "opaque", key: opaqueIntentKey(...parts) };
}

/**
 * Whether an Android prototype show leaves state that outlives the session and that neither a
 * revert nor the baseline clean removes: a device-persistent window, a window above apps (the
 * daemon grants CtrlProxy SYSTEM_ALERT_WINDOW first) and a `storage` block (the device saves the
 * listed values per prototype id and restores them on the next show).
 */
function showLeavesDeviceState(spec: unknown): boolean {
  if (!isRecord(spec)) {
    return false;
  }
  const window = isRecord(spec.window) ? spec.window : {};
  return window.persistence === "device" || window.layer === "app" || spec.storage !== undefined;
}

function prototypeMutations(args: Record<string, unknown>, platform?: Platform): ToolMutation[] {
  if (platform !== "android") {
    // The iOS simulator keeps a prototype in the injected agent's process; a saved prototype is an
    // installed app, which the iOS app-inventory clean removes.
    return [];
  }
  switch (args.action) {
    case "save":
      return [fallback("prototype", "save")];
    case "show":
      // A spec given as specPath is resolved before this runs; an unreadable one stays unknown.
      return args.specPath !== undefined && args.spec === undefined
        ? [fallback("prototype", "show", "unresolved-spec")]
        : showLeavesDeviceState(args.spec)
          ? [fallback("prototype", "show", "device-state")]
          : [];
    default:
      return [];
  }
}

/**
 * Orchestration, composite and device-resource tools (#14359).
 * - `getAndroid`, `getApple`, `startDevice`, `provisionDevice`, `killDevice` and `deleteDevice` are
 *   registered without a device handler: they never reach the recorder, and a broker session
 *   refuses them (the binding journal owns native lifecycle).
 * - `barrier` only waits on a host-side coordinator.
 * - `criticalSection`, `executePlan`, `explore` and `navigateTo` run their device steps through the
 *   recorded dispatcher or through input primitives that change no persistent state; an
 *   `executePlan` whose cleanup clears app data records the same intent `launchApp` does.
 * - `setDeviceResources` and `reconcileDeviceResources` repair change optional apps, settings and
 *   simulator services whose prior state has no captured reader, so a call that applies resources
 *   records a `fallback:` intent. `restore` and report-only calls change nothing new.
 * - `prototype` records according to {@link prototypeMutations}; shows, patches, dismissals and
 *   reads of a session prototype are dismissed when the CtrlProxy client disconnects.
 */
export function orchestrationToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] | undefined {
  switch (name) {
    case "getAndroid":
    case "getApple":
    case "startDevice":
    case "provisionDevice":
    case "killDevice":
    case "deleteDevice":
    case "barrier":
    case "criticalSection":
    case "explore":
    case "navigateTo":
      return [];
    case "executePlan":
      return args.cleanupClearAppData === true && typeof args.cleanupAppId === "string"
        ? [fallback("clearAppData", args.cleanupAppId)]
        : [];
    case "setDeviceResources":
      return isRecord(args.resources) && Object.keys(args.resources).length > 0
        ? [fallback("setDeviceResources")]
        : [];
    case "reconcileDeviceResources":
      return args.repair === true ? [fallback("reconcileDeviceResources")] : [];
    case "prototype":
      return prototypeMutations(args, platform);
    default:
      return undefined;
  }
}
