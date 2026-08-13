import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import {
  RunnerReadinessService,
  type ReadinessAndroidManager,
  type ReadinessClient,
  type ReadinessIosManager,
} from "../../src/utils/RunnerReadinessService";
import { FakeTimer } from "../fakes/FakeTimer";

const androidDevice = (deviceId = "emulator-5554"): BootedDevice => ({
  deviceId,
  name: "Pixel_9_Pro",
  platform: "android",
});

const iosDevice: BootedDevice = {
  deviceId: "IOS-UDID",
  name: "iPhone 16 Pro",
  platform: "ios",
};

class FakeReadinessClient implements ReadinessClient {
  connected = true;
  healthResults: boolean[] = [true];
  connectionResults: boolean[] = [true];
  healthCalls = 0;
  connectionCalls = 0;

  isConnected(): boolean {
    return this.connected;
  }

  async waitForConnection(): Promise<boolean> {
    this.connectionCalls++;
    return this.connectionResults.shift() ?? false;
  }

  async verifyServiceReady(): Promise<boolean> {
    this.healthCalls++;
    return this.healthResults.shift() ?? false;
  }
}

class FakeAndroidManager implements ReadinessAndroidManager {
  installed = true;
  enabled = true;
  setupCalls = 0;
  compatibilityResult: Awaited<ReturnType<ReadinessAndroidManager["ensureCompatibleVersion"]>> = {
    status: "compatible",
  };

  async isInstalled(): Promise<boolean> {
    return this.installed;
  }

  async isEnabled(): Promise<boolean> {
    return this.enabled;
  }

  async ensureCompatibleVersion() {
    return this.compatibilityResult;
  }

  async setup() {
    this.setupCalls++;
    this.installed = true;
    this.enabled = true;
    return { success: true, message: "ready" };
  }

  resetSetupState(): void {}
}

class FakeIosManager implements ReadinessIosManager {
  setupResult = { success: true, message: "ready" };
  setupCalls = 0;

  async setup() {
    this.setupCalls++;
    return this.setupResult;
  }

  getServicePort(): number {
    return 8765;
  }
}

function createService(
  options: {
    timer?: FakeTimer;
    androidManager?: FakeAndroidManager;
    androidClient?: FakeReadinessClient;
    iosManager?: FakeIosManager;
    iosClient?: FakeReadinessClient;
  } = {},
) {
  const timer = options.timer ?? new FakeTimer();
  timer.enableAutoAdvance();
  const androidManager = options.androidManager ?? new FakeAndroidManager();
  const androidClient = options.androidClient ?? new FakeReadinessClient();
  const iosManager = options.iosManager ?? new FakeIosManager();
  const iosClient = options.iosClient ?? new FakeReadinessClient();
  return {
    timer,
    androidManager,
    androidClient,
    iosManager,
    iosClient,
    service: new RunnerReadinessService({
      timer,
      getAndroidManager: () => androidManager,
      getAndroidClient: () => androidClient,
      getIosManager: () => iosManager,
      getIosClient: () => iosClient,
      checkIosOverride: async () => ({ present: false, usable: true }),
      awaitIosStartupMaintenance: async () => {},
    }),
  };
}

