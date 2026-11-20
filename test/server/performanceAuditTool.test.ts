import { describe, expect, test } from "bun:test";
import { createPerformanceAuditTool } from "../../src/server/performanceAuditTool";
import type { MemoryAuditResult } from "../../src/features/audit/OnDemandAudit";
import { MemoryAudit } from "../../src/features/memory/MemoryAudit";
import { wrapCommandError } from "../../src/utils/CommandError";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeOnDemandAuditEngines } from "../fakes/FakeOnDemandAuditEngines";
import {
  AUDIT_ANDROID,
  AUDIT_IOS,
  PINNED_BACKGROUND_PERFORMANCE,
  PINNED_PERFORMANCE,
  performanceScenarioEngines,
  registeredHandler,
} from "../helpers/auditToolScenarios";

const pidofCommand = "shell pidof 'com.other'";

function handlerWithPidofError(error: Error) {
  const adb = new FakeAdbExecutor();
  adb.setCommandError(pidofCommand, error);
  const engines = new FakeOnDemandAuditEngines();
  const memoryAudit = new MemoryAudit(AUDIT_ANDROID, { create: () => adb });
  engines.memory = (appId) => memoryAudit.runAudit(appId, "audit", {}, { action: async () => {} });
  return { handler: registeredHandler(createPerformanceAuditTool(() => engines)), adb };
}

describe("performanceAudit tool (#17279)", () => {
  test.each([false, true])("reports a clean pidof miss (wrapped: %s)", async (wrapped) => {
    const raw = Object.assign(new Error("pidof exited with status 1"), {
      code: 1,
      stdout: "",
      stderr: "",
    });
    const error = wrapped ? wrapCommandError(raw, { command: "adb", args: [pidofCommand] }) : raw;
    const { handler, adb } = handlerWithPidofError(error);

    const response = await handler(AUDIT_ANDROID, { appId: "com.other" });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual({
      success: true,
      failed: false,
      appId: "com.other",
      unsupported: {
        performance: PINNED_BACKGROUND_PERFORMANCE.unsupported.performance,
        memory: "com.other is not running.",
      },
    });
    expect(adb.getExecutedCommands()).toEqual([pidofCommand]);

    const asserted = await handler(AUDIT_ANDROID, {
      appId: "com.other",
      kinds: ["memory"],
      failOn: "error",
    });
    expect(asserted.isError).toBe(true);
    expect(asserted.structuredContent).toMatchObject({
      success: false,
      failed: true,
      unsupported: { memory: "com.other is not running." },
    });
  });

  test.each([
    { code: 255, stderr: "" },
    { code: 1, stderr: "error: device offline" },
  ])("propagates other pidof errors (%j)", async ({ code, stderr }) => {
    const raw = Object.assign(new Error("pidof failed"), { code, stdout: "", stderr });
    const error = wrapCommandError(raw, { command: "adb", args: [pidofCommand] });
    const { handler } = handlerWithPidofError(error);

    await expect(handler(AUDIT_ANDROID, { appId: "com.other" })).rejects.toBe(error);
  });

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

  test("a failing memory check alone fails failOn", async () => {
    const engines = performanceScenarioEngines();
    engines.performanceResult = { ...engines.performanceResult!, passed: true };
    engines.memoryResult = { passed: false } as MemoryAuditResult;

    const response = await registeredHandler(createPerformanceAuditTool(() => engines))(
      AUDIT_ANDROID,
      { failOn: "warning" },
    );

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      success: false,
      failed: true,
      performance: { passed: true },
      memory: { passed: false },
    });
  });

  test("failOn fails when a background appId leaves performance unsupported (#17281)", async () => {
    const response = await registeredHandler(
      createPerformanceAuditTool(() => performanceScenarioEngines()),
    )(AUDIT_ANDROID, { appId: "com.other", failOn: "error" });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({
      ...PINNED_BACKGROUND_PERFORMANCE,
      success: false,
      failed: true,
    });
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

  test("runs performance and memory on an iOS Simulator", async () => {
    const engines = performanceScenarioEngines();
    const response = await registeredHandler(createPerformanceAuditTool(() => engines))(
      { ...AUDIT_IOS, deviceId: "A25C7946-AF1E-403B-AF98-CAD293FEF933" },
      { failOn: "error" },
    );

    expect(engines.calls).toEqual(["observe", "performance", "memory:com.example"]);
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(PINNED_PERFORMANCE);
  });

  test("refuses both kinds on a physical iOS device without observing", async () => {
    const engines = performanceScenarioEngines();
    const response = await registeredHandler(createPerformanceAuditTool(() => engines))(
      { ...AUDIT_IOS, deviceId: "00008030-001C2D3E1234567A" },
      {},
    );

    const error =
      "performanceAudit on a physical iOS device is not supported; use an iOS Simulator.";
    expect(engines.calls).toEqual([]);
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({
      success: false,
      failed: false,
      unsupported: { performance: error, memory: error },
      error,
    });
  });
});
