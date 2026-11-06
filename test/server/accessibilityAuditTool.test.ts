import { describe, expect, test } from "bun:test";
import { deviceAwareHandler } from "../helpers/registeredHandler";
import type { BootedDevice } from "../../src/models";
import { NativeAccessibilityAudit } from "../../src/features/accessibility/NativeAccessibilityAudit";
import { createAccessibilityAuditTool } from "../../src/server/accessibilityAuditTool";
import type { ToolRegistrar } from "../../src/server/defineTool";
import { WCAG_ENGINE_UNSUPPORTED_ERROR } from "../../src/features/audit/WcagAccessibilityAudit";
import { FakeOnDemandAuditEngines } from "../fakes/FakeOnDemandAuditEngines";
import {
  AUDIT_ANDROID,
  AUDIT_IOS,
  PINNED_ACCESSIBILITY,
  accessibilityScenarioEngines,
  registeredHandler as auditHandler,
} from "../helpers/auditToolScenarios";

const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

function registeredHandler(tool: ReturnType<typeof createAccessibilityAuditTool>) {
  let handler: ((...args: never[]) => Promise<unknown>) | undefined;
  const registrar = {
    register: () => {},
    registerDeviceAware: (_name, _description, _schema, registered) => {
      handler = deviceAwareHandler(registered);
    },
  } as ToolRegistrar;
  tool.register(registrar);
  return (device: BootedDevice, args: Record<string, unknown>) =>
    Reflect.apply(handler!, undefined, [device, args]);
}

describe("accessibilityAudit tool (#14086)", () => {
  const tool = createAccessibilityAuditTool(
    new NativeAccessibilityAudit(() => {
      throw new Error("Android must not reach the iOS runner");
    }),
  );

  test("accepts known checks and bounds maxIssues", () => {
    expect(tool.schema.safeParse({ checks: ["contrast", "all"], maxIssues: 10 }).success).toBe(
      true,
    );
    expect(tool.schema.safeParse({ checks: ["bogus"] }).success).toBe(false);
    expect(tool.schema.safeParse({ maxIssues: 0 }).success).toBe(false);
    expect(tool.schema.safeParse({ maxIssues: 501 }).success).toBe(false);
  });

  test("an unsupported platform is an error response with its typed code", async () => {
    const response = (await registeredHandler(tool)(android, { engine: "platform" })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      engine: "atf",
      errorCode: "unsupported_platform",
      issues: [],
    });
  });
});

describe("accessibilityAudit wcag engine (#17279)", () => {
  const rejectingPlatform = new NativeAccessibilityAudit(() => {
    throw new Error("the wcag engine must not reach the iOS runner");
  });
  const toolWith = (engines: FakeOnDemandAuditEngines) =>
    createAccessibilityAuditTool(rejectingPlatform, () => engines);

  test("accepts engine, scope, baseline and failOn", () => {
    const tool = toolWith(new FakeOnDemandAuditEngines());

    expect(tool.schema.safeParse({ engine: "wcag", failOn: "warning" }).success).toBe(true);
    expect(tool.schema.safeParse({ engine: "atf" }).success).toBe(false);
    expect(tool.schema.safeParse({ scope: { container: {} } }).success).toBe(false);
    expect(tool.schema.safeParse({ baseline: { name: "home", mode: "diff" } }).success).toBe(false);
  });

  test("is the Android default and reports the audit tool's findings, flattened", async () => {
    const engines = accessibilityScenarioEngines();
    const response = await auditHandler(toolWith(engines))(AUDIT_ANDROID, {
      scope: { container: { elementId: "card" } },
      baseline: { name: "home", mode: "compare" },
      failOn: "warning",
    });

    const { accessibility, ...rest } = PINNED_ACCESSIBILITY;
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({ ...rest, ...accessibility, engine: "wcag" });
    expect(engines.calls).toEqual(["observe", "accessibility:com.example:/tmp/shot.png"]);
  });

  test("baseline record names the saved baseline", async () => {
    const engines = accessibilityScenarioEngines();
    const response = await auditHandler(toolWith(engines))(AUDIT_ANDROID, {
      engine: "wcag",
      baseline: { name: "next", mode: "record" },
    });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({
      success: true,
      failed: false,
      baselineRecorded: "next",
      totalViolations: 3,
    });
    expect(engines.savedBaselines.get("next")?.length).toBe(3);
  });

  test("on iOS is unsupported_platform without observing", async () => {
    const engines = accessibilityScenarioEngines();
    const response = await auditHandler(toolWith(engines))(AUDIT_IOS, { engine: "wcag" });

    expect(engines.calls).toEqual([]);
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({
      success: false,
      failed: false,
      engine: "wcag",
      errorCode: "unsupported_platform",
      error: WCAG_ENGINE_UNSUPPORTED_ERROR,
    });
  });

  test("the platform engine is the iOS default", async () => {
    const engines = new FakeOnDemandAuditEngines();
    const requests: string[] = [];
    const tool = createAccessibilityAuditTool(
      new NativeAccessibilityAudit(() => ({
        requestAccessibilityAudit: async (request) => {
          requests.push(request.checks.join(","));
          return { success: true, totalTimeMs: 1, issues: [], unsupportedChecks: [] };
        },
      })),
      () => engines,
    );

    const response = await auditHandler(tool)(AUDIT_IOS, { checks: ["contrast"] });

    expect(requests).toEqual(["contrast"]);
    expect(engines.calls).toEqual([]);
    expect(response.structuredContent).toMatchObject({ success: true, engine: "xcuitest" });
  });

  test("arguments of the other engine are an error, before any audit runs", async () => {
    const engines = accessibilityScenarioEngines();
    const handler = auditHandler(toolWith(engines));

    const wcag = await handler(AUDIT_ANDROID, { maxIssues: 5 });
    const platform = await handler(AUDIT_IOS, {
      failOn: "error",
      baseline: { name: "h", mode: "record" },
    });

    expect(engines.calls).toEqual([]);
    expect(wcag.isError).toBe(true);
    expect(wcag.structuredContent).toEqual({
      success: false,
      failed: false,
      engine: "wcag",
      error: "maxIssues does not apply to engine wcag; pass engine platform or drop it.",
    });
    expect(platform.isError).toBe(true);
    expect(platform.structuredContent).toEqual({
      success: false,
      engine: "xcuitest",
      issues: [],
      totalIssues: 0,
      truncated: false,
      unsupportedChecks: [],
      error: "baseline, failOn do not apply to engine platform; pass engine wcag or drop them.",
    });
  });
});
