/**
 * Real-path driving tools per platform module: the existing MCP tools that put a device into the
 * state a module reads or reports, so an agent tests a prototype through the real platform
 * instead of a fake. Keys are production `platformModules` names; a test keeps the table in step
 * with the contract and with `schemas/tool-definitions.json`.
 */
export interface PrototypePlatformDrivingTools {
  /** MCP tool names, in the order an agent would reach for them. Empty when none applies. */
  tools: readonly string[];
  /** What the tools change, or why no tool reaches the module. */
  note: string;
}

export const PROTOTYPE_PLATFORM_DRIVING_TOOLS: Readonly<
  Record<string, PrototypePlatformDrivingTools>
> = {
  device: {
    tools: ["rotate", "displayConfig", "setPosture", "windowMode"],
    note: "orientation, window size, posture and windowing mode fire `device.changed`",
  },
  realtime: {
    tools: [],
    note: "the channel's server drives frames and status; no device tool",
  },
  haptics: { tools: [], note: "assert the call's `prototype_platform` outcome" },
  sound: { tools: [], note: "assert the call's `prototype_platform` outcome" },
  clipboard: {
    tools: ["clipboard"],
    note: "set the clipboard before `paste`/`hasText`; read it after `copy`",
  },
  share: { tools: ["observe", "tapOn"], note: "drive the system share sheet" },
  battery: { tools: ["setDeviceState"], note: "`power.battery` level and charging (Android)" },
  power: {
    tools: ["setDeviceState"],
    note: "`power.batterySaver` and `power.thermalStatus` (Android)",
  },
  audio: { tools: ["mediaSession"], note: "stream volume (Android)" },
  connectivity: {
    tools: ["setDeviceState"],
    note: "`connectivity` toggles and `networkCondition`",
  },
  biometric: {
    tools: ["biometricAuth", "setDeviceState"],
    note: "match or fail a prompt; `biometrics.enrollment` on an iOS Simulator",
  },
  settings: {
    tools: ["observe", "pressButton"],
    note: "confirm the settings screen, then go back",
  },
  contacts: { tools: ["observe", "tapOn"], note: "pick in the system picker" },
  calendar: { tools: ["observe", "tapOn"], note: "save or cancel in the system editor" },
  links: { tools: ["observe"], note: "confirm the opened app or browser" },
  mediaLibrary: {
    tools: ["putAppFile", "setAppPermissions"],
    note: "stage photos in the `media_library` domain; grant or revoke access",
  },
  camera: {
    tools: ["setDeviceState", "setAppPermissions"],
    note: "`cameraPoster` sets what the emulated camera sees",
  },
  auth: { tools: ["observe", "tapOn"], note: "complete the provider's sign-in screen" },
  location: {
    tools: ["setDeviceState", "setAppPermissions", "systemAlerts"],
    note: "`location` fix or route; grant access or answer the prompt",
  },
  commerce: { tools: ["observe", "tapOn"], note: "complete the store purchase sheet" },
  secureStorage: { tools: [], note: "read `/platform/secureStorage/locked`; no device tool" },
  sensors: { tools: ["setSensor", "shake"], note: "emulator sensor values and a shake gesture" },
  map: { tools: ["tapOn", "swipeOn"], note: "tap markers and pan the map" },
  audioRecorder: {
    tools: ["injectAudioInput", "setAppPermissions"],
    note: "feed known audio into the microphone",
  },
  notifications: {
    tools: ["systemTray", "setNotificationPolicy", "setAppPermissions"],
    note: "open, act on, reply to or dismiss a posted notification; block a channel or the app",
  },
  media: { tools: ["mediaSession"], note: "headset transport keys and session state (Android)" },
  cast: { tools: [], note: "needs a real receiver on the network; no device tool" },
};

/** The real-path driving table rendered for the authoring guide. */
export function renderPlatformDrivingTools(
  table: Readonly<Record<string, PrototypePlatformDrivingTools>> = PROTOTYPE_PLATFORM_DRIVING_TOOLS,
): string {
  const rows = Object.entries(table).map(([module, entry]) => {
    const tools = entry.tools.map((tool) => `\`${tool}\``).join(", ") || "-";
    return `| \`${module}\` | ${tools} | ${entry.note} |`;
  });
  return [
    "To test a module for real, drive the device with these tools, then assert with `awaitEvent` and `observe`:",
    "",
    "| Module | Tools | What they drive |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}
