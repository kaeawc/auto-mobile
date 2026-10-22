export interface MutationToolTraits {
  name: string;
  requiresDevice?: boolean;
  deviceReadOnly?: boolean | ((args: Record<string, unknown>) => boolean);
}

export interface PendingMutationAdapter {
  status: "notJournaled" | "pending-adapter" | "journaled";
  reason: string;
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

function pendingTools(
  names: readonly string[],
  reason: string,
  status: PendingMutationAdapter["status"] = "pending-adapter",
): Record<string, PendingMutationAdapter> {
  return Object.fromEntries(names.map((name) => [name, { status, reason }]));
}

export const DEVICE_MUTATION_TOOL_COVERAGE: Readonly<Record<string, PendingMutationAdapter>> = {
  ...pendingTools(
    [
      "accessibility",
      "accessibilityAction",
      "biometricAuth",
      "changeLocalization",
      "clipboard",
      "displayConfig",
      "displayProfile",
      "installApp",
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
      "setDeviceState",
      "setNotificationPolicy",
      "setPosture",
      "setUIState",
      "uninstallApp",
      "clearKeyValueFile",
      "clearMockNetwork",
      "deviceSnapshot",
      "mockNetwork",
      "phoneCall",
      "removeKeyValue",
      "resetAppLogs",
      "sendSms",
      "setKeyValue",
      "setPreference",
      "sqlQuery",
    ],
    "Session-scoped tool dispatch attempts to record before action; recording failures warn and proceed. Unreadable priors and opaque intents are non-revertible. Legacy sessions are unchanged.",
    "journaled",
  ),
  ...pendingTools(
    ["manufacturerProfile", "statusBar"],
    "Pending device-appearance intent and prior-value adapters (#14359); unavailable journal coverage limits best-effort reverts but does not gate tool actions or unconditional keep-booted cleaning.",
  ),
  ...pendingTools(
    ["sendBroadcast"],
    "Pending data/provider-specific journal adapter (#14359); opaque priors cannot drive best-effort reverts and do not gate keep-booted cleaning.",
  ),
  ...pendingTools(
    ["backgroundWork"],
    "Pending app-state journal adapter (#14359): runJob and WorkManager diagnostics run app-owned work whose effects are opaque, so best-effort reverts cannot undo them; keep-booted cleaning runs unconditionally.",
  ),
  ...pendingTools(
    ["stageSessionDownloads"],
    "The deprecated Downloads alias resolves its device inside the service through nonDeviceHandler and bypasses the recorded device dispatcher. It needs service-side record-before-act wiring (#14359), not only an intent mapping. putAppFile is journaled; this alias remains pending and does not gate keep-booted cleaning.",
  ),
  ...pendingTools(
    [
      "accessibilityFocus",
      "appLifecycle",
      "audit",
      "crashApp",
      "dragAndDrop",
      "dragPath",
      "highlight",
      "homeScreen",
      "launchApp",
      "measureStartup",
      "multiTouch",
      "pinchOn",
      "pressButton",
      "recentApps",
      "selectAllText",
      "sendKeys",
      "shake",
      "swipeAt",
      "swipeOn",
      "systemTray",
      "tapAny",
      "tapAt",
      "tapOn",
      "terminateApp",
      "wakeAndUnlock",
    ],
    "UI/process interaction can induce app-owned persistent changes; pending opaque-mutation tracking for best-effort reverts (#14359). Keep-booted cleaning runs unconditionally.",
  ),
  ...pendingTools(
    [
      "barrier",
      "criticalSection",
      "executePlan",
      "explore",
      "navigateTo",
      "performanceTrace",
      "prototype",
      "reconcileDeviceResources",
      "recordDeviceGestures",
      "setDeviceResources",
      "videoRecording",
    ],
    "Composite/resource/recording operation: pending child mutation adapters and setup-side-effect coverage (#14359).",
  ),
  ...pendingTools(
    ["deleteDevice", "getAndroid", "getApple", "killDevice", "provisionDevice", "startDevice"],
    "Native lifecycle is owned by the binding journal; readiness side effects still need mutation adapters (#14359).",
  ),
  ...pendingTools(
    ["audit", "accessibilityAudit"],
    "Observes the screen and reads app metrics; accessibility baselines are stored on the host, so there is no persistent device setting to journal (#14359).",
    "notJournaled",
  ),
  ...pendingTools(
    ["exportPlan", "recordToolCalls", "setActiveDevice", "setToolEnabled", "systemAlerts"],
    "Host routing/recording configuration has no direct persistent device setting; device-side child operations remain pending (#14359).",
    "notJournaled",
  ),
};

export function mutationToolCoverageViolations(
  tools: readonly MutationToolTraits[],
  coverage: Readonly<Record<string, PendingMutationAdapter>> = DEVICE_MUTATION_TOOL_COVERAGE,
): string[] {
  return tools
    .filter((tool) => tool.deviceReadOnly !== true)
    .filter((tool) => {
      const adapter = Object.hasOwn(coverage, tool.name) ? coverage[tool.name] : undefined;
      return (
        !adapter ||
        !["journaled", "pending-adapter", "notJournaled"].includes(adapter.status) ||
        !adapter.reason.trim()
      );
    })
    .map(
      (tool) =>
        `${tool.name}: missing journaled adapter, pending-adapter or explicit notJournaled justification`,
    );
}
