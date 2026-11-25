import type { Platform } from "../models";
import { opaqueIntentKey } from "../daemon/sessionBroker/mutations/types";
import { isRecord } from "./pipeline/isRecord";
import type { ToolMutation } from "./deviceMutationAdapters";
import { appFallback } from "./deviceMutationLifecycleAdapters";
import {
  DISPOSABLE_APP_SLUG_PATTERN,
  MAX_DISPOSABLE_APP_SLUG_LENGTH,
  disposableAppId,
} from "../features/prototype/disposableApp/disposableAppId";

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

/**
 * A disposable-app install (#14184) records what `installApp` records for the app id its slug
 * stamps: the `installed-app` row the baseline clean (Android) and app-inventory reset (iOS)
 * remove, and the fallback for an install over an app the baseline held. An invalid slug is
 * refused before anything is installed, so it records nothing.
 */
function disposableInstallMutations(
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] {
  const slug = isRecord(args.app) ? args.app.slug : undefined;
  if (
    (platform !== "android" && platform !== "ios") ||
    typeof slug !== "string" ||
    slug.length > MAX_DISPOSABLE_APP_SLUG_LENGTH ||
    !DISPOSABLE_APP_SLUG_PATTERN.test(slug)
  ) {
    return [];
  }
  const appId = disposableAppId(platform, slug);
  return [{ kind: "installed-app", key: appId }, appFallback("installApp", appId)];
}

function prototypeMutations(args: Record<string, unknown>, platform?: Platform): ToolMutation[] {
  if (args.action === "installApp") {
    return disposableInstallMutations(args, platform);
  }
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
 * - Device lifecycle and coordination tools (`getAndroid`, `killDevice`, `barrier`,
 *   `criticalSection`, `explore`, `navigateTo`, ...) are `notJournaled` in
 *   `DEVICE_MUTATION_TOOL_COVERAGE` and never reach this adapter.
 * - `executePlan` runs its device steps through the recorded dispatcher; one whose cleanup clears
 *   app data records the same intent `launchApp` does.
 * - `setDeviceResources` and `reconcileDeviceResources` repair change optional apps, settings and
 *   simulator services whose prior state has no captured reader, so a call that applies resources
 *   records a `fallback:` intent. `restore` and report-only calls change nothing new.
 * - `prototype` records according to {@link prototypeMutations}; shows, patches, dismissals and
 *   reads of a session prototype are dismissed when the CtrlProxy client disconnects. A
 *   disposable-app `uninstallApp` removes only reserved-prefix apps and records nothing.
 */
const ORCHESTRATION_MUTATIONS: Readonly<
  Record<string, (args: Record<string, unknown>, platform?: Platform) => ToolMutation[]>
> = {
  executePlan: (args) =>
    args.cleanupClearAppData === true && typeof args.cleanupAppId === "string"
      ? [fallback("clearAppData", args.cleanupAppId)]
      : [],
  setDeviceResources: (args) =>
    isRecord(args.resources) && Object.keys(args.resources).length > 0
      ? [fallback("setDeviceResources")]
      : [],
  reconcileDeviceResources: (args) =>
    args.repair === true ? [fallback("reconcileDeviceResources")] : [],
  prototype: prototypeMutations,
};

export function orchestrationToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] | undefined {
  return Object.hasOwn(ORCHESTRATION_MUTATIONS, name)
    ? ORCHESTRATION_MUTATIONS[name](args, platform)
    : undefined;
}
