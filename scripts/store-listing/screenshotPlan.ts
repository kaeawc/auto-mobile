/**
 * The ProtoViewer store-screenshot capture plan (#14152): which screens, on which pinned devices, in
 * which appearance, driven by which AutoMobile tools, and where each image lands in the fastlane tree.
 *
 * The plan is data. `capture-screenshots.ts --emit` writes one `scripts/mcp-drive.ts --plan` file per
 * shot plus a manifest; nothing here talks to a device. Determinism comes from the inputs, not the
 * runner: a fixed sample library, the `statusBar` tool's fixed clock and bars, a fixed appearance,
 * and a clean app (`clearAppData`) seeded before every shot.
 */

export type Platform = "android" | "ios";
export type Appearance = "light" | "dark";
export type ScreenId = "library" | "viewer" | "import" | "share";

export interface McpStep {
  kind: "mcp";
  tool: string;
  args: Record<string, unknown>;
}

/** A command the host runs around the MCP steps (appearance has no MCP tool on both platforms). */
export interface HostStep {
  kind: "host";
  argv: string[];
  note: string;
}

export type PlanStep = McpStep | HostStep;

export interface DeviceProfile {
  id: string;
  platform: Platform;
  /** Store bucket the image belongs to. */
  bucket: "phone" | "sevenInch" | "tenInch";
  /** Android: AVD to acquire by name. iOS: unused (the simulator is pinned by UDID). */
  avdName?: string;
  /** Expected pixel size of the capture, checked by the runner before the image is accepted. */
  pixels: { width: number; height: number };
}

export interface ScreenshotShot {
  id: string;
  profile: DeviceProfile;
  appearance: Appearance;
  screen: ScreenId;
  /** Path relative to `fastlane/metadata`. */
  destination: string;
  steps: PlanStep[];
}

export interface PlanPins {
  /** adb serial of the dedicated capture emulator. Never the shared dev emulator. */
  androidSerial: string;
  /** UDID of the dedicated capture simulator. */
  iosUdid: string;
}

export const APP_IDS = {
  android: "dev.jasonpearson.automobile.protoviewer",
  ios: "dev.jasonpearson.automobile.protoviewer",
} as const;

/** Valid prototypes from the shared corpus; the library is imported fresh and identical every run. */
export const SAMPLE_LIBRARY = [
  { file: "test/fixtures/prototype-spec/valid/chat-scroll.json", label: "chat-scroll" },
  { file: "test/fixtures/prototype-spec/valid/chart-variants.json", label: "chart-variants" },
  { file: "test/fixtures/prototype-spec/valid/carousel-multi-browse.json", label: "carousel" },
] as const;

/** Prototype opened for the viewer and share screens. */
export const FEATURED = SAMPLE_LIBRARY[0];

export const PROFILES: readonly DeviceProfile[] = [
  {
    id: "android-phone",
    platform: "android",
    bucket: "phone",
    avdName: "protoviewer-shots-phone",
    pixels: { width: 1080, height: 2400 },
  },
  {
    id: "android-7in",
    platform: "android",
    bucket: "sevenInch",
    avdName: "protoviewer-shots-7in",
    pixels: { width: 1200, height: 1920 },
  },
  {
    id: "android-10in",
    platform: "android",
    bucket: "tenInch",
    avdName: "protoviewer-shots-10in",
    pixels: { width: 1600, height: 2560 },
  },
  { id: "ios-iphone-69", platform: "ios", bucket: "phone", pixels: { width: 1320, height: 2868 } },
];

const SCREENS: readonly ScreenId[] = ["library", "viewer", "import", "share"];

/** Fixed system chrome: the classic 9:41 clock, full battery and bars. */
const STATUS_BAR = {
  action: "override",
  time: "9:41",
  batteryLevel: 100,
  batteryState: "charged",
  cellularBars: 4,
  wifiBars: 3,
  dataNetwork: "wifi",
  hideNotifications: true,
} as const;

function acquire(profile: DeviceProfile, pins: PlanPins): McpStep {
  return profile.platform === "android"
    ? {
        kind: "mcp",
        tool: "getAndroid",
        args: { avdName: profile.avdName, deviceId: pins.androidSerial },
      }
    : { kind: "mcp", tool: "getApple", args: { udid: pins.iosUdid } };
}

