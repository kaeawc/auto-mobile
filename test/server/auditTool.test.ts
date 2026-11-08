import { describe, expect, test } from "bun:test";
import { deviceAwareHandler } from "../helpers/registeredHandler";
import type { BootedDevice } from "../../src/models";
import { createAuditTool } from "../../src/server/auditTool";
import type { ToolRegistrar } from "../../src/server/defineTool";
import type { WcagViolation } from "../../src/models/AccessibilityAudit";
import { FakeOnDemandAuditEngines } from "../fakes/FakeOnDemandAuditEngines";
import {
  AUDIT_ANDROID,
  AUDIT_IOS,
  accessibilityScenarioEngines,
  PINNED_ACCESSIBILITY,
  PINNED_BACKGROUND_PERFORMANCE,
  PINNED_PERFORMANCE,
  performanceScenarioEngines,
  registeredHandler as pinHandler,
} from "../helpers/auditToolScenarios";

const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

function registeredHandler(tool: ReturnType<typeof createAuditTool>) {
  let handler: ((...args: never[]) => Promise<unknown>) | undefined;
  const registrar = {
    register: () => {},
    registerDeviceAware: (_name, _description, _schema, registered) => {
      handler = deviceAwareHandler(registered);
    },
  } as ToolRegistrar;
  tool.register(registrar);
  return (device: BootedDevice, args: Record<string, unknown>) =>
    Reflect.apply(handler!, undefined, [device, args]) as Promise<{
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    }>;
}

const smallTarget: WcagViolation = {
  type: "touch-target-too-small",
  severity: "error",
  criterion: "2.5.5",
  message: "Touch target too small",
  element: { bounds: { left: 0, top: 0, right: 20, bottom: 20 } },
  fingerprint: "small",
};

describe("audit tool (#14075)", () => {
  test("validates kinds, scope and baseline", () => {
    const tool = createAuditTool(() => new FakeOnDemandAuditEngines());

    expect(tool.schema.safeParse({ kinds: ["accessibility", "memory"] }).success).toBe(true);
    expect(tool.schema.safeParse({ kinds: ["bogus"] }).success).toBe(false);
    expect(tool.schema.safeParse({ scope: { container: {} } }).success).toBe(false);
    expect(tool.schema.safeParse({ scope: { container: { elementId: "card" } } }).success).toBe(
      true,
    );
    expect(tool.schema.safeParse({ baseline: { name: "home", mode: "diff" } }).success).toBe(false);
  });

  test("failOn turns findings into an error response", async () => {
    const engines = new FakeOnDemandAuditEngines();
    engines.violations = [smallTarget];
    const handler = registeredHandler(createAuditTool(() => engines));

    const reported = await handler(android, {});
    expect(reported.isError).toBeUndefined();
    expect(reported.structuredContent).toMatchObject({ success: true, failed: false });

    const failed = await handler(android, { failOn: "error" });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({ success: false, failed: true });
  });
});

/** The exact responses the deprecated audit tool returns today (#17279 pins them before the split). */
describe("audit tool output pins (#17279)", () => {
  test("accessibility with container, baseline compare and failOn", async () => {
    const handler = pinHandler(createAuditTool(() => accessibilityScenarioEngines()));

    const response = await handler(AUDIT_ANDROID, {
      scope: { container: { elementId: "card" } },
      baseline: { name: "home", mode: "compare" },
      failOn: "warning",
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(PINNED_ACCESSIBILITY);
  });

  test("performance and memory with failOn", async () => {
    const handler = pinHandler(createAuditTool(() => performanceScenarioEngines()));

    const response = await handler(AUDIT_ANDROID, {
      kinds: ["performance", "memory"],
      failOn: "error",
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(PINNED_PERFORMANCE);
  });

  test("memory of another app, with performance not in the foreground", async () => {
    const handler = pinHandler(createAuditTool(() => performanceScenarioEngines()));

    const response = await handler(AUDIT_ANDROID, {
      kinds: ["performance", "memory"],
      appId: "com.other",
    });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual(PINNED_BACKGROUND_PERFORMANCE);
  });

  test("a cancelled call does not record a baseline (#17281)", async () => {
    const engines = accessibilityScenarioEngines();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      pinHandler(createAuditTool(() => engines))(
        AUDIT_ANDROID,
        { baseline: { name: "next", mode: "record" } },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(engines.savedBaselines.has("next")).toBe(false);
  });

  test("iOS reports every requested kind unsupported", async () => {
    const handler = pinHandler(createAuditTool(() => performanceScenarioEngines()));

    const response = await handler(AUDIT_IOS, { kinds: ["performance", "memory"] });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({
      success: false,
      failed: false,
      unsupported: {
        performance: "The performance audit runs on Android only.",
        memory: "The memory audit runs on Android only.",
      },
      error: "On-demand audits run on Android only.",
    });
  });
});
