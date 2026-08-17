import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "bun:test";
import { DeviceBootService, type DeviceBootProgress } from "../../src/utils/deviceBootService";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import type { DeviceMatchCriteria } from "../../src/models/DeviceMatchCriteria";
import type { DeviceBootRecovery } from "../../src/utils/deviceBootRecovery";
import type { Timer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";

const image: DeviceInfo = {
  name: "Pixel_9_API_35",
  platform: "android",
  isRunning: false,
  osVersion: "35",
};

function service(
  deviceManager: FakeDeviceUtils,
  matcher = new FakeDeviceMatcher(),
  bootRecovery?: DeviceBootRecovery,
  timer?: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
): DeviceBootService {
  return new DeviceBootService({
    deviceManager,
    deviceMatcher: matcher,
    deviceCreationGate: { isCreationAllowed: () => false, describeSource: () => "test" },
    deviceProvisioner: {
      provision: async () => {
        throw new Error("unexpected provision");
      },
    },
    matchingStrategy: "LATEST",
    bootRecovery,
    timer: timer ?? new FakeTimer(),
  });
}

describe("DeviceBootService", () => {
  it("cold-boots and awaits readiness without MCP-only side effects", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);

    const result = await service(devices, matcher).boot({ platform: "android", timeoutMs: 12_345 });

    expect(result.source).toBe("cold-boot");
    expect(result.sourceImage).toBe(image);
    expect(result.processHandle).toBe(devices.getWaitForDeviceReadyChildProcess());
    expect(result.processId).toBe(12345);
    expect(devices.getExecutedOperations()).toEqual([
      "listDeviceImages:android",
      "getBootedDevices:android",
      "startDevice:Pixel_9_API_35:12345",
      "waitForDeviceReady:Pixel_9_API_35:12345",
    ]);
  });

  it("passes only the remaining total budget to readiness after device start", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const timer = new FakeTimer();
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);
    const originalStartDevice = devices.startDevice.bind(devices);
    devices.startDevice = async (...args) => {
      const handle = await originalStartDevice(...args);
      timer.advanceTime(4_000);
      return handle;
    };

    await service(devices, matcher, undefined, timer).boot({
      platform: "android",
      timeoutMs: 10_000,
    });

    expect(devices.getExecutedOperations()).toContain("waitForDeviceReady:Pixel_9_API_35:6000");
    expect(devices.getWaitForDeviceReadySignal()).toBeDefined();
    expect(devices.getWaitForDeviceReadySignal()?.aborted).toBe(false);
  });

  it("bounds a pending start progress callback by the shared deadline and cancels its owned process", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const timer = new FakeTimer();
    let killCount = 0;
    let progressStarted = false;
    let outcome: "pending" | "rejected" = "pending";
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);
    devices.setMockChildProcess(image.name, {
      kill: () => {
        killCount++;
        return true;
      },
      pid: 12,
    } as any);

    const boot = service(devices, matcher, undefined, timer).boot(
      { platform: "android", timeoutMs: 10_000 },
      {
        report: async (current) => {
          if (current === 60) {
            progressStarted = true;
            await new Promise<void>(() => {});
          }
        },
      },
    );
    void boot.catch(() => {
      outcome = "rejected";
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(progressStarted).toBe(true);
    timer.advanceTime(10_000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(outcome).toBe("rejected");
    expect(killCount).toBe(1);
  });

  it("cancels the owned process when a pending progress callback is externally aborted", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const controller = new AbortController();
    let killCount = 0;
    let progressStarted = false;
    let outcome: "pending" | "rejected" = "pending";
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);
    devices.setMockChildProcess(image.name, {
      kill: () => {
        killCount++;
        return true;
      },
      pid: 12,
    } as any);

    const boot = service(devices, matcher).boot(
      { platform: "android", signal: controller.signal },
      {
        report: async (current) => {
          if (current === 60) {
            progressStarted = true;
            await new Promise<void>(() => {});
          }
        },
      },
    );
    void boot.catch(() => {
      outcome = "rejected";
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(progressStarted).toBe(true);
    controller.abort(new Error("request cancelled"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(outcome).toBe("rejected");
    expect(killCount).toBe(1);
  });

  it("cancels the owned process when final progress reporting fails", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    let killCount = 0;
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);
    devices.setMockChildProcess(image.name, {
      kill: () => {
        killCount++;
        return true;
      },
      pid: 12,
    } as any);

    await expect(
      service(devices, matcher).boot(
        { platform: "android" },
        {
          report: async (current) => {
            if (current === 100) {
              throw new Error("progress failed");
            }
          },
        },
      ),
    ).rejects.toThrow("progress failed");

    expect(killCount).toBe(1);
  });

  it("preserves successful cold-boot progress reporting", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const reports: Array<{ current: number; total: number; message: string }> = [];
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);

    await service(devices, matcher).boot(
      { platform: "android" },
      {
        report: async (current, total, message) => {
          reports.push({ current, total, message });
        },
      },
    );

    expect(reports).toEqual([
      { current: 60, total: 100, message: "Device started, waiting for readiness..." },
      { current: 100, total: 100, message: "Device is ready for use" },
    ]);
  });

  it("aborts provisioning at the shared absolute deadline", async () => {
    const devices = new FakeDeviceUtils();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let created = false;
    let provisionSettled = false;
    let provisionSignal: AbortSignal | undefined;
    const bootService = new DeviceBootService({
      deviceManager: devices,
      deviceMatcher: new FakeDeviceMatcher(),
      deviceCreationGate: { isCreationAllowed: () => true, describeSource: () => "test" },
      deviceProvisioner: {
        provision: async (_criteria, signal) => {
          provisionSignal = signal;
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                timer.setTimeout(() => {
                  provisionSettled = true;
                  reject(signal.reason);
                }, 250);
              },
              { once: true },
            );
          });
          created = true;
          return {
            platform: "android",
            name: "late-device",
            deviceType: "pixel",
            runtime: "android-35",
          };
        },
      },
      matchingStrategy: "LATEST",
      timer,
    });

    await expect(
      bootService.boot({
        platform: "android",
        createIfMissing: true,
        totalDeadlineMs: 1_000,
      }),
    ).rejects.toThrow(/provisioning a device.*remainingBudgetMs=0/);

    expect(provisionSignal?.aborted).toBe(true);
    expect(provisionSettled).toBe(true);
    expect(created).toBe(false);
  });

  it("preempts a non-cooperative discovery phase after external cancellation", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const controller = new AbortController();
    const running: BootedDevice = {
      name: image.name,
      platform: "android",
      deviceId: "emulator-5554",
    };
    let resolveDiscovery!: (devices: BootedDevice[]) => void;
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    const pendingDiscovery = new Promise<BootedDevice[]>((resolve) => {
      resolveDiscovery = resolve;
    });
    devices.setDeviceImages("android", [image]);
    matcher.setBootedResult(running);
    devices.getBootedDevices = async () => {
      markDiscoveryStarted();
      return pendingDiscovery;
    };

    const boot = service(devices, matcher).boot({ platform: "android", signal: controller.signal });
    await discoveryStarted;
    controller.abort();

    await expect(boot).rejects.toBe(controller.signal.reason);
    resolveDiscovery([running]);
    await Promise.resolve();

    expect(devices.wasMethodCalled("waitForDeviceReady")).toBe(false);
    expect(devices.wasMethodCalled("startDevice")).toBe(false);
  });

  it("cancels a late start handle after external cancellation", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const controller = new AbortController();
    let resolveStart!: (handle: ChildProcess | null) => void;
    let markStartStarted!: () => void;
    const startStarted = new Promise<void>((resolve) => {
      markStartStarted = resolve;
    });
    const pendingStart = new Promise<ChildProcess | null>((resolve) => {
      resolveStart = resolve;
    });
    let killCount = 0;
    const handle = {
      pid: 12,
      kill: () => {
        killCount++;
        return true;
      },
    } as ChildProcess;
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);
    devices.startDevice = async () => {
      markStartStarted();
      return pendingStart;
    };

    const boot = service(devices, matcher).boot({ platform: "android", signal: controller.signal });
    await startStarted;
    controller.abort();

    resolveStart(handle);
    await expect(boot).rejects.toBe(controller.signal.reason);
    await Promise.resolve();
    await Promise.resolve();

    expect(killCount).toBe(1);
    expect(devices.wasMethodCalled("waitForDeviceReady")).toBe(false);
  });

  it("cancels a resolved start handle when cancellation wins the phase boundary", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const controller = new AbortController();
    const abortReason = new Error("request cancelled");
    let resolveStart!: (handle: ChildProcess | null) => void;
    let markStartStarted!: () => void;
    const startStarted = new Promise<void>((resolve) => {
      markStartStarted = resolve;
    });
    const pendingStart = new Promise<ChildProcess | null>((resolve) => {
      resolveStart = resolve;
    });
    let killCount = 0;
    const handle = {
      pid: 12,
      kill: () => {
        killCount++;
        return true;
      },
    } as ChildProcess;
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);
    devices.startDevice = async () => {
      markStartStarted();
      return pendingStart;
    };

    const boot = service(devices, matcher).boot({ platform: "android", signal: controller.signal });
    await startStarted;
    resolveStart(handle);
    queueMicrotask(() => controller.abort(abortReason));

    await expect(boot).rejects.toBe(abortReason);

    expect(killCount).toBe(1);
    expect(devices.wasMethodCalled("waitForDeviceReady")).toBe(false);
  });

  it("cancels a started handle when external cancellation lands during progress reporting", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const controller = new AbortController();
    let resolveProgress!: () => void;
    let markProgressStarted!: () => void;
    const progressStarted = new Promise<void>((resolve) => {
      markProgressStarted = resolve;
    });
    const pendingProgress = new Promise<void>((resolve) => {
      resolveProgress = resolve;
    });
    let killCount = 0;
    const progress: DeviceBootProgress = {
      report: async () => {
        markProgressStarted();
        await pendingProgress;
      },
    };
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);
    devices.setMockChildProcess(image.name, {
      pid: 12,
      kill: () => {
        killCount++;
        return true;
      },
    } as ChildProcess);

    const boot = service(devices, matcher).boot(
      { platform: "android", signal: controller.signal },
      progress,
    );
    await progressStarted;
    controller.abort();
    resolveProgress();

    await expect(boot).rejects.toBe(controller.signal.reason);
    expect(killCount).toBe(1);
    expect(devices.wasMethodCalled("waitForDeviceReady")).toBe(false);
  });

  it("prevents a final progress callback from returning a cancelled cold boot", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const controller = new AbortController();
    let markFinalProgressStarted!: () => void;
    let resolveFinalProgress!: () => void;
    const finalProgressStarted = new Promise<void>((resolve) => {
      markFinalProgressStarted = resolve;
    });
    const pendingFinalProgress = new Promise<void>((resolve) => {
      resolveFinalProgress = resolve;
    });
    let killCount = 0;
    const progress: DeviceBootProgress = {
      report: async (current) => {
        if (current === 100) {
          markFinalProgressStarted();
          await pendingFinalProgress;
        }
      },
    };
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);
    devices.setMockChildProcess(image.name, {
      pid: 12,
      kill: () => {
        killCount++;
        return true;
      },
    } as ChildProcess);

    const boot = service(devices, matcher).boot(
      { platform: "android", signal: controller.signal },
      progress,
    );
    await finalProgressStarted;
    controller.abort();

    await expect(boot).rejects.toBe(controller.signal.reason);
    resolveFinalProgress();
    await Promise.resolve();

    expect(killCount).toBe(1);
  });

  it("awaits cancellation-aware provisioning before returning an external abort", async () => {
    const devices = new FakeDeviceUtils();
    const timer = new FakeTimer();
    const controller = new AbortController();
    const abortReason = new Error("request cancelled");
    let provisionSettled = false;
    let outcome: "pending" | "rejected" = "pending";
    const bootService = new DeviceBootService({
      deviceManager: devices,
      deviceMatcher: new FakeDeviceMatcher(),
      deviceCreationGate: { isCreationAllowed: () => true, describeSource: () => "test" },
      deviceProvisioner: {
        provision: async (_criteria, signal) => {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                timer.setTimeout(() => {
                  provisionSettled = true;
                  reject(signal.reason);
                }, 250);
              },
              { once: true },
            );
          });
          throw new Error("unexpected provision completion");
        },
      },
      matchingStrategy: "LATEST",
      timer,
    });

    const boot = bootService.boot({
      platform: "android",
      createIfMissing: true,
      signal: controller.signal,
    });
    void boot.catch(() => {
      outcome = "rejected";
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(abortReason);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(outcome).toBe("pending");
    timer.advanceTime(250);
    await expect(boot).rejects.toBe(abortReason);
    expect(provisionSettled).toBe(true);
  });

  it("adopts and awaits a matching running device", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const running = { name: image.name, platform: "android" as const, deviceId: "emulator-5554" };
    devices.setDeviceImages("android", [image]);
    devices.setBootedDevices("android", [running]);
    matcher.setBootedResult(running);

    const result = await service(devices, matcher).boot({ platform: "android" });

    expect(result.source).toBe("booted");
    expect(result.sourceImage).toBeUndefined();
    expect(result.processHandle).toBeUndefined();
    expect(result.processId).toBeUndefined();
    expect(devices.getExecutedOperations()).toContain("waitForDeviceReady:Pixel_9_API_35:120000");
  });

  it("cancels a failed cold boot through its launch handle", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    let killed = false;
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);
    devices.setMockChildProcess(image.name, {
      kill: () => {
        killed = true;
        return true;
      },
      pid: 12,
    } as any);
    devices.setWaitForDeviceReadyError(new Error("not ready"));

    await expect(service(devices, matcher).boot({ platform: "android" })).rejects.toThrow(
      "not ready",
    );
    expect(killed).toBe(true);
  });

  it("applies an injected recovery policy at the cold product boot boundary", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const recovered: string[] = [];
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);
    const bootRecovery: DeviceBootRecovery = {
      run: async (target, boot) => {
        recovered.push(target.name);
        return boot();
      },
    };

    await service(devices, matcher, bootRecovery).boot({ platform: "android" });

    expect(recovered).toEqual([image.name]);
  });

  it("applies an injected recovery policy while awaiting an adopted running device", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const running = { name: image.name, platform: "android" as const, deviceId: "emulator-5554" };
    const recovered: string[] = [];
    devices.setDeviceImages("android", [image]);
    devices.setBootedDevices("android", [running]);
    matcher.setBootedResult(running);
    const bootRecovery: DeviceBootRecovery = {
      run: async (target, boot) => {
        recovered.push(target.deviceId ?? target.name);
        return boot();
      },
    };

    await service(devices, matcher, bootRecovery).boot({ platform: "android" });

    expect(recovered).toEqual(["emulator-5554"]);
  });

  it("cold-boots an adopted device after recovery erases its failed readiness state", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const running = { name: image.name, platform: "android" as const, deviceId: "emulator-5554" };
    devices.setDeviceImages("android", [image]);
    devices.setBootedDevices("android", [running]);
    matcher.setBootedResult(running);
    let attempts = 0;
    const originalWaitForDeviceReady = devices.waitForDeviceReady.bind(devices);
    devices.waitForDeviceReady = async (...args) => {
      attempts++;
      if (attempts === 1) {
        throw new Error("not ready");
      }
      return originalWaitForDeviceReady(...args);
    };
    const bootRecovery: DeviceBootRecovery = {
      run: async (_target, boot) => {
        try {
          return await boot();
        } catch {
          return boot();
        }
      },
    };

    const result = await service(devices, matcher, bootRecovery).boot({
      platform: "android",
      timeoutMs: 12_345,
    });

    expect(result.source).toBe("cold-boot");
    expect(devices.getExecutedOperations()).toContain("startDevice:Pixel_9_API_35:12345");
  });

  it("preserves named CI runtime bounds when provisioning after a relaxed named match", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    let provisionCriteria: DeviceMatchCriteria | undefined;
    const bootService = new DeviceBootService({
      deviceManager: devices,
      deviceMatcher: matcher,
      deviceCreationGate: { isCreationAllowed: () => true, describeSource: () => "test" },
      deviceProvisioner: {
        provision: async (criteria) => {
          provisionCriteria = criteria;
          return {
            platform: "ios",
            name: "AutoMobile CI iPhone",
            deviceId: "CI-UDID",
            deviceType: "iPhone",
            runtime: "iOS-26-3",
          };
        },
      },
      matchingStrategy: "LATEST",
    });

    await bootService.boot({
      platform: "ios",
      name: "AutoMobile CI iPhone (com.apple.CoreSimulator.SimRuntime.iOS-26-3)",
      minOsVersion: "26.3",
      maxOsVersion: "26.3",
      matchNamedDeviceIgnoringOsVersion: true,
      createIfMissing: true,
    });

    expect(provisionCriteria).toMatchObject({ minOsVersion: "26.3", maxOsVersion: "26.3" });
  });
});
