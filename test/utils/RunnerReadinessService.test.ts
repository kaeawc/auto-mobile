import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import {
  RunnerReadinessService,
  SystemUiAnrRecoveryRequiredError,
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
  accessibilityHierarchies: Array<ViewHierarchyResult | null> = [];
  tapResult = { success: true };
  tapCoordinates: Array<{ x: number; y: number }> = [];

  isConnected(): boolean {
    return this.connected;
  }

  async waitForConnection(): Promise<boolean> {
    this.connectionCalls++;
    const connected = this.connectionResults.shift() ?? false;
    this.connected = connected;
    return connected;
  }

  async verifyServiceReady(): Promise<boolean> {
    this.healthCalls++;
    return this.healthResults.shift() ?? false;
  }

  async getAccessibilityHierarchy(): Promise<ViewHierarchyResult | null> {
    return this.accessibilityHierarchies.shift() ?? null;
  }

  async requestTapCoordinates(x: number, y: number): Promise<{ success: boolean; error?: string }> {
    this.tapCoordinates.push({ x, y });
    return this.tapResult;
  }
}

class FakeAndroidManager implements ReadinessAndroidManager {
  installed = true;
  enabled = true;
  versionCompatible = true;
  setupCalls = 0;
  enableCalls = 0;
  compatibilityResult: Awaited<ReturnType<ReadinessAndroidManager["ensureCompatibleVersion"]>> = {
    status: "compatible",
  };

  async isInstalled(): Promise<boolean> {
    return this.installed;
  }

  async isEnabled(): Promise<boolean> {
    return this.enabled;
  }

  async isVersionCompatible(): Promise<boolean> {
    return this.versionCompatible;
  }

  async enable(): Promise<void> {
    this.enableCalls++;
    this.enabled = true;
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
  installed = true;
  setupResult = { success: true, message: "ready" };
  setupCalls = 0;
  startCalls = 0;
  setupSignal: AbortSignal | undefined;
  setupMinimumHealthPollDurationMs: number | undefined;
  startOptions: { signal?: AbortSignal; minimumHealthPollDurationMs?: number } | undefined;

  async isInstalled(): Promise<boolean> {
    return this.installed;
  }

  /** Optional hook to simulate elapsed provisioning time (e.g. a cold launch). */
  onStart?: () => Promise<void>;
  onSetup?: () => Promise<void>;

  async start(options?: { signal?: AbortSignal; minimumHealthPollDurationMs?: number }): Promise<void> {
    this.startCalls++;
    this.startOptions = options;
    if (this.onStart) {
      await this.onStart();
    }
  }

  async setup(
    _force?: boolean,
    _perf?: unknown,
    signal?: AbortSignal,
    minimumHealthPollDurationMs?: number,
  ) {
    this.setupCalls++;
    this.setupSignal = signal;
    this.setupMinimumHealthPollDurationMs = minimumHealthPollDurationMs;
    if (this.onSetup) {
      await this.onSetup();
    }
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
    autoAdvance?: boolean;
    awaitIosStartupMaintenance?: () => Promise<void>;
  } = {},
) {
  const timer = options.timer ?? new FakeTimer();
  if (options.autoAdvance !== false) {
    timer.enableAutoAdvance();
  }
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
      awaitIosStartupMaintenance: options.awaitIosStartupMaintenance ?? (async () => {}),
    }),
  };
}

function clearedAnrHierarchy(): ViewHierarchyResult {
  return { hierarchy: {}, windows: [] };
}