function appearanceStep(profile: DeviceProfile, appearance: Appearance, pins: PlanPins): HostStep {
  return profile.platform === "android"
    ? {
        kind: "host",
        argv: [
          "adb",
          "-s",
          pins.androidSerial,
          "shell",
          "cmd",
          "uimode",
          "night",
          appearance === "dark" ? "yes" : "no",
        ],
        note: `set Android night mode ${appearance}`,
      }
    : {
        kind: "host",
        argv: ["xcrun", "simctl", "ui", pins.iosUdid, "appearance", appearance],
        note: `set the simulator appearance ${appearance}`,
      };
}

/** Clean slate, then the fixed sample files; the app is relaunched by each screen's own steps. */
function seedSteps(profile: DeviceProfile): McpStep[] {
  const files = SAMPLE_LIBRARY.map((entry) => ({
    sourcePath: entry.file,
    destinationPath: `${entry.label}.automobile-proto`,
  }));
  const appId = APP_IDS[profile.platform];
  return [
    { kind: "mcp", tool: "launchApp", args: { appId, clearAppData: true } },
    { kind: "mcp", tool: "terminateApp", args: { appId } },
    {
      kind: "mcp",
      tool: "putAppFile",
      args:
        profile.platform === "android"
          ? { target: { domain: "user_files", namespace: "protoviewer-shots", reset: true }, files }
          : {
              target: { domain: "app_containers", appId: APP_IDS.ios, container: "documents" },
              files,
            },
    },
  ];
}

function screenSteps(profile: DeviceProfile, screen: ScreenId): McpStep[] {
  const appId = APP_IDS[profile.platform];
  const launch: McpStep = { kind: "mcp", tool: "launchApp", args: { appId, coldBoot: true } };
  const open: McpStep = {
    kind: "mcp",
    tool: "tapOn",
    args: { selector: { text: FEATURED.label } },
  };
  const capture: McpStep = {
    kind: "mcp",
    tool: "observe",
    args: { screenshot: "settled", settled: true },
  };
  switch (screen) {
    case "library":
      return [launch, capture];
    case "viewer":
      return [launch, open, capture];
    case "import":
      return [
        launch,
        { kind: "mcp", tool: "tapOn", args: { selector: { text: "Import" } } },
        capture,
      ];
    case "share":
      return [
        launch,
        {
          kind: "mcp",
          tool: "tapOn",
          args: { selector: { text: `More options for ${FEATURED.label}` } },
        },
        { kind: "mcp", tool: "tapOn", args: { selector: { text: "Share" } } },
        capture,
      ];
  }
}

const ANDROID_DIRS = {
  phone: "phoneScreenshots",
  sevenInch: "sevenInchScreenshots",
  tenInch: "tenInchScreenshots",
} as const;

/** Where a shot lands: Play's `images/<bucket>Screenshots/`, or iOS `screenshots/` (deliver reads dimensions). */
export function destinationFor(
  profile: DeviceProfile,
  screen: ScreenId,
  appearance: Appearance,
): string {
  const order = String(SCREENS.indexOf(screen) + 1).padStart(2, "0");
  const name = `${order}_${screen}_${appearance}.png`;
  return profile.platform === "android"
    ? `android/en-US/images/${ANDROID_DIRS[profile.bucket]}/${name}`
    : `ios/en-US/screenshots/${profile.id}_${name}`;
}

/** The full matrix: every profile x appearance x screen, in a stable order. */
export function buildScreenshotPlan(pins: PlanPins): ScreenshotShot[] {
  return PROFILES.flatMap((profile) =>
    (["light", "dark"] as const).flatMap((appearance) =>
      SCREENS.map((screen) => ({
        id: `${profile.id}-${appearance}-${screen}`,
        profile,
        appearance,
        screen,
        destination: destinationFor(profile, screen, appearance),
        steps: [
          acquire(profile, pins),
          appearanceStep(profile, appearance, pins),
          {
            kind: "mcp" as const,
            tool: "statusBar",
            args: { ...STATUS_BAR, platform: profile.platform },
          },
          ...seedSteps(profile),
          ...screenSteps(profile, screen),
        ],
      })),
    ),
  );
}

/** The `{tool, args}` array `scripts/mcp-drive.ts --plan` consumes (host steps run outside it). */
export function toDrivePlan(
  shot: ScreenshotShot,
): { tool: string; args: Record<string, unknown> }[] {
  return shot.steps.flatMap((step) =>
    step.kind === "mcp" ? [{ tool: step.tool, args: step.args }] : [],
  );
}
