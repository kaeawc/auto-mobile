export interface MutationToolTraits {
  name: string;
  requiresDevice?: boolean;
  deviceReadOnly?: boolean | ((args: Record<string, unknown>) => boolean);
}

/**
 * How a mutating tool is covered (#14359). There is no "pending" state: a tool either records a
 * journal intent before it acts (`journaled`) or changes no device state a later session could
 * observe (`notJournaled`). A journaled tool with `fallback: true` can record a `fallback:` opaque
 * intent (see `opaqueIntentKey`) for an effect nothing reverts, so keep-booted reset escalates to
 * its baseline fallback instead of reporting clean.
 */
export interface MutationToolCoverage {
  status: "notJournaled" | "journaled";
  reason: string;
  fallback?: true;
}

export const DEVICE_MUTATION_CALL_EXEMPTIONS: Readonly<
  Record<string, { actions: readonly string[]; status: "notJournaled"; reason: string }>
> = {
  keyboard: {
    actions: ["open", "close"],
    status: "notJournaled",
    reason:
      "Keyboard visibility is transient UI state. Typing profiles and IME key actions remain journaled because they can leave persistent device state.",
  },
  biometricAuth: {
    actions: ["match", "fail", "cancel", "error"],
    status: "notJournaled",
    reason:
      "Authentication responses affect only the current prompt, not biometric enrollment. App-owned changes remain subject to baseline verification.",
  },
};

function tools(
  names: readonly string[],
  reason: string,
  status: MutationToolCoverage["status"],
  options: { fallback?: true } = {},
): Record<string, MutationToolCoverage> {
  return Object.fromEntries(names.map((name) => [name, { status, reason, ...options }]));
}

const SESSION_DISPATCH_REASON =
  "Session-scoped tool dispatch attempts to record before action; recording failures warn and proceed. Unreadable priors and opaque intents are non-revertible. Legacy sessions are unchanged.";

