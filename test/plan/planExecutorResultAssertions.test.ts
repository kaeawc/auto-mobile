import { describe, expect, test } from "bun:test";
import type { PlanStep } from "../../src/models/Plan";
import { z } from "zod/v4";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import type { PlanStepTools } from "../../src/utils/plan/PlanStepExecutor";
import { YamlPlanSerializer } from "../../src/utils/plan/PlanSerializer";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";

// Verbatim captured messages: the old 120-second replay included both runs.
const capturedMessages = [
  "reply received: [null] action=reply",
  "reply received: [hello ] action=reply",
];

function harness(payload: Record<string, unknown>) {
  const timer = new FakeTimer();
  const tool = {
    schema: z.strictObject({ since: z.string().optional(), device: z.string().optional() }),
  };
  const calls: Array<{ name: string; start: number | undefined }> = [];
  const tools: PlanStepTools<typeof tool> = {
    getTool: () => tool,
    getToolForPlan: () => tool,
    callInternal: async (_tool, _params, request) => {
      calls.push({ name: "step", start: request?.planStartMs });
      timer.advanceTime(2500);
      return createStructuredToolResponse(payload);
    },
  };
  const executor = new DefaultPlanExecutor(
    { toolRegistry: tools, daemon: { sessionManager: () => undefined } },
    timer,
  );
  return { executor, calls, timer };
}

describe("plan result assertions", () => {
  test("the captured null reply fails replay instead of reporting success", async () => {
    const plan = new YamlPlanSerializer().importPlanFromYaml(`name: reply
steps:
  - tool: getLogs
    params: { since: run-start }
    expect:
      notContains: "reply received: [null]"
`);
    const { executor } = harness({
      success: true,
      lines: capturedMessages.map((message) => ({ message })),
    });
    const result = await executor.executePlan(plan, 0);
    expect(result.success).toBe(false);
    expect(result.executedSteps).toBe(0);
    expect(result.failedStep?.error).toContain("notContains");
  });

  test("both checks pass on returned log text without a fresh observation", async () => {
    const plan = new YamlPlanSerializer().importPlanFromYaml(`name: reply
steps:
  - tool: getLogs
    expect:
      contains: "reply received: [hello ] action=reply"
      notContains: "reply received: [null]"
`);
    const { executor, calls } = harness({
      success: true,
      lines: [{ message: capturedMessages[1] }],
    });
    expect((await executor.executePlan(plan, 0)).success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("run start is shared by steps and renewed for a resumed execution", async () => {
    const plan = {
      name: "clock",
      steps: [
        { tool: "getLogs", params: {} },
        { tool: "getLogs", params: {} },
      ],
    };
    const { executor, calls } = harness({ success: true, lines: [] });
    await executor.executePlan(plan, 0);
    await executor.executePlan(plan, 1);
    expect(calls.map((call) => call.start)).toEqual([0, 0, 5000]);
  });
  test("without an assertion the captured mixed-run payload still succeeds (neighbouring pin)", async () => {
    const { executor } = harness({
      success: true,
      lines: capturedMessages.map((message) => ({ message })),
    });
    const result = await executor.executePlan(
      { name: "unchanged", steps: [{ tool: "getLogs", params: {} }] },
      0,
    );
    expect(result.success).toBe(true);
  });

  for (const [label, payload, assertion, error] of [
    ["missing required text", { success: true, lines: [] }, { contains: "hello" }, "contains"],
    [
      "truncated absence",
      { success: true, lines: [], truncated: true },
      { notContains: "null" },
      "truncated",
    ],
    ["malformed assertion", { success: true, lines: [] }, {}, "non-empty strings"],
    ["unknown assertion", { success: true, lines: [] }, { pattern: "hello" }, "non-empty strings"],
    ["missing log lines", { success: true }, { notContains: "null" }, "no lines array"],
    [
      "malformed log lines",
      { success: true, lines: [null] },
      { notContains: "null" },
      "invalid log line",
    ],
  ] as const) {
    test(label, async () => {
      const { executor } = harness(payload);
      const result = await executor.executePlan(
        {
          name: "invalid",
          steps: [{ tool: "getLogs", params: {}, expect: assertion } as PlanStep],
        },
        0,
      );
      expect(result.success).toBe(false);
      expect(result.failedStep?.error).toContain(error);
    });
  }

  test("log assertions ignore the response summary and inspect the full messages", async () => {
    const text = "x".repeat(30_000) + "reply received: [hello ] action=reply";
    const { executor } = harness({
      success: true,
      message: "reply received: [null]",
      lines: [{ message: text }],
    });
    const result = await executor.executePlan(
      {
        name: "payload",
        steps: [
          {
            tool: "getLogs",
            params: {},
            expect: { contains: "reply received: [hello ]", notContains: "reply received: [null]" },
          },
        ],
      },
      0,
    );
    expect(result.success).toBe(true);
  });

  test("optional result failures skip the step and preserve plan success", async () => {
    const { executor } = harness({ success: true, lines: [] });
    const result = await executor.executePlan(
      {
        name: "optional",
        steps: [{ tool: "getLogs", params: {}, optional: true, expect: { contains: "hello" } }],
      },
      0,
    );
    expect(result.success).toBe(true);
    expect(result.skippedSteps?.[0]?.error).toContain("contains");
  });

  test("observe checks its original JSON payload without another tool call", async () => {
    const { executor, calls } = harness({ success: true, elements: [{ text: "Reminder" }] });
    const result = await executor.executePlan(
      {
        name: "screen",
        steps: [
          { tool: "observe", params: {}, expect: { contains: "Reminder", notContains: "Loading" } },
        ],
      },
      0,
    );
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("log messages are checked literally, including quotes and line breaks", async () => {
    const text = 'quoted "hello"\nsecond line';
    const { executor } = harness({ success: true, lines: [{ message: text }] });
    const result = await executor.executePlan(
      { name: "literal", steps: [{ tool: "getLogs", params: {}, expect: { contains: text } }] },
      0,
    );
    expect(result.success).toBe(true);
  });

  test("parallel device tracks use the same run start", async () => {
    const { executor, calls } = harness({ success: true, lines: [] });
    const result = await executor.executePlan(
      {
        name: "parallel",
        devices: ["A", "B"],
        steps: [
          { tool: "getLogs", params: { device: "A" } },
          { tool: "getLogs", params: { device: "B" } },
        ],
      },
      0,
    );
    expect(result.success).toBe(true);
    expect(calls.map((call) => call.start)).toEqual([0, 0]);
  });

  test("overlapping runs on one executor keep their own anchors", async () => {
    const { executor, calls, timer } = harness({ success: true, lines: [] });
    const gate = Promise.withResolvers<void>();
    const plan = { name: "overlap", steps: [{ tool: "getLogs", params: {} }] };
    const first = executor.executePlan(
      plan,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { onBeforePlanStep: () => gate.promise },
    );
    timer.advanceTime(1000);
    await executor.executePlan(plan, 0);
    gate.resolve();
    await first;
    expect(calls.map((call) => call.start)).toEqual([1000, 0]);
  });
});
