import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { createDefaultPlanExecutor } from "../../src/server/planExecutorFactory";
import { YamlPlanSerializer } from "../../src/utils/plan/PlanSerializer";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Step-level `expectations` (#16817): after the step's tool succeeds, each expectation is checked
 * with a fresh internal `observe` carrying the matching `waitFor`. A waitFor timeout fails the
 * step (or skips it when `optional`), naming the expectation and what the observation saw.
 */
describe("PlanExecutor — step-level expectations", () => {
  let restoreTools: () => void;
  let stepCalls: Array<Record<string, unknown>>;
  let observeCalls: Array<Record<string, unknown>>;
  /** Decides each fake observe answer from its waitFor; returns a timed-out observation by default. */
  let observeAnswer: (waitFor: Record<string, unknown>) => Record<string, unknown>;

  const timedOut = (texts: string[]) => ({
    awaitTimeout: true,
    awaitDuration: 5000,
    elements: { text: texts.map((text) => ({ text })) },
    candidates: [{ text: "Item 1", "resource-id": "list_row" }],
  });

  beforeEach(() => {
    restoreTools = preserveToolRegistry();
    stepCalls = [];
    observeCalls = [];
    observeAnswer = () => ({ awaitTimeout: false, awaitDuration: 40 });
    ToolRegistry.register(
      "expectationsStrictTool",
      "strict schema tool",
      z.strictObject({
        platform: z.string().optional(),
        deviceId: z.string().optional(),
        sessionUuid: z.string().optional(),
      }),
      async (params) => {
        stepCalls.push(params);
        return createStructuredToolResponse({ success: true });
      },
    );
    ToolRegistry.register(
      "observe",
      "fake observe",
      z.strictObject({
        platform: z.string().optional(),
        deviceId: z.string().optional(),
        sessionUuid: z.string().optional(),
        device: z.string().optional(),
        waitFor: z.record(z.string(), z.unknown()).optional(),
      }),
      async (params) => {
        observeCalls.push(params);
        const answer = observeAnswer((params.waitFor ?? {}) as Record<string, unknown>);
        // Like the real observe, a waitFor timeout is an isError envelope that still carries
        // the last observation (#16889).
        return withIsErrorOnFailure(
          createStructuredToolResponse(answer),
          answer.awaitTimeout !== true,
        );
      },
    );
  });

  afterEach(() => restoreTools());

  const planWith = (expectations: string, extra = "") =>
    new YamlPlanSerializer().importPlanFromYaml(`name: expectations-demo
steps:
  - tool: expectationsStrictTool
${extra}    expectations:
${expectations}
  - tool: expectationsStrictTool
`);

  const run = (
    plan: ReturnType<typeof planWith>,
    platform: "android" | "ios",
    deviceId = platform === "android" ? "emulator-5554" : "SIM-UDID",
  ) => createDefaultPlanExecutor(new FakeTimer()).executePlan(plan, 0, platform, deviceId);

  for (const platform of ["android", "ios"] as const) {
    describe(platform, () => {
      test("a passing expectation is checked with a fresh observe and the plan continues", async () => {
        const plan = planWith(`      - type: elementVisible
        selector: { testTag: bug_repro_content }
      - type: textEquals
        selector: { resourceId: counter }
        text: "3"
`);

        const result = await run(plan, platform);

        expect(result.success).toBe(true);
        expect(result.warnings).toBeUndefined();
        expect(stepCalls).toHaveLength(2);
        expect(stepCalls[0]).not.toHaveProperty("expectations");
        expect(observeCalls.map((call) => call.waitFor)).toEqual([
          { testTag: "bug_repro_content" },
          { elementId: "counter", text: "3", textMatch: "exact", textSource: "displayed" },
        ]);
        expect(observeCalls[0].platform).toBe(platform);
      });

      test("a failing expectation fails the step and names what was observed", async () => {
        observeAnswer = (waitFor) =>
          "absent" in waitFor ? { awaitTimeout: false } : timedOut(["Home", "Settings"]);
        const plan = planWith(`      - type: elementAbsent
        selector: { text: Loading }
      - type: textContains
        text: Welcome
        timeoutMs: 1500
`);

        const result = await run(plan, platform);

        expect(result.success).toBe(false);
        expect(stepCalls).toHaveLength(1);
        expect(observeCalls.map((call) => call.waitFor)).toEqual([
          { absent: { text: "Loading" } },
          { text: "Welcome", textMatch: "contains", textSource: "displayed", timeout: 1500 },
        ]);
        expect(result.failedStep?.stepIndex).toBe(0);
        expect(result.failedStep?.error).toBe(
          'Expectation 2/2 (textContains text="Welcome") failed: not satisfied after 5000ms; ' +
            '1 near match(es); observed texts: "Home", "Settings"',
        );
        expect(result.failedStep?.failureObservation?.visibleTextsSample).toEqual([
          "Home",
          "Settings",
        ]);
        const details = result.debug?.steps[0].details;
        expect(details?.failedExpectation).toEqual({
          index: 1,
          expectation: { type: "textContains", text: "Welcome", timeoutMs: 1500 },
        });
        expect(details?.waitForTimeout).toMatchObject({ awaitDuration: 5000, candidateCount: 1 });
      });

      test("an optional step whose expectation fails is skipped and the plan continues", async () => {
        observeAnswer = () => timedOut([]);
        const plan = planWith(
          `      - type: elementVisible
        selector: { contentDescription: Dismiss }
`,
          "    optional: true\n",
        );

        const result = await run(plan, platform);

        expect(result.success).toBe(true);
        expect(stepCalls).toHaveLength(2);
        expect(result.skippedSteps).toHaveLength(1);
        expect(result.skippedSteps?.[0]).toMatchObject({
          stepIndex: 0,
          error:
            'Expectation 1/1 (elementVisible contentDescription="Dismiss") failed: not satisfied after 5000ms; 1 near match(es)',
        });
      });
    });
  }

  test("the expectation observes the device the step itself targeted", async () => {
    const plan = new YamlPlanSerializer().importPlanFromYaml(`name: step-override
steps:
  - tool: expectationsStrictTool
    params:
      deviceId: emulator-5556
    expectations:
      - type: elementVisible
        selector: { text: Done }
`);

    const result = await run(plan, "android");

    expect(result.success).toBe(true);
    expect(stepCalls[0].deviceId).toBe("emulator-5556");
    expect(observeCalls[0]).toMatchObject({ platform: "android", deviceId: "emulator-5556" });
  });

  test("an unsupported expectation type is reported as a warning, not silently passed", async () => {
    const plan = planWith(`      - type: hasAccessibilityIssues
`);

    const result = await run(plan, "android");

    expect(result.success).toBe(true);
    expect(observeCalls).toHaveLength(0);
    expect(result.warnings?.[0].warnings).toEqual([
      "Expectation `hasAccessibilityIssues` was not evaluated: type `hasAccessibilityIssues` is not supported (supported: elementVisible, elementAbsent, textEquals, textContains).",
    ]);
  });

  test("an invalid expectation fails the step without observing", async () => {
    const plan = planWith(`      - type: elementVisible
`);

    const result = await run(plan, "android");

    expect(result.success).toBe(false);
    expect(observeCalls).toHaveLength(0);
    expect(result.failedStep?.error).toBe(
      "Expectation 1/1 (elementVisible) failed: invalid expectation: elementVisible requires a selector",
    );
  });

  test("an observe that reports failure fails the expectation with its error", async () => {
    observeAnswer = () => ({ success: false, error: "device offline" });
    const plan = planWith(`      - type: elementVisible
        selector: { text: Done }
`);

    const result = await run(plan, "ios");

    expect(result.success).toBe(false);
    expect(result.failedStep?.error).toBe(
      'Expectation 1/1 (elementVisible text="Done") failed: could not observe the screen: device offline',
    );
  });

  test("an unmet expectation reports how long it waited, not the serialized observation (#17196)", async () => {
    observeAnswer = () => ({ ...timedOut(["Settings", "Network"]), awaitDuration: 750 });
    const plan = planWith(`      - type: textEquals
        text: "Definitely Not Present 0091a"
        timeoutMs: 750
`);

    const result = await run(plan, "android");

    expect(result.success).toBe(false);
    const error = result.failedStep?.error ?? "";
    expect(error).toBe(
      'Expectation 1/1 (textEquals text="Definitely Not Present 0091a") failed: not satisfied after 750ms; ' +
        '1 near match(es); observed texts: "Settings", "Network"',
    );
    expect(error).not.toContain("could not observe");
    expect(error).not.toContain("awaitTimeout");
    expect(result.failedStep?.failureObservation?.visibleTextsSample).toEqual([
      "Settings",
      "Network",
    ]);
  });

  test("an isError observe that is not a waitFor timeout still reports it could not observe", async () => {
    ToolRegistry.register(
      "observe",
      "failing observe",
      z.strictObject({
        platform: z.string().optional(),
        deviceId: z.string().optional(),
        sessionUuid: z.string().optional(),
        device: z.string().optional(),
        waitFor: z.record(z.string(), z.unknown()).optional(),
      }),
      async () =>
        withIsErrorOnFailure(
          createStructuredToolResponse({ error: "hierarchy dump failed" }),
          false,
        ),
    );
    const plan = planWith(`      - type: elementVisible
        selector: { text: Done }
`);

    const result = await run(plan, "android");

    expect(result.success).toBe(false);
    expect(result.failedStep?.error).toBe(
      'Expectation 1/1 (elementVisible text="Done") failed: could not observe the screen: hierarchy dump failed',
    );
    expect(result.failedStep?.failureObservation).toBeUndefined();
  });

  test("a step without expectations never observes", async () => {
    const plan = new YamlPlanSerializer().importPlanFromYaml(`name: plain
steps:
  - tool: expectationsStrictTool
`);

    const result = await run(plan, "android");

    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(observeCalls).toHaveLength(0);
  });
});
