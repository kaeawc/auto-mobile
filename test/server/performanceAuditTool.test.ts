import { describe, expect, test } from "bun:test";
import { createPerformanceAuditTool } from "../../src/server/performanceAuditTool";
import { FakeOnDemandAuditEngines } from "../fakes/FakeOnDemandAuditEngines";
import {
  AUDIT_ANDROID,
  AUDIT_IOS,
  PINNED_BACKGROUND_PERFORMANCE,
  PINNED_PERFORMANCE,
  performanceScenarioEngines,
  registeredHandler,
} from "../helpers/auditToolScenarios";

describe("performanceAudit tool (#17279)", () => {
  test("accepts only the performance and memory kinds", () => {
    const tool = createPerformanceAuditTool(() => new FakeOnDemandAuditEngines());

    expect(tool.schema.safeParse({ kinds: ["performance"], failOn: "error" }).success).toBe(true);
    expect(tool.schema.safeParse({ kinds: ["accessibility"] }).success).toBe(false);
    expect(tool.schema.safeParse({ kinds: [] }).success).toBe(false);
    // Accessibility arguments belong to accessibilityAudit.
    expect(tool.schema.safeParse({ scope: { container: { elementId: "card" } } }).success).toBe(
      false,
    );
  });

  test("returns the audit tool's performance and memory result, failing on failOn", async () => {
    const response = await registeredHandler(
      createPerformanceAuditTool(() => performanceScenarioEngines()),
    )(AUDIT_ANDROID, { kinds: ["performance", "memory"], failOn: "error" });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(PINNED_PERFORMANCE);
  });

  test("runs both kinds by default", async () => {
    const engines = performanceScenarioEngines();
    const response = await registeredHandler(createPerformanceAuditTool(() => engines))(
      AUDIT_ANDROID,
      { appId: "com.other" },
    );

    expect(engines.calls).toEqual(["observe", "memory:com.other"]);
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual(PINNED_BACKGROUND_PERFORMANCE);
  });

  test("never runs the accessibility audit", async () => {
    const engines = performanceScenarioEngines();
    await registeredHandler(createPerformanceAuditTool(() => engines))(AUDIT_ANDROID, {
      kinds: ["performance"],
    });

    expect(engines.calls).toEqual(["observe", "performance"]);
  });

  test("iOS reports both kinds unsupported", async () => {
    const response = await registeredHandler(
      createPerformanceAuditTool(() => performanceScenarioEngines()),
    )(AUDIT_IOS, {});

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      success: false,
      unsupported: {
        performance: "The performance audit runs on Android only.",
        memory: "The memory audit runs on Android only.",
      },
    });
  });
});