describe("RunnerReadinessService", () => {
  test("keeps an already-ready Android device on the fast path", async () => {
    const { service, androidManager, androidClient } = createService();

    await service.ensureReady({
      device: androidDevice(),
      requestedIdentity: "platform=android name=Pixel_9_Pro",
      totalDeadlineMs: 30_000,
      readinessTimeoutMs: 30_000,
    });

    expect(androidManager.setupCalls).toBe(0);
    expect(androidClient.healthCalls).toBe(1);
  });

  test("repairs a missing Android package before checking observation health", async () => {
    const androidManager = new FakeAndroidManager();
    androidManager.installed = false;
    androidManager.enabled = false;
    androidManager.compatibilityResult = { status: "installed" };
    const androidClient = new FakeReadinessClient();
    androidClient.connected = false;
    const { service } = createService({ androidManager, androidClient });

    await service.ensureReady({
      device: androidDevice(),
      requestedIdentity: "platform=android",
      totalDeadlineMs: 30_000,
      readinessTimeoutMs: 30_000,
    });

    expect(androidManager.setupCalls).toBe(1);
    expect(androidClient.connectionCalls).toBe(1);
    expect(androidClient.healthCalls).toBe(1);
  });

  test("preserves the original signing incompatibility when Android recovery fails", async () => {
    const androidManager = new FakeAndroidManager();
    androidManager.compatibilityResult = {
      status: "failed",
      upgradeError: "INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match",
      reinstallError: "clean install failed: disk full",
    };
    const { service } = createService({ androidManager });

    await expect(
      service.ensureReady({
        device: androidDevice(),
        requestedIdentity: "platform=android deviceId=emulator-5554",
        totalDeadlineMs: 30_000,
        readinessTimeoutMs: 30_000,
      }),
    ).rejects.toThrow(/INSTALL_FAILED_UPDATE_INCOMPATIBLE.*clean install failed/);
  });

  test("redacts credentials while retaining actionable package-manager output", async () => {
    const androidManager = new FakeAndroidManager();
    androidManager.compatibilityResult = {
      status: "failed",
      upgradeError: "INSTALL_FAILED_UPDATE_INCOMPATIBLE token=top-secret signatures do not match",
    };
    const { service } = createService({ androidManager });

    try {
      await service.ensureReady({
        device: androidDevice(),
        requestedIdentity: "platform=android",
        totalDeadlineMs: 30_000,
        readinessTimeoutMs: 30_000,
      });
      throw new Error("expected readiness failure");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("INSTALL_FAILED_UPDATE_INCOMPATIBLE");
      expect(message).toContain("token=[REDACTED]");
      expect(message).not.toContain("top-secret");
    }
  });

  test("fails start readiness when iOS setup fails", async () => {
    const iosManager = new FakeIosManager();
    iosManager.setupResult = {
      success: false,
      message: "runner unavailable",
      error: "xcodebuild exited 65",
    };
    const iosClient = new FakeReadinessClient();
    iosClient.connected = false;
    const { service } = createService({ iosManager, iosClient });

    await expect(
      service.ensureReady({
        device: iosDevice,
        requestedIdentity: "platform=ios deviceId=IOS-UDID",
        totalDeadlineMs: 30_000,
        readinessTimeoutMs: 30_000,
      }),
    ).rejects.toThrow(/phase=runner-setup.*xcodebuild exited 65/);
  });

  test("retries delayed runner health independently for 40 devices", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const services = Array.from({ length: 40 }, (_, index) => {
      const client = new FakeReadinessClient();
      client.connected = false;
      client.connectionResults = [false, true];
      client.healthResults = [false, true];
      const manager = new FakeAndroidManager();
      return {
        client,
        service: createService({ timer, androidManager: manager, androidClient: client }).service,
        device: androidDevice(`emulator-${5554 + index * 2}`),
      };
    });

    await Promise.all(
      services.map(({ service, device }) =>
        service.ensureReady({
          device,
          requestedIdentity: `platform=android deviceId=${device.deviceId}`,
          totalDeadlineMs: 10_000,
          readinessTimeoutMs: 10_000,
        }),
      ),
    );

    expect(
      services.every(({ client }) => client.connectionCalls >= 2 && client.healthCalls >= 2),
    ).toBe(true);
    expect(timer.now()).toBeLessThan(2_000);
  });

  test("reports the exhausted phase, attempts, mapping, and remaining budget", async () => {
    const client = new FakeReadinessClient();
    client.connected = false;
    client.connectionResults = [];
    const { service } = createService({ androidClient: client });

    await expect(
      service.ensureReady({
        device: androidDevice(),
        requestedIdentity: "platform=android name=Pixel_9_Pro",
        totalDeadlineMs: 1_000,
        readinessTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(
      /platform=android.*requested=\[platform=android name=Pixel_9_Pro\].*resolved=\[Pixel_9_Pro \(emulator-5554\)\].*phase=runner-connect.*attempts=[1-9].*remainingBudgetMs=0/,
    );
  });
});