export const DEVICE_MUTATION_TOOL_COVERAGE: Readonly<Record<string, MutationToolCoverage>> = {
  ...tools(
    [
      "accessibility",
      "accessibilityAction",
      "biometricAuth",
      "changeLocalization",
      "clipboard",
      "displayConfig",
      "displayProfile",
      "keyboard",
      "killProfile",
      "network",
      "openLink",
      "postNotification",
      "putAppFile",
      "resetKeychain",
      "rotate",
      "mediaSession",
      "setAppLinks",
      "setSensor",
      "windowMode",
      "setAppPermissions",
      "setNotificationPolicy",
      "setPosture",
      "setUIState",
      "clearKeyValueFile",
      "deleteKeychainItem",
      "clearMockNetwork",
      "mockNetwork",
      "phoneCall",
      "removeKeyValue",
      "resetAppLogs",
      "sendSms",
      "setKeyValue",
      "setPreference",
      "sqlQuery",
    ],
    SESSION_DISPATCH_REASON,
    "journaled",
  ),
  ...tools(
    ["setDeviceState"],
    SESSION_DISPATCH_REASON +
      " Effects nothing reverts (an emulator GPS fix, a lock credential, a camera poster) record a fallback intent.",
    "journaled",
    { fallback: true },
  ),
  ...tools(
    ["deviceSnapshot"],
    SESSION_DISPATCH_REASON +
      " A user snapshot write escalates through the session's opaque-persistent-change activity (wipe-data fallback).",
    "journaled",
    { fallback: true },
  ),
  ...tools(
    ["statusBar"],
    "An override records the status-bar row with the sysui_demo_allowed prior (iOS: no override, because every reset clears it); the Android port exits demo mode and restores the setting, the iOS port clears the override. clear and get change nothing.",
    "journaled",
  ),
  ...tools(
    ["manufacturerProfile"],
    "apply records the keyboard profile row plus a breadcrumb for the kill and display facets, whose session-owned restore receipts bypass the recorded dispatcher; list, describe, reset, iOS and refused calls change nothing.",
    "journaled",
  ),
  ...tools(
    ["pressButton", "sendKeys"],
    "Only some calls persist: power/lock journal the screen state with a readable prior, volume presses leave a breadcrumb, a typed keyboardProfile journals the keyboard profile row. Every other button or text call is transient input.",
    "journaled",
  ),
  ...tools(
    ["sendBroadcast", "backgroundWork"],
    "Receiver and job code writes app-owned data nothing reverts or cleans: sendBroadcast and backgroundWork runJob record a fallback intent; list and diagnostics reads record nothing.",
    "journaled",
    { fallback: true },
  ),
  ...tools(
    ["launchApp", "measureStartup", "installApp", "uninstallApp"],
    "clearAppData, a persistent compilation mode, an install over, or an uninstall of an app the baseline held records a fallback intent unless the session installed an app the baseline did not hold; installs also keep their installed-app row. Other calls only start or stop processes.",
    "journaled",
    { fallback: true },
  ),
  ...tools(
    ["executePlan", "setDeviceResources", "reconcileDeviceResources", "prototype"],
    "executePlan cleanup that clears app data, applied device resources, an Android prototype that is device-persistent, above apps, stored or saved record a fallback intent; their device steps otherwise go through the recorded dispatcher.",
    "journaled",
    { fallback: true },
  ),
  ...tools(
    [
      "accessibilityFocus",
      "dragAndDrop",
      "dragPath",
      "focusNavigate",
      "highlight",
      "homeScreen",
      "multiTouch",
      "pinchOn",
      "recentApps",
      "selectAllText",
      "shake",
      "swipeAt",
      "swipeOn",
      "systemTray",
      "tapAny",
      "tapAt",
      "tapOn",
      "wakeAndUnlock",
    ],
    "Pointer, key and gesture input changes no persistent device state; the target app's own effects are app-owned and outside the journal's scope, and the baseline clean covers shared settings, packages and files.",
    "notJournaled",
  ),
  ...tools(
    ["terminateApp", "crashApp", "appLifecycle"],
    "Acts on the app process only (force-stop, crash, trim memory, background kill); process state does not survive the next launch.",
    "notJournaled",
  ),
  ...tools(
    ["performanceTrace", "videoRecording", "recordDeviceGestures"],
    "Writes host-side artifacts; the device-side recording or trace file is removed after the pull, and gesture capture only reads input events.",
    "notJournaled",
  ),
  ...tools(
    ["barrier", "criticalSection", "explore", "navigateTo"],
    "Host-side coordination, or device steps that run through the recorded dispatcher or change no persistent state (input primitives).",
    "notJournaled",
  ),
  ...tools(
    ["deleteDevice", "getAndroid", "getApple", "killDevice", "provisionDevice", "startDevice"],
    "Native lifecycle is owned by the binding journal: these tools have no device handler, never reach the recorder, and a broker session refuses them.",
    "notJournaled",
  ),
  ...tools(
    ["audit", "accessibilityAudit"],
    "Observes the screen and reads app metrics; accessibility baselines are stored on the host, so there is no persistent device setting to journal (#14359).",
    "notJournaled",
  ),
  ...tools(
    ["exportPlan", "recordToolCalls", "setActiveDevice", "setToolEnabled", "systemAlerts"],
    "Host routing/recording configuration has no direct persistent device setting; device-side child operations are journaled by their own tools (#14359).",
    "notJournaled",
  ),
};

export function mutationToolCoverageViolations(
  tools: readonly MutationToolTraits[],
  coverage: Readonly<Record<string, MutationToolCoverage>> = DEVICE_MUTATION_TOOL_COVERAGE,
): string[] {
  return tools
    .filter((tool) => tool.deviceReadOnly !== true)
    .filter((tool) => {
      const adapter = Object.hasOwn(coverage, tool.name) ? coverage[tool.name] : undefined;
      return (
        !adapter ||
        !["journaled", "notJournaled"].includes(adapter.status) ||
        !adapter.reason.trim()
      );
    })
    .map(
      (tool) => `${tool.name}: missing journaled adapter or explicit notJournaled justification`,
    );
}
