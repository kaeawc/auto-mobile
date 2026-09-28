import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerSharedStorageTools } from "../../src/server/sharedStorageTools";
import type { StageSharedStorageResult } from "../../src/server/sharedStorageService";
import type { BootedDevice } from "../../src/models";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};

describe("shared-storage tools", () => {
  beforeAll(() => {
    // Ajv2020's `.compile()` JIT-warms its code-generation machinery on its
    // first call in a process (~18-20ms), regardless of which schema is
    // compiled. Absorb that cold-start cost here, in setup, rather than
    // letting it land inside the "advertises defaulted fields as optional"
    // test body below — the 100ms/test CI budget
    // (`scripts/validate-bun-test-timings.sh`) measures per-test time only,
    // and the cold compile pushed that test past the budget whenever a
    // widely-imported module changed and re-triggered this suite (same class
    // of flake fixed for PlanSchemaValidator, see #6244).
    new Ajv2020({ strict: false }).compile({
      type: "object",
      properties: { warmup: { type: "string" } },
    });
  });

  beforeEach(() => (ToolRegistry as any).tools.clear());
  afterEach(() => (ToolRegistry as any).tools.clear());

  test("registers a discoverable session-bound staging operation", () => {
    registerSharedStorageTools();
    const tools = ToolRegistry.getToolDefinitions().filter(
      (candidate) =>
        candidate.name === "stageSharedStorage" || candidate.name === "stageSharedStorageFixtures",
    );
    expect(tools).toHaveLength(2);
    const tool = tools.find((candidate) => candidate.name === "stageSharedStorage");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties.namespace).toBeDefined();
    expect(tool!.inputSchema.properties.reset).toBeDefined();
    expect(tool!.inputSchema.properties.files).toBeDefined();
    expect(ToolRegistry.getTool("stageSharedStorage")!.defaultEnabled).toBe(true);
    expect(ToolRegistry.getTool("stageSharedStorageFixtures")!.defaultEnabled).toBe(false);
  });

  test("advertises defaulted fields as optional", () => {
    registerSharedStorageTools();
    for (const name of ["stageSharedStorage", "stageSharedStorageFixtures"]) {
      const tool = ToolRegistry.getToolDefinitions().find((candidate) => candidate.name === name)!;
      const validate = new Ajv2020({ strict: false }).compile(tool.inputSchema);

      expect(
        validate({
          namespace: "run-42",
          files: [{ contentText: "fixture", destinationPath: "fixture.txt" }],
        }),
      ).toBe(true);
    }
  });

  for (const name of ["stageSharedStorage", "stageSharedStorageFixtures"]) {
    test(`${name} registers device cleanup before staging settles`, async () => {
      const staged = Promise.withResolvers<StageSharedStorageResult>();
      const registrations: Array<{ deviceId: string; cleanup: Promise<unknown> }> = [];
      let stagePromise: Promise<StageSharedStorageResult> | undefined;
      registerSharedStorageTools({
        sharedStorage: () => ({
          stage: () => {
            stagePromise = staged.promise;
            return staged.promise;
          },
        }),
        registerPendingDeviceCleanup: (deviceId, cleanup) => {
          registrations.push({ deviceId, cleanup });
        },
      });

      const pending = ToolRegistry.getTool(name)!.deviceAwareHandler!(androidDevice, {
        namespace: "run-42",
        files: [{ contentText: "fixture", destinationPath: "fixture.txt" }],
      });
      try {
        expect(stagePromise).toBe(staged.promise);
        expect(registrations).toEqual([
          { deviceId: androidDevice.deviceId, cleanup: staged.promise },
        ]);
      } finally {
        staged.resolve({
          success: true,
          deviceId: androidDevice.deviceId,
          platform: "android",
          namespace: "run-42",
          userId: 0,
          userSource: "primary",
          destinationDirectory: "/storage/emulated/0/Download/run-42",
          reset: false,
          files: [],
        });
        await pending;
      }
    });
  }
});
