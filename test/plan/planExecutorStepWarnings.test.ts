import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { preserveToolRegistry, unregisterTemporaryTools } from "../helpers/withTemporaryTool";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { registerCriticalSectionTools } from "../../src/server/criticalSectionTools";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import { FakeTimer } from "../fakes/FakeTimer";
import { ActionableError } from "../../src/models";
import {
  registerInteractionTools,
  resetTapOnElementFactory,
  setTapOnElementFactory,
  tapOnHandler,
} from "../../src/server/interactionTools";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";

describe("PlanExecutor — real tapOn warnings inside criticalSection", () => {
  const warning = "The matched element is disabled; the tap may have no effect.";
  const device = { platform: "android" as const, deviceId: "fake-device", name: "Fake" };
  let executor: DefaultPlanExecutor;
  let coordinator: CriticalSectionCoordinator;
  let restoreTools: () => void;
  let restoreCoordinator: () => void;
  let restoreHandlers: () => void;
  let restoreSuiteTools: () => void;

  beforeAll(() => {
    restoreSuiteTools = preserveToolRegistry();
    registerInteractionTools();
    registerCriticalSectionTools();
    expect(ToolRegistry.getToolForPlan("tapOn")?.deviceAwareHandler).toBe(tapOnHandler);
  });

  afterAll(() => restoreSuiteTools());

  beforeEach(() => {
    restoreTools = preserveToolRegistry();
    executor = new DefaultPlanExecutor(new FakeTimer());
    coordinator = CriticalSectionCoordinator.createForTesting(new FakeTimer());
    restoreCoordinator = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    setTapOnElementFactory(() => ({
      execute: async (params) => ({
        success: params.text !== "Missing",
        action: "tap",
        element: {
          text: params.text,
          enabled: params.text !== "Disabled",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
        },
        ...(params.text === "Disabled" ? { warnings: [warning] } : {}),
        ...(params.text === "Missing" ? { error: "Element not found" } : {}),
      }),
    }));
    const tap = ToolRegistry.getToolForPlan("tapOn")!;
    const section = ToolRegistry.getToolForPlan("criticalSection")!;
    // Replace only device acquisition/auditing; retain real handlers, internal
    // dispatch and finalization without device I/O or a file-backed database.
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

  function tapStep(text: string): Plan["steps"][number] {
    return { tool: "tapOn", params: { device: "A", action: "tap", selector: { text } } };
  }

  test.each([
    { outcome: "success", fails: false, optional: false },
    { outcome: "required failure", fails: true, optional: false },
    { outcome: "optional section skipped", fails: true, optional: true },
  ])("$outcome retains the sub-step warning exactly once", async ({ fails, optional }) => {
    const result = await executor.executePlan(
      {
        name: "real-tap-section-warning",
        steps: [
          {
            tool: "criticalSection",
            optional,
            params: {
              device: "A",
              lock: "real-tap-warning",
              deviceCount: 1,
              steps: [
                tapStep("Primary"),
                tapStep("Disabled"),
                tapStep(fails ? "Missing" : "Primary"),
              ],
            },
          },
        ],
      },
      0,
    );
    expect(result.success).toBe(!fails || optional);
    expect(result.warnings).toEqual([
      { stepIndex: 0, tool: "criticalSection", warnings: [`step 2 (tapOn): ${warning}`] },
    ]);
    expect(result.failedStep?.stepIndex).toBe(fails && !optional ? 0 : undefined);
    expect(result.skippedSteps?.map((step) => step.stepIndex)).toEqual(optional ? [0] : undefined);
  });

  test("top-level real tapOn warning remains unchanged before a required failure", async () => {
    const result = await executor.executePlan(
      {
        name: "real-tap-top-level-warning",
        steps: [tapStep("Disabled"), tapStep("Missing")],
      },
      0,
    );
    expect(result.success).toBe(false);
    expect(result.failedStep?.stepIndex).toBe(1);
    expect(result.warnings).toEqual([{ stepIndex: 0, tool: "tapOn", warnings: [warning] }]);
  });
});

/**
 * A best-effort epilogue that fails keeps the step successful and reports itself
 * through `warnings` (issue #6868). Inside
 * `executePlan` that used to be the step's whole failure signal, so dropping it
 * would let a plan report an entirely clean success while later steps ran against
 * a screen the caller thinks is in a different state.
 */
describe("PlanExecutor — best-effort warnings in debug.steps", () => {
  let planExecutor: DefaultPlanExecutor;

  const sendKeysSchema = z.object({
    commands: z.array(z.object({ action: z.string() })),
    platform: z.string().optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
  });

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
  });

  afterEach(() => {
    unregisterTemporaryTools("sendKeys");
  });

  const registerSendKeys = (payload: Record<string, unknown>) => {
    const handler = mock(async () => createStructuredToolResponse(payload));
    ToolRegistry.register("sendKeys", "Mock sendKeys", sendKeysSchema, handler);
    (ToolRegistry.getTool("sendKeys") as { requiresDevice: boolean }).requiresDevice = true;
  };

  test("a successful step's warnings reach debug.steps[n].details", async () => {
    registerSendKeys({
      success: true,
      text: "hello",
      keyboardDismissed: false,
      warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
    });

    const plan: Plan = {
      name: "input-warning-plan",
      steps: [{ tool: "sendKeys", params: { commands: [{ action: "clear" }] } }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(true);
    const step = result.debug?.steps.find((s) => s.step.includes(": sendKeys"));
    expect(step?.status).toBe("completed");
    expect(step?.details?.warnings).toEqual([
      "keyboard dismissal failed: Keyboard state unavailable",
    ]);
  });

  // `debug` is only forwarded into the executePlan response when the unrelated
  // `captureObserveSteps` option is set, so a warning that lives only in the
  // debug trace never reaches an ordinary plan's caller (#6887 review). The
  // executor promotes it to a first-class `warnings` field on the result.
  test("a successful step's warnings are promoted onto the plan result", async () => {
    registerSendKeys({
      success: true,
      text: "hello",
      keyboardDismissed: false,
      warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
    });

    const plan: Plan = {
      name: "input-warning-plan",
      steps: [
        { tool: "sendKeys", params: { commands: [{ action: "clear" }] } },
        { tool: "sendKeys", params: { commands: [{ action: "key" }] } },
      ],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([
      {
        stepIndex: 0,
        tool: "sendKeys",
        warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
      },
      {
        stepIndex: 1,
        tool: "sendKeys",
        warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
      },
    ]);
  });

  test("a multi-device plan labels each promoted warning with its device", async () => {
    registerSendKeys({
      success: true,
      text: "hello",
      keyboardDismissed: false,
      warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
    });

    const plan: Plan = {
      name: "input-warning-multi-device-plan",
      devices: ["A", "B"],
      steps: [
        { tool: "sendKeys", params: { commands: [{ action: "clear" }], device: "A" } },
        { tool: "sendKeys", params: { commands: [{ action: "clear" }], device: "B" } },
      ],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(true);
    expect(
      [...(result.warnings ?? [])].sort((a, b) => (a.device ?? "").localeCompare(b.device ?? "")),
    ).toEqual([
      {
        stepIndex: 0,
        tool: "sendKeys",
        device: "A",
        warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
      },
      {
        stepIndex: 1,
        tool: "sendKeys",
        device: "B",
        warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
      },
    ]);
  });

  test("a clean plan carries no warnings key", async () => {
    registerSendKeys({ success: true });

    const plan: Plan = {
      name: "input-clean-result-plan",
      steps: [{ tool: "sendKeys", params: { commands: [{ action: "clear" }] } }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.warnings).toBeUndefined();
  });

  test("a clean step carries no warnings key", async () => {
    registerSendKeys({ success: true });

    const plan: Plan = {
      name: "input-clean-plan",
      steps: [{ tool: "sendKeys", params: { commands: [{ action: "clear" }] } }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(true);
    const step = result.debug?.steps.find((s) => s.step.includes(": sendKeys"));
    expect(step?.details?.warnings).toBeUndefined();
  });
});

describe("PlanExecutor — failed criticalSection warnings", () => {
  let executor: DefaultPlanExecutor;
  let timer: FakeTimer;
  let restoreTools: () => void;
  let restoreCoordinator: () => void;
  let coordinator: CriticalSectionCoordinator;
  let restoreHandler: () => void;
  const observe = mock(async () =>
    createStructuredToolResponse({
      updatedAt: 0,
      activeWindow: { appId: "fake.app" },
      viewHierarchy: { text: "failure screen" },
    }),
  );

  beforeEach(() => {
    restoreTools = preserveToolRegistry();
    timer = new FakeTimer();
    executor = new DefaultPlanExecutor(timer);
    coordinator = CriticalSectionCoordinator.createForTesting(new FakeTimer());
    restoreCoordinator = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    registerCriticalSectionTools();
    const section = ToolRegistry.getToolForPlan("criticalSection")!;
    // Bind the real section handler to a fake device; avoid device acquisition/DB access.
    const handler = spyOn(section, "handler").mockImplementation((params, progress, signal) =>
      section.deviceAwareHandler!(
        { platform: "android", deviceId: "fake-device", name: "Fake" },
        params,
        progress,
        signal,
      ),
    );
    restoreHandler = () => handler.mockRestore();
    observe.mockClear();
    ToolRegistry.register(
      "observe",
      "fake failure observation",
      z.object({}).passthrough(),
      observe,
    );
    ToolRegistry.register("sectionWarning", "warns", z.object({}).passthrough(), async () => ({
      success: true,
      warnings: ["epilogue failed"],
    }));
    ToolRegistry.register("sectionFailure", "fails", z.object({}).passthrough(), async () => {
      throw new ActionableError("required failure");
    });
  });

  afterEach(() => {
    restoreHandler();
    coordinator.reset();
    restoreCoordinator();
    restoreTools();
  });

  function sectionStep(
    device = "A",
    optional = false,
    withWarnings = true,
    options: { outerOptional?: boolean; singleWarning?: boolean } = {},
  ): Plan["steps"][number] {
    return {
      tool: "criticalSection",
      ...(options.outerOptional !== undefined ? { optional: options.outerOptional } : {}),
      params: {
        device,
        lock: `warning-lock-${device}`,
        deviceCount: 1,
        steps: [
          ...(withWarnings
            ? [
                { tool: "sectionWarning", params: { device } },
                ...(options.singleWarning
                  ? []
                  : [
                      {
                        tool: optional ? "sectionFailure" : "sectionWarning",
                        params: { device },
                        optional,
                      },
                    ]),
              ]
            : []),
          { tool: "sectionFailure", params: { device } },
        ],
      },
    };
  }

  test.each([false, true])(
    "outer optional=%s preserves earlier warnings exactly once",
    async (outerOptional) => {
      const section = sectionStep("A", false, true, { outerOptional, singleWarning: true });
      const result = await executor.executePlan(
        {
          name: "outer-optional-section",
          steps: [
            { tool: "sectionWarning", params: {} },
            section,
            { tool: "sectionWarning", params: {} },
          ],
        },
        0,
      );
      expect(result.success).toBe(outerOptional);
      expect(result.executedSteps).toBe(outerOptional ? 2 : 1);
      expect(result.warnings).toEqual([
        { stepIndex: 0, tool: "sectionWarning", warnings: ["epilogue failed"] },
        {
          stepIndex: 1,
          tool: "criticalSection",
          warnings: ["step 1 (sectionWarning): epilogue failed"],
        },
        ...(outerOptional
          ? [{ stepIndex: 2, tool: "sectionWarning", warnings: ["epilogue failed"] }]
          : []),
      ]);
      if (outerOptional) {
        expect(result.skippedSteps).toEqual([
          { stepIndex: 1, tool: "criticalSection", error: sectionError("A") },
        ]);
        expect(result.failedStep).toBeUndefined();
      } else {
        expect(result.skippedSteps).toBeUndefined();
        expect(result.failedStep).toMatchObject({
          stepIndex: 1,
          tool: "criticalSection",
          error: sectionError("A"),
        });
      }
    },
  );

  test("multi-device skipped section keeps warning indexes and device labels without duplicates", async () => {
    const result = await executor.executePlan(
      {
        name: "multi-device-optional-section",
        devices: ["A", "B"],
        steps: [
          { tool: "sectionWarning", params: { device: "A" } },
          { tool: "sectionWarning", params: { device: "B" } },
          sectionStep("A", false, true, { outerOptional: true, singleWarning: true }),
          { tool: "sectionWarning", params: { device: "A" } },
        ],
      },
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      "finish-current-step",
    );
    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(3);
    expect(result.skippedSteps).toEqual([
      { stepIndex: 2, tool: "criticalSection", error: sectionError("A"), device: "A" },
    ]);
    expect(result.warnings).toEqual([
      { stepIndex: 0, tool: "sectionWarning", device: "A", warnings: ["epilogue failed"] },
      { stepIndex: 1, tool: "sectionWarning", device: "B", warnings: ["epilogue failed"] },
      {
        stepIndex: 2,
        tool: "criticalSection",
        device: "A",
        warnings: ["step 1 (sectionWarning): epilogue failed"],
      },
      { stepIndex: 3, tool: "sectionWarning", device: "A", warnings: ["epilogue failed"] },
    ]);
  });

  test("skipped outer section without earlier warnings omits the warnings entry", async () => {
    const result = await executor.executePlan(
      {
        name: "optional-section-no-warnings",
        steps: [sectionStep("A", false, false, { outerOptional: true })],
      },
      0,
    );
    expect(result.success).toBe(true);
    expect(result.skippedSteps).toHaveLength(1);
    expect(result).not.toHaveProperty("warnings");
  });

  function sectionError(device: string): string {
    return `Error: Critical section "warning-lock-${device}" failed for device fake-device: Failed at step 2/2 (sectionFailure): required failure`;
  }

  test.each([false, true])(
    "failed section retains top-level warnings with optional skip=%s",
    async (optional) => {
      const result = await executor.executePlan(
        {
          name: "failed-section-warnings",
          steps: [{ tool: "sectionWarning", params: {} }, sectionStep("A", optional)],
        },
        0,
        "android",
        "fake-device",
      );
      expect(result.success).toBe(false);
      expect(result.executedSteps).toBe(1);
      expect(result.failedStep).toMatchObject({ stepIndex: 1, tool: "criticalSection" });
      expect(result.warnings).toEqual([
        { stepIndex: 0, tool: "sectionWarning", warnings: ["epilogue failed"] },
        {
          stepIndex: 1,
          tool: "criticalSection",
          warnings: [
            "step 1 (sectionWarning): epilogue failed",
            optional
              ? "step 2 (sectionFailure): optional step failed; skipped: required failure"
              : "step 2 (sectionWarning): epilogue failed",
          ],
        },
      ]);
      expect(result.skippedSteps).toBeUndefined();
    },
  );

  test("failed section captures failureObservation through the existing executeStep catch", async () => {
    const result = await executor.executePlan(
      { name: "section-observation", steps: [sectionStep()] },
      0,
      "android",
      "fake-device",
    );
    expect(result.success).toBe(false);
    expect(result.failedStep?.failureObservation).toMatchObject({
      activeWindow: { appId: "fake.app" },
      viewHierarchy: { text: "failure screen" },
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("failed section with no accumulated warnings omits the warnings field", async () => {
    const result = await executor.executePlan(
      { name: "section-no-warnings", steps: [sectionStep("A", false, false)] },
      0,
    );
    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty("warnings");
  });

  test("multi-device failed sections retain warnings with plan indexes and device labels", async () => {
    const result = await executor.executePlan(
      {
        name: "multi-device-section-warnings",
        devices: ["A", "B"],
        steps: [
          { tool: "sectionWarning", params: { device: "A" } },
          { tool: "sectionWarning", params: { device: "B" } },
          sectionStep("A"),
          sectionStep("B"),
        ],
      },
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      "finish-current-step",
    );
    expect(result.success).toBe(false);
    expect(result.executedSteps).toBe(2);
    expect(result.warnings).toEqual([
      { stepIndex: 0, tool: "sectionWarning", device: "A", warnings: ["epilogue failed"] },
      { stepIndex: 1, tool: "sectionWarning", device: "B", warnings: ["epilogue failed"] },
      ...["A", "B"].map((device, index) => ({
        stepIndex: index + 2,
        tool: "criticalSection",
        device,
        warnings: [
          "step 1 (sectionWarning): epilogue failed",
          "step 2 (sectionWarning): epilogue failed",
        ],
      })),
    ]);
  });
});
