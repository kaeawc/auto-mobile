import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  invalidateReadinessForDisabledAccessibility,
  observeSchema,
  registerObserveTools,
} from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, ObserveResult } from "../../src/models";
import { FakeAccessibilityDetector } from "../fakes/FakeAccessibilityDetector";

isolateToolRegistry();

describe("observe accessibility readiness", () => {
  const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

  const scenarios: Array<[boolean, string[]]> = [
    [true, []],
    [false, ["reset", "invalidate:owner:accessibility service disabled"]],
  ];

  test.each(scenarios)("synthetic=%s produces actions %j", async (detectionSkipped, expected) => {
    const calls: string[] = [];
    const detector = new FakeAccessibilityDetector();
    detector.setCtrlProxyServiceEnabled(device.deviceId, false);
    const result = {
      accessibilityState: { enabled: false, service: "unknown", detectionSkipped },
    } as ObserveResult;

    await invalidateReadinessForDisabledAccessibility(device, result, "owner", {
      accessibilityDetector: detector,
      resetSetupState: () => calls.push("reset"),
      isDaemonInitialized: () => true,
      invalidateAutomationReadiness: (sessionUuid, reason) =>
        calls.push(`invalidate:${sessionUuid}:${reason}`),
    });

    expect(calls).toEqual(expected);
    expect(detector.getInvalidatedDevices()).toEqual(detectionSkipped ? [] : [device.deviceId]);
  });
});

describe("observeSchema raw flag", () => {
  test("image delivery is opt-in and accepts only a boolean", () => {
    expect(observeSchema.parse({ platform: "android" }).includeScreenshotImage).toBeUndefined();
    expect(
      observeSchema.parse({ platform: "android", includeScreenshotImage: false })
        .includeScreenshotImage,
    ).toBe(false);
    expect(
      observeSchema.parse({ platform: "android", includeScreenshotImage: true })
        .includeScreenshotImage,
    ).toBe(true);
    expect(() =>
      observeSchema.parse({ platform: "android", includeScreenshotImage: "true" }),
    ).toThrow();
  });

  test("image delivery accepts encoding options through its effective settled capture", () => {
    expect(
      observeSchema.safeParse({
        platform: "android",
        includeScreenshotImage: true,
        screenshotOptions: { format: "webp", quality: 80 },
      }).success,
    ).toBe(true);
    for (const screenshot of ["async", "none"] as const) {
      expect(
        observeSchema.safeParse({
          platform: "android",
          includeScreenshotImage: true,
          screenshot,
          screenshotOptions: { format: "webp" },
        }).success,
      ).toBe(false);
    }
    expect(
      observeSchema.safeParse({ platform: "android", screenshotOptions: { format: "webp" } })
        .success,
    ).toBe(false);
  });

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
    ToolRegistry.clearTools();
    registerObserveTools();

    const tool = ToolRegistry.getTool("observe");
    expect(tool).toBeDefined();

    // Parse the schema shape to confirm raw is a valid optional boolean
    expect(() => tool!.schema.parse({ platform: "ios", raw: true })).not.toThrow();
  });
});

describe("observe tool registration", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  test("registers observe tool", () => {
    registerObserveTools();
    const toolNames = ToolRegistry.getToolDefinitions().map((t) => t.name);
    expect(toolNames).toContain("observe");
  });

  test("routes display carplay only on iOS simulators", async () => {
    const probed: string[] = [];
    registerObserveTools({
      carPlay: {
        projectionProbe: {
          async probe(deviceId) {
            probed.push(deviceId);
            return {
              found: false,
              tag: null,
              displayId: null,
              displayType: null,
              identity: null,
              name: null,
              deviceName: null,
              isCarDisplay: false,
              isCarInstrumentsDisplay: false,
            };
          },
        },
      },
    });
    const tool = ToolRegistry.getTool("observe")!;
    const handler = tool.deviceAwareHandler!;
    const args = tool.schema.parse({ display: "carplay" });
    const simulatorId = "6B1F3C2E-0000-4000-8000-00000000A7C1";
    await expect(
      handler({ name: "iPhone", deviceId: simulatorId, platform: "ios" }, args),
    ).rejects.toThrow("No CarPlay screen (TVOut or AirPlay display) was found");
    await expect(
      handler({ name: "Pixel", deviceId: "emulator-5554", platform: "android" }, args),
    ).rejects.toThrow("requires an iOS simulator");
    await expect(
      handler({ name: "iPhone", deviceId: "00008030-001C2D3E1234567A", platform: "ios" }, args),
    ).rejects.toThrow("requires an iOS simulator");
    expect(probed).toEqual([simulatorId]);
  });

  test("does not register rawViewHierarchy tool", () => {
    registerObserveTools();
    const toolNames = ToolRegistry.getToolDefinitions().map((t) => t.name);
    expect(toolNames).not.toContain("rawViewHierarchy");
  });
});
