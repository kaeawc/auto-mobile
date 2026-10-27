import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { createAuditTool } from "../../src/server/auditTool";
import type { ToolRegistrar } from "../../src/server/defineTool";
import type { WcagViolation } from "../../src/models/AccessibilityAudit";
import { FakeOnDemandAuditEngines } from "../fakes/FakeOnDemandAuditEngines";

const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

function registeredHandler(tool: ReturnType<typeof createAuditTool>) {
  let handler: ((...args: never[]) => Promise<unknown>) | undefined;
  const registrar = {
    register: () => {},
    registerDeviceAware: (_name, _description, _schema, registered) => {
      handler = registered;
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
