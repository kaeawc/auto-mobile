import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { z } from "zod/v4";
import {
  DefaultPlanExecutor,
  UNEVALUATED_EXPECTATIONS_WARNING,
} from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { preserveToolRegistry, unregisterTemporaryTools } from "../helpers/withTemporaryTool";
import { registerCriticalSectionTools } from "../../src/server/criticalSectionTools";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  registerInteractionTools,
  resetTapOnElementFactory,
  setTapOnElementFactory,
} from "../../src/server/interactionTools";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

// criticalSection sub-steps run through ToolRegistry.callInternal, which does not
// parse. They must still get the migration + schema parse a top-level step gets
// (#9927). Real tapOn registration + the fake element factory, no device I/O.
describe("criticalSection sub-steps get the plan path's migration and schema parse (#9927)", () => {
  const device = { platform: "android" as const, deviceId: "fake-device", name: "Fake" };
  let executor: DefaultPlanExecutor;
  let coordinator: CriticalSectionCoordinator;
  let restoreTools: () => void;
  let restoreCoordinator: () => void;
  let restoreHandlers: () => void;
  let restoreSuiteTools: () => void;
  let tappedTexts: Array<string | undefined>;

  beforeAll(() => {
    restoreSuiteTools = preserveToolRegistry();
    registerInteractionTools();
    registerCriticalSectionTools();
  });

  afterAll(() => restoreSuiteTools());

  beforeEach(() => {
    restoreTools = preserveToolRegistry();
    executor = new DefaultPlanExecutor(new FakeTimer());
    coordinator = CriticalSectionCoordinator.createForTesting(new FakeTimer());
    restoreCoordinator = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    tappedTexts = [];
    setTapOnElementFactory(() => ({
      execute: async (params) => {
        tappedTexts.push(params.text);
        return {
          success: true,
          action: "tap",
          element: { text: params.text, bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
        };
      },
    }));
    const section = ToolRegistry.getToolForPlan("criticalSection")!;
    const tap = ToolRegistry.getToolForPlan("tapOn")!;
    const handlers = [tap, section].map((tool) =>
      spyOn(tool, "handler").mockImplementation(async (params, progress, signal) =>
        finalizeToolResponse(await tool.deviceAwareHandler!(device, params, progress, signal), {
          name: tool.name,
          internal: true,
        }),
      ),
    );
    restoreHandlers = () => handlers.forEach((handler) => handler.mockRestore());
  });

  afterEach(() => {
    restoreHandlers();
    resetTapOnElementFactory();
    coordinator.reset();
    restoreCoordinator();
    restoreTools();
  });

  const sectionPlan = (steps: Array<Record<string, unknown>>): Plan => ({
    name: "section-sub-step-schema",
    steps: [
      {
        tool: "criticalSection",
        params: { device: "A", lock: "sub-step-schema", deviceCount: 1, steps },
      },
    ],
  });

  test("a legacy flat tapOn { text } sub-step is migrated and taps the text", async () => {
    const result = await executor.executePlan(
      sectionPlan([{ tool: "tapOn", params: { device: "A", text: "Sync" } }]),
      0,
    );
    expect(result.failedStep).toBeUndefined();
    expect(result.success).toBe(true);
    expect(tappedTexts).toEqual(["Sync"]);
  });

  test("a legacy tapOnText sub-step is renamed to tapOn and taps the text", async () => {
    const result = await executor.executePlan(
      sectionPlan([{ tool: "tapOnText", params: { device: "A", text: "Sync" } }]),
      0,
    );
    expect(result.success).toBe(true);
    expect(tappedTexts).toEqual(["Sync"]);
  });

  test("the already-migrated selector form is unchanged", async () => {
    const result = await executor.executePlan(
      sectionPlan([
        { tool: "tapOn", params: { device: "A", action: "tap", selector: { text: "Sync" } } },
      ]),
      0,
    );
    expect(result.success).toBe(true);
    expect(tappedTexts).toEqual(["Sync"]);
  });

  test("an unknown sub-step key fails like the top-level step instead of being ignored", async () => {
    const subStep = {
      tool: "tapOn",
      params: { device: "A", action: "tap", selector: { text: "Sync" }, bogus: 1 },
    };
    const inSection = await executor.executePlan(sectionPlan([subStep]), 0);
    const topLevel = await executor.executePlan(
      { name: "top-level-unknown-key", steps: [subStep] },
      0,
    );

    expect(topLevel.success).toBe(false);
    expect(topLevel.failedStep?.error).toContain("Invalid parameters for tool tapOn");
    expect(inSection.success).toBe(false);
    expect(inSection.failedStep?.error).toContain("Invalid parameters for tool tapOn");
    expect(inSection.failedStep?.error).toContain("bogus");
    expect(tappedTexts).toEqual([]);
  });

  test("an optional sub-step with invalid params still fails the section", async () => {
    const result = await executor.executePlan(
      sectionPlan([
        {
          tool: "tapOn",
          optional: true,
          params: { device: "A", action: "tap", selector: { text: "Sync" }, bogus: 1 },
        },
      ]),
      0,
    );
    expect(result.success).toBe(false);
    expect(result.failedStep?.error).toContain("Invalid parameters for tool tapOn");
  });

  test("a sub-step carrying expectations runs and the section warns they were not evaluated", async () => {
    const result = await executor.executePlan(
      sectionPlan([
        {
          tool: "tapOn",
          params: { device: "A", action: "tap", selector: { text: "Sync" } },
          expectations: [{ type: "elementVisible", selector: { text: "Done" } }],
        },
        { tool: "tapOn", params: { device: "A", action: "tap", selector: { text: "Plain" } } },
      ]),
      0,
    );
    expect(result.failedStep).toBeUndefined();
    expect(result.success).toBe(true);
    expect(tappedTexts).toEqual(["Sync", "Plain"]);
    expect(result.warnings).toEqual([
      {
        stepIndex: 0,
        tool: "criticalSection",
        warnings: [`step 1 (tapOn): ${UNEVALUATED_EXPECTATIONS_WARNING}`],
      },
    ]);
  });

  test("an empty expectations list adds no warning", async () => {
    const result = await executor.executePlan(
      sectionPlan([
        {
          tool: "tapOn",
          params: { device: "A", action: "tap", selector: { text: "Sync" } },
          expectations: [],
        },
      ]),
      0,
    );
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
  });

  describe("the section's required device label", () => {
    afterEach(() => unregisterTemporaryTools("strictNoDeviceProbe", "strictDeviceProbe"));

    test("is not rejected as an unknown key by a strict schema that has no device field", async () => {
      const received: unknown[] = [];
      ToolRegistry.register(
        "strictNoDeviceProbe",
        "strict tool without a device field (like listDevices)",
        z.strictObject({ query: z.string().optional() }),
        async (params: unknown) => {
          received.push(params);
          return createStructuredToolResponse({ success: true });
        },
      );
      const result = await executor.executePlan(
        sectionPlan([{ tool: "strictNoDeviceProbe", params: { device: "A", query: "x" } }]),
        0,
      );
      expect(result.failedStep).toBeUndefined();
      expect(result.success).toBe(true);
      expect(received).toEqual([expect.objectContaining({ query: "x" })]);
      expect(received[0]).not.toHaveProperty("device");
    });

    test("is kept when the tool declares a device field", async () => {
      const received: unknown[] = [];
      ToolRegistry.register(
        "strictDeviceProbe",
        "strict tool that declares device",
        z.strictObject({ device: z.string().optional() }),
        async (params: unknown) => {
          received.push(params);
          return createStructuredToolResponse({ success: true });
        },
      );
      const result = await executor.executePlan(
        sectionPlan([{ tool: "strictDeviceProbe", params: { device: "A" } }]),
        0,
      );
      expect(result.success).toBe(true);
      expect(received).toEqual([expect.objectContaining({ device: "A" })]);
    });

    test("other unknown keys on a no-device strict tool are still rejected", async () => {
      ToolRegistry.register(
        "strictNoDeviceProbe",
        "strict tool without a device field",
        z.strictObject({ query: z.string().optional() }),
        async () => createStructuredToolResponse({ success: true }),
      );
      const result = await executor.executePlan(
        sectionPlan([{ tool: "strictNoDeviceProbe", params: { device: "A", bogus: 1 } }]),
        0,
      );
      expect(result.success).toBe(false);
      expect(result.failedStep?.error).toContain("Invalid parameters for tool strictNoDeviceProbe");
      expect(result.failedStep?.error).toContain("bogus");
    });
  });

  describe("schema defaults reach the handler", () => {
    afterEach(() => unregisterTemporaryTools("subStepDefaultsProbe"));

    test("a zod default and an unknown-key strip are applied before the handler runs", async () => {
      const received: unknown[] = [];
      ToolRegistry.register(
        "subStepDefaultsProbe",
        "defaults probe",
        z.object({ device: z.string().optional(), mode: z.string().default("fast") }),
        async (params: unknown) => {
          received.push(params);
          return createStructuredToolResponse({ success: true });
        },
      );
      const result = await executor.executePlan(
        sectionPlan([{ tool: "subStepDefaultsProbe", params: { device: "A", extra: true } }]),
        0,
      );
      expect(result.success).toBe(true);
      expect(received).toEqual([expect.objectContaining({ device: "A", mode: "fast" })]);
      expect(received[0]).not.toHaveProperty("extra");
    });
  });
});
