import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as yaml from "js-yaml";
import { PLAN_RELEVANT_TOOLS } from "../../src/features/record/McpCallRecorder";
import type { Plan } from "../../src/models";
import { registerMcpTools } from "../../src/server/index";
import {
  getMcpRecorder,
  resetMcpRecordingState,
  startMcpRecording,
  stopMcpRecording,
} from "../../src/server/mcpRecordingManager";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlanSchemaValidator } from "../../src/utils/plan/PlanSchemaValidator";
import { importPlanFromYaml } from "../../src/utils/planUtils";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Interaction between recordSteps (#10052 widened the recorded tool list to every state-changing
 * tool) and the plan schema (#10124/#10125 made `schemas/test-plan.schema.json` accept every
 * tool call the live tool schemas accept). `recordSteps` end hands back plan YAML that
 * `executePlan` then schema-validates and normalises: a recorded step the schema rejects, or one
 * the normaliser/migrator rewrites into something different, is a recorded plan that cannot be
 * replayed. Neither side's own tests cover a recorded plan through the other.
 */

/** One valid call per recorded tool, as a client sends it (before the registry's injected params). */
const CALLS: Readonly<Record<string, Record<string, unknown>>> = {
  launchApp: { appId: "com.example" },
  terminateApp: { appId: "com.example" },
  crashApp: { appId: "com.example" },
  appLifecycle: { appId: "com.example", action: "background" },
  observe: {},
  tapOn: { selector: { text: "Login" } },
  tapAny: { container: { text: "List" } },
  tapAt: { x: 10, y: 20 },
  swipeOn: { direction: "up" },
  sendKeys: { commands: [{ action: "type", text: "hello" }] },
  pressButton: { button: "home" },
  dragAndDrop: { source: { elementId: "a" }, target: { elementId: "b" } },
  pinchOn: { direction: "in" },
  selectAllText: {},
  clipboard: { action: "copy", text: "x" },
  keyboard: { action: "open" },
  homeScreen: {},
  recentApps: {},
  openLink: { url: "https://example.com" },
  systemTray: { action: "tap", notification: { title: "Hi" } },
  wakeAndUnlock: {},
  rotate: { orientation: "landscape" },
  shake: {},
  setPosture: { posture: "half_opened" },
  setDeviceState: { connectivity: { airplaneMode: true } },
  displayConfig: { theme: "dark" },
  changeLocalization: { locale: "en-US" },
  setAppPermissions: { appId: "com.example", permissions: ["android.permission.CAMERA"] },
  postNotification: { title: "Hi", body: "There" },
  setUIState: { fields: [{ selector: { text: "Name" }, value: "Ada" }] },
  accessibility: { talkback: true },
  biometricAuth: { action: "match", modality: "fingerprint" },
  phoneCall: { action: "call", phoneNumber: "5551234" },
  sendSms: { phoneNumber: "5551234", message: "hello" },
  setNotificationPolicy: { appId: "com.example", policyAccess: true },
  setPreference: {
    scope: "sharedPreferences",
    appId: "com.example",
    key: "flag",
    value: true,
    type: "bool",
  },
  // The recorder writes the destructive confirmation as false, so a replay stops at the step.
  resetKeychain: { appId: "com.example", confirm: true },
  resetAppLogs: { appId: "com.example", container: "documents", paths: ["logs/app.log"] },
  putAppFile: {
    target: { domain: "app_containers", appId: "com.example", container: "documents" },
    files: [{ destinationPath: "fixtures/a.json", contentText: "{}" }],
  },
  stageSharedStorage: {
    namespace: "fixtures",
    files: [{ destinationPath: "a.txt", contentText: "a" }],
  },
  stageSharedStorageFixtures: {
    namespace: "fixtures",
    files: [{ destinationPath: "a.txt", contentText: "a" }],
  },
  stageSessionDownloads: {
    directory: "fixtures",
    files: [{ destinationPath: "a.txt", contentText: "a" }],
  },
};

