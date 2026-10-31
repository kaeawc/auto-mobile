import { describe, expect, test } from "bun:test";
import { deviceAwareHandler } from "../helpers/registeredHandler";
import type { BootedDevice } from "../../src/models";
import { NativeAccessibilityAudit } from "../../src/features/accessibility/NativeAccessibilityAudit";
import { createAccessibilityAuditTool } from "../../src/server/accessibilityAuditTool";
import type { ToolRegistrar } from "../../src/server/defineTool";

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
    const response = (await registeredHandler(tool)(android, {})) as {
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
