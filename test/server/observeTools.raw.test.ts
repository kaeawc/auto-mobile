import { beforeEach, describe, expect, test } from "bun:test";
import {
  invalidateReadinessForDisabledAccessibility,
  observeSchema,
  registerObserveTools,
} from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, ObserveResult } from "../../src/models";

describe("observe accessibility readiness", () => {
  const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

  test.each([
    [true, []],
    [false, ["reset", "invalidate:owner:accessibility service disabled"]],
  ] as const)("synthetic=%s produces actions %j", (detectionSkipped, expected) => {
    const calls: string[] = [];
    const result = {
      accessibilityState: { enabled: false, service: "unknown", detectionSkipped },
    } as ObserveResult;

    invalidateReadinessForDisabledAccessibility(device, result, "owner", {
      resetSetupState: () => calls.push("reset"),
      isDaemonInitialized: () => true,
      invalidateAutomationReadiness: (sessionUuid, reason) =>
        calls.push(`invalidate:${sessionUuid}:${reason}`),
    });

    expect(calls).toEqual(expected);
  });
});

describe("observeSchema raw flag", () => {
  test("accepts raw: true", () => {
    expect(() => observeSchema.parse({ platform: "android", raw: true })).not.toThrow();
  });

  test("accepts raw: false", () => {
    expect(() => observeSchema.parse({ platform: "android", raw: false })).not.toThrow();
  });

  test("accepts missing raw (defaults to undefined)", () => {
    const parsed = observeSchema.parse({ platform: "android" });
    expect(parsed.raw).toBeUndefined();
  });

  test("raw field is present in tool inputSchema", () => {
    (ToolRegistry as any).tools.clear();
    registerObserveTools();

    const tool = ToolRegistry.getTool("observe");
    expect(tool).toBeDefined();

    // Parse the schema shape to confirm raw is a valid optional boolean
    expect(() => tool!.schema.parse({ platform: "ios", raw: true })).not.toThrow();
  });
});

describe("observe tool registration", () => {
  beforeEach(() => {
    (ToolRegistry as any).tools.clear();
  });

  test("registers observe tool", () => {
    registerObserveTools();
    const toolNames = ToolRegistry.getToolDefinitions().map((t) => t.name);
    expect(toolNames).toContain("observe");
  });

  test("does not register rawViewHierarchy tool", () => {
    registerObserveTools();
    const toolNames = ToolRegistry.getToolDefinitions().map((t) => t.name);
    expect(toolNames).not.toContain("rawViewHierarchy");
  });
});