function systemUiAnrHierarchy(): ViewHierarchyResult {
  return {
    hierarchy: {},
    windows: [
      {
        windowLayer: 100,
        packageName: "com.android.systemui",
        hierarchy: {
          $: {},
          node: [
            { $: { text: "System UI isn't responding" } },
            { $: { text: "Close app" } },
            { $: { text: "Wait", bounds: "[100,200][300,260]" } },
          ],
        },
      },
    ],
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

  test("checks for a System UI ANR while runner health is failing", async () => {
    const androidClient = new FakeReadinessClient();
    androidClient.healthResults = [false, false, true];
    androidClient.accessibilityHierarchies = [
      systemUiAnrHierarchy(),
      clearedAnrHierarchy(),
      clearedAnrHierarchy(),
    ];
    const { service, androidManager } = createService({ androidClient });

    await service.ensureReady({
      device: androidDevice(),
      requestedIdentity: "platform=android name=Pixel_9_Pro",
      totalDeadlineMs: 30_000,
      readinessTimeoutMs: 30_000,
    });

    expect(androidManager.setupCalls).toBe(1);
    expect(androidClient.tapCoordinates).toEqual([{ x: 200, y: 230 }]);
    expect(androidClient.healthCalls).toBe(3);
  });

  test("treats unreadable confirmation hierarchies as an unrecovered ANR", async () => {
    const androidClient = new FakeReadinessClient();
    androidClient.healthResults = [false, false, true];
    // The dialog is present, then both post-tap confirmation reads fail. A failed
    // read must not be mistaken for a cleared dialog (#5430 review), so recovery
    // is still required rather than reported as healthy.
    androidClient.accessibilityHierarchies = [systemUiAnrHierarchy(), null, null];
    const { service } = createService({ androidClient });

    await expect(
      service.ensureReady({
        device: androidDevice(),
        requestedIdentity: "platform=android name=Pixel_9_Pro",
        totalDeadlineMs: 30_000,
        readinessTimeoutMs: 30_000,
      }),
    ).rejects.toThrow(SystemUiAnrRecoveryRequiredError);
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

  test("honors disabled downloads while still enabling an installed compatible runner", async () => {
    const androidManager = new FakeAndroidManager();
    androidManager.enabled = false;
    const androidClient = new FakeReadinessClient();
    androidClient.connected = false;
    const { service } = createService({ androidManager, androidClient });

    await service.ensureReady({
      device: androidDevice(),
      requestedIdentity: "platform=android",
      totalDeadlineMs: 30_000,
      readinessTimeoutMs: 30_000,
      skipCtrlProxyDownload: true,
    });

    expect(androidManager.enableCalls).toBe(1);
    expect(androidManager.setupCalls).toBe(0);
    expect(androidClient.healthCalls).toBe(1);
  });

  test("fails without setup when downloads are disabled and CtrlProxy is missing", async () => {
    const androidManager = new FakeAndroidManager();
    androidManager.installed = false;
    androidManager.enabled = false;
    const { service } = createService({ androidManager });

    await expect(service.ensureReady({
      device: androidDevice(),
      requestedIdentity: "platform=android",
      totalDeadlineMs: 30_000,
      readinessTimeoutMs: 30_000,
      skipCtrlProxyDownload: true,
    })).rejects.toThrow(/not installed.*downloads are disabled/);

    expect(androidManager.setupCalls).toBe(0);
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

    const error = await service.ensureReady({
        device: androidDevice(),
        requestedIdentity: "platform=android",
        totalDeadlineMs: 30_000,
        readinessTimeoutMs: 30_000,
      }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("INSTALL_FAILED_UPDATE_INCOMPATIBLE");
    expect(message).toContain("token=[REDACTED]");
    expect(message).not.toContain("top-secret");
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

  test("passes the remaining readiness budget to iOS CtrlProxy setup", async () => {
    const iosManager = new FakeIosManager();
    const iosClient = new FakeReadinessClient();
    iosClient.connected = false;
    const timer = new FakeTimer();
    const { service } = createService({
      timer,
      iosManager,
      iosClient,
      awaitIosStartupMaintenance: async () => {
        timer.advanceTime(10_000);
      },
    });

    await service.ensureReady({
      device: iosDevice,
      requestedIdentity: "platform=ios deviceId=IOS-UDID",
      totalDeadlineMs: 120_000,
      readinessTimeoutMs: 120_000,
    });

    expect(iosManager.setupMinimumHealthPollDurationMs).toBe(110_000);
    expect(iosManager.setupSignal).toBeDefined();
  });

  test("starts only the cached iOS runner when downloads are disabled", async () => {
    const iosManager = new FakeIosManager();
    const iosClient = new FakeReadinessClient();
    iosClient.connected = false;
    const { service } = createService({ iosManager, iosClient });

    await service.ensureReady({
      device: iosDevice,
      requestedIdentity: "platform=ios deviceId=IOS-UDID",
      totalDeadlineMs: 30_000,
      readinessTimeoutMs: 30_000,
      skipCtrlProxyDownload: true,
    });

    expect(iosManager.startCalls).toBe(1);
    expect(iosManager.startOptions?.minimumHealthPollDurationMs).toBe(30_000);
    expect(iosManager.startOptions?.signal).toBeDefined();
    expect(iosManager.setupCalls).toBe(0);
    expect(iosClient.healthCalls).toBe(1);
  });

  test("sizes the cold-launch health poll by the provision budget, not the health budget", async () => {
    // With a provision-class total deadline larger than the health budget, the
    // one-time cold launch runs against the total, not the 30s health window
    // (#5376). Pre-fix this was min(total, readiness) = 30_000, killing a cold
    // launch mid-flight.
    const iosManager = new FakeIosManager();
    const iosClient = new FakeReadinessClient();
    iosClient.connected = false;
    const { service } = createService({ iosManager, iosClient });

    await service.ensureReady({
      device: iosDevice,
      requestedIdentity: "platform=ios deviceId=IOS-UDID",
      totalDeadlineMs: 180_000,
      readinessTimeoutMs: 30_000,
      skipCtrlProxyDownload: true,
    });

    expect(iosManager.startOptions?.minimumHealthPollDurationMs).toBe(180_000);
  });

  test("provisions a cold iOS runner whose launch outlasts the health budget", async () => {
    const iosManager = new FakeIosManager();
    const iosClient = new FakeReadinessClient();
    iosClient.connected = false;
    const { service, timer } = createService({ iosManager, iosClient });
    // Cold launch takes 90s — longer than the 30s health budget but well within
    // the 180s provision budget. Pre-#5376 the setup phase was capped at the
    // health budget and aborted at 30s; now it runs against the total deadline.
    iosManager.onStart = async () => {
      await timer.sleep(90_000);
    };

    await service.ensureReady({
      device: iosDevice,
      requestedIdentity: "platform=ios deviceId=IOS-UDID",
      totalDeadlineMs: 180_000,
      readinessTimeoutMs: 30_000,
      skipCtrlProxyDownload: true,
    });

    expect(iosManager.startCalls).toBe(1);
    expect(iosClient.healthCalls).toBe(1);
    // The health window opened only after the launch, so we spent the launch
    // time but did not exhaust the total budget.
    expect(timer.now()).toBeGreaterThanOrEqual(90_000);
    expect(timer.now()).toBeLessThan(180_000);
  });

  test("keeps the health probe fast-fail after a long cold provision", async () => {
    const iosManager = new FakeIosManager();
    const iosClient = new FakeReadinessClient();
    iosClient.connected = false;
    iosClient.connectionResults = []; // runner launches but never answers
    const { service, timer } = createService({ iosManager, iosClient });
    iosManager.onStart = async () => {
      await timer.sleep(90_000);
    };

    await expect(
      service.ensureReady({
        device: iosDevice,
        requestedIdentity: "platform=ios deviceId=IOS-UDID",
        totalDeadlineMs: 180_000,
        readinessTimeoutMs: 1_000,
        skipCtrlProxyDownload: true,
      }),
    ).rejects.toThrow(/phase=runner-connect/);

    // The 90s launch was allowed to finish (provision budget), but the health
    // window then failed within ~1s — it did not stretch to the 180s total.
    expect(timer.now()).toBeGreaterThanOrEqual(90_000);
    expect(timer.now()).toBeLessThan(95_000);
  });

  test("fails without iOS setup when downloads are disabled and no runner is installed", async () => {
    const iosManager = new FakeIosManager();
    iosManager.installed = false;
    const iosClient = new FakeReadinessClient();
    iosClient.connected = false;
    const { service } = createService({ iosManager, iosClient });

    await expect(
      service.ensureReady({
        device: iosDevice,
        requestedIdentity: "platform=ios deviceId=IOS-UDID",
        totalDeadlineMs: 30_000,
        readinessTimeoutMs: 30_000,
        skipCtrlProxyDownload: true,
      }),
    ).rejects.toThrow(/not installed.*downloads are disabled/);

    expect(iosManager.startCalls).toBe(0);
    expect(iosManager.setupCalls).toBe(0);
  });

  test("coalesces concurrent readiness for the same device", async () => {
    const timer = new FakeTimer();
    const manager = new FakeAndroidManager();
    manager.installed = false;
    manager.enabled = false;
    manager.compatibilityResult = { status: "installed" };
    const client = new FakeReadinessClient();
    client.connected = false;
    client.healthResults = [true, true];
    let releaseSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    manager.setup = async () => {
      manager.setupCalls++;
      await setupGate;
      manager.installed = true;
      manager.enabled = true;
      return { success: true, message: "ready" };
    };
    const first = createService({
      timer,
      androidManager: manager,
      androidClient: client,
      autoAdvance: false,
    }).service;
    const second = createService({
      timer,
      androidManager: manager,
      androidClient: client,
      autoAdvance: false,
    }).service;
    const request = {
      device: androidDevice(),
      requestedIdentity: "platform=android deviceId=emulator-5554",
      totalDeadlineMs: 30_000,
      readinessTimeoutMs: 30_000,
    };

    const firstReadiness = first.ensureReady(request);
    const secondReadiness = second.ensureReady(request);
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.setupCalls).toBe(1);
    releaseSetup();
    await Promise.all([firstReadiness, secondReadiness]);
  });

  test("lets a longer-budget waiter retry after the lock owner times out", async () => {
    const timer = new FakeTimer();
    const manager = new FakeAndroidManager();
    manager.installed = false;
    manager.enabled = false;
    manager.compatibilityResult = { status: "installed" };
    let firstSetupSignal: AbortSignal | undefined;
    manager.setup = async (_force, _perf, signal) => {
      manager.setupCalls++;
      if (manager.setupCalls === 1) {
        firstSetupSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      manager.installed = true;
      manager.enabled = true;
      return { success: true, message: "ready" };
    };
    const { service } = createService({
      timer,
      androidManager: manager,
      androidClient: Object.assign(new FakeReadinessClient(), { connected: false }),
      autoAdvance: false,
    });

    const first = service.ensureReady({
      device: androidDevice(),
      requestedIdentity: "short owner",
      totalDeadlineMs: 1_000,
      readinessTimeoutMs: 1_000,
    });
    const second = service.ensureReady({
      device: androidDevice(),
      requestedIdentity: "long waiter",
      totalDeadlineMs: 10_000,
      readinessTimeoutMs: 10_000,
    });
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(1_000);

    await expect(first).rejects.toThrow(/requested=\[short owner\].*phase=runner-setup/);
    await second;
    expect(firstSetupSignal?.aborted).toBe(true);
    expect(manager.setupCalls).toBe(2);
  });

  test("aborts runner setup when its readiness deadline expires", async () => {
    const timer = new FakeTimer();
    const manager = new FakeAndroidManager();
    manager.installed = false;
    manager.enabled = false;
    manager.compatibilityResult = { status: "installed" };
    let setupSignal: AbortSignal | undefined;
    let setupSettled = false;
    manager.setup = async (_force, _perf, signal) => {
      manager.setupCalls++;
      setupSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            timer.setTimeout(() => {
              setupSettled = true;
              reject(signal.reason);
            }, 250);
          },
          { once: true },
        );
      });
      manager.installed = true;
      manager.enabled = true;
      return { success: true, message: "ready" };
    };
    const { service } = createService({ timer, androidManager: manager });

    await expect(
      service.ensureReady({
        device: androidDevice(),
        requestedIdentity: "platform=android",
        totalDeadlineMs: 1_000,
        readinessTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/readiness phase exceeded/);

    expect(setupSignal?.aborted).toBe(true);
    expect(setupSettled).toBe(true);
    expect(manager.installed).toBe(false);
    expect(manager.enabled).toBe(false);
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

  test("reconnects when the runner drops its connection after a failed health probe", async () => {
    const client = new FakeReadinessClient();
    client.healthResults = [false, true];
    const originalVerify = client.verifyServiceReady.bind(client);
    client.verifyServiceReady = async (...args) => {
      const ready = await originalVerify(...args);
      if (!ready) {
        client.connected = false;
      }
      return ready;
    };
    const { service } = createService({ androidClient: client });

    await service.ensureReady({
      device: androidDevice(),
      requestedIdentity: "platform=android",
      totalDeadlineMs: 10_000,
      readinessTimeoutMs: 10_000,
    });

    expect(client.connectionCalls).toBe(1);
    expect(client.healthCalls).toBe(2);
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
