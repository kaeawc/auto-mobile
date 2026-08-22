import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  provisionDeviceSchema,
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type {
  ExactDeviceProvisionRequest,
  ExactDeviceProvisioner,
  ExactProvisionedDevice,
} from "../../src/utils/exactDeviceProvisioning";
import type { ProvisionDeviceOperationStore } from "../../src/db/provisionDeviceOperationRepository";
import { ProvisionDeviceOperationConflictError } from "../../src/db/provisionDeviceOperationRepository";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";

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
      resolvedSpec: request.spec,
    };
  }
}

class FakeProvisionDeviceOperationStore implements ProvisionDeviceOperationStore {
  private readonly results = new Map<
    string,
    { fingerprint: string; result?: Record<string, unknown>; creationStarted: boolean }
  >();
  completeError: Error | undefined;
  failCalls = 0;

  async begin(operationId: string, requestFingerprint: string) {
    const existing = this.results.get(operationId);
    if (!existing) {
      this.results.set(operationId, {
        fingerprint: requestFingerprint,
        creationStarted: false,
      });
      return { started: true, reconcileExistingConfiguration: false } as const;
    }
    if (existing.fingerprint !== requestFingerprint) {
      throw new ProvisionDeviceOperationConflictError(operationId);
    }
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

  async markDeviceCreationStarted(operationId: string): Promise<void> {
    const operation = this.results.get(operationId);
    if (!operation) {
      throw new Error(`missing operation ${operationId}`);
    }
    operation.creationStarted = true;
  }

  async complete(operationId: string, result: Record<string, unknown>): Promise<void> {
    if (this.completeError) {
      throw this.completeError;
    }
    const operation = this.results.get(operationId);
    if (!operation) {
      throw new Error(`missing operation ${operationId}`);
    }
    operation.result = result;
  }

  async fail(): Promise<void> {
    this.failCalls++;
  }
}

describe("provisionDevice handler", () => {
  let deviceManager: FakeDeviceUtils;
  let exactProvisioner: FakeExactDeviceProvisioner;
  let operationStore: FakeProvisionDeviceOperationStore;

  beforeEach(() => {
    deviceManager = new FakeDeviceUtils();
    exactProvisioner = new FakeExactDeviceProvisioner();
    operationStore = new FakeProvisionDeviceOperationStore();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deviceManager,
      exactDeviceProvisionerFactory: () => exactProvisioner,
      provisionDeviceOperationStoreFactory: () => operationStore,
      notifyResourcesChanged: async () => {},
    });
    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
  });

  test("accepts omitted boot and readiness with their documented defaults", () => {
    expect(provisionDeviceSchema.parse({
      operationId: "operation-defaults",
      device: {
        platform: "android",
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
    })).toMatchObject({
      boot: true,
      readiness: "automation",
    });
  });

  test("rejects unbootable memory for modern Play Store Android images", () => {
    expect(() => provisionDeviceSchema.parse({
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
    })).toThrow(/at least 2048/);
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
          configuration: { memoryMb: 4096 },
        },
      },
      boot: false,
      readiness: "automation",
    };

    const first = JSON.parse((await tool.handler({
      ...args,
      __mcpSessionId: "mcp-session-5434",
      __executionId: "execution-5434",
      __executionStartTime: 0,
    } as any) as any).content[0].text);
    const second = JSON.parse((await tool.handler(args) as any).content[0].text);

