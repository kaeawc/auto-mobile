import { recordPlanCall } from "../../helpers/recordPlanCall";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ToolCallRecorder } from "../../../src/features/record/ToolCallRecorder";
import { registerMcpTools } from "../../../src/server/index";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";

isolateToolRegistry();

/** The `stagesFiles` trait the registry hands the recorder for the file-staging tools (#11825). */
const STAGES_FILES = { stagesFiles: true } as const;

// Every tool the live registry lists in daemon mode (the superset surface).
// Tools hidden from listing (startDevice, plan-only barrier/criticalSection) are
// not enumerable, so they are classified below by name regardless.
let registeredTools: string[] = [];
// The tools declaring the `planRelevant` trait (#11825), derived from the live registry.
let PLAN_RELEVANT_TOOLS: Set<string> = new Set();

beforeAll(() => {
  ToolRegistry.clearTools();
  registerMcpTools(true);
  registeredTools = ToolRegistry.getAllTools({ includeUnavailable: true }).map((tool) => tool.name);
  PLAN_RELEVANT_TOOLS = new Set(
    [...ToolRegistry["tools"].values()]
      .filter((tool) => tool.planRelevant === true)
      .map((t) => t.name),
  );
});

afterAll(() => {
  ToolRegistry.clearTools();
});

const DEVICE_MANAGEMENT = "Device or image management, not a replayable step in a plan";
const READ_ONLY = "Read-only query; changes no device state so a plan gains nothing from it";
const EMBEDDED_SDK_ONLY =
  "Embedded-SDK-only tool, not planExecutable: getToolForPlan refuses it unless the daemon runs with --embedded-sdk, so a recorded step would fail as an unknown tool on replay (#9966)";
const DEBUG_ONLY =
  "Debug-only tool, not planExecutable: getToolForPlan refuses it unless the daemon runs with --debug, so a recorded step would fail as an unknown tool on replay (#9966)";
const SESSION_META = "Session, recording or plan meta-tool; recording it would be self-referential";
const HOST_LOCAL = "Host-local aid, not part of the app interaction a plan replays";

// Registered tools that are deliberately not recorded, each with the reason.
const EXCLUDED_TOOLS: Record<string, string> = {
  getAndroid: DEVICE_MANAGEMENT,
  getApple: DEVICE_MANAGEMENT,
  listDevices: DEVICE_MANAGEMENT,
  listDeviceImages: DEVICE_MANAGEMENT,
  startDevice: DEVICE_MANAGEMENT, // hidden, so absent from the generated definitions
  killDevice: DEVICE_MANAGEMENT,
  deleteDevice: DEVICE_MANAGEMENT,
  provisionDevice: DEVICE_MANAGEMENT,
  setActiveDevice: DEVICE_MANAGEMENT,
  deviceSnapshot: DEVICE_MANAGEMENT,
  installApp: DEVICE_MANAGEMENT,
  uninstallApp: DEVICE_MANAGEMENT,
  setDeviceResources: DEVICE_MANAGEMENT,
  reconcileDeviceResources: DEVICE_MANAGEMENT,
  executePlan: SESSION_META,
  exportPlan: SESSION_META,
  recordToolCalls: SESSION_META,
  recordDeviceGestures: SESSION_META,
  setToolEnabled: SESSION_META,
  criticalSection: "Multi-device coordination primitive, handled by the plan executor",
  barrier: "Multi-device coordination primitive, handled by the plan executor",
  videoRecording: "Starts or stops a host-side capture; not part of the replayed interaction",
  performanceTrace: "Starts or stops a diagnostic tracer; not part of the replayed interaction",
  explore: "Builds the navigation graph; an exploration run, not a scripted step",
  measureStartup: "Performance measurement run over repeated launches, not an interaction step",
  navigateTo: "Resolves through a host-local navigation graph, so the step is not portable",
  prototype: HOST_LOCAL,
  highlight: HOST_LOCAL,
  doctor: READ_ONLY, // hidden/gated, so absent from the generated definitions
  hitTest: READ_ONLY,
  identifyInteractions: READ_ONLY,
  snapshotOf: READ_ONLY,
  listApps: READ_ONLY,
  getAppPermissions: READ_ONLY,
  inspectPackageSigning: READ_ONLY,
  getDeepLinks: READ_ONLY,
  accessibilityAudit: READ_ONLY,
  getDeviceState: READ_ONLY,
  getIosSimulatorCapabilities: READ_ONLY,
  getNavigationGraph: READ_ONLY,
  getNetworkGraph: READ_ONLY,
  getNotificationPolicy: READ_ONLY,
  getDataStore: READ_ONLY,
  listDataStores: READ_ONLY,
  getPreference: READ_ONLY,
  sqlQuery: READ_ONLY,
  accessibilityFocus: DEBUG_ONLY,
  setKeyValue: EMBEDDED_SDK_ONLY,
  removeKeyValue: EMBEDDED_SDK_ONLY,
  clearKeyValueFile: EMBEDDED_SDK_ONLY,
  network: EMBEDDED_SDK_ONLY,
  mockNetwork: EMBEDDED_SDK_ONLY,
  clearMockNetwork: EMBEDDED_SDK_ONLY,
};

