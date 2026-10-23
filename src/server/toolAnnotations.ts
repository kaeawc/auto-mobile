import type { ToolAnnotations } from "@modelcontextprotocol/server";

export interface ToolAnnotationEntry {
  readonly title: string;
  readonly annotations: Readonly<
    Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">
  >;
}

const readDevice = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});
const readHost = Object.freeze({ ...readDevice, openWorldHint: false });
const captureDevice = Object.freeze({ ...readDevice, idempotentHint: false });
const controlDevice = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});
const destructiveDevice = Object.freeze({ ...controlDevice, destructiveHint: true });
const setDevice = Object.freeze({ ...controlDevice, idempotentHint: true });
const clearDevice = Object.freeze({ ...destructiveDevice, idempotentHint: true });
const controlHost = Object.freeze({ ...controlDevice, openWorldHint: false });
const setHost = Object.freeze({ ...controlHost, idempotentHint: true });

/**
 * MCP defaults are false/true/false/true (readOnly/destructive/idempotent/openWorld).
 * Destructive is deliberately explicit on every control, including the true default,
 * so clients that mistake an absent hint for false still warn. Read-only tools omit
 * destructive and idempotent hints because the spec defines them as meaningless there.
 */
function entry(title: string, hints: ToolAnnotationEntry["annotations"]): ToolAnnotationEntry {
  const readOnly = hints.readOnlyHint === true;
  return {
    title,
    annotations: Object.freeze({
      ...(readOnly ? { readOnlyHint: true } : { destructiveHint: hints.destructiveHint !== false }),
      ...(!readOnly && hints.idempotentHint === true ? { idempotentHint: true } : {}),
      ...(hints.openWorldHint === false ? { openWorldHint: false } : {}),
    }),
  };
}

/**
 * Untrusted client hints only; never use these for authorization or deviceReadOnly dispatch.
 * Mixed-action tools take the conservative union: any destructive or non-idempotent
 * action determines that hint. Host-only state is closed-world; device effects are open-world.
 */
