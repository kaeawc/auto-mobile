import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpCallRecorder, PLAN_RELEVANT_TOOLS } from "../../../src/features/record/McpCallRecorder";

// Every tool the MCP server advertises (generated from the registry and kept in
// sync by `generate-tool-definitions.ts --check`).
const registeredTools: string[] = (
  JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../../schemas/tool-definitions.json"), "utf8"),
  ) as { name: string }[]
).map((tool) => tool.name);

const DEVICE_MANAGEMENT = "Device or image management, not a replayable step in a plan";
const READ_ONLY = "Read-only query; changes no device state so a plan gains nothing from it";
const NOT_YET =
  "State-changing but not yet recorded; follow-up to #9928, which scopes UI/device actions";
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
  overlay: HOST_LOCAL,
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
  accessibility: NOT_YET,
  accessibilityFocus: NOT_YET,
  biometricAuth: NOT_YET,
  phoneCall: NOT_YET,
  sendSms: NOT_YET,
  setNotificationPolicy: NOT_YET,
  setPreference: NOT_YET,
  setKeyValue: NOT_YET,
  removeKeyValue: NOT_YET,
  clearKeyValueFile: NOT_YET,
  resetKeychain: NOT_YET,
  resetAppLogs: NOT_YET,
  putAppFile: NOT_YET,
  stageSessionDownloads: NOT_YET,
  stageSharedStorage: NOT_YET,
  stageSharedStorageFixtures: NOT_YET,
  network: NOT_YET,
  mockNetwork: NOT_YET,
  clearMockNetwork: NOT_YET,
};

describe("PLAN_RELEVANT_TOOLS coverage (#9928)", () => {
  test("every registered tool is either recorded or excluded with a reason", () => {
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
    const registered = new Set(registeredTools);
    expect([...PLAN_RELEVANT_TOOLS].filter((name) => !registered.has(name))).toEqual([]);
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
});