/** The hand-kept PLAN_RELEVANT_TOOLS list the `planRelevant` trait replaced (#11825). */
const FORMER_PLAN_RELEVANT_TOOLS = [
  "accessibility",
  // Added after the list was frozen: a semantic accessibility action replays as a plan step (#14077).
  "accessibilityAction",
  // Added after the list was frozen: an audit runs as a plan assertion step (#14075).
  "audit",
  "appLifecycle",
  // Added after the list was frozen: a triggered job replays as a plan step (#14090).
  "backgroundWork",
  "biometricAuth",
  "changeLocalization",
  "clipboard",
  "compareScreenshot",
  "crashApp",
  "displayConfig",
  "displayProfile",
  "dragAndDrop",
  "dragPath",
  "homeScreen",
  "getLogs",
  "keyboard",
  "killProfile",
  "launchApp",
  "manufacturerProfile",
  "mediaSession",
  "multiTouch",
  "observe",
  "openLink",
  "phoneCall",
  "pinchOn",
  "postNotification",
  "pressButton",
  "putAppFile",
  "recentApps",
  "rotaryScroll",
  "resetAppLogs",
  "resetKeychain",
  "rotate",
  "selectAllText",
  "sendBroadcast",
  "sendKeys",
  "sendSms",
  "setAppLinks",
  "setAppPermissions",
  "setDeviceState",
  "setNotificationPolicy",
  "setPosture",
  "setPreference",
  "setSensor",
  "setUIState",
  "shake",
  "statusBar",
  "swipeAt",
  "swipeOn",
  "systemAlerts",
  "systemTray",
  "tapAny",
  "tapAt",
  "tapOn",
  "terminateApp",
  "wakeAndUnlock",
  "windowMode",
] as const;

