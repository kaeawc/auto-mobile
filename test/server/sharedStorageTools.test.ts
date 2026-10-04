import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerSharedStorageTools } from "../../src/server/sharedStorageTools";
import {
  createSharedStorageServiceForTesting,
  type StageSharedStorageRequest,
  type StageSharedStorageResult,
} from "../../src/server/sharedStorageService";
import { ActionableError, type BootedDevice } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

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
    test(`${name} preserves the shared rollback error for a three-file indexing failure`, async () => {
      const adb = new FakeAdbExecutor();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const service = createSharedStorageServiceForTesting({
        adbFactory: { create: () => adb },
        timer,
        fileSystem: {
          stat: async () => ({ size: 7, isFile: () => true }),
          mkdtemp: async () => "/fake/unused",
          writeFileBuffer: async () => {},
          rm: async () => {},
        },
        createUserResolver: () => ({ resolve: async () => ({ userId: 0, source: "primary" }) }),
      });
      const pendingCleanups: Promise<unknown>[] = [];
      registerSharedStorageTools({
        sharedStorage: () => service,
        registerPendingDeviceCleanup: (_deviceId, cleanup) => {
          pendingCleanups.push(cleanup);
        },
      });
      const error = await ToolRegistry.getTool(name)!.deviceAwareHandler!(androidDevice, {
        namespace: "fixtures",
        files: ["a.txt", "b.png", "c.txt"].map((destinationPath) => ({
          contentText: "fixture",
          destinationPath,
        })),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(ActionableError);
      expect((error as Error).message).toBe(
        "Android shared-storage batch staging failed for b.png: Android media indexing did not complete for /storage/emulated/0/Download/fixtures/b.png within 5 seconds. Rolled back: b.png, a.txt. Rollback failures: none.",
      );
      expect(adb.getExecutedArgv().filter((args) => args[0] === "push")).toHaveLength(2);
      expect(adb.getExecutedCommands()).toContain(
        "shell rm -f '/storage/emulated/0/Download/fixtures/b.png' '/storage/emulated/0/Download/fixtures/a.txt'",
      );
      expect(pendingCleanups).toHaveLength(1);
      await expect(pendingCleanups[0]).rejects.toBe(error);
    });
  }

  for (const name of ["stageSharedStorage", "stageSharedStorageFixtures"]) {
    test(`${name} registers device cleanup before staging settles`, async () => {
      const staged = Promise.withResolvers<StageSharedStorageResult>();
      const registrations: Array<{ deviceId: string; cleanup: Promise<unknown> }> = [];
      let stageRequest: StageSharedStorageRequest | undefined;
      let stagePromise: Promise<StageSharedStorageResult> | undefined;
      registerSharedStorageTools({
        sharedStorage: () => ({
          stage: (request) => {
            stageRequest = request;
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
        expect(stageRequest?.rollbackOnFailure).toBe(true);
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
