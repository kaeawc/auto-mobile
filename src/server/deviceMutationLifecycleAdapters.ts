import type { Platform } from "../models";
import { opaqueIntentKey } from "../daemon/sessionBroker/mutations/types";
import type { ToolMutation } from "./deviceMutationAdapters";
import { launchedAppIntentKey } from "../daemon/sessionBroker/mutations/launchedApp";

/** App-scoped effects no revert and no baseline clean undoes: the first fallback key part. */
export const APP_FALLBACK_TOOLS = [
  "installApp",
  "uninstallApp",
  "clearAppData",
  "measureStartup",
] as const;

export function appFallback(
  tool: (typeof APP_FALLBACK_TOOLS)[number],
  appId: unknown,
  keepData = false,
): ToolMutation {
  return {
    kind: "opaque",
    key: opaqueIntentKey(
      tool,
      typeof appId === "string" && appId.length > 0 ? appId : null,
      ...(keepData ? [true] : []),
    ),
  };
}

/**
 * App lifecycle tools (#14359).
 * - Process-only and host-artifact tools (`terminateApp`, `performanceTrace`, ...) are
 *   `notJournaled` in `DEVICE_MUTATION_TOOL_COVERAGE` and never reach this adapter.
 * - `launchApp` is `am start` / `simctl launch`, except `clearAppData`, which destroys app data
 *   nothing restores, so it records a `fallback:` intent.
 * - `measureStartup` with a compilation mode other than `asIs` runs `cmd package compile`, which
 *   persists across reboots, so it records a `fallback:` intent. Every other call only force-stops,
 *   drops caches and launches.
 * - On Android both also record a non-fallback launch row (`launchedAppIntentKey`): the started
 *   app may write its own data, which keep-booted cleaning clears for a preinstalled app.
 * - `installApp` and `uninstallApp` keep the `installed-app` row the baseline clean reverts for a
 *   session-installed app. They also record a `fallback:` intent: the clean cannot reinstall an app
 *   the baseline held, nor undo an APK replacement or restore its data. The recording layer drops
 *   that intent when the session itself installed an app the baseline did not hold
 *   (`withoutSessionCoveredFallbacks`). An uninstall that keeps data always retains its fallback:
 *   the package inventory cannot see removed packages whose data remains.
 */
function installMutations(args: Record<string, unknown>): ToolMutation[] {
  return [
    ...(typeof args.appId === "string"
      ? [{ kind: "installed-app", key: args.appId } satisfies ToolMutation]
      : []),
    appFallback("installApp", args.appId),
  ];
}

function launched(args: Record<string, unknown>, platform?: Platform): ToolMutation[] {
  return platform === "android" && typeof args.appId === "string" && args.appId.length > 0
    ? [{ kind: "opaque", key: launchedAppIntentKey(args.appId) }]
    : [];
}

const APP_TOOL_MUTATIONS: Readonly<
  Record<string, (args: Record<string, unknown>, platform?: Platform) => ToolMutation[]>
> = {
  launchApp: (args, platform) => [
    ...(args.clearAppData === true ? [appFallback("clearAppData", args.appId)] : []),
    ...launched(args, platform),
  ],
  measureStartup: (args, platform) => [
    ...(args.compilation !== undefined && args.compilation !== "asIs"
      ? [appFallback("measureStartup", args.appId)]
      : []),
    ...launched(args, platform),
  ],
  installApp: installMutations,
  uninstallApp: (args) => [
    { kind: "installed-app", key: String(args.appId) },
    appFallback("uninstallApp", args.appId, args.keepData === true),
  ],
};

export function lifecycleToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] | undefined {
  return Object.hasOwn(APP_TOOL_MUTATIONS, name)
    ? APP_TOOL_MUTATIONS[name](args, platform)
    : undefined;
}