describe("PLAN_RELEVANT_TOOLS coverage (#9928)", () => {
  test("planRelevant is declared by exactly the tools the former PLAN_RELEVANT_TOOLS list named", () => {
    expect([...PLAN_RELEVANT_TOOLS].sort()).toEqual([...FORMER_PLAN_RELEVANT_TOOLS].sort());
  });

  test("every registered tool is either recorded or excluded with a reason", () => {
    expect(registeredTools.length).toBeGreaterThan(60);
    const unclassified = registeredTools.filter(
      (name) => !PLAN_RELEVANT_TOOLS.has(name) && !(name in EXCLUDED_TOOLS),
    );
    expect(unclassified).toEqual([]);
  });

  test("no tool is both recorded and excluded", () => {
    const both = Object.keys(EXCLUDED_TOOLS).filter((name) => PLAN_RELEVANT_TOOLS.has(name));
    expect(both).toEqual([]);
  });

  test("every recorded tool is registered", () => {
    const missing = [...PLAN_RELEVANT_TOOLS].filter(
      (name) => ToolRegistry.getRegisteredTool(name) === undefined,
    );
    expect(missing).toEqual([]);
  });

  test("a recorded tapAt step carries no snapshot reference and parses for replay", () => {
    const recorder = new ToolCallRecorder();
    recorder.start();
    recordPlanCall(recorder, "tapAt", {
      x: 10,
      y: 20,
      snapshotId: "snap-1",
      deviceId: "emulator-5554",
    });
    const [step] = recorder.stop();

    expect(step).toEqual({ tool: "tapAt", params: { x: 10, y: 20 } });
    const schema = ToolRegistry.getToolForPlan("tapAt")?.schema;
    expect(schema).toBeDefined();
    if (!schema) {
      throw new Error("Missing tool schema");
    }
    expect(() => schema.parse(step.params)).not.toThrow();
  });

  test("a recorded dragPath step carries no snapshot reference (#12811)", () => {
    const recorder = new ToolCallRecorder();
    recorder.start();
    recordPlanCall(recorder, "dragPath", {
      points: [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
      ],
      snapshotId: "snap-1",
      deviceId: "emulator-5554",
    });
    const [step] = recorder.stop();

    expect(step.params).not.toHaveProperty("snapshotId");
  });

  test("tools other than tapAt keep their params untouched", () => {
    const recorder = new ToolCallRecorder();
    recorder.start();
    recordPlanCall(recorder, "tapAny", { container: { text: "List" } });
    expect(recorder.stop()[0].params).toEqual({ container: { text: "List" } });
  });

  test("read-only actions of multi-action tools are not recorded", () => {
    const recorder = new ToolCallRecorder();
    recorder.start();
    recordPlanCall(recorder, "keyboard", { action: "detect" });
    recordPlanCall(recorder, "keyboard", { action: "listImes" });
    recordPlanCall(recorder, "clipboard", { action: "get" });
    recordPlanCall(recorder, "systemTray", { action: "list", appId: "com.example" });
    recordPlanCall(recorder, "systemTray", { action: "find", notification: { title: "Hi" } });
    recordPlanCall(recorder, "displayConfig", {});
    recordPlanCall(recorder, "systemAlerts", { action: "get" });
    expect(recorder.stop()).toEqual([]);
  });

  test("mutating actions of the same tools are recorded", () => {
    const recorder = new ToolCallRecorder();
    recorder.start();
    recordPlanCall(recorder, "keyboard", { action: "open" });
    recordPlanCall(recorder, "clipboard", { action: "copy", text: "x" });
    recordPlanCall(recorder, "systemTray", { action: "tap", notification: { title: "Hi" } });
    recordPlanCall(recorder, "displayConfig", { theme: "dark" });
    recordPlanCall(recorder, "displayConfig", { reset: true });
    recordPlanCall(recorder, "displayConfig", { increaseContrast: true });
    recordPlanCall(recorder, "displayConfig", { reduceMotion: false });
    recordPlanCall(recorder, "displayConfig", { boldText: true });
    recordPlanCall(recorder, "displayConfig", { size: { width: 720, height: 1600 } });
    recordPlanCall(recorder, "displayConfig", { navigationMode: "threeButton" });
    recordPlanCall(recorder, "displayConfig", { displayCutout: "hole" });
    recordPlanCall(recorder, "systemAlerts", { action: "setPolicy", policy: "allow" });
    expect(recorder.stop().map((step) => step.tool)).toEqual([
      "keyboard",
      "clipboard",
      "systemTray",
      "displayConfig",
      "displayConfig",
      "displayConfig",
      "displayConfig",
      "displayConfig",
      "displayConfig",
      "displayConfig",
      "displayConfig",
      "systemAlerts",
    ]);
  });

  test("records the action tools a session can run, in order (issue scenario)", () => {
    const recorder = new ToolCallRecorder();
    recorder.start();
    recordPlanCall(recorder, "launchApp", { appId: "com.example" });
    recordPlanCall(recorder, "tapAny", { container: { text: "List" } });
    recordPlanCall(recorder, "tapAt", { x: 1, y: 2 });
    recordPlanCall(recorder, "homeScreen", {});
    recordPlanCall(recorder, "openLink", { url: "https://example.com" });
    recordPlanCall(recorder, "rotate", { orientation: "landscape" });

    expect(recorder.stop().map((step) => step.tool)).toEqual([
      "launchApp",
      "tapAny",
      "tapAt",
      "homeScreen",
      "openLink",
      "rotate",
    ]);
  });

  test("still skips excluded tools", () => {
    const recorder = new ToolCallRecorder();
    recorder.start();
    recorder.record("listDevices", {});
    recorder.record("recordToolCalls", { action: "end" });
    expect(recorder.stop()).toEqual([]);
  });

  test("no excluded tool carries a placeholder reason", () => {
    const placeholders = Object.entries(EXCLUDED_TOOLS).filter(([, reason]) =>
      /not yet recorded/i.test(reason),
    );
    expect(placeholders).toEqual([]);
  });

  test("a tool excluded as gated is really unreachable for plans in the default registry", () => {
    const gated = Object.entries(EXCLUDED_TOOLS)
      .filter(([, reason]) => reason === EMBEDDED_SDK_ONLY || reason === DEBUG_ONLY)
      .map(([name]) => name);
    const reachable = gated.filter((name) => ToolRegistry.getToolForPlan(name) !== undefined);
    expect(gated.length).toBeGreaterThan(0);
    expect(reachable).toEqual([]);
  });
});

