import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpCallRecorder, PLAN_RELEVANT_TOOLS } from "../../../src/features/record/McpCallRecorder";
import { registerMcpTools } from "../../../src/server/index";
import { ToolRegistry } from "../../../src/server/toolRegistry";

// Every tool the live registry lists in daemon mode (the superset surface).
// Tools hidden from listing (startDevice, plan-only barrier/criticalSection) are
// not enumerable, so they are classified below by name regardless.
let registeredTools: string[] = [];

beforeAll(() => {
  ToolRegistry.clearTools();
  registerMcpTools(true);
  registeredTools = ToolRegistry.getAllTools({ includeUnavailable: true }).map((tool) => tool.name);
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
  executePlan: SESSION_META,
  exportPlan: SESSION_META,
  recordSteps: SESSION_META,
  startTestRecording: SESSION_META,
  setToolEnabled: SESSION_META,
  criticalSection: "Multi-device coordination primitive, handled by the plan executor",
  barrier: "Multi-device coordination primitive, handled by the plan executor",
  videoRecording: "Starts or stops a host-side capture; not part of the replayed interaction",
  explore: "Builds the navigation graph; an exploration run, not a scripted step",
  navigateTo: "Resolves through a host-local navigation graph, so the step is not portable",
  prototype: HOST_LOCAL,
  overlay: HOST_LOCAL, // hidden deprecated alias of prototype
  highlight: HOST_LOCAL,
  doctor: READ_ONLY, // hidden/gated, so absent from the generated definitions
  hitTest: READ_ONLY,
  identifyInteractions: READ_ONLY,
  snapshotOf: READ_ONLY,
  listApps: READ_ONLY,
  getAppPermissions: READ_ONLY,
  getDeepLinks: READ_ONLY,
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

describe("PLAN_RELEVANT_TOOLS coverage (#9928)", () => {
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
    const recorder = new McpCallRecorder();
    recorder.start();
    recorder.record("tapAt", { x: 10, y: 20, snapshotId: "snap-1", deviceId: "emulator-5554" });
    const [step] = recorder.stop();

    expect(step).toEqual({ tool: "tapAt", params: { x: 10, y: 20 } });
    const schema = ToolRegistry.getToolForPlan("tapAt")?.schema;
    expect(schema).toBeDefined();
    expect(() => schema.parse(step.params)).not.toThrow();
  });

  test("tools other than tapAt keep their params untouched", () => {
    const recorder = new McpCallRecorder();
    recorder.start();
    recorder.record("tapAny", { container: { text: "List" } });
    expect(recorder.stop()[0].params).toEqual({ container: { text: "List" } });
  });

  test("read-only actions of multi-action tools are not recorded", () => {
    const recorder = new McpCallRecorder();
    recorder.start();
    recorder.record("keyboard", { action: "detect" });
    recorder.record("keyboard", { action: "listImes" });
    recorder.record("clipboard", { action: "get" });
    recorder.record("systemTray", { action: "list", appId: "com.example" });
    recorder.record("systemTray", { action: "find", notification: { title: "Hi" } });
    recorder.record("displayConfig", {});
    expect(recorder.stop()).toEqual([]);
  });

  test("mutating actions of the same tools are recorded", () => {
    const recorder = new McpCallRecorder();
    recorder.start();
    recorder.record("keyboard", { action: "open" });
    recorder.record("clipboard", { action: "copy", text: "x" });
    recorder.record("systemTray", { action: "tap", notification: { title: "Hi" } });
    recorder.record("displayConfig", { theme: "dark" });
    recorder.record("displayConfig", { reset: true });
    expect(recorder.stop().map((step) => step.tool)).toEqual([
      "keyboard",
      "clipboard",
      "systemTray",
      "displayConfig",
      "displayConfig",
    ]);
  });

  test("records the action tools a session can run, in order (issue scenario)", () => {
    const recorder = new McpCallRecorder();
    recorder.start();
    recorder.record("launchApp", { appId: "com.example" });
    recorder.record("tapAny", { container: { text: "List" } });
    recorder.record("tapAt", { x: 1, y: 2 });
    recorder.record("homeScreen", {});
    recorder.record("openLink", { url: "https://example.com" });
    recorder.record("rotate", { orientation: "landscape" });

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
    const recorder = new McpCallRecorder();
    recorder.start();
    recorder.record("listDevices", {});
    recorder.record("recordSteps", { action: "end" });
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
  [
    "stageSessionDownloads",
    { directory: "fixtures", files: [{ destinationPath: "a.txt", contentText: "a" }] },
  ],
];

const RECORDED_TOOLS_9966 = [
  "accessibility",
  "biometricAuth",
  "phoneCall",
  "sendSms",
  "setNotificationPolicy",
  "setPreference",
  "resetKeychain",
  "resetAppLogs",
  "putAppFile",
  "stageSessionDownloads",
];

describe("tools recorded by #9966", () => {
  test.each(RECORDED_STEP_CALLS)("%s step parses with the live schema", (tool, args) => {
    const recorder = new McpCallRecorder();
    recorder.start();
    // Session and routing params are injected by the registry and must be stripped.
    recorder.record(tool, {
      ...args,
      platform: "android",
      deviceId: "emulator-5554",
      sessionUuid: "session-1",
    });
    const steps = recorder.stop();

    expect(steps).toEqual([{ tool, params: args }]);
    const schema = ToolRegistry.getToolForPlan(tool)?.schema;
    expect(schema).toBeDefined();
    // PlanExecutor re-injects the session for device-aware tools before parsing;
    // stageSessionDownloads declares it as required.
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
    const recorder = new McpCallRecorder();
    recorder.start();
    recorder.record("accessibility", {});
    recorder.record("accessibility", { deviceId: "emulator-5554" });
    expect(recorder.stop()).toEqual([]);
  });

  test("a file-staging call that copies a host file is not recorded", () => {
    const recorder = new McpCallRecorder();
    recorder.start();
    recorder.record("putAppFile", {
      target: { domain: "media_library" },
      files: [{ destinationPath: "pic.png", sourcePath: "/Users/dev/pic.png" }],
    });
    recorder.record("putAppFile", {
      appId: "com.example",
      container: "documents",
      destinationPath: "legacy.txt",
      sourcePath: "fixtures/legacy.txt",
    });
    recorder.record("putAppFile", {
      target: { domain: "user_files", namespace: "fixtures" },
      files: [
        { destinationPath: "a.txt", contentText: "a" },
        { destinationPath: "b.txt", sourcePath: "/tmp/b.txt" },
      ],
    });
    recorder.record("stageSessionDownloads", {
      directory: "fixtures",
      files: [{ destinationPath: "a.txt", sourcePath: "/tmp/a.txt" }],
    });
    expect(recorder.stop()).toEqual([]);
  });
});