/** What the registry injects into every device-aware call; the recorder must strip it. */
const INJECTED = { platform: "android", deviceId: "emulator-5554", sessionUuid: "recording" };

let validator: PlanSchemaValidator;

beforeAll(async () => {
  ToolRegistry.clearTools();
  registerMcpTools(true);
  validator = new PlanSchemaValidator();
  await validator.loadSchema();
  // Warm the plan schema compile so no test body pays for it (100ms/test budget).
  validator.validateYaml("name: warm\nsteps:\n  - tool: observe\n");
});

afterAll(() => {
  ToolRegistry.clearTools();
  resetMcpRecordingState();
});

/** Record the calls through the real recording manager and return the exported plan YAML. */
function recordPlanYaml(calls: ReadonlyArray<readonly [string, Record<string, unknown>]>): string {
  resetMcpRecordingState();
  const timer = new FakeTimer();
  startMcpRecording({ timer });
  for (const [tool, args] of calls) {
    getMcpRecorder()!.record(tool, { ...args, ...INJECTED });
  }
  return stopMcpRecording({ timer }).planContent;
}

describe("recordSteps plans through the plan schema and normaliser (#10052 x #10124)", () => {
  test("the fixture table covers every recorded tool, so a newly recorded tool needs a case", () => {
    expect(Object.keys(CALLS).sort()).toEqual([...PLAN_RELEVANT_TOOLS].sort());
  });

  test.each(Object.entries(CALLS))("%s: the recorded step is schema-valid", (tool, args) => {
    const planYaml = recordPlanYaml([[tool, args]]);

    const verdict = validator.validateYaml(planYaml);
    expect(verdict.errors ?? []).toEqual([]);
    expect(verdict.valid).toBe(true);
  });

  test("one plan holding every recorded tool is schema-valid and keeps its step order", () => {
    const planYaml = recordPlanYaml(Object.entries(CALLS));

    const verdict = validator.validateYaml(planYaml);
    expect(verdict.errors ?? []).toEqual([]);
    const recorded = yaml.load(planYaml) as Plan;
    expect(recorded.steps.map((step) => step.tool)).toEqual(Object.keys(CALLS));
  });

  test("the normaliser returns each recorded step unchanged and the live tool schema parses it", () => {
    const planYaml = recordPlanYaml(Object.entries(CALLS));
    const recorded = yaml.load(planYaml) as Plan;

    for (const platform of ["android", "ios"] as const) {
      const imported = importPlanFromYaml(planYaml, { platform });
      // The migrator may only add the tool's own default: tapOn.action "tap" (PlanMigrator).
      const expected = recorded.steps.map((step) =>
        step.tool === "tapOn" ? { ...step, params: { action: "tap", ...step.params } } : step,
      );
      expect(imported.steps).toEqual(expected);
    }
    const unparsed = recorded.steps.filter((step) => {
      const schema = ToolRegistry.getToolForPlan(step.tool)?.schema;
      // PlanExecutor re-injects the session for device-aware tools before parsing.
      return !schema || !schema.safeParse({ ...step.params, sessionUuid: "replay" }).success;
    });
    expect(unparsed.map((step) => step.tool)).toEqual([]);
  });

  test("a recorded tapAt step carries no snapshot reference through validation and import", () => {
    const planYaml = recordPlanYaml([["tapAt", { x: 1, y: 2, snapshotId: "snap-1" }]]);

    expect(validator.validateYaml(planYaml).valid).toBe(true);
    const imported = importPlanFromYaml(planYaml, { platform: "android" });
    expect(imported.steps).toEqual([{ tool: "tapAt", params: { x: 1, y: 2 } }]);
  });

  test("a recorded resetKeychain step keeps its withheld confirmation after validation and import", () => {
    const planYaml = recordPlanYaml([["resetKeychain", { appId: "com.example", confirm: true }]]);

    expect(validator.validateYaml(planYaml).valid).toBe(true);
    const [step] = importPlanFromYaml(planYaml, { platform: "ios" }).steps;
    expect(step.params).toEqual({ appId: "com.example", confirm: false });
  });
});