// Params as a client sends them, per tool recorded by #9966. A recorded step
// must parse with the tool's live schema, exactly as PlanExecutor does it.
const RECORDED_STEP_CALLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["accessibility", { talkback: true }],
  ["accessibility", { voiceover: false }],
  ["biometricAuth", { action: "match", modality: "fingerprint" }],
  ["biometricAuth", { action: "error", errorCode: 7 }],
  ["phoneCall", { action: "call", phoneNumber: "5551234" }],
  ["sendSms", { phoneNumber: "5551234", message: "hello" }],
  ["mediaSession", { action: { dispatch: "pause" } }],
  ["mediaSession", { action: { volume: { stream: "music", level: 5 } } }],
  ["mediaSession", { action: "get", waitFor: { mediaState: "playing", timeoutMs: 3000 } }],
  [
    "windowMode",
    {
      appId: "com.example",
      mode: { freeform: { bounds: { left: 0, top: 0, right: 800, bottom: 1200 } } },
    },
  ],
  [
    "windowMode",
    { appId: "com.example", mode: { splitScreen: { with: "com.other", position: "secondary" } } },
  ],
  ["windowMode", { appId: "com.example", mode: "fullscreen" }],
  ["setNotificationPolicy", { appId: "com.example", policyAccess: true }],
  [
    "setPreference",
    { scope: "sharedPreferences", appId: "com.example", key: "flag", value: true, type: "bool" },
  ],
  ["setPreference", { scope: "systemProperty", key: "debug.flag", value: "1", type: "string" }],
  // The recorder writes the destructive confirmation as false (#10052).
  ["resetKeychain", { appId: "com.example", confirm: false }],
  ["resetAppLogs", { appId: "com.example", container: "documents", paths: ["logs/app.log"] }],
  [
    "putAppFile",
    {
      target: { domain: "app_containers", appId: "com.example", container: "documents" },
      files: [{ destinationPath: "fixtures/a.json", contentText: "{}" }],
    },
  ],
  [
    "putAppFile",
    {
      target: { domain: "user_files", namespace: "fixtures", reset: true },
      files: [{ destinationPath: "pic.png", contentBase64: "iVBORw0KGgo=" }],
    },
  ],
  [
    "putAppFile",
    {
      appId: "com.example",
      container: "documents",
      destinationPath: "legacy.txt",
      contentText: "hi",
    },
  ],
];

