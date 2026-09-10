import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  provisionDeviceSchema,
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { classifyDisplayCutout } from "../../src/utils/displayCutout";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { stubCtrlProxySetup } from "../helpers/stubCtrlProxySetup";
import type {
  ExactDeviceProvisionRequest,
  ExactDeviceProvisioner,
  ExactProvisionedDevice,
} from "../../src/utils/exactDeviceProvisioning";
import type { ProvisionDeviceOperationStore } from "../../src/db/provisionDeviceOperationRepository";
import { ProvisionDeviceOperationConflictError } from "../../src/db/provisionDeviceOperationRepository";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceTeardownOperationStore } from "../fakes/FakeDeviceTeardownOperationStore";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceResourceController } from "../fakes/FakeDeviceResourceController";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool, McpSessionRecoveryInProgressError } from "../../src/daemon/devicePool";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/utils/virtualDeviceLifecycleCoordinator";
import { MAX_PROVISION_DEVICE_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import { RunnerReadinessError } from "../../src/utils/RunnerReadinessService";

class FakeExactDeviceProvisioner implements ExactDeviceProvisioner {
  readonly requests: ExactDeviceProvisionRequest[] = [];

  async provision(request: ExactDeviceProvisionRequest): Promise<ExactProvisionedDevice> {
    this.requests.push(request);
    return {
      created: true,
      device: {
        name: request.name,
        platform: request.platform,
        isRunning: false,
      },
      resolvedSpec: {
        ...request.spec,
        displayCutout: classifyDisplayCutout(request.platform, request.spec.deviceType),
      },
    };
  }
}

class FakeProvisionDeviceOperationStore implements ProvisionDeviceOperationStore {
  private readonly results = new Map<
    string,
    {
      fingerprint: string;
      attemptId: string;
      result?: Record<string, unknown>;
      creationStarted: boolean;
    }
  >();
  private readonly forcedInProgress = new Set<string>();
  completeError: Error | undefined;
  failCalls = 0;
  readonly failures: { operationId: string; errorCode: string }[] = [];
  readonly failCodes: string[] = [];

  /** Simulate a "running" row left behind by a crashed/earlier attempt. */
  markInProgress(operationId: string): void {
    this.forcedInProgress.add(operationId);
  }

  async begin(operationId: string, requestFingerprint: string, attemptId: string) {
    if (this.forcedInProgress.has(operationId)) {
      return { started: false as const, inProgress: true as const };
    }
    const existing = this.results.get(operationId);
    if (!existing) {
      this.results.set(operationId, {
        fingerprint: requestFingerprint,
        attemptId,
        creationStarted: false,
      });
      return { started: true, reconcileExistingConfiguration: false } as const;
    }
    if (existing.fingerprint !== requestFingerprint) {
      throw new ProvisionDeviceOperationConflictError(operationId);
    }
    // Admission (and a replay) takes the fence, exactly as the repository's
    // compare-and-set does.
    existing.attemptId = attemptId;
    return existing.result
      ? {
          started: false as const,
          result: existing.result,
          reconcileExistingConfiguration: existing.creationStarted,
        }
      : {
          started: true as const,
          reconcileExistingConfiguration: existing.creationStarted,
        };
  }

  async markDeviceCreationStarted(operationId: string, attemptId: string): Promise<boolean> {
    const operation = this.results.get(operationId);
    if (!operation) {
      throw new Error(`missing operation ${operationId}`);
    }
    if (operation.attemptId !== attemptId) {
      return false;
    }
    operation.creationStarted = true;
    return true;
  }

  async complete(
    operationId: string,
    attemptId: string,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.completeError) {
      throw this.completeError;
    }
    const operation = this.results.get(operationId);
    if (!operation) {
      throw new Error(`missing operation ${operationId}`);
    }
    if (operation.attemptId !== attemptId) {
      return false;
    }
    operation.result = result;
    return true;
  }

  setStoredResult(operationId: string, result: Record<string, unknown>): void {
    const operation = this.results.get(operationId);
    if (!operation) {
      throw new Error(`missing operation ${operationId}`);
    }
    operation.result = result;
  }

  getStoredResult(operationId: string): Record<string, unknown> | undefined {
    return this.results.get(operationId)?.result;
  }

  async fail(
    operationId: string,
    attemptId: string,
    errorCode: string,
    _message: string,
    options?: { clearCreationStarted?: boolean },
  ): Promise<boolean> {
    const operation = this.results.get(operationId);
    if (operation && operation.attemptId !== attemptId) {
      return false;
    }
    this.failCalls++;
    this.failures.push({ operationId, errorCode });
    this.failCodes.push(errorCode);
    if (options?.clearCreationStarted) {
      if (!operation) {
        throw new Error(`missing operation ${operationId}`);
      }
      operation.creationStarted = false;
    }
    return true;
  }
}

type ProvisionTestPlatform = "android" | "ios";

function provisionTestArgs(platform: ProvisionTestPlatform, operationId: string) {
  return platform === "android"
    ? {
        operationId,
        device: {
          platform,
          name: "phone-api-36-a",
          spec: {
            runtime: "system-images;android-36;google_apis;x86_64",
            deviceType: "pixel_9",
          },
        },
        boot: true,
        readiness: "automation" as const,
      }
    : {
        operationId,
        device: {
          platform,
          name: "iPhone 17",
          spec: {
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
            deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
          },
        },
        boot: true,
        readiness: "automation" as const,
      };
}

function provisionedTestDevice(
  platform: ProvisionTestPlatform,
  created: boolean,
): ExactProvisionedDevice {
  const args = provisionTestArgs(platform, "unused");
  return {
    created,
    device: {
      name: args.device.name,
      platform,
      ...(platform === "ios" ? { deviceId: "SIM-123" } : {}),
      isRunning: false,
      runtime: args.device.spec.runtime,
      deviceType: args.device.spec.deviceType,
    },
    resolvedSpec: {
      ...args.device.spec,
      displayCutout: classifyDisplayCutout(platform, args.device.spec.deviceType),
    },
  };
}

function configureProvisionBootAndTeardown(
  manager: FakeDeviceUtils,
  platform: ProvisionTestPlatform,
): void {
  const deviceName = provisionTestArgs(platform, "unused").device.name;
  let exitListener: (() => void) | undefined;
  const processHandle: any = {
    exitCode: null,
    signalCode: null,
    once: (event: string, listener: () => void) => {
      if (event === "exit") {
        exitListener = listener;
      }
      return processHandle;
    },
    kill: () => {
      processHandle.exitCode = 0;
      manager.setBootedDevices(platform, []);
      exitListener?.();
      return true;
    },
  };
  manager.setMockChildProcess(deviceName, processHandle as any);
  const originalWaitForDeviceReady = manager.waitForDeviceReady.bind(manager);
  manager.waitForDeviceReady = async (device, timeoutMs, childProcess, signal) => {
    const booted = await originalWaitForDeviceReady(device, timeoutMs, childProcess, signal);
    const resolved = {
      ...booted,
      deviceId: platform === "android" ? "emulator-5554" : "SIM-123",
    };
    manager.setBootedDevices(platform, [resolved]);
    return resolved;
  };
  const originalKillDevice = manager.killDevice.bind(manager);
  manager.killDevice = async (device) => {
    await originalKillDevice(device);
    manager.setBootedDevices(platform, []);
  };
}