    expect(exactProvisioner.requests).toHaveLength(1);
    expect(exactProvisioner.requests[0]).toMatchObject({
      platform: "android",
      name: "phone-api-36-a",
      spec: {
        runtime: "system-images;android-36;google_apis;x86_64",
        deviceType: "pixel_9",
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
    });
    expect(second).toEqual(first);
  });

  test("boots the exact device and runs automation readiness when requested", async () => {
    deviceManager.setDeviceImages("android", [{
      name: "phone-api-36-a",
      platform: "android",
      isRunning: false,
    }]);
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

    const result = JSON.parse((await tool.handler({
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
    }) as any).content[0].text);

    expect(deviceManager.wasMethodCalled("startDevice")).toBe(true);
    expect(readinessRequest).toMatchObject({
      device: { name: "phone-api-36-a", platform: "android" },
    });
    expect(result).toMatchObject({
      lifecycleState: "ready",
      readiness: { mode: "automation", status: "automation_ready" },
      sessionId: expect.any(String),
    });
  });

  test("adopts a running Android AVD by resolving its transport ID before boot", async () => {
    deviceManager.setDeviceImages("android", [{
      name: "phone-api-36-a",
      platform: "android",
      isRunning: true,
    }]);
    deviceManager.setBootedDevices("android", [{
      name: "phone-api-36-a",
      platform: "android",
      deviceId: "emulator-5554",
    }]);
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const result = JSON.parse((await tool.handler({
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
    }) as any).content[0].text);

    expect(deviceManager.wasMethodCalled("startDevice")).toBe(false);
    expect(result).toMatchObject({
      lifecycleState: "ready",
      device: {
        deviceId: "emulator-5554",
        name: "phone-api-36-a",
      },
    });
  });

  test("boots the provisioned iOS UDID instead of another running simulator with the same name", async () => {
    deviceManager.setDeviceImages("ios", [{
      name: "phone-api-36-a",
      platform: "ios",
      deviceId: "requested-udid",
      isRunning: false,
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    }]);
    deviceManager.setBootedDevices("ios", [{
      name: "phone-api-36-a",
      platform: "ios",
      deviceId: "other-udid",
    }]);
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

    const response = JSON.parse((await tool.handler({
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
    }) as any).content[0].text);

    expect(response).toMatchObject({
      device: {
        deviceId: "requested-udid",
      },
    });
    expect(deviceManager.getExecutedOperations()).toContainEqual(
      expect.stringContaining("startDevice:phone-api-36-a"),
    );
  });

  test("rebinds a live session before replaying a completed boot operation", async () => {
    deviceManager.setDeviceImages("android", [{
      name: "phone-api-36-a",
      platform: "android",
      isRunning: false,
    }]);
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

    const first = JSON.parse((await tool.handler(args) as any).content[0].text);
    await Promise.resolve();
    const second = JSON.parse((await tool.handler(args) as any).content[0].text);

    expect(exactProvisioner.requests).toHaveLength(2);
    expect(exactProvisioner.requests[1]?.reconcileExistingConfiguration).toBe(false);
    expect(deviceManager.getCallCount("getBootedDevices")).toBeGreaterThanOrEqual(2);
    expect(second).toMatchObject({
      lifecycleState: "ready",
      sessionId: expect.any(String),
    });
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  test("returns a completed boot operation while its session is still live", async () => {
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
    deviceManager.setDeviceImages("android", [{
      name: "phone-api-36-a",
      platform: "android",
      isRunning: false,
    }]);
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
    const args = {
      operationId: "operation-live-session",
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

    const first = JSON.parse((await tool.handler(args) as any).content[0].text);
    const second = JSON.parse((await tool.handler(args) as any).content[0].text);

    expect(second).toEqual(first);
    expect(exactProvisioner.requests).toHaveLength(1);
    expect(deviceManager.getCallCount("startDevice")).toBe(1);
    expect(readinessCalls).toBe(2);
    sessionManager.stopCleanupTimer();
  });

  test("rebinds an errored persisted session instead of replaying its stale readiness", async () => {
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
    deviceManager.setDeviceImages("android", [{
      name: "phone-api-36-a",
      platform: "android",
      isRunning: false,
    }]);
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

    const first = JSON.parse((await tool.handler(args) as any).content[0].text);
    const pooledDevice = pool.getDevice(bootedDevice.deviceId);
    if (!pooledDevice) {
      throw new Error("expected pooled device");
    }
    pooledDevice.status = "error";
    const second = JSON.parse((await tool.handler(args) as any).content[0].text);

    expect(second).toMatchObject({
      lifecycleState: "ready",
      sessionId: expect.any(String),
    });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(exactProvisioner.requests).toHaveLength(2);
    expect(pool.getDevice(bootedDevice.deviceId)?.status).toBe("busy");
    sessionManager.stopCleanupTimer();
  });

  test("releases the bound session when completion persistence fails", async () => {
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
    deviceManager.setDeviceImages("android", [{
      name: "phone-api-36-a",
      platform: "android",
      isRunning: false,
    }]);
    await pool.initializeWithDevices([bootedDevice]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    operationStore.completeError = new Error("database unavailable");

    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const response = JSON.parse((await tool.handler({
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
    }) as any).content[0].text);

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
          resolvedSpec: request.spec,
        };
      },
    };
    deviceManager.setDeviceImages("android", [{
      name: "phone-api-36-a",
      platform: "android",
      isRunning: false,
    }]);
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

    const first = JSON.parse((await tool.handler(args) as any).content[0].text);
    const second = JSON.parse((await tool.handler(args) as any).content[0].text);

    expect(calls).toBe(2);
    expect(first).toMatchObject({ created: true, adopted: false });
    expect(second).toMatchObject({ created: true, adopted: false });
  });

  test("keeps a shared operation running when its initiating caller aborts", async () => {
    let resolveProvision!: (result: ExactProvisionedDevice) => void;
    let provisionSignal: AbortSignal | undefined;
    const pendingProvisioner: ExactDeviceProvisioner = {
      provision: async (request) => await new Promise<ExactProvisionedDevice>((resolve) => {
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

    expect(JSON.parse((await first as any).content[0].text)).toMatchObject({
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
      resolvedSpec: args.device.spec,
    });

    expect(JSON.parse((await second as any).content[0].text)).toMatchObject({
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
        },
      },
      boot: false,
      readiness: "none",
    };

    await tool.handler(base);
    const conflicting = JSON.parse((await tool.handler({
      ...base,
      device: {
        ...base.device,
        spec: {
          ...base.device.spec,
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4",
        },
      },
    }) as any).content[0].text);

    expect(conflicting).toMatchObject({
      success: false,
      error: {
        code: "operation_conflict",
      },
    });
  });

  test("enforces timeoutMs across exact provisioning before boot begins", async () => {
    const timer = new FakeTimer();
    let provisionSignal: AbortSignal | undefined;
    const pendingProvisioner: ExactDeviceProvisioner = {
      provision: async (request) => await new Promise<ExactProvisionedDevice>((_resolve, reject) => {
        provisionSignal = request.signal;
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
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

    await Promise.resolve();
    timer.advanceTime(1_000);

    expect(JSON.parse((await response as any).content[0].text)).toMatchObject({
      success: false,
      error: {
        code: "timeout",
      },
    });
    expect(provisionSignal?.aborted).toBe(true);
    expect(deviceManager.wasMethodCalled("startDevice")).toBe(false);
  });
});
