import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import { registerCriticalSectionTools } from "../../src/server/criticalSectionTools";
import { criticalSectionResultSchema } from "../../src/server/criticalSectionToolOutputSchemas";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import {
  reconcileDeviceResourcesResultSchema,
  setDeviceResourcesResultSchema,
} from "../../src/server/deviceResourceToolOutputSchemas";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceResourceController } from "../fakes/FakeDeviceResourceController";
import { FakeDeviceResourceObserver } from "../fakes/FakeDeviceResourceObserver";
import { FakeDeviceResourceReconciler } from "../fakes/FakeDeviceResourceReconciler";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const ios: BootedDevice = {
  platform: "ios",
  name: "iPhone",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};

interface StructuredResponse {
  content: Array<{ type: string; text?: string }>;
  structuredContent: unknown;
  isError?: boolean;
}

function textOf(response: StructuredResponse): string {
  const block = response.content[0];
  if (block.type !== "text" || block.text === undefined) {
    throw new Error("Expected text result");
  }
  return block.text;
}

function expectTextMatchesStructured(response: StructuredResponse): void {
  expect(JSON.parse(textOf(response))).toEqual(
    JSON.parse(JSON.stringify(response.structuredContent)),
  );
}

describe("setDeviceResources, reconcileDeviceResources and criticalSection output schemas (#11830)", () => {
  let controller: FakeDeviceResourceController;
  let observer: FakeDeviceResourceObserver;
  let reconciler: FakeDeviceResourceReconciler;

  beforeEach(() => {
    ToolRegistry.clearTools();
    controller = new FakeDeviceResourceController();
    observer = new FakeDeviceResourceObserver();
    // Agree with the fake controller's request, so observation does not contradict it.
    observer.result.resources.wallpaperRendering = { state: "disabled" };
    reconciler = new FakeDeviceResourceReconciler();
    setDeviceToolsDependencies({
      deviceResourceControllerFactory: () => controller,
      deviceResourceObserverFactory: () => observer,
      deviceResourceReconcilerFactory: () => reconciler,
      timer: new FakeTimer(),
    });
    registerDeviceTools();
    registerCriticalSectionTools();
  });
  afterEach(() => {
    resetDeviceToolsDependencies();
    ToolRegistry.clearTools();
  });

  test.each([
    ["setDeviceResources", setDeviceResourcesResultSchema],
    ["reconcileDeviceResources", reconcileDeviceResourcesResultSchema],
    ["criticalSection", criticalSectionResultSchema],
  ] as const)("%s declares its outputSchema", (name, schema) => {
    expect(ToolRegistry.getToolForPlan(name)?.outputSchema).toBe(schema);
  });

  test.each([true, false])(
    "setDeviceResources (success=%s) keeps the text payload, validates and keeps isError",
    async (success) => {
      controller.result.success = success;
      const response = (await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(ios, {
        resources: controller.result.requested,
        timeoutMs: 10_000,
      })) as StructuredResponse;
      expectTextMatchesStructured(response);
      expect(setDeviceResourcesResultSchema.safeParse(response.structuredContent).success).toBe(
        true,
      );
      expect(response.isError === true).toBe(!success);
    },
  );

  test.each([true, false])(
    "reconcileDeviceResources (success=%s) keeps the text payload, validates and keeps isError",
    async (success) => {
      reconciler.result = {
        ...reconciler.result,
        success,
        remainingDrift: success
          ? []
          : [
              {
                resource: "wallpaperRendering",
                kind: "commandFailure",
                expected: "disabled",
                observed: { state: "unknown", reason: "read failed" },
              },
            ],
      };
      const response = (await ToolRegistry.getTool("reconcileDeviceResources")!.deviceAwareHandler!(
        ios,
        {
          resources: { wallpaperRendering: "disabled" },
        },
      )) as StructuredResponse;
      expectTextMatchesStructured(response);
      expect(
        reconcileDeviceResourcesResultSchema.safeParse(response.structuredContent).success,
      ).toBe(true);
      expect(response.isError === true).toBe(!success);
    },
  );

  test("criticalSection keeps the text payload and validates structuredContent", async () => {
    const coordinator = CriticalSectionCoordinator.createForTesting(new FakeTimer());
    const restore = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    ToolRegistry.register(
      "schemaProbe",
      "Probe",
      z.object({}),
      mock(async () => ({ success: true })),
    );
    try {
      const response = (await ToolRegistry.getToolForPlan("criticalSection")!.deviceAwareHandler!(
        { platform: "android", deviceId: "emulator-5554", name: "A" },
        { lock: "schema", deviceCount: 1, steps: [{ tool: "schemaProbe", params: {} }] },
      )) as StructuredResponse;
      expectTextMatchesStructured(response);
      expect(criticalSectionResultSchema.safeParse(response.structuredContent).success).toBe(true);
    } finally {
      coordinator.forceCleanup("schema");
      restore();
    }
  });
});