export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotationEntry>> = {
  // Device/platform reads do not change app state; native inventory is outside daemon state.
  doctor: entry("Diagnose Setup", readDevice),
  getAppPermissions: entry("Get Permissions", readDevice),
  getDataStore: entry("Read Data Store", readDevice),
  getDeepLinks: entry("Get Deep Links", readDevice),
  getDeviceState: entry("Get Device State", readDevice),
  getIosSimulatorCapabilities: entry("Get iOS Simulator Capabilities", readDevice),
  getNotificationPolicy: entry("Get Notification Policy", readDevice),
  getLogs: entry("Read Device Logs", readDevice),
  getPreference: entry("Get Preference", readDevice),
  hitTest: entry("Inspect Point", readDevice),
  identifyInteractions: entry("Identify Interactions", readDevice),
  inspectPackageSigning: entry("Inspect Package Signing", readDevice),
  listApps: entry("List Installed Apps", readDevice),
  listDataStores: entry("List Data Stores", readDevice),
  listDeviceImages: entry("List Device Images", readDevice),
  listDevices: entry("List Devices", readDevice),

  // compareScreenshot is deviceReadOnly (safe to watch a held device) but its record mode
  // overwrites a host-side baseline, so it is advertised as a destructive control.
  compareScreenshot: entry("Compare Screenshot", destructiveDevice),

  // Observation artifacts are incidental to reading the device, but repeats can save new files.
  observe: entry("Observe Screen", captureDevice),
  snapshotOf: entry("Capture Snapshot", captureDevice),

  // Graph queries read captured host data without contacting the app/device.
  getNavigationGraph: entry("Get Navigation Graph", readHost),
  getNetworkGraph: entry("Get Network Graph", readHost),

  // Gestures, app interaction and multiplexed controls can have additional effects on repetition.
  accessibility: entry("Control Accessibility", controlDevice),
  // Report-only, but registration does not classify native audits as deviceReadOnly.
  accessibilityAudit: entry("Audit Native Accessibility", controlDevice),
  biometricAuth: entry("Simulate Biometrics", destructiveDevice),
  focusNavigate: entry("Navigate D-pad Focus", destructiveDevice),
  dragAndDrop: entry("Drag and Drop Element", destructiveDevice),
  dragPath: entry("Drag Along Path", destructiveDevice),
  exportPlan: entry("Export Plan", controlDevice),
  highlight: entry("Highlight Screen Element", controlDevice),
  homeScreen: entry("Open Home Screen", controlDevice),
  keyboard: entry("Control Keyboard", destructiveDevice),
  multiTouch: entry("Multi Touch Gesture", destructiveDevice),
  mockNetwork: entry("Mock Network Response", controlDevice),
  network: entry("Control Network Capture", controlDevice),
  openLink: entry("Open Web Link", destructiveDevice),
  phoneCall: entry("Simulate Phone Call", controlDevice),
  pinchOn: entry("Pinch Screen Element", destructiveDevice),
  postNotification: entry("Post Notification", controlDevice),
  pressButton: entry("Press Button", destructiveDevice),
  recentApps: entry("Open Recent Apps", controlDevice),
  recordDeviceGestures: entry("Record Gestures", controlDevice),
  selectAllText: entry("Select All Text", controlDevice),
  sendSms: entry("Simulate SMS", controlDevice),
  setActiveDevice: entry("Set Active Device", setHost),
  shake: entry("Shake", controlDevice),
  swipeAt: entry("Swipe at Coordinates", destructiveDevice),
  swipeOn: entry("Swipe Screen Element", destructiveDevice),
  tapAny: entry("Tap Any Element", destructiveDevice),
  tapAt: entry("Tap at Coordinates", destructiveDevice),
  tapOn: entry("Tap Screen Element", destructiveDevice),
  videoRecording: entry("Record Video", controlDevice),
  wakeAndUnlock: entry("Wake and Unlock", controlDevice),

  // Desired-state writes have no additional effect when repeated with the same arguments.
  accessibilityFocus: entry("Set Accessibility Focus", setDevice),
  rotate: entry("Rotate", setDevice),
  setNotificationPolicy: entry("Set Notification Policy", setDevice),
  setPosture: entry("Set Posture", setDevice),
  setPreference: entry("Set Preference", clearDevice),

  // Explicit kills, resets, deletes, restores and replayed plan/navigation/SQL calls may destroy state.
  accessibilityAction: entry("Run Accessibility Action", destructiveDevice),
  // Recording an audit baseline can replace an existing host-side baseline.
  audit: entry("Audit Current Screen", destructiveDevice),
  backgroundWork: entry("Control Background Jobs", destructiveDevice),
  // start/stop is a mixed-action tool: stop pulls the trace and deletes the device copy.
  captureTrace: entry("Capture Trace", destructiveDevice),
  displayProfile: entry("Set Display Profile", destructiveDevice),
  // Pauses the app while dumping; leaves only a host file, no app or device state is lost.
  heapDump: entry("Dump Heap", controlDevice),
  killProfile: entry("Set Kill Policy", destructiveDevice),
  manufacturerProfile: entry("Set OEM Profile", destructiveDevice),
  measureStartup: entry("Measure Startup", destructiveDevice),
  mediaSession: entry("Control Media", destructiveDevice),
  // appLaunch tracing can launch the app; other templates only capture artifacts.
  performanceTrace: entry("Record Trace", destructiveDevice),
  sendBroadcast: entry("Send Broadcast", destructiveDevice),
  setAppLinks: entry("Set App Links", destructiveDevice),
  // Stored policies can later tap arbitrary alert buttons during device interaction.
  systemAlerts: entry("Set Alert Policy", destructiveDevice),
  windowMode: entry("Set Window Mode", destructiveDevice),
  appLifecycle: entry("Control App Lifecycle", destructiveDevice),
  changeLocalization: entry("Change Locale", destructiveDevice),
  clipboard: entry("Control Clipboard", destructiveDevice),
  crashApp: entry("Crash App", destructiveDevice),
  criticalSection: entry("Run Critical Section", destructiveDevice),
  deviceSnapshot: entry("Manage Snapshot", destructiveDevice),
  displayConfig: entry("Configure Display", destructiveDevice),
  executePlan: entry("Execute Automation Plan", destructiveDevice),
  explore: entry("Explore Screens", destructiveDevice),
  getAndroid: entry("Acquire Android", destructiveDevice),
  getApple: entry("Acquire Apple", destructiveDevice),
  installApp: entry("Install App", destructiveDevice),
  launchApp: entry("Launch App", destructiveDevice),
  navigateTo: entry("Navigate to Screen", destructiveDevice),
  prototype: entry("Manage UI Prototype", destructiveDevice),
  provisionDevice: entry("Provision Virtual Device", destructiveDevice),
  putAppFile: entry("Write App File", destructiveDevice),
  reconcileDeviceResources: entry("Reconcile Device Resources", destructiveDevice),
  sendKeys: entry("Send Keyboard Input", destructiveDevice),
  setDeviceResources: entry("Set Device Resources", destructiveDevice),
  setDeviceState: entry("Set Device State", destructiveDevice),
  setUIState: entry("Set Form State", destructiveDevice),
  sqlQuery: entry("Query Database", destructiveDevice),
  startDevice: entry("Start Device", destructiveDevice),
  systemTray: entry("Control Notifications", destructiveDevice),

  // Scoped clears/deletes and replacement values remain destructive even when idempotent.
  setSensor: entry("Set Emulator Sensor", clearDevice),
  statusBar: entry("Set Status Bar", clearDevice),
  clearKeyValueFile: entry("Clear Key Value File", clearDevice),
  clearMockNetwork: entry("Clear Mock Network Rules", clearDevice),
  deleteDevice: entry("Delete Device", clearDevice),
  killDevice: entry("Kill Device", clearDevice),
  removeKeyValue: entry("Remove Key Value", clearDevice),
  resetAppLogs: entry("Reset Logs", clearDevice),
  resetKeychain: entry("Reset Keychain", clearDevice),
  setAppPermissions: entry("Set Permissions", clearDevice),
  setKeyValue: entry("Set Key Value", clearDevice),
  terminateApp: entry("Terminate App", clearDevice),
  uninstallApp: entry("Uninstall App", clearDevice),

  // Coordination and call recording mutate daemon-owned state only; barrier runs no steps.
  barrier: entry("Synchronize Tracks", controlHost),
  recordToolCalls: entry("Record Tool Calls", controlHost),

  // Discovery selection sets session configuration without changing the device.
  setToolEnabled: entry("Set Tool Discovery", setHost),
};