const RECORDED_TOOLS_9966 = [
  "accessibility",
  "biometricAuth",
  "phoneCall",
  "sendSms",
  "mediaSession",
  "windowMode",
  "setNotificationPolicy",
  "setPreference",
  "resetKeychain",
  "resetAppLogs",
  "putAppFile",
];

describe("tools recorded by #9966", () => {
  test.each(RECORDED_STEP_CALLS)("%s step parses with the live schema", (tool, args) => {
    const recorder = new ToolCallRecorder();
    recorder.start();
    // Session and routing params are injected by the registry and must be stripped.
    recordPlanCall(recorder, tool, {
      ...args,
      platform: "android",
      deviceId: "emulator-5554",
      sessionUuid: "session-1",
    });
    const steps = recorder.stop();

    expect(steps).toEqual([{ tool, params: args }]);
    const schema = ToolRegistry.getToolForPlan(tool)?.schema;
    expect(schema).toBeDefined();
    if (!schema) {
      throw new Error("Missing tool schema");
    }
    // PlanExecutor re-injects the session for device-aware tools before parsing;
    // putAppFile declares it as required.
    expect(() => schema.parse({ ...steps[0].params, sessionUuid: "session-2" })).not.toThrow();
  });

  test("every tool recorded by #9966 is covered by a parse case and reachable for plans", () => {
    const covered = new Set(RECORDED_STEP_CALLS.map(([tool]) => tool));
    expect(RECORDED_TOOLS_9966.filter((name) => !covered.has(name))).toEqual([]);
    expect(RECORDED_TOOLS_9966.filter((name) => !PLAN_RELEVANT_TOOLS.has(name))).toEqual([]);
    expect(
      RECORDED_TOOLS_9966.filter((name) => ToolRegistry.getToolForPlan(name) === undefined),
    ).toEqual([]);
  });

  test("accessibility state queries are not recorded", () => {
    const recorder = new ToolCallRecorder();
    recorder.start();
    recordPlanCall(recorder, "accessibility", {});
    recordPlanCall(recorder, "accessibility", { deviceId: "emulator-5554" });
    expect(recorder.stop()).toEqual([]);
  });

  test("a mediaSession read is not recorded unless it waits", () => {
    const recorder = new ToolCallRecorder();
    recorder.start();
    recordPlanCall(recorder, "mediaSession", { action: "get" });
    recordPlanCall(recorder, "mediaSession", { action: "get", appId: "com.example" });
    recordPlanCall(recorder, "mediaSession", { action: "get", waitFor: { mediaState: "playing" } });
    expect(recorder.stop()).toEqual([
      { tool: "mediaSession", params: { action: "get", waitFor: { mediaState: "playing" } } },
    ]);
  });

  test("a file-staging call that copies a host file is not recorded", () => {
    const recorder = new ToolCallRecorder();
    recorder.start();
    recordPlanCall(
      recorder,
      "putAppFile",
      {
        target: { domain: "media_library" },
        files: [{ destinationPath: "pic.png", sourcePath: "/Users/dev/pic.png" }],
      },
      STAGES_FILES,
    );
    recordPlanCall(
      recorder,
      "putAppFile",
      {
        appId: "com.example",
        container: "documents",
        destinationPath: "legacy.txt",
        sourcePath: "fixtures/legacy.txt",
      },
      STAGES_FILES,
    );
    recordPlanCall(
      recorder,
      "putAppFile",
      {
        target: { domain: "user_files", namespace: "fixtures" },
        files: [
          { destinationPath: "a.txt", contentText: "a" },
          { destinationPath: "b.txt", sourcePath: "/tmp/b.txt" },
        ],
      },
      STAGES_FILES,
    );
    expect(recorder.stop()).toEqual([]);
  });
});
