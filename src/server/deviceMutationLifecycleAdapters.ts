import type { Platform } from "../models";
import { opaqueIntentKey } from "../daemon/sessionBroker/mutations/types";
import type { ToolMutation } from "./deviceMutationAdapters";

/** App-scoped effects no revert and no baseline clean undoes: the first fallback key part. */
export const APP_FALLBACK_TOOLS = [
  "installApp",
  "uninstallApp",
  "clearAppData",
  "measureStartup",
] as const;

function appFallback(tool: (typeof APP_FALLBACK_TOOLS)[number], appId: unknown): ToolMutation {
  return {
    kind: "opaque",
    key: opaqueIntentKey(tool, typeof appId === "string" && appId.length > 0 ? appId : null),
  };
}

/**
 * App lifecycle tools (#14359).
 * - `terminateApp`, `crashApp`, `appLifecycle`, `performanceTrace`, `videoRecording` and
 *   `recordDeviceGestures` act on a process or leave only host-side artifacts (a device-side
 *   recording or trace file is removed after the pull), so they change no persistent device state.
 * - `launchApp` is `am start` / `simctl launch`, except `clearAppData`, which destroys app data
 *   nothing restores, so it records a `fallback:` intent.
 * - `measureStartup` with a compilation mode other than `asIs` runs `cmd package compile`, which
 *   persists across reboots, so it records a `fallback:` intent. Every other call only force-stops,
 *   drops caches and launches.
 * - `installApp` and `uninstallApp` keep the `installed-app` row the baseline clean reverts for a
 *   session-installed app. They also record a `fallback:` intent: the clean cannot reinstall an app
 *   the baseline held, nor undo an APK replacement or restore its data. The recording layer drops
 *   that intent when the session itself installed an app the baseline did not hold
 *   (`withoutSessionCoveredFallbacks`).
 */
const PROCESS_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "terminateApp",
  "crashApp",
  "appLifecycle",
  "performanceTrace",
  "videoRecording",
  "recordDeviceGestures",
]);

function installMutations(args: Record<string, unknown>): ToolMutation[] {
  return [
    ...(typeof args.appId === "string"
      ? [{ kind: "installed-app", key: args.appId } satisfies ToolMutation]
      : []),
    appFallback("installApp", args.appId),
  ];
}

const APP_TOOL_MUTATIONS: Readonly<
  Record<string, (args: Record<string, unknown>) => ToolMutation[]>
> = {
  launchApp: (args) =>
    args.clearAppData === true ? [appFallback("clearAppData", args.appId)] : [],
  measureStartup: (args) =>
    args.compilation !== undefined && args.compilation !== "asIs"
      ? [appFallback("measureStartup", args.appId)]
      : [],
  installApp: installMutations,
  uninstallApp: (args) => [
    { kind: "installed-app", key: String(args.appId) },
    appFallback("uninstallApp", args.appId),
  ],
};

export function lifecycleToolMutations(
  name: string,
  args: Record<string, unknown>,
  _platform?: Platform,
): ToolMutation[] | undefined {
  if (PROCESS_ONLY_TOOLS.has(name)) {
    return [];
  }
  return Object.hasOwn(APP_TOOL_MUTATIONS, name) ? APP_TOOL_MUTATIONS[name](args) : undefined;
}
