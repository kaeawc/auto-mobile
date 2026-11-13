/**
 * One canonical emoji per tool (two only in extreme cases), plus the docs page
 * that every emoji reference to the tool must link to. Keys cover every
 * registration in TOOL_ANNOTATIONS; `scripts/docs/check-tool-emoji.ts` keeps
 * docs consistent with this table (#18142).
 */
export type ToolEmoji = readonly [string] | readonly [string, string];

export interface ToolEmojiEntry {
  readonly emoji: ToolEmoji;
  /** Repo-relative Markdown page for the tool; defaults to TOOLS_PAGE. */
  readonly page?: string;
}

export const TOOLS_PAGE = "docs/tools.md";

function tool(emoji: string, page?: string): ToolEmojiEntry {
  const entry: ToolEmojiEntry = page === undefined ? { emoji: [emoji] } : { emoji: [emoji], page };
  return Object.freeze(entry);
}

export const TOOL_EMOJI: Readonly<Record<string, ToolEmojiEntry>> = Object.freeze({
  // Observe & navigate
  snapshotOf: tool("📸"),
  compareScreenshot: tool("🆚"),
  observe: tool("👁️", "docs/using/observe.md"),
  hitTest: tool("🎯"),
  explore: tool("🧭"),
  navigateTo: tool("🗺️"),
  getNavigationGraph: tool("🕸️"),
  identifyInteractions: tool("🔎"),
  prototype: tool("🧪"),
  exportPrototypeWeb: tool("💻"),
  blePeripheral: tool("📡", "docs/using/ble-peripheral.md"),
  highlight: tool("🔦"),
  // Interact
  tapAt: tool("📍", "docs/using/tap-at.md"),
  tapOn: tool("👆"),
  tapAny: tool("🤏"),
  swipeOn: tool("👉", "docs/using/swipe-on.md"),
  swipeAt: tool("↔️"),
  dragAndDrop: tool("🫳"),
  dragPath: tool("〰️"),
  hoverAt: tool("🖱️"),
  pinchOn: tool("🤌"),
  multiTouch: tool("🖐️"),
  sendKeys: tool("🔤"),
  focusNavigate: tool("🕹️"),
  setUIState: tool("☑️"),
  selectAllText: tool("📝"),
  pressButton: tool("🔘"),
  keyboard: tool("⌨️"),
  clipboard: tool("📋"),
  siri: tool("🗣️"),
  // Apps, files & data
  listApps: tool("🗂️"),
  launchApp: tool("🚀"),
  terminateApp: tool("🛑"),
  crashApp: tool("💥"),
  appLifecycle: tool("🔄"),
  installApp: tool("📲"),
  uninstallApp: tool("🗑️"),
  inspectPackageSigning: tool("🔏"),
  getDeepLinks: tool("🔗"),
  putAppFile: tool("📥"),
  resetAppLogs: tool("🧹"),
  getPreference: tool("⚙️"),
  setPreference: tool("🔧"),
  deleteKeychainItem: tool("🗝️"),
  setKeyValue: tool("🔑"),
  removeKeyValue: tool("❌"),
  clearKeyValueFile: tool("🧼"),
  listDataStores: tool("🗄️"),
  getDataStore: tool("🗃️"),
  sqlQuery: tool("🧮"),
  resetKeychain: tool("🔐"),
  setAppLinks: tool("🖇️"),
  performanceAudit: tool("🚦", "docs/using/audits.md"),
  measureStartup: tool("⏱️"),
  getLogs: tool("📜"),
  sendBroadcast: tool("📻"),
  backgroundWork: tool("🛠️"),
  // Devices & system
  doctor: tool("⚕️"),
  startDevice: tool("🏁"),
  listDevices: tool("📃"),
  listDeviceImages: tool("💿", "docs/using/device-images.md"),
  getAndroid: tool("🤖"),
  getApple: tool("🍎"),
  provisionDevice: tool("🏗️"),
  setDeviceResources: tool("🧰"),
  reconcileDeviceResources: tool("⚖️"),
  setActiveDevice: tool("📌"),
  killDevice: tool("🔌"),
  deleteDevice: tool("⚰️"),
  deviceSnapshot: tool("💾"),
  rotate: tool("🔃"),
  portReverse: tool("🔁"),
  setPosture: tool("📐"),
  statusBar: tool("🔋"),
  windowMode: tool("🪟"),
  rotaryScroll: tool("🎛️"),
  glassesInput: tool("🥽"),
  ambient: tool("🌙"),
  wearSurface: tool("⌚"),
  rotateCrown: tool("👑"),
  openLink: tool("🌍"),
  homeScreen: tool("🏠"),
  recentApps: tool("🕘"),
  systemTray: tool("🔔"),
  wakeAndUnlock: tool("🔓"),
  changeLocalization: tool("🌐"),
  getDeviceState: tool("🩺"),
  setDeviceState: tool("🎚️"),
  displayConfig: tool("🖥️"),
  displayProfile: tool("🎨"),
  getIosSimulatorCapabilities: tool("🍏"),
  biometricAuth: tool("🪪"),
  shake: tool("📳"),
  setSensor: tool("🧲"),
  injectAudioInput: tool("🎙️"),
  stopAudioInput: tool("⏹️"),
  captureAudio: tool("🔊"),
  phoneCall: tool("📞"),
  sendSms: tool("💬"),
  seedContent: tool("🌱", "docs/using/seed-content.md"),
  mediaSession: tool("🎵"),
  postNotification: tool("📣"),
  getNotificationPolicy: tool("🔕"),
  setNotificationPolicy: tool("🤫"),
  getAppPermissions: tool("🛂"),
  setAppPermissions: tool("🎫"),
  killProfile: tool("☠️", "docs/using/kill-profiles.md"),
  manufacturerProfile: tool("🏭", "docs/using/oem-personas.md"),
  systemAlerts: tool("⚠️"),
  // Network, plans & recording
  network: tool("📶"),
  mockNetwork: tool("🎭"),
  clearMockNetwork: tool("🧽"),
  getNetworkGraph: tool("📊"),
  executePlan: tool("▶️"),
  criticalSection: tool("🔒"),
  barrier: tool("🚧"),
  recordToolCalls: tool("⏺️"),
  recordDeviceGestures: tool("🎬"),
  exportPlan: tool("📤"),
  videoRecording: tool("🎥"),
  performanceTrace: tool("📈", "docs/using/performance-trace.md"),
  captureTrace: tool("🔬"),
  heapDump: tool("🧠"),
  // Accessibility & tooling
  accessibility: tool("🦮"),
  accessibilityFocus: tool("🔲"),
  accessibilityAction: tool("🫶"),
  accessibilityAudit: tool("✅", "docs/using/audits.md"),
  audit: tool("🧾"),
  setToolEnabled: tool("🧩"),
});

export function toolPage(name: string): string {
  return TOOL_EMOJI[name]?.page ?? TOOLS_PAGE;
}