describe("provisionDevice handler", () => {
  let deviceManager: FakeDeviceUtils;
  let exactProvisioner: FakeExactDeviceProvisioner;
  let operationStore: FakeProvisionDeviceOperationStore;
  let teardownOperationStore: FakeDeviceTeardownOperationStore;

  beforeEach(() => {
    deviceManager = new FakeDeviceUtils();
    exactProvisioner = new FakeExactDeviceProvisioner();
    operationStore = new FakeProvisionDeviceOperationStore();
    teardownOperationStore = new FakeDeviceTeardownOperationStore();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deviceManager,
      exactDeviceProvisionerFactory: () => exactProvisioner,
      provisionDeviceOperationStoreFactory: () => operationStore,
      teardownDeviceOperationStoreFactory: () => teardownOperationStore,
      notifyResourcesChanged: async () => {},
      clearInstalledAppsForDevice: async () => {},
    });
    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
  });

  test("resource settings require booting and reject profiles and raw daemon labels", () => {
    const args = provisionTestArgs("ios", "resource-schema");
    expect(
      provisionDeviceSchema.safeParse({
        ...args,
        boot: false,
        resources: { wallpaperRendering: "disabled" },
      }).success,
    ).toBe(false);
    expect(
      provisionDeviceSchema.safeParse({ ...args, resources: { profile: "efficient" } }).success,
    ).toBe(false);
    expect(
      provisionDeviceSchema.safeParse({ ...args, resources: { "com.apple.apsd": "disabled" } })
        .success,
    ).toBe(false);
  });

  test.each(["ios", "android"] as const)(
    "applies %s resources before automation readiness and includes verified results",
    async (platform) => {
      const resources = new FakeDeviceResourceController();
      const order: string[] = [];
      resources.onRequest = async () => {
        order.push("resources");
      };
      exactProvisioner.provision = async () => provisionedTestDevice(platform, false);
      deviceManager.setBootedDevices(platform, [
        {
          name: provisionTestArgs(platform, "unused").device.name,
          platform,
          deviceId: platform === "ios" ? "SIM-123" : "emulator-5554",
        },
      ]);
      setDeviceToolsDependencies({
        deviceResourceControllerFactory: () => resources,
        ensureCtrlProxyReady: async () => {
          order.push("readiness");
        },
      });
      const args = {
        ...provisionTestArgs(platform, `resources-${platform}`),
        resources: { wallpaperRendering: "disabled" as const },
      };
      const response = await ToolRegistry.getTool("provisionDevice")!.handler(args);
      expect(order).toEqual(["resources", "readiness"]);
      expect(resources.requests[0]!.device.platform).toBe(platform);
      expect(JSON.parse((response as any).content[0].text)).toMatchObject({
        success: true,
        resources: { success: true, resources: { wallpaperRendering: { state: "disabled" } } },
      });
    },
  );

  test("resource timeout leaves readiness time and returns the retained device and session", async () => {
    const timer = new FakeTimer();
    const resources = new FakeDeviceResourceController();
    resources.result.success = false;
    resources.result.resources = { wallpaperRendering: { state: "unknown", reason: "timed out" } };
    resources.onRequest = async (request) => {
      timer.advanceTime(request.deadlineMs - timer.now());
    };
    exactProvisioner.provision = async () => provisionedTestDevice("android", true);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    let readinessBudget = 0;
    setDeviceToolsDependencies({
      timer,
      deviceResourceControllerFactory: () => resources,
      ensureCtrlProxyReady: async ({ totalDeadlineMs }) => {
        readinessBudget = totalDeadlineMs - timer.now();
        if (readinessBudget <= 0) {
          throw new Error("No readiness budget remaining");
        }
      },
    });
    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android", "resource-timeout"),
      timeoutMs: 60_000,
      resources: { wallpaperRendering: "disabled" },
    });
    expect(readinessBudget).toBeGreaterThan(0);
    expect((response as any).isError).toBe(true);
    const payload = JSON.parse((response as any).content[0].text);
    expect(Object.hasOwn(payload, "sessionUuid")).toBe(true);
    expect(Object.hasOwn(payload, "sessionId")).toBe(true);
    expect(payload.sessionUuid).toBe(payload.sessionId);
    const persisted = operationStore.getStoredResult("resource-timeout")!;
    expect(persisted.sessionId).toBe(payload.sessionUuid);
    expect(Object.hasOwn(persisted, "sessionUuid")).toBe(false);
    expect(payload).toMatchObject({
      success: false,
      created: true,
      device: { deviceId: "emulator-5554" },
      sessionId: expect.any(String),
      readiness: { status: "automation_ready" },
      resources: { success: false, resources: { wallpaperRendering: { state: "unknown" } } },
    });
    expect(operationStore.failCalls).toBe(0);
  });

  test("teardown preemption after resource configuration prevents readiness and session binding", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const resources = new FakeDeviceResourceController();
    let teardown: ReturnType<typeof coordinator.reserve> | undefined;
    let readinessCalls = 0;
    resources.onRequest = async (request) => {
      teardown = coordinator.reserve(
        { kind: "stable", platform: "android", stableId: "phone-api-36-a" },
        { operation: "teardown", deadlineMs: 60_000 },
      );
      expect(request.signal?.aborted).toBe(true);
    };
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator: coordinator,
      deviceResourceControllerFactory: () => resources,
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
      },
    });
    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android", "resource-preemption"),
      timeoutMs: 60_000,
      resources: { wallpaperRendering: "disabled" },
    });
    const lease = await teardown;
    lease?.release();
    expect(readinessCalls).toBe(0);
    expect((response as any).isError).toBe(true);
    expect(JSON.parse((response as any).content[0].text).sessionId).toBeUndefined();
  });

  test("a changed resource request conflicts with a reused operation ID", async () => {
    const resources = new FakeDeviceResourceController();
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    setDeviceToolsDependencies({ deviceResourceControllerFactory: () => resources });
    const tool = ToolRegistry.getTool("provisionDevice")!;
    const args = {
      ...provisionTestArgs("android", "resource-conflict"),
      readiness: "none" as const,
      resources: { wallpaperRendering: "disabled" as const },
    };
    await tool.handler(args);
    const response = await tool.handler({ ...args, resources: { wallpaperRendering: "enabled" } });
    expect((response as any).isError).toBe(true);
    expect(JSON.parse((response as any).content[0].text).error.code).toBe("operation_conflict");
    expect(resources.requests).toHaveLength(1);
  });

  test("unsupported resources return an explicit error while preserving the provisioned identity", async () => {
    const resources = new FakeDeviceResourceController();
    resources.result.success = false;
    resources.result.resources = {
      wallpaperRendering: { state: "unsupported", reason: "Android control deferred" },
    };
    resources.result.changed = [];
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    setDeviceToolsDependencies({ deviceResourceControllerFactory: () => resources });
    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android", "unsupported-resources"),
      readiness: "none",
      resources: { wallpaperRendering: "disabled" },
    });
    expect((response as any).isError).toBe(true);
    expect(JSON.parse((response as any).content[0].text)).toMatchObject({
      success: false,
      device: { deviceId: "emulator-5554" },
      resources: { resources: { wallpaperRendering: { state: "unsupported" } } },
    });
  });

  test("accepts omitted boot and readiness with their documented defaults", () => {
    expect(
      provisionDeviceSchema.parse({
        operationId: "operation-defaults",
        device: {
          platform: "android",
          name: "phone-api-36-a",
          spec: {
            runtime: "system-images;android-36;google_apis;x86_64",
            deviceType: "pixel_9",
          },
        },
      }),
    ).toMatchObject({
      boot: true,
      readiness: "automation",
    });
  });

  test("reserves enough outer request time for bounded rollback", () => {
    const args = provisionTestArgs("android", "operation-max-provision-timeout");

    expect(
      provisionDeviceSchema.parse({ ...args, timeoutMs: MAX_PROVISION_DEVICE_TIMEOUT_MS })
        .timeoutMs,
    ).toBe(MAX_PROVISION_DEVICE_TIMEOUT_MS);
    expect(() =>
      provisionDeviceSchema.parse({ ...args, timeoutMs: MAX_PROVISION_DEVICE_TIMEOUT_MS + 1 }),
    ).toThrow();
  });

  test("accepts only documented display-cutout preferences", () => {
    const input = {
      operationId: "operation-display-cutout-schema",
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
          displayCutout: "hole_punch",
        },
      },
    };

    expect(provisionDeviceSchema.parse(input).device.spec).toMatchObject({
      displayCutout: "hole_punch",
    });
    expect(() =>
      provisionDeviceSchema.parse({
        ...input,
        device: {
          ...input.device,
          spec: { ...input.device.spec, displayCutout: "camera" },
        },
      }),
    ).toThrow();
  });

  test("advertises the platform-discriminated device schema with deterministic oneOf", () => {
    const definition = ToolRegistry.getToolDefinitions().find(
      (candidate) => candidate.name === "provisionDevice",
    );
    const properties = definition?.inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;

    expect(properties?.device.oneOf).toBeArray();
    expect(properties?.device.anyOf).toBeUndefined();
  });

  test("rejects unbootable memory for modern Play Store Android images", () => {
    expect(() =>
      provisionDeviceSchema.parse({
        operationId: "operation-low-play-memory",
        device: {
          platform: "android",
          name: "phone-api-36-play",
          spec: {
            runtime: "system-images;android-36;google_apis_playstore;x86_64",
            deviceType: "pixel_9",
            configuration: { memoryMb: 1024 },
          },
        },
      }),
    ).toThrow(/at least 2048/);
  });

  test("creates the caller-specified device once and replays its structured result by operationId", async () => {
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      operationId: "operation-5434",
      device: {
        platform: "android",
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
          displayCutout: "hole_punch",
          configuration: { memoryMb: 4096 },
        },
      },
      boot: false,
      readiness: "automation",
    };

    const first = JSON.parse(
      (
        (await tool.handler({
          ...args,
          __mcpSessionId: "mcp-session-5434",
          __executionId: "execution-5434",
          __executionStartTime: 0,
        } as any)) as any
      ).content[0].text,
    );
    const second = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(exactProvisioner.requests).toHaveLength(1);
    expect(exactProvisioner.requests[0]).toMatchObject({
      platform: "android",
      name: "phone-api-36-a",
      spec: {
        runtime: "system-images;android-36;google_apis;x86_64",
        deviceType: "pixel_9",
        displayCutout: "hole_punch",
        configuration: { memoryMb: 4096 },
      },
    });
    expect(exactProvisioner.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(first).toMatchObject({
      operationId: "operation-5434",
      created: true,
      adopted: false,
      lifecycleState: "created",
      readiness: { status: "not_requested" },
      device: {
        name: "phone-api-36-a",
        platform: "android",
      },
      displayCutout: "hole_punch",
    });
    expect(second).toEqual(first);
  });

  test("backfills cutout fields when replaying a legacy persisted result", async () => {
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      operationId: "operation-legacy-cutout-replay",
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: false,
      readiness: "none" as const,
    };

    const first = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    const legacyResult = { ...first };
    delete legacyResult.displayCutout;
    legacyResult.resolvedSpec = { ...legacyResult.resolvedSpec };
    delete legacyResult.resolvedSpec.displayCutout;
    operationStore.setStoredResult(args.operationId, legacyResult);

    const replay = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(replay).toMatchObject({
      displayCutout: "hole_punch",
      resolvedSpec: { displayCutout: "hole_punch" },
    });
    expect(replay).toEqual(operationStore.getStoredResult(args.operationId));
  });

  test("coordinates completed provisioning replays with teardown", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    setDeviceToolsDependencies({ timer, lifecycleCoordinator });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      operationId: "operation-replay-lifecycle",
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: false,
      readiness: "none" as const,
    };
    await tool.handler(args);
    await Promise.resolve();
    const teardownLease = await lifecycleCoordinator.reserve(
      { kind: "stable", platform: "android", stableId: args.device.name },
      { operation: "teardown", deadlineMs: 1_000 },
    );
    let replaySettled = false;
    const replay = tool.handler(args).finally(() => {
      replaySettled = true;
    });

    for (let attempt = 0; attempt < 10; attempt++) {
      await Promise.resolve();
    }
    expect(replaySettled).toBe(false);

    teardownLease.release();
    await replay;
    expect(exactProvisioner.requests).toHaveLength(1);
  });

  test("slices one absolute deadline across a replay instead of re-granting timeoutMs", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const readinessBudgets: number[] = [];
    deviceManager.setDeviceImages("android", [
      { name: "phone-api-36-a", platform: "android", isRunning: false },
    ]);
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator,
      ensureCtrlProxyReady: async ({ totalDeadlineMs }) => {
        readinessBudgets.push(totalDeadlineMs - timer.now());
      },
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      ...provisionTestArgs("android", "operation-replay-budget"),
      timeoutMs: 60_000,
    };

    await tool.handler(args);
    await Promise.resolve();
    expect(readinessBudgets).toEqual([60_000]);

    // A competing teardown holds the stable lease for almost the whole
    // request budget. The replay's readiness must run inside what is LEFT of
    // that budget, not a freshly re-granted timeoutMs.
    const teardownLease = await lifecycleCoordinator.reserve(
      { kind: "stable", platform: "android", stableId: args.device.name },
      { operation: "teardown", deadlineMs: 10_000_000 },
    );
    const replay = tool.handler(args);
    for (let attempt = 0; attempt < 10; attempt++) {
      await Promise.resolve();
    }
    timer.advanceTime(59_000);
    teardownLease.release();
    await replay;

    expect(readinessBudgets).toHaveLength(2);
    expect(readinessBudgets[1]).toBeLessThanOrEqual(1_000);
  });

  test("boots the exact device and runs automation readiness when requested", async () => {
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    let readinessRequest: unknown;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async (request) => {
        readinessRequest = request;
      },
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const result = JSON.parse(
      (
        (await tool.handler({
          operationId: "operation-boot",
          device: {
            platform: "android",
            name: "phone-api-36-a",
            spec: {
              runtime: "system-images;android-36;google_apis;x86_64",
              deviceType: "pixel_9",
            },
          },
          boot: true,
          readiness: "automation",
        })) as any
      ).content[0].text,
    );

    expect(deviceManager.wasMethodCalled("startDevice")).toBe(true);
    expect(readinessRequest).toMatchObject({
      device: { name: "phone-api-36-a", platform: "android" },
    });
    expect(result).toMatchObject({
      lifecycleState: "ready",
      readiness: { mode: "automation", status: "automation_ready" },
      sessionUuid: expect.any(String),
      sessionId: expect.any(String),
    });
  });

  test.each(["android", "ios"] as const)(
    "exposes sessionUuid for fresh booted %s provisioning while retaining sessionId",
    async (platform) => {
      exactProvisioner.provision = async () => provisionedTestDevice(platform, false);
      deviceManager.setBootedDevices(platform, [
        {
          name: provisionTestArgs(platform, "unused").device.name,
          platform,
          deviceId: platform === "android" ? "emulator-5554" : "SIM-123",
        },
      ]);

      const response = JSON.parse(
        (
          (await ToolRegistry.getTool("provisionDevice")!.handler({
            ...provisionTestArgs(platform, `operation-public-session-${platform}`),
            readiness: "none",
          })) as any
        ).content[0].text,
      );

      expect(response.sessionUuid).toEqual(expect.any(String));
      expect(Object.hasOwn(response, "sessionUuid")).toBe(true);
      expect(Object.hasOwn(response, "sessionId")).toBe(true);
      expect(response.sessionUuid).toBe(response.sessionId);
      const persisted = operationStore.getStoredResult(`operation-public-session-${platform}`)!;
      expect(persisted.sessionId).toBe(response.sessionUuid);
      expect(Object.hasOwn(persisted, "sessionUuid")).toBe(false);
    },
  );

  test.each(["android", "ios"] as const)(
    "does not expose a session for boot:false %s provisioning",
    async (platform) => {
      const response = JSON.parse(
        (
          (await ToolRegistry.getTool("provisionDevice")!.handler({
            ...provisionTestArgs(platform, "operation-no-session"),
            boot: false,
            readiness: "none",
          })) as any
        ).content[0].text,
      );

      expect(Object.hasOwn(response, "sessionUuid")).toBe(false);
      expect(Object.hasOwn(response, "sessionId")).toBe(false);
      const persisted = operationStore.getStoredResult("operation-no-session")!;
      expect(Object.hasOwn(persisted, "sessionUuid")).toBe(false);
      expect(Object.hasOwn(persisted, "sessionId")).toBe(false);
    },
  );

  for (const platform of ["android", "ios"] as const) {
    test(`${platform}: cleans up a newly created device when readiness fails`, async () => {
      const provisioned = provisionedTestDevice(platform, true);
      configureProvisionBootAndTeardown(deviceManager, platform);
      const provisioner: ExactDeviceProvisioner = {
        provision: async (request) => {
          await request.onBeforeCreate?.();
          deviceManager.setDeviceImages(platform, [provisioned.device]);
          return provisioned;
        },
      };
      setDeviceToolsDependencies({
        exactDeviceProvisionerFactory: () => provisioner,
        ensureCtrlProxyReady: async () => {
          throw new Error("runner readiness failed");
        },
        idGenerator: new FakeIdGenerator([`attempt-${platform}`, `cleanup-${platform}`]),
      });
      registerDeviceTools();
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }

      const response = JSON.parse(
        ((await tool.handler(provisionTestArgs(platform, `operation-cleanup-${platform}`))) as any)
          .content[0].text,
      );

      expect(response).toMatchObject({
        success: false,
        error: { code: "platform_command_failed" },
        provisionFailure: {
          code: "platform_command_failed",
          message: expect.stringContaining("runner readiness failed"),
        },
        cleanup: {
          status: "succeeded",
          operationId: `cleanup-${platform}`,
          state: "destroyed",
        },
      });
      expect(deviceManager.getExecutedOperations()).toContainEqual(
        expect.stringContaining(`destroyDevice:${platform}:`),
      );
      expect(await deviceManager.listDeviceImages(platform)).toEqual([]);
      expect(operationStore.failCalls).toBe(1);
    });

    test(`${platform}: never deletes an adopted device when readiness fails`, async () => {
      const provisioned = provisionedTestDevice(platform, false);
      configureProvisionBootAndTeardown(deviceManager, platform);
      deviceManager.setDeviceImages(platform, [provisioned.device]);
      setDeviceToolsDependencies({
        exactDeviceProvisionerFactory: () => ({
          provision: async () => provisioned,
        }),
        ensureCtrlProxyReady: async () => {
          throw new Error("runner readiness failed");
        },
      });
      registerDeviceTools();
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }

      const response = JSON.parse(
        ((await tool.handler(provisionTestArgs(platform, `operation-adopted-${platform}`))) as any)
          .content[0].text,
      );

      expect(response).toMatchObject({
        success: false,
        error: { code: "platform_command_failed" },
      });
      expect(response.cleanup).toBeUndefined();
      expect(deviceManager.getExecutedOperations()).not.toContainEqual(
        expect.stringContaining("destroyDevice:"),
      );
      expect(await deviceManager.listDeviceImages(platform)).toEqual([provisioned.device]);
    });

    test(`${platform}: reports a structured cleanup failure without false success`, async () => {
      const timer = new FakeTimer();
      const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
      const provisioned = provisionedTestDevice(platform, true);
      configureProvisionBootAndTeardown(deviceManager, platform);
      const provisioner: ExactDeviceProvisioner = {
        provision: async (request) => {
          await request.onBeforeCreate?.();
          deviceManager.setDeviceImages(platform, [provisioned.device]);
          return provisioned;
        },
      };
      let destroyCalls = 0;
      deviceManager.destroyDevice = async () => {
        destroyCalls++;
        throw new Error("platform delete failed");
      };
      setDeviceToolsDependencies({
        timer,
        lifecycleCoordinator,
        exactDeviceProvisionerFactory: () => provisioner,
        ensureCtrlProxyReady: async () => {
          throw new Error("runner readiness failed");
        },
        idGenerator: new FakeIdGenerator([
          `attempt-failure-${platform}`,
          `cleanup-failure-${platform}`,
        ]),
      });
      registerDeviceTools();
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }

      const response = JSON.parse(
        (
          (await tool.handler(
            provisionTestArgs(platform, `operation-cleanup-failure-${platform}`),
          )) as any
        ).content[0].text,
      );

      expect(response).toMatchObject({
        success: false,
        error: {
          code: "cleanup_failed",
          message: expect.stringContaining("platform delete failed"),
        },
        provisionFailure: {
          code: "platform_command_failed",
          message: expect.stringContaining("runner readiness failed"),
        },
        cleanup: {
          status: "failed",
          operationId: `cleanup-failure-${platform}`,
          failure: {
            code: "operation_failed",
            phase: "destroy",
            message: expect.stringContaining("platform delete failed"),
          },
        },
      });
      expect(destroyCalls).toBe(1);

      const releasedLease = await lifecycleCoordinator.reserve(
        {
          kind: "stable",
          platform,
          stableId: platform === "android" ? provisioned.device.name : "SIM-123",
        },
        { operation: "provision", deadlineMs: timer.now() + 1 },
      );
      releasedLease.release();
    });

    test(`${platform}: retries the same failed operation and returns stable success fields`, async () => {
      const provisioned = provisionedTestDevice(platform, true);
      configureProvisionBootAndTeardown(deviceManager, platform);
      let provisionCalls = 0;
      const provisioner: ExactDeviceProvisioner = {
        provision: async (request) => {
          provisionCalls++;
          await request.onBeforeCreate?.();
          deviceManager.setDeviceImages(platform, [provisioned.device]);
          return provisioned;
        },
      };
      let readinessCalls = 0;
      setDeviceToolsDependencies({
        exactDeviceProvisionerFactory: () => provisioner,
        ensureCtrlProxyReady: async () => {
          readinessCalls++;
          if (readinessCalls === 1) {
            throw new Error("first readiness attempt failed");
          }
        },
        idGenerator: new FakeIdGenerator([
          `attempt-retry-${platform}`,
          `cleanup-retry-${platform}`,
        ]),
      });
      registerDeviceTools();
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }
      const args = provisionTestArgs(platform, `operation-retry-cleanup-${platform}`);

      const failed = JSON.parse(((await tool.handler(args)) as any).content[0].text);
      const retried = JSON.parse(((await tool.handler(args)) as any).content[0].text);

      expect(failed).toMatchObject({
        success: false,
        cleanup: { status: "succeeded" },
      });
      expect(retried).toMatchObject({
        operationId: args.operationId,
        created: true,
        adopted: false,
        lifecycleState: "ready",
        readiness: { mode: "automation", status: "automation_ready" },
        sessionId: expect.any(String),
        device: {
          name: provisioned.device.name,
          platform,
          deviceId: platform === "android" ? "emulator-5554" : "SIM-123",
        },
      });
      expect(provisionCalls).toBe(2);
    });
  }

  test("rolls back before a queued provision for the same device begins", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const provisioned = provisionedTestDevice("android", true);
    const firstReadinessStarted = Promise.withResolvers<void>();
    const failFirstReadiness = Promise.withResolvers<void>();
    let readinessCalls = 0;
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator,
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          await request.onBeforeCreate?.();
          deviceManager.setDeviceImages("android", [provisioned.device]);
          return provisioned;
        },
      }),
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
        if (readinessCalls === 1) {
          firstReadinessStarted.resolve();
          await failFirstReadiness.promise;
          throw new Error("first readiness attempt failed");
        }
      },
      idGenerator: new FakeIdGenerator(["attempt-queued-provision", "cleanup-queued-provision"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const first = tool.handler(provisionTestArgs("android", "operation-queued-first"));
    await firstReadinessStarted.promise;
    let secondSettled = false;
    const second = tool
      .handler(provisionTestArgs("android", "operation-queued-second"))
      .finally(() => {
        secondSettled = true;
      });

    for (let attempt = 0; attempt < 10; attempt++) {
      await Promise.resolve();
    }
    expect(secondSettled).toBe(false);

    failFirstReadiness.resolve();
    const firstResponse = JSON.parse(((await first) as any).content[0].text);
    const secondResponse = JSON.parse(((await second) as any).content[0].text);

    expect(firstResponse).toMatchObject({
      success: false,
      cleanup: { status: "succeeded" },
    });
    expect(secondResponse).toMatchObject({
      operationId: "operation-queued-second",
      lifecycleState: "ready",
      readiness: { status: "automation_ready" },
    });
  });

  test("cleans up an Android AVD created before exact provisioning fails", async () => {
    const created = provisionedTestDevice("android", true);
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          await request.onBeforeCreate?.();
          deviceManager.setDeviceImages("android", [created.device]);
          throw new Error("writing AVD memory configuration failed");
        },
      }),
      idGenerator: new FakeIdGenerator(["attempt-partial-android", "cleanup-partial-android"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = JSON.parse(
      (
        (await tool.handler(
          provisionTestArgs("android", "operation-partial-create-android"),
        )) as any
      ).content[0].text,
    );

    expect(response).toMatchObject({
      success: false,
      cleanup: { status: "succeeded", operationId: "cleanup-partial-android" },
    });
    expect(await deviceManager.listDeviceImages("android")).toEqual([]);
  });

  test("keeps a committed provision when the post-commit resource notification fails", async () => {
    const created = provisionedTestDevice("android", true);
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          await request.onBeforeCreate?.();
          deviceManager.setDeviceImages("android", [created.device]);
          return created;
        },
      }),
      ensureCtrlProxyReady: async () => {},
      notifyResourcesChanged: async () => {
        throw new Error("resource notification transport closed");
      },
      idGenerator: new FakeIdGenerator(["session-notify-failure", "cleanup-notify-failure"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = JSON.parse(
      ((await tool.handler(provisionTestArgs("android", "operation-notify-failure"))) as any)
        .content[0].text,
    );

    // Session + pool ownership are already committed by the time the
    // best-effort notification runs, so its failure must neither be reported
    // as a provisioning failure nor drive destructive rollback.
    expect(response).toMatchObject({
      created: true,
      lifecycleState: "ready",
      sessionId: "session-notify-failure",
    });
    expect(response.success).toBeUndefined();
    expect(response.error).toBeUndefined();
    expect(response.cleanup).toBeUndefined();
    expect(
      deviceManager
        .getExecutedOperations()
        .filter((operation) => operation.startsWith("destroyDevice:")),
    ).toEqual([]);
    expect(await deviceManager.listDeviceImages("android")).toEqual([created.device]);
  });

  test("cleans up an iOS simulator created before exact provisioning fails", async () => {
    const created = provisionedTestDevice("ios", true);
    configureProvisionBootAndTeardown(deviceManager, "ios");
    deviceManager.setDeviceImages("ios", []);
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          await request.onBeforeCreate?.();
          // simctl created the simulator, but its UDID never reached us.
          deviceManager.setDeviceImages("ios", [created.device]);
          throw new Error("reading the created simulator UDID failed");
        },
      }),
      idGenerator: new FakeIdGenerator(["cleanup-partial-ios"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = JSON.parse(
      ((await tool.handler(provisionTestArgs("ios", "operation-partial-create-ios"))) as any)
        .content[0].text,
    );

    expect(response).toMatchObject({
      success: false,
      cleanup: { status: "succeeded", operationId: "cleanup-partial-ios" },
    });
    expect(await deviceManager.listDeviceImages("ios")).toEqual([]);
  });

  test("does not roll back a fresh provision when MCP session recovery is in progress", async () => {
    const created = provisionedTestDevice("android", true);
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          await request.onBeforeCreate?.();
          deviceManager.setDeviceImages("android", [created.device]);
          return created;
        },
      }),
      ensureCtrlProxyReady: async () => {
        throw new McpSessionRecoveryInProgressError("mcp-session-recovering");
      },
      idGenerator: new FakeIdGenerator(["session-recovery", "cleanup-recovery"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = await tool.handler(
      provisionTestArgs("android", "operation-recovery-fresh-android"),
    );

    // A transport routing conflict does not invalidate the healthy device, so
    // the recovery error must keep its identity instead of being wrapped by
    // the rollback and costing a full create + cold boot on retry.
    expect(JSON.stringify(response)).toContain("recovering a device");
    expect(JSON.stringify(response)).not.toContain("cleanup");
    expect(
      deviceManager
        .getExecutedOperations()
        .filter((operation) => operation.startsWith("destroyDevice:")),
    ).toEqual([]);
    expect(await deviceManager.listDeviceImages("android")).toEqual([created.device]);
  });

  test("cleans up a retried operation's adopted device when the original cleanup failed", async () => {
    const adopted = provisionedTestDevice("android", false);
    configureProvisionBootAndTeardown(deviceManager, "android");
    const originalDestroyDevice = deviceManager.destroyDevice.bind(deviceManager);
    let failFirstCleanup = true;
    deviceManager.destroyDevice = async (device) => {
      if (failFirstCleanup) {
        failFirstCleanup = false;
        throw new Error("first cleanup failed");
      }
      await originalDestroyDevice(device);
    };
    let provisionCalls = 0;
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionCalls++;
          if (provisionCalls === 1) {
            await request.onBeforeCreate?.();
            deviceManager.setDeviceImages("android", [adopted.device]);
            throw new Error("writing AVD memory configuration failed");
          }
          return adopted;
        },
      }),
      ensureCtrlProxyReady: async () => {
        throw new Error("retry readiness failed");
      },
      idGenerator: new FakeIdGenerator([
        "attempt-partial-first-android",
        "cleanup-partial-first-android",
        "attempt-partial-retry-android",
        "cleanup-partial-retry-android",
      ]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = provisionTestArgs("android", "operation-partial-retry-android");

    const initial = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    const retried = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(initial).toMatchObject({
      success: false,
      cleanup: { status: "failed", operationId: "cleanup-partial-first-android" },
    });
    expect(retried).toMatchObject({
      success: false,
      cleanup: { status: "succeeded", operationId: "cleanup-partial-retry-android" },
    });
    expect(await deviceManager.listDeviceImages("android")).toEqual([]);
  });

  test("does not retain creation ownership after verified rollback", async () => {
    const created = provisionedTestDevice("android", true);
    const replacement = provisionedTestDevice("android", false);
    configureProvisionBootAndTeardown(deviceManager, "android");
    let provisionCalls = 0;
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionCalls++;
          if (provisionCalls === 1) {
            await request.onBeforeCreate?.();
            deviceManager.setDeviceImages("android", [created.device]);
            throw new Error("writing AVD memory configuration failed");
          }
          return replacement;
        },
      }),
      ensureCtrlProxyReady: async () => {
        throw new Error("replacement readiness failed");
      },
      idGenerator: new FakeIdGenerator(["attempt-original-android", "cleanup-original-android"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = provisionTestArgs("android", "operation-cleaned-up-retry-android");

    const initial = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    deviceManager.setDeviceImages("android", [replacement.device]);
    const retried = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(initial).toMatchObject({
      success: false,
      cleanup: { status: "succeeded", operationId: "cleanup-original-android" },
    });
    expect(retried).toMatchObject({ success: false });
    expect(retried.cleanup).toBeUndefined();
    expect(await deviceManager.listDeviceImages("android")).toEqual([replacement.device]);
    expect(
      deviceManager
        .getExecutedOperations()
        .filter((operation) => operation.startsWith("destroyDevice:")),
    ).toHaveLength(1);
  });

  test("adopts a running Android AVD by resolving its transport ID before boot", async () => {
    const existing = {
      name: "phone-api-36-a",
      platform: "android" as const,
      isRunning: true,
    };
    deviceManager.setDeviceImages("android", [existing]);
    deviceManager.setBootedDevices("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        deviceId: "emulator-5554",
      },
    ]);
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async () => ({
          created: false,
          device: existing,
          resolvedSpec: {
            runtime: "system-images;android-36;google_apis;x86_64",
            deviceType: "pixel_9",
            displayCutout: "hole_punch",
          },
        }),
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const result = JSON.parse(
      (
        (await tool.handler({
          operationId: "operation-adopt-running",
          device: {
            platform: "android",
            name: "phone-api-36-a",
            spec: {
              runtime: "system-images;android-36;google_apis;x86_64",
              deviceType: "pixel_9",
            },
          },
          boot: true,
          readiness: "none",
        })) as any
      ).content[0].text,
    );

    expect(deviceManager.wasMethodCalled("startDevice")).toBe(false);
    expect(result).toMatchObject({
      created: false,
      adopted: true,
      lifecycleState: "ready",
      readiness: { mode: "none", status: "device_ready" },
      sessionId: expect.any(String),
      device: {
        deviceId: "emulator-5554",
        name: "phone-api-36-a",
      },
    });
  });

  test("boots the provisioned iOS UDID instead of another running simulator with the same name", async () => {
    deviceManager.setDeviceImages("ios", [
      {
        name: "phone-api-36-a",
        platform: "ios",
        deviceId: "requested-udid",
        isRunning: false,
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      },
    ]);
    deviceManager.setBootedDevices("ios", [
      {
        name: "phone-api-36-a",
        platform: "ios",
        deviceId: "other-udid",
      },
    ]);
    const exactIosProvisioner: ExactDeviceProvisioner = {
      provision: async () => ({
        created: false,
        device: {
          name: "phone-api-36-a",
          platform: "ios",
          deviceId: "requested-udid",
          isRunning: false,
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        },
        resolvedSpec: {
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        },
      }),
    };
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => exactIosProvisioner,
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = JSON.parse(
      (
        (await tool.handler({
          operationId: "operation-ios-running-identity",
          device: {
            platform: "ios",
            name: "phone-api-36-a",
            spec: {
              runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
              deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
            },
          },
          boot: true,
          readiness: "none",
        })) as any
      ).content[0].text,
    );

    expect(response).toMatchObject({
      created: false,
      adopted: true,
      lifecycleState: "ready",
      readiness: { mode: "none", status: "device_ready" },
      sessionId: expect.any(String),
      device: {
        deviceId: "requested-udid",
      },
    });
    expect(deviceManager.getExecutedOperations()).toContainEqual(
      expect.stringContaining("startDevice:phone-api-36-a"),
    );
  });

  test("reports a contended iOS selector reservation as a timeout", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const blocker = await coordinator.reserve(
      { kind: "selector", platform: "ios", selector: "iPhone 17" },
      { operation: "provision", deadlineMs: 10_000_000 },
    );
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator: coordinator,
      exactDeviceProvisionerFactory: () => ({
        provision: async () => {
          throw new Error("provisioning must not start without a reservation");
        },
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const pending = tool.handler({
      ...provisionTestArgs("ios", "operation-ios-selector-contended"),
      boot: false,
      readiness: "none",
      timeoutMs: 60_000,
    });
    for (let index = 0; index < 30; index++) {
      await Promise.resolve();
    }
    timer.advanceTime(60_001);
    const response = JSON.parse(((await pending) as any).content[0].text);
    blocker.release();

    expect(response).toMatchObject({
      success: false,
      error: { code: "timeout" },
    });
  });

  test("fails closed when iOS lifecycle-reservation discovery is incomplete", async () => {
    deviceManager.failedPlatforms.add("ios");
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = JSON.parse(
      (
        (await tool.handler({
          operationId: "operation-ios-discovery-incomplete",
          device: {
            platform: "ios",
            name: "iPhone 17",
            spec: {
              runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
              deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
            },
          },
          boot: false,
          readiness: "none",
        })) as any
      ).content[0].text,
    );

    expect(response).toMatchObject({
      success: false,
      error: { code: "platform_command_failed" },
    });
    expect(exactProvisioner.requests).toHaveLength(0);
  });

  test("locks a newly created iOS simulator before booting it", async () => {
    const created: ExactProvisionedDevice = {
      created: true,
      device: {
        platform: "ios",
        name: "iPhone 17",
        deviceId: "created-udid",
        isRunning: false,
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      },
      resolvedSpec: {
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        displayCutout: "dynamic_island",
      },
    };
    let releaseReadiness!: () => void;
    const readinessStarted = new Promise<void>((resolve) => {
      setDeviceToolsDependencies({
        ensureCtrlProxyReady: async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseReadiness = release;
          });
        },
      });
    });
    const exactIosProvisioner: ExactDeviceProvisioner = {
      provision: async (request) => {
        deviceManager.setDeviceImages("ios", [created.device]);
        await request.lifecycleLease?.bindCanonicalIdentity({
          platform: "ios",
          stableId: created.device.deviceId!,
        });
        return created;
      },
    };
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => exactIosProvisioner,
    });
    registerDeviceTools();
    const provisionTool = ToolRegistry.getTool("provisionDevice");
    const teardownTool = ToolRegistry.getTool("deleteDevice");
    if (!provisionTool || !teardownTool) {
      throw new Error("expected provisionDevice and deleteDevice tools");
    }

    const provision = provisionTool.handler({
      operationId: "operation-ios-created-lock",
      device: {
        platform: "ios",
        name: created.device.name,
        spec: created.resolvedSpec,
      },
      boot: true,
      readiness: "automation",
    });
    await readinessStarted;
    deviceManager.clearHistory();

    const teardown = teardownTool.handler({
      operationId: "35e6f783-b794-47b8-b8a1-8619677820f0",
      target: {
        platform: "ios",
        isVirtual: true,
        stableId: created.device.deviceId!,
        stableName: created.device.name,
      },
      mode: "destroy",
      verifyAbsence: true,
      timeoutMs: 60_000,
    });
    let teardownSettled = false;
    void teardown.then(
      () => {
        teardownSettled = true;
      },
      () => {
        teardownSettled = true;
      },
    );
    for (let attempt = 0; attempt < 50; attempt++) {
      await Promise.resolve();
    }
    expect(teardownSettled).toBe(false);
    expect(deviceManager.getExecutedOperations()).toEqual([]);

    releaseReadiness();
    await provision;
    await teardown;
    expect(deviceManager.getExecutedOperations()).toContainEqual(
      expect.stringContaining("getBootedDevices:ios"),
    );
  });

  test("rebinds a live session before replaying a completed boot operation", async () => {
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      operationId: "operation-rebind-session",
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: true,
      readiness: "none" as const,
    };

    const first = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    await Promise.resolve();
    const second = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(exactProvisioner.requests).toHaveLength(2);
    expect(exactProvisioner.requests[1]?.reconcileExistingConfiguration).toBe(false);
    expect(deviceManager.getCallCount("getBootedDevices")).toBeGreaterThanOrEqual(2);
    for (const response of [first, second]) {
      expect(Object.hasOwn(response, "sessionUuid")).toBe(true);
      expect(Object.hasOwn(response, "sessionId")).toBe(true);
      expect(response.sessionUuid).toBe(response.sessionId);
    }
    expect(second).toMatchObject({
      lifecycleState: "ready",
      sessionId: expect.any(String),
    });
    expect(second.sessionUuid).not.toBe(first.sessionUuid);
    const persisted = operationStore.getStoredResult(args.operationId)!;
    expect(persisted.sessionId).toBe(second.sessionUuid);
    expect(Object.hasOwn(persisted, "sessionUuid")).toBe(false);
  });

  test.each([false, true])(
    "returns a completed boot operation while its session is still live (resource verification: %s)",
    async (configureResources) => {
      const resourceController = new FakeDeviceResourceController();
      setDeviceToolsDependencies({ deviceResourceControllerFactory: () => resourceController });
      const timer = new FakeTimer();
      const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const pool = new DevicePool(
        sessionManager,
        "daemon-session",
        timer,
        undefined,
        deviceManager,
      );
      const bootedDevice = {
        name: "phone-api-36-a",
        platform: "android" as const,
        deviceId: "mock-phone-api-36-a",
      };
      deviceManager.setDeviceImages("android", [
        {
          name: "phone-api-36-a",
          platform: "android",
          isRunning: false,
        },
      ]);
      await pool.initializeWithDevices([bootedDevice]);
      DaemonState.getInstance().initialize(sessionManager, pool);
      let readinessCalls = 0;
      setDeviceToolsDependencies({
        timer,
        ensureCtrlProxyReady: async ({ totalDeadlineMs }) => {
          expect(totalDeadlineMs).toBeGreaterThan(timer.now());
          readinessCalls++;
        },
      });

      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }
      const args = {
        operationId: "operation-live-session",
        ...(configureResources ? { resources: { wallpaperRendering: "disabled" as const } } : {}),
        device: {
          platform: "android" as const,
          name: "phone-api-36-a",
          spec: {
            runtime: "system-images;android-36;google_apis;x86_64",
            deviceType: "pixel_9",
          },
        },
        boot: true,
        readiness: "automation" as const,
        timeoutMs: 60_000,
      };

      const first = JSON.parse(((await tool.handler(args)) as any).content[0].text);
      const second = JSON.parse(((await tool.handler(args)) as any).content[0].text);

      for (const response of [first, second]) {
        expect(Object.hasOwn(response, "sessionUuid")).toBe(true);
        expect(Object.hasOwn(response, "sessionId")).toBe(true);
        expect(response.sessionUuid).toBe(response.sessionId);
      }
      expect(second).toEqual(first);
      const persisted = operationStore.getStoredResult(args.operationId)!;
      expect(persisted.sessionId).toBe(second.sessionUuid);
      expect(Object.hasOwn(persisted, "sessionUuid")).toBe(false);
      expect(exactProvisioner.requests).toHaveLength(1);
      expect(deviceManager.getCallCount("startDevice")).toBe(1);
      expect(readinessCalls).toBe(2);
      expect(resourceController.requests).toHaveLength(configureResources ? 2 : 0);
      if (configureResources) {
        resourceController.onRequest = async (request) => {
          timer.advanceTime(request.deadlineMs - timer.now());
        };
        resourceController.result = {
          ...resourceController.result,
          success: false,
          resources: { wallpaperRendering: { state: "unknown", reason: "drift" } },
        };
        const drift = await tool.handler(args);
        expect((drift as any).isError).toBe(true);
        const driftPayload = JSON.parse((drift as any).content[0].text);
        expect(Object.hasOwn(driftPayload, "sessionUuid")).toBe(true);
        expect(Object.hasOwn(driftPayload, "sessionId")).toBe(true);
        expect(driftPayload.sessionUuid).toBe(driftPayload.sessionId);
        expect(driftPayload.sessionUuid).toBe(first.sessionUuid);
        expect(exactProvisioner.requests).toHaveLength(1);
        expect(readinessCalls).toBe(3);
        expect(operationStore.getStoredResult(args.operationId)?.resources).toMatchObject({
          success: false,
        });
        const persistedDrift = operationStore.getStoredResult(args.operationId)!;
        expect(persistedDrift.sessionId).toBe(driftPayload.sessionUuid);
        expect(Object.hasOwn(persistedDrift, "sessionUuid")).toBe(false);
      }
      sessionManager.stopCleanupTimer();
    },
  );

  // #6227 (round 6 P1): `readiness: "none"` deliberately skips CtrlProxy /
  // accessibility-service setup in `ensureProvisionDeviceReadiness`, so the
  // freshly-bound session must NOT be recorded as `automationReady` — that
  // would make a later `automationReady` tool (e.g. `observe`) wrongly treat
  // setup as already satisfied and run against a device whose CtrlProxy setup
  // was intentionally skipped.
  test("records booted (not automationReady) when readiness: 'none' skips CtrlProxy setup (#6227 round 6)", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, deviceManager);
    const bootedDevice = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "mock-phone-api-36-a",
    };
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    await pool.initializeWithDevices([bootedDevice]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    let readinessCalls = 0;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
      },
    });

    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const response = JSON.parse(
      (
        (await tool.handler({
          operationId: "operation-readiness-none-record",
          device: {
            platform: "android",
            name: "phone-api-36-a",
            spec: {
              runtime: "system-images;android-36;google_apis;x86_64",
              deviceType: "pixel_9",
            },
          },
          boot: true,
          readiness: "none",
        })) as any
      ).content[0].text,
    );

    expect(readinessCalls).toBe(0);
    expect(response.sessionUuid).toEqual(expect.any(String));
    expect(response.sessionId).toEqual(expect.any(String));
    expect(sessionManager.getDeviceReadiness(response.sessionUuid)).toBe("booted");
    sessionManager.stopCleanupTimer();
  });

  // #6227 (round 6 P1, continued): because the session bound after
  // `readiness: "none"` is recorded as merely `booted`, a subsequent
  // `automationReady`-declaring tool call against that same session must
  // still run CtrlProxy / accessibility-service setup rather than skipping it
  // as already-satisfied.
  test("a later automationReady tool runs setup for a session acquired via readiness: 'none' (#6227 round 6)", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, deviceManager);
    const bootedDevice = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "mock-phone-api-36-a",
    };
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    await pool.initializeWithDevices([bootedDevice]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {},
    });

    const ctrlProxySetup = stubCtrlProxySetup();

    try {
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }
      const response = JSON.parse(
        (
          (await tool.handler({
            operationId: "operation-readiness-none-upgrade",
            device: {
              platform: "android",
              name: "phone-api-36-a",
              spec: {
                runtime: "system-images;android-36;google_apis;x86_64",
                deviceType: "pixel_9",
              },
            },
            boot: true,
            readiness: "none",
          })) as any
        ).content[0].text,
      );
      const sessionUuid = response.sessionUuid as string;
      expect(response.sessionId).toEqual(expect.any(String));
      expect(sessionManager.getDeviceReadiness(sessionUuid)).toBe("booted");

      ToolRegistry.registerDeviceAware(
        "automationReadyAfterProvisionProbe",
        "Automation-ready probe after provisionDevice readiness: none",
        z.object({ sessionUuid: z.string().optional() }),
        async () => ({ success: true }),
        { deviceReadiness: "automationReady" },
      );

      const automationResponse = await ToolRegistry.getTool(
        "automationReadyAfterProvisionProbe",
      )!.handler({
        platform: "android",
        sessionUuid,
        // This probe verifies readiness setup, not host ADB keep-awake behavior.
        keepScreenAwake: false,
      });

      expect(automationResponse).toMatchObject({ success: true });
      expect(ctrlProxySetup.setupCallCount()).toBe(1);
      expect(sessionManager.getDeviceReadiness(sessionUuid)).toBe("automationReady");
    } finally {
      ctrlProxySetup.restore();
      sessionManager.stopCleanupTimer();
    }
  });

  test("marks the operation row terminal when a fresh attempt hits MCP session recovery", async () => {
    // McpSessionRecoveryInProgressError is explicitly transient ("cannot remap
    // until recovery finishes"), so the caller is expected to retry. Leaving
    // the freshly admitted "running" row untouched would brick the
    // operationId for the whole PROVISION_DEVICE_OPERATION_TTL_MS (~30m) with
    // nothing actually running.
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async () => {
          throw new McpSessionRecoveryInProgressError("mcp-session-recovering");
        },
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = await tool.handler({
      ...provisionTestArgs("android", "operation-recovery-terminal"),
      boot: false,
      readiness: "none",
    });

    expect(JSON.stringify(response)).toContain("recovering a device");
    expect(operationStore.failures).toEqual([
      { operationId: "operation-recovery-terminal", errorCode: "session_recovery_in_progress" },
    ]);
  });

  test("reconnecting during recovery preserves the live session and completed operation", async () => {
    const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, deviceManager);
    const bootedDevice = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "mock-phone-api-36-a",
    };
    try {
      deviceManager.setDeviceImages("android", [
        {
          name: "phone-api-36-a",
          platform: "android",
          isRunning: false,
        },
      ]);
      await pool.initializeWithDevices([bootedDevice]);
      DaemonState.getInstance().initialize(sessionManager, pool);
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }
      const args = {
        operationId: "operation-reconnected-mcp-session",
        device: {
          platform: "android" as const,
          name: "phone-api-36-a",
          spec: {
            runtime: "system-images;android-36;google_apis;x86_64",
            deviceType: "pixel_9",
          },
        },
        boot: true,
        readiness: "none" as const,
      };

      const first = JSON.parse(
        (
          (await tool.handler({
            ...args,
            __mcpSessionId: "mcp-session-original",
          })) as any
        ).content[0].text,
      );
      const recoveringDevice = {
        ...bootedDevice,
        deviceId: "recovering-device",
        name: "Recovery AVD",
      };
      await pool.addDevice(recoveringDevice);
      const recovery = await pool.reserveDeviceForShutdown(recoveringDevice.deviceId, undefined, {
        mcpSessionId: "mcp-session-reconnected",
        expectedSessionId: undefined,
      });
      const rejected = await tool.handler({ ...args, __mcpSessionId: "mcp-session-reconnected" });
      expect(JSON.stringify(rejected)).toContain("recovering a device");
      expect(sessionManager.getSession(first.sessionId)).not.toBeNull();
      expect(pool.getDevice(bootedDevice.deviceId)?.sessionId).toBe(first.sessionId);
      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-original")).toBe(
        first.sessionId,
      );
      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-reconnected")).toBeUndefined();
      expect(operationStore.failCalls).toBe(0);
      recovery!.releaseRecoveryRouteLease();
      await recovery!.release();
      const second = JSON.parse(
        (
          (await tool.handler({
            ...args,
            __mcpSessionId: "mcp-session-reconnected",
          })) as any
        ).content[0].text,
      );

      for (const response of [first, second]) {
        expect(Object.hasOwn(response, "sessionUuid")).toBe(true);
        expect(Object.hasOwn(response, "sessionId")).toBe(true);
        expect(response.sessionUuid).toBe(response.sessionId);
      }
      expect(second).toEqual(first);
      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-reconnected", "android")).toBe(
        first.sessionId,
      );
      const persisted = operationStore.getStoredResult(args.operationId)!;
      expect(persisted.sessionId).toBe(second.sessionUuid);
      expect(Object.hasOwn(persisted, "sessionUuid")).toBe(false);
    } finally {
      sessionManager.stopCleanupTimer();
      if (originalAutolock === undefined) {
        delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
      }
    }
  });

  test("releases a live replay session when automation readiness fails", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, deviceManager);
    const bootedDevice = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "mock-phone-api-36-a",
    };
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    await pool.initializeWithDevices([bootedDevice]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    let readinessCalls = 0;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
        if (readinessCalls === 2) {
          throw new Error("readiness failed");
        }
      },
    });
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      operationId: "operation-replay-readiness-failure",
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: true,
      readiness: "automation" as const,
    };

    await tool.handler(args);
    const failedReplay = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(failedReplay).toMatchObject({
      success: false,
      error: { code: "platform_command_failed" },
    });
    expect(pool.getDevice(bootedDevice.deviceId)).toMatchObject({
      sessionId: null,
      status: "idle",
    });
    expect(operationStore.failCalls).toBe(1);
    sessionManager.stopCleanupTimer();
  });

  test("rebinds an errored persisted session instead of replaying its stale readiness", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, deviceManager);
    const bootedDevice = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "mock-phone-api-36-a",
    };
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    await pool.initializeWithDevices([bootedDevice]);
    DaemonState.getInstance().initialize(sessionManager, pool);

    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      operationId: "operation-errored-session",
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: true,
      readiness: "none" as const,
    };

    const first = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    const pooledDevice = pool.getDevice(bootedDevice.deviceId);
    if (!pooledDevice) {
      throw new Error("expected pooled device");
    }
    pooledDevice.status = "error";
    const second = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    for (const response of [first, second]) {
      expect(Object.hasOwn(response, "sessionUuid")).toBe(true);
      expect(Object.hasOwn(response, "sessionId")).toBe(true);
      expect(response.sessionUuid).toBe(response.sessionId);
    }
    expect(second).toMatchObject({
      lifecycleState: "ready",
      sessionId: expect.any(String),
    });
    expect(second.sessionUuid).not.toBe(first.sessionUuid);
    const persisted = operationStore.getStoredResult(args.operationId)!;
    expect(persisted.sessionId).toBe(second.sessionUuid);
    expect(Object.hasOwn(persisted, "sessionUuid")).toBe(false);
    expect(exactProvisioner.requests).toHaveLength(2);
    expect(pool.getDevice(bootedDevice.deviceId)?.status).toBe("busy");
    sessionManager.stopCleanupTimer();
  });

  test("releases the bound session when completion persistence fails", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, deviceManager);
    const bootedDevice = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "mock-phone-api-36-a",
    };
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    await pool.initializeWithDevices([bootedDevice]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    operationStore.completeError = new Error("database unavailable");

    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const response = JSON.parse(
      (
        (await tool.handler({
          operationId: "operation-persistence-failure",
          device: {
            platform: "android",
            name: "phone-api-36-a",
            spec: {
              runtime: "system-images;android-36;google_apis;x86_64",
              deviceType: "pixel_9",
            },
          },
          boot: true,
          readiness: "none",
        })) as any
      ).content[0].text,
    );

    expect(response).toMatchObject({
      success: false,
      error: {
        code: "platform_command_failed",
      },
    });
    expect(pool.getDevice(bootedDevice.deviceId)).toMatchObject({
      sessionId: null,
      status: "idle",
    });
    expect(operationStore.failCalls).toBe(1);
    sessionManager.stopCleanupTimer();
  });

  test("retains creation ownership when a completed boot operation rebinds", async () => {
    let calls = 0;
    const replayProvisioner: ExactDeviceProvisioner = {
      provision: async (request) => {
        calls++;
        return {
          created: calls === 1,
          device: {
            name: request.name,
            platform: "android",
            isRunning: false,
          },
          resolvedSpec: {
            ...request.spec,
            displayCutout: classifyDisplayCutout(request.platform, request.spec.deviceType),
          },
        };
      },
    };
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => replayProvisioner,
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      operationId: "operation-preserve-created",
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: true,
      readiness: "none" as const,
    };

    const first = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    const second = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(calls).toBe(2);
    expect(first).toMatchObject({ created: true, adopted: false });
    expect(second).toMatchObject({ created: true, adopted: false });
  });

  test("takes creation ownership when a rebind re-creates a device the first attempt adopted", async () => {
    let calls = 0;
    const replayProvisioner: ExactDeviceProvisioner = {
      provision: async (request) => {
        calls++;
        // The adopted device disappeared between attempts, so the rebind
        // genuinely creates it.
        if (calls > 1) {
          await request.onBeforeCreate?.();
        }
        return {
          created: calls > 1,
          device: {
            name: request.name,
            platform: "android",
            isRunning: false,
          },
          resolvedSpec: {
            ...request.spec,
            displayCutout: classifyDisplayCutout(request.platform, request.spec.deviceType),
          },
        };
      },
    };
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => replayProvisioner,
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      operationId: "operation-rebind-recreated",
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: true,
      readiness: "none" as const,
    };

    const first = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    const second = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(calls).toBe(2);
    expect(first).toMatchObject({ created: false, adopted: true });
    // A caller that only deletes what AutoMobile created must not be told this
    // device was adopted.
    expect(second).toMatchObject({ created: true, adopted: false });
  });

  test("clears creation ownership after a successful lifecycle rollback", async () => {
    let calls = 0;
    const retryingProvisioner: ExactDeviceProvisioner = {
      provision: async (request) => {
        calls++;
        if (calls === 1) {
          await request.onBeforeCreate?.();
        }
        return {
          created: calls === 1,
          device: {
            name: request.name,
            platform: "android",
            isRunning: false,
          },
          resolvedSpec: {
            ...request.spec,
            displayCutout: classifyDisplayCutout(request.platform, request.spec.deviceType),
          },
        };
      },
    };
    let readinessCalls = 0;
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => retryingProvisioner,
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
        if (readinessCalls === 1) {
          throw new Error("first readiness attempt failed");
        }
      },
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      operationId: "operation-retry-created-ownership",
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: true,
      readiness: "automation" as const,
    };

    const failed = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    const retried = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(failed).toMatchObject({ success: false });
    expect(retried).toMatchObject({ created: false, adopted: true });
    expect(calls).toBe(2);
  });

  test("cancels the lifecycle and reports request_cancelled when the last waiter aborts", async () => {
    let provisionSignal: AbortSignal | undefined;
    let observedAbort = false;
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionSignal = request.signal;
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) {
              resolve();
              return;
            }
            request.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          observedAbort = true;
          throw request.signal?.reason ?? new Error("aborted");
        },
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      ...provisionTestArgs("android", "operation-sole-caller-abort"),
      boot: false,
      readiness: "none" as const,
    };

    const caller = new AbortController();
    const call = tool.handler(args, undefined, caller.signal);
    await Promise.resolve();
    caller.abort(new Error("client went away"));
    const response = await call;
    for (let attempt = 0; attempt < 10; attempt++) {
      await Promise.resolve();
    }

    // Nothing is waiting for the result any more, so the provisioning work
    // must be cancelled rather than left to boot a device and bind a session
    // no client owns.
    expect(provisionSignal?.aborted).toBe(true);
    expect(observedAbort).toBe(true);
    expect(JSON.parse((response as any).content[0].text)).toMatchObject({
      success: false,
      error: { code: "request_cancelled" },
      operationId: args.operationId,
      operationContinues: false,
    });
    expect(operationStore.getStoredResult(args.operationId)).toBeUndefined();
  });

  test("tells a detaching joiner that the shared operation continues", async () => {
    let resolveProvision!: (result: ExactProvisionedDevice) => void;
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async () =>
          await new Promise<ExactProvisionedDevice>((resolve) => {
            resolveProvision = resolve;
          }),
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      ...provisionTestArgs("android", "operation-joiner-abort"),
      boot: false,
      readiness: "none" as const,
    };

    const initiator = tool.handler(args);
    await Promise.resolve();
    const joinerController = new AbortController();
    const joiner = tool.handler(args, undefined, joinerController.signal);
    await Promise.resolve();
    joinerController.abort(new Error("joiner disconnected"));
    const joinerResponse = await joiner;

    expect(JSON.parse((joinerResponse as any).content[0].text)).toMatchObject({
      success: false,
      error: { code: "request_cancelled" },
      operationId: args.operationId,
      operationContinues: true,
    });

    resolveProvision(provisionedTestDevice("android", true));
    expect(JSON.parse(((await initiator) as any).content[0].text)).toMatchObject({
      operationId: args.operationId,
    });
  });

  test("keeps a shared operation running when its initiating caller aborts", async () => {
    let resolveProvision!: (result: ExactProvisionedDevice) => void;
    let provisionSignal: AbortSignal | undefined;
    const pendingProvisioner: ExactDeviceProvisioner = {
      provision: async (request) =>
        await new Promise<ExactProvisionedDevice>((resolve) => {
          provisionSignal = request.signal;
          resolveProvision = resolve;
        }),
    };
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => pendingProvisioner,
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      operationId: "operation-shared-abort",
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: false,
      readiness: "none" as const,
    };
    const firstCaller = new AbortController();
    const first = tool.handler(args, undefined, firstCaller.signal);
    await Promise.resolve();
    const second = tool.handler(args);
    firstCaller.abort(new Error("first caller disconnected"));

    expect(JSON.parse(((await first) as any).content[0].text)).toMatchObject({
      success: false,
    });
    expect(provisionSignal?.aborted).toBe(false);

    resolveProvision({
      created: true,
      device: {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
      resolvedSpec: {
        ...args.device.spec,
        displayCutout: classifyDisplayCutout(args.device.platform, args.device.spec.deviceType),
      },
    });

    expect(JSON.parse(((await second) as any).content[0].text)).toMatchObject({
      operationId: "operation-shared-abort",
    });
    expect(provisionSignal?.aborted).toBe(false);
  });

  test("returns a typed operation conflict when an operationId is reused for a different request", async () => {
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const base = {
      operationId: "operation-conflict",
      device: {
        platform: "ios",
        name: "phone-api-36-a",
        spec: {
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
          displayCutout: "any",
        },
      },
      boot: false,
      readiness: "none",
    };

    await tool.handler(base);
    const conflicting = JSON.parse(
      (
        (await tool.handler({
          ...base,
          device: {
            ...base.device,
            spec: {
              ...base.device.spec,
              displayCutout: "dynamic_island",
            },
          },
        })) as any
      ).content[0].text,
    );

    expect(conflicting).toMatchObject({
      success: false,
      error: {
        code: "operation_conflict",
      },
    });
  });

  test("reports in-progress instead of re-running provisioning for an already-running operation", async () => {
    operationStore.markInProgress("operation-already-running");

    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = JSON.parse(
      (
        (await tool.handler({
          operationId: "operation-already-running",
          device: {
            platform: "android",
            name: "phone-api-36-a",
            spec: {
              runtime: "system-images;android-36;google_apis;x86_64",
              deviceType: "pixel_9",
            },
          },
          boot: false,
          readiness: "none",
        })) as any
      ).content[0].text,
    );

    expect(response).toMatchObject({
      success: false,
      error: {
        code: "operation_in_progress",
      },
    });
    // The lifecycle must never run for an in-progress row -- otherwise this is
    // just the #6652 defect-1 restart bug wearing a different response shape.
    expect(exactProvisioner.requests).toHaveLength(0);
    expect(operationStore.failCalls).toBe(0);
  });

  test.each(["android", "ios"] as const)(
    "preserves %s boot timeout classification",
    async (platform) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const provisioned = provisionedTestDevice(platform, false);
      exactProvisioner.provision = async () => provisioned;
      deviceManager.setDeviceImages(platform, [provisioned.device]);
      deviceManager.waitForDeviceReady = async (_device, _timeout, _handle, signal) => {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      };
      setDeviceToolsDependencies({ timer });
      const response = await ToolRegistry.getTool("provisionDevice")!.handler({
        ...provisionTestArgs(platform, `boot-timeout-${platform}`),
        timeoutMs: 180_000,
      });
      const payload = JSON.parse((response as any).content[0].text);
      expect(payload.error.code).toBe("timeout");
      expect(payload.error.message).toContain("provisionDevice timeout exhausted");
      expect(payload.error.message).toContain("waiting for device boot readiness");
    },
  );

  test.each([false, true])(
    "a delayed reservation release preserves acquisition outcome (failure=%s)",
    async (failReadiness) => {
      const timer = new FakeTimer();
      const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
      sessionManager.stopCleanupTimer();
      const pool = new DevicePool(
        sessionManager,
        "daemon-session",
        timer,
        undefined,
        deviceManager,
      );
      const booted = {
        name: "phone-api-36-a",
        platform: "android" as const,
        deviceId: "emulator-5554",
      };
      deviceManager.setBootedDevices("android", [booted]);
      await pool.initializeWithDevices([booted]);
      DaemonState.getInstance().initialize(sessionManager, pool);
      exactProvisioner.provision = async () => provisionedTestDevice("android", false);
      let releaseRequested = false;
      const released = Promise.withResolvers<void>();
      pool.reserveDeviceForReadiness = async () =>
        Object.assign(
          async () => {
            releaseRequested = true;
            await released.promise;
          },
          { owner: Symbol("test-reservation") },
        );
      setDeviceToolsDependencies({
        timer,
        ensureCtrlProxyReady: async () => {
          if (failReadiness) {
            throw new Error("original readiness failure");
          }
        },
      });
      try {
        const response = await ToolRegistry.getTool("provisionDevice")!.handler({
          ...provisionTestArgs("android", `delayed-release-${failReadiness}`),
          timeoutMs: 1_000,
        });
        const payload = JSON.parse((response as any).content[0].text);
        expect(releaseRequested).toBe(true);
        if (failReadiness) {
          expect(payload.error.message).toContain("original readiness failure");
          expect(sessionManager.getAllSessionIds()).toEqual([]);
        } else {
          expect(payload.sessionUuid).toBeDefined();
          expect(sessionManager.getSession(payload.sessionUuid)?.assignedDevice).toBe(
            booted.deviceId,
          );
        }
        expect(deviceManager.wasMethodCalled("killDevice")).toBe(false);
      } finally {
        released.resolve();
      }
    },
  );

  test("bounds a pending final session binding by the provision deadline", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, deviceManager);
    const booted = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "emulator-5554",
    };
    deviceManager.setBootedDevices("android", [booted]);
    await pool.initializeWithDevices([booted]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    pool.bindOrReuseDeviceSession = async () => await new Promise<string>(() => {});
    setDeviceToolsDependencies({ timer, ensureCtrlProxyReady: async () => {} });
    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android", "pending-final-binding"),
      timeoutMs: 1_000,
    });
    const payload = JSON.parse((response as any).content[0].text);
    expect(payload.error.code).toBe("timeout");
    expect(payload.error.message).toContain("binding the device session");
    expect(sessionManager.getAllSessionIds()).toEqual([]);
  });

  test("enforces timeoutMs across exact provisioning before boot begins", async () => {
    const timer = new FakeTimer();
    let provisionSignal: AbortSignal | undefined;
    const pendingProvisioner: ExactDeviceProvisioner = {
      provision: async (request) =>
        await new Promise<ExactProvisionedDevice>((_resolve, reject) => {
          provisionSignal = request.signal;
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true,
          });
        }),
    };
    setDeviceToolsDependencies({
      timer,
      exactDeviceProvisionerFactory: () => pendingProvisioner,
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = tool.handler({
      operationId: "operation-timeout",
      device: {
        platform: "android",
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: true,
      readiness: "automation",
      timeoutMs: 1_000,
    });

    for (let attempt = 0; provisionSignal === undefined && attempt < 10; attempt++) {
      await Promise.resolve();
    }
    expect(provisionSignal).toBeInstanceOf(AbortSignal);
    timer.advanceTime(1_000);

    expect(JSON.parse(((await response) as any).content[0].text)).toMatchObject({
      success: false,
      error: {
        code: "timeout",
      },
    });
    expect(provisionSignal?.aborted).toBe(true);
    expect(deviceManager.wasMethodCalled("startDevice")).toBe(false);
  });

  test.each([
    ["__mcpSessionId", "mcp-session-1"],
    ["__executionId", "execution-1"],
    ["__executionStartTime", 1_000],
    ["__mcpRequestTimeoutMs", 120_000],
    // Absolute deadline on the shared timer clock, so it must be far-future.
    ["__mcpRequestDeadlineMs", 8_640_000_000_000],
    ["__mcpLiveDeadlineKey", "live-deadline-1"],
  ] as const)(
    "strips the internal %s param before re-parsing against the strict schema",
    async (param, value) => {
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }

      const response = await tool.handler({
        ...provisionTestArgs("android", `operation-internal-${param}`),
        boot: false,
        readiness: "none",
        [param]: value,
      } as any);

      expect((response as any).isError).toBeUndefined();
      expect(JSON.parse((response as any).content[0].text)).toMatchObject({
        operationId: `operation-internal-${param}`,
        lifecycleState: "created",
      });
    },
  );

  test("returns a structured invalid_arguments error instead of throwing a raw ZodError", async () => {
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = await tool.handler({
      ...provisionTestArgs("android", "operation-invalid-args"),
      boot: false,
      readiness: "none",
      totallyUnknownKey: "nope",
    } as any);

    expect((response as any).isError).toBe(true);
    const payload = JSON.parse((response as any).content[0].text);
    expect(payload.error.code).toBe("invalid_arguments");
    expect(payload.error.message).toContain("provisionDevice");
  });

  // `cancelUnownedColdBoot` returns a settlement that resolves on the
  // emulator child's `exit` event. provisionDevice discarded it, so the AVD's
  // stable lifecycle lease was released while the emulator was still shutting
  // down and a concurrent start/teardown of the same AVD could relaunch or
  // delete it against a live `hardware-qemu.ini.lock`.
  test("holds the AVD lifecycle lease until a cancelled cold boot has exited", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    deviceManager.setDeviceImages("android", [
      { name: "phone-api-36-a", platform: "android", isRunning: false },
    ]);
    const exitListeners: (() => void)[] = [];
    const handle: any = {
      exitCode: null,
      signalCode: null,
      once: (event: string, listener: () => void) => {
        if (event === "exit") {
          exitListeners.push(listener);
        }
        return handle;
      },
      // A real emulator does not disappear synchronously on kill().
      kill: () => true,
    };
    deviceManager.setMockChildProcess("phone-api-36-a", handle);
    const originalWaitForDeviceReady = deviceManager.waitForDeviceReady.bind(deviceManager);
    deviceManager.waitForDeviceReady = async (device, timeoutMs, childProcess, signal) => {
      const booted = await originalWaitForDeviceReady(device, timeoutMs, childProcess, signal);
      const resolved = { ...booted, deviceId: "emulator-5554" };
      deviceManager.setBootedDevices("android", [resolved]);
      return resolved;
    };
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator: coordinator,
      ensureCtrlProxyReady: async () => {
        throw new Error("automation readiness failed");
      },
    });

    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android", "cold-boot-settlement"),
      timeoutMs: 60_000,
    });
    expect((response as any).isError).toBe(true);

    let leaseGranted = false;
    const contender = coordinator
      .reserve(
        { kind: "stable", platform: "android", stableId: "phone-api-36-a" },
        { operation: "start", deadlineMs: 60_000 },
      )
      .then((lease) => {
        leaseGranted = true;
        return lease;
      });
    await new Promise((resolve) => setImmediate(resolve));
    expect(leaseGranted).toBe(false);

    expect(exitListeners.length).toBeGreaterThan(0);

    handle.exitCode = 0;
    for (const listener of exitListeners) {
      listener();
    }
    (await contender).release();
    expect(leaseGranted).toBe(true);
  });

  // A readiness failure caused by an exhausted deadline was reported and
  // persisted as `platform_command_failed`, so a controller that retries on
  // `timeout` but treats `platform_command_failed` as terminal gave up on a
  // purely time-based failure.
  test("reports an exhausted readiness budget as a timeout", async () => {
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        throw new RunnerReadinessError(
          "provisionDevice automation runner readiness failed: phase=runner-setup " +
            "attempts=1 remainingBudgetMs=0: readiness budget exhausted before setup lock",
          false,
          true,
        );
      },
    });

    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android", "readiness-budget-timeout"),
      timeoutMs: 60_000,
    });

    expect(JSON.parse((response as any).content[0].text).error.code).toBe("timeout");
    expect(operationStore.failCodes).toEqual(["timeout"]);
  });

  // Boot and automation readiness share one provision budget, so a slow cold
  // boot could consume all of it and leave CtrlProxy setup with a
  // millisecond ("readiness budget exhausted before setup lock"). Boot must be
  // bounded by its own share of the deadline instead.
  test("bounds boot by its own share instead of the whole provision budget", async () => {
    const timer = new FakeTimer();
    deviceManager.setDeviceImages("android", [
      { name: "phone-api-36-a", platform: "android", isRunning: false },
    ]);
    const handle: any = {
      exitCode: null,
      signalCode: null,
      once: () => handle,
      kill: () => true,
    };
    deviceManager.setMockChildProcess("phone-api-36-a", handle);
    const originalWaitForDeviceReady = deviceManager.waitForDeviceReady.bind(deviceManager);
    deviceManager.waitForDeviceReady = async (device, timeoutMs, childProcess, signal) => {
      // Yield once so the boot phase has registered its deadline timer, then
      // model a slow cold boot that ends 1ms before the whole provision deadline.
      await Promise.resolve();
      timer.advanceTime(59_999);
      const booted = await originalWaitForDeviceReady(device, timeoutMs, childProcess, signal);
      const resolved = { ...booted, deviceId: "emulator-5554" };
      deviceManager.setBootedDevices("android", [resolved]);
      return resolved;
    };
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    let readinessBudgetMs: number | undefined;
    setDeviceToolsDependencies({
      timer,
      ensureCtrlProxyReady: async ({ totalDeadlineMs }) => {
        readinessBudgetMs = totalDeadlineMs - timer.now();
      },
    });

    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android", "boot-budget-slice"),
      timeoutMs: 60_000,
    });

    const payload = JSON.parse((response as any).content[0].text);
    // Either boot stayed inside its share and readiness kept a usable budget, or
    // boot overran its share and the request failed as a timeout. What must not
    // happen is readiness running with a starved budget.
    expect(readinessBudgetMs ?? Number.POSITIVE_INFINITY).toBeGreaterThan(1_000);
    expect(payload.error?.code).toBe("timeout");
  });

  // `reserveDeviceForReadiness` proves ownership through its `autolockClient`
  // argument before the caller starts readiness side effects ("Acquisition may
  // reboot a device during readiness recovery"). provisionDevice passed no
  // autolock client, so it reset the shared per-device CtrlProxy manager and
  // rewrote device resource settings on another MCP client's live device, only
  // failing afterwards at the bind.
  test("does not touch a device autolocked to another MCP client", async () => {
    const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, deviceManager);
    try {
      const booted = {
        name: "phone-api-36-a",
        platform: "android" as const,
        deviceId: "emulator-5554",
      };
      deviceManager.setBootedDevices("android", [booted]);
      deviceManager.setDeviceImages("android", [
        { name: "phone-api-36-a", platform: "android", isRunning: true },
      ]);
      await pool.initializeWithDevices([booted]);
      DaemonState.getInstance().initialize(sessionManager, pool);
      await pool.autolockDevice(
        "emulator-5554",
        "android",
        "other-mcp-client",
        undefined,
        undefined,
        booted,
      );
      exactProvisioner.provision = async () => provisionedTestDevice("android", false);
      const resources = new FakeDeviceResourceController();
      let readinessCalls = 0;
      setDeviceToolsDependencies({
        timer,
        deviceResourceControllerFactory: () => resources,
        ensureCtrlProxyReady: async () => {
          readinessCalls++;
        },
      });

      const response = await ToolRegistry.getTool("provisionDevice")!.handler({
        ...provisionTestArgs("android", "autolocked-elsewhere"),
        timeoutMs: 60_000,
        resources: { wallpaperRendering: "disabled" as const },
        __mcpSessionId: "my-mcp-client",
      });

      expect({ readinessCalls, resourceRequests: resources.requests.length }).toEqual({
        readinessCalls: 0,
        resourceRequests: 0,
      });
      expect((response as any).isError).toBe(true);
    } finally {
      sessionManager.stopCleanupTimer();
      if (originalAutolock === undefined) {
        delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
      }
    }
  });

  // `reserveProvisionDeviceReadiness` records a stable-name readiness
  // reservation keyed `android:<avd>`. If the pooled entry's incarnation changes
  // while readiness is in flight (a disconnect + rediscovery of the same serial,
  // i.e. exactly the Android-reboot case the name reservation exists to bridge),
  // provisionDevice must still be able to bind: its own reservation owner has to
  // be handed to `bindBootedDeviceSession`, or the reservation denies its own bind.
  test("binds through its own readiness name reservation after an incarnation change", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, deviceManager);
    const booted = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "emulator-5554",
    };
    const avdInfo = {
      name: "phone-api-36-a",
      platform: "android" as const,
      isRunning: true,
      source: "local" as const,
    };
    deviceManager.setBootedDevices("android", [booted]);
    deviceManager.setDeviceImages("android", [avdInfo]);
    await pool.initializeWithDevices([booted]);
    // `trackStableName` only fires for an emulator whose pooled AVD name matches.
    (pool as any).devices.get("emulator-5554").avdName = "phone-api-36-a";
    DaemonState.getInstance().initialize(sessionManager, pool);
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    setDeviceToolsDependencies({
      timer,
      ensureCtrlProxyReady: async () => {
        // A disconnect + rediscovery of the same serial mints a new incarnation.
        await pool.removeDevice("emulator-5554");
        await pool.addDevice(booted, avdInfo);
      },
    });

    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android", "readiness-reservation-owner"),
      timeoutMs: 60_000,
    });

    expect((response as any).isError).toBeFalsy();
    const payload = JSON.parse((response as any).content[0].text);
    expect(payload.error).toBeUndefined();
    expect(payload).toMatchObject({
      lifecycleState: "ready",
      sessionId: expect.any(String),
    });
  });

  test("reserves rollback and response time from the daemon's queued-request deadline", async () => {
    const timer = new FakeTimer();
    let provisionDeadlineMs: number | undefined;
    setDeviceToolsDependencies({
      timer,
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionDeadlineMs = request.deadlineMs;
          return provisionedTestDevice("android", true);
        },
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    await tool.handler({
      ...provisionTestArgs("android", "operation-queued-deadline"),
      boot: false,
      readiness: "none",
      timeoutMs: 100_000,
      // The outer request originally had 165s (100s provisioning + 60s
      // rollback + 5s response headroom); 20s elapsed in the socket queue.
      __mcpRequestTimeoutMs: 145_000,
      __mcpRequestDeadlineMs: 145_000,
    });

    expect(provisionDeadlineMs).toBe(80_000);
  });
});
