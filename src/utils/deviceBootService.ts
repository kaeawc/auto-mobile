import type { ChildProcess } from "child_process";
import type { BootedDevice, DeviceInfo } from "../models";
import { ActionableError } from "../models";
import type {
  DeviceMatchCriteria,
  FormFactor,
  MatchingStrategy,
} from "../models/DeviceMatchCriteria";
import type { DeviceCreationGate } from "./deviceCreationGate";
import {
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  type PlatformDeviceManager,
  waitForDeviceReadyOrCancel,
} from "./deviceUtils";
import type { DeviceMatcher } from "./deviceMatcher";
import type { DeviceProvisioner } from "./deviceProvisioning";
import { NoopDeviceBootRecovery, type DeviceBootRecovery } from "./deviceBootRecovery";
import { defaultTimer, type Timer } from "./SystemTimer";
import { runWithAbortSignal } from "./AbortContext";

const ABORT_SETTLEMENT_GRACE_MS = 1_000;

/** Inputs which affect device discovery, creation, and readiness, but not MCP sessions or automation setup. */
export interface DeviceBootRequest {
  platform: "android" | "ios";
  minOsVersion?: string;
  maxOsVersion?: string;
  name?: string;
  formFactor?: FormFactor;
  screenSize?: { width: number; height: number };
  deviceId?: string;
  preferRunning?: boolean;
  timeoutMs?: number;
  /** Absolute deadline shared with higher-level automation readiness. */
  totalDeadlineMs?: number;
  signal?: AbortSignal;
  createIfMissing?: boolean;
  /** Internal CI policy: preserve OS bounds for provisioning while matching its exact owned name across runtime fallback. */
  matchNamedDeviceIgnoringOsVersion?: boolean;
}

export interface DeviceBootProgress {
  report(current: number, total: number, message: string): Promise<void>;
}

export interface DeviceBootResult {
  device: BootedDevice;
  source: "booted" | "cold-boot";
  sourceImage?: DeviceInfo;
  processHandle?: ChildProcess | null;
  processId?: number;
  provisioned: boolean;
}

export interface DeviceBootServiceDependencies {
  deviceManager: PlatformDeviceManager;
  deviceMatcher: DeviceMatcher;
  deviceCreationGate: DeviceCreationGate;
  deviceProvisioner: DeviceProvisioner;
  matchingStrategy: MatchingStrategy;
  /** Defaults to no recovery so normal product and MCP boot never erases devices. */
  bootRecovery?: DeviceBootRecovery;
  timer?: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
}

interface BootDeadlineContext {
  deadlineMs: number;
  signal?: AbortSignal;
}

interface PhaseCancellation {
  promise: Promise<never>;
  throwIfCancelled(): void;
  dispose(): void;
}

function createPhaseCancellation(signal: AbortSignal | undefined, phase: string): PhaseCancellation {
  const never = new Promise<never>(() => undefined);
  const throwIfCancelled = () => {
    if (signal?.aborted) {
      throw new ActionableError(`startDevice cancelled while ${phase}`);
    }
  };
  if (!signal || signal.aborted) {
    return { promise: never, throwIfCancelled, dispose: () => {} };
  }

  let rejectCancellation!: (error: ActionableError) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abort = () => {
    rejectCancellation(new ActionableError(`startDevice cancelled while ${phase}`));
  };
  signal.addEventListener("abort", abort, { once: true });
  return {
    promise,
    throwIfCancelled,
    dispose: () => signal.removeEventListener("abort", abort),
  };
}

/**
 * Product boot boundary shared by MCP and daemon-free callers.
 *
 * It deliberately does not create MCP sessions, update resources, or start
 * CtrlProxy. Those are application concerns layered on by `startDevice`.
 */
export class DeviceBootService {
  private readonly bootRecovery: DeviceBootRecovery;
  private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;

  constructor(private readonly dependencies: DeviceBootServiceDependencies) {
    this.bootRecovery = dependencies.bootRecovery ?? new NoopDeviceBootRecovery();
    this.timer = dependencies.timer ?? defaultTimer;
  }

  async boot(request: DeviceBootRequest, progress?: DeviceBootProgress): Promise<DeviceBootResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
    const context: BootDeadlineContext = {
      deadlineMs: request.totalDeadlineMs ?? this.timer.now() + timeoutMs,
      signal: request.signal,
    };
    if (request.deviceId) {
      return this.bootKnownDevice({ ...request, deviceId: request.deviceId }, context, progress);
    }
    return this.bootMatchingDevice(request, context, progress);
  }

  private async bootKnownDevice(
    request: DeviceBootRequest & { deviceId: string },
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult> {
    const { deviceManager } = this.dependencies;
    const booted = await this.runPhase(context, "discovering running devices", () =>
      deviceManager.getBootedDevices(request.platform),
    );
    const running = booted.find((device) => device.deviceId === request.deviceId);
    if (running) {
      return this.waitForRunningDevice(running, context, progress);
    }
    const images = await this.runPhase(context, "listing device images", () =>
      deviceManager.listDeviceImages(request.platform),
    );
    const image = images.find(
      (device) => device.deviceId === request.deviceId || device.name === request.deviceId,
    );
    if (!image) {
      throw new ActionableError(
        `Device '${request.deviceId}' not found. Available booted: ${booted.map((device) => device.deviceId).join(", ") || "none"}. ` +
          `Available images: ${images.map((device) => device.name).join(", ") || "none"}.`,
      );
    }
    return this.bootImage(image, context, progress, false);
  }

  private async bootMatchingDevice(
    request: DeviceBootRequest,
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult> {
    const { deviceManager, deviceMatcher, matchingStrategy } = this.dependencies;
    const provisionCriteria: DeviceMatchCriteria = {
      platform: request.platform,
      minOsVersion: request.minOsVersion,
      maxOsVersion: request.maxOsVersion,
      name: request.name,
      formFactor: request.formFactor,
      screenSize: request.screenSize,
    };
    const criteria = request.matchNamedDeviceIgnoringOsVersion
      ? { ...provisionCriteria, minOsVersion: undefined, maxOsVersion: undefined }
      : provisionCriteria;
    const images = await this.runPhase(context, "listing device images", () =>
      deviceManager.listDeviceImages(request.platform),
    );
    const running = await this.findRunningMatch(request, criteria, images, context, progress);
    if (running) {
      return running;
    }
    const image = deviceMatcher.matchDeviceImage(criteria, images, matchingStrategy);
    if (image) {
      return this.bootMatchedImage(image, context, progress);
    }
    return this.provisionAndBoot(request, provisionCriteria, images, context, progress);
  }

  private async findRunningMatch(
    request: DeviceBootRequest,
    criteria: DeviceMatchCriteria,
    images: DeviceInfo[],
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult | undefined> {
    if (request.preferRunning === false) {
      return undefined;
    }
    const booted = await this.runPhase(context, "discovering running devices", () =>
      this.dependencies.deviceManager.getBootedDevices(request.platform),
    );
    const match = this.dependencies.deviceMatcher.matchBootedDevice(
      criteria,
      enrichBootedDevicesFromImages(booted, images),
      this.dependencies.matchingStrategy,
    );
    if (!match) {
      return undefined;
    }
    await progress?.report(100, 100, "Found matching running device");
    return this.waitForRunningDevice(match, context, progress);
  }

  private async bootMatchedImage(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult> {
    if (!image.isRunning) {
      return this.bootImage(image, context, progress, false);
    }
    const booted = await this.runPhase(context, "resolving the running device image", () =>
      this.dependencies.deviceManager.getBootedDevices(image.platform),
    );
    const running = booted.find(
      (device) => device.deviceId === image.deviceId || device.name === image.name,
    );
    if (!running) {
      return this.bootImage(image, context, progress, false);
    }
    const result = await this.waitForRunningDevice(running, context, progress);
    return { ...result, device: enrichBootedDevice(result.device, image) };
  }

  private async provisionAndBoot(
    request: DeviceBootRequest,
    criteria: DeviceMatchCriteria,
    images: DeviceInfo[],
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult> {
    if (!this.dependencies.deviceCreationGate.isCreationAllowed(request.createIfMissing)) {
      throw new ActionableError(
        `No ${request.platform} device matching criteria found. ` +
          `${request.minOsVersion ? `minOsVersion>=${request.minOsVersion} ` : ""}` +
          `${request.maxOsVersion ? `maxOsVersion<=${request.maxOsVersion} ` : ""}` +
          `${request.name ? `name=${request.name} ` : ""}` +
          `Available images: ${images.map((device) => `${device.name}${device.osVersion ? ` (v${device.osVersion})` : ""}`).join(", ") || "none"}.`,
      );
    }
    const provisioned = await this.runPhase(context, "provisioning a device", (signal) =>
      this.dependencies.deviceProvisioner.provision(criteria, signal),
    );
    const createdImage: DeviceInfo = {
      name: provisioned.name,
      platform: provisioned.platform,
      deviceId: provisioned.deviceId,
      isRunning: false,
      formFactor: request.formFactor,
    } as DeviceInfo;
    return this.bootImage(createdImage, context, progress, true);
  }

  private async waitForRunningDevice(
    device: BootedDevice,
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult> {
    const recoveryTarget: DeviceInfo = { ...device, isRunning: true };
    let attempts = 0;
    return this.bootRecovery.run(recoveryTarget, async () => {
      attempts++;
      if (attempts > 1) {
        return this.bootImageOnce(recoveryTarget, context, progress, false);
      }
      const ready = await this.runPhase(context, "waiting for a running device", () =>
        this.dependencies.deviceManager.waitForDeviceReady(
          { ...device, isRunning: true },
          this.remaining(context.deadlineMs, "waiting for a running device"),
        ),
      );
      return { device: { ...device, ...ready }, source: "booted", provisioned: false };
    }, context.signal);
  }

  private async bootImage(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    provisioned: boolean,
  ): Promise<DeviceBootResult> {
    if (image.platform === "ios" && !image.deviceId) {
      throw new ActionableError("iOS simulator deviceId (UDID) is required to start a simulator.");
    }
    return this.bootRecovery.run(
      image,
      async () => this.bootImageOnce(image, context, progress, provisioned),
      context.signal,
    );
  }

  private async bootImageOnce(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    provisioned: boolean,
  ): Promise<DeviceBootResult> {
    const handle = await this.runPhase(context, "starting the device", async signal => {
      const started = await this.dependencies.deviceManager.startDevice(
        image,
        this.remaining(context.deadlineMs, "starting the device"),
      );
      if (signal.aborted && started) {
        started.kill();
      }
      return started;
    });
    let handleCancelled = false;
    const cancelHandle = () => {
      if (handle && !handleCancelled) {
        handleCancelled = true;
        handle.kill();
      }
    };
    context.signal?.addEventListener("abort", cancelHandle, { once: true });
    try {
      await progress?.report(60, 100, "Device started, waiting for readiness...");
      const ready = await this.runPhase(context, "waiting for device boot readiness", signal =>
        waitForDeviceReadyOrCancel(
          this.dependencies.deviceManager,
          image,
          handle,
          this.remaining(context.deadlineMs, "waiting for device boot readiness"),
          signal,
          cancelHandle,
        ),
      );
      await progress?.report(100, 100, "Device is ready for use");
      return {
        device: enrichBootedDevice(ready, image),
        source: "cold-boot",
        sourceImage: image,
        processHandle: handle,
        processId: handle?.pid,
        provisioned,
      };
    } catch (error) {
      cancelHandle();
      throw error;
    } finally {
      context.signal?.removeEventListener("abort", cancelHandle);
    }
  }

  private remaining(deadlineMs: number, phase: string): number {
    const remainingMs = Math.floor(deadlineMs - this.timer.now());
    if (remainingMs <= 0) {
      throw new ActionableError(
        `startDevice timeout exhausted while ${phase}; remainingBudgetMs=0`,
      );
    }
    return remainingMs;
  }

  private async runPhase<T>(
    context: BootDeadlineContext,
    phase: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const remainingMs = this.remaining(context.deadlineMs, phase);
    const cancellation = createPhaseCancellation(context.signal, phase);
    cancellation.throwIfCancelled();
    const controller = new AbortController();
    const signal = context.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const operationPromise = runWithAbortSignal(signal, () => operation(signal));
    void operationPromise.catch(() => {});
    try {
      return await Promise.race([
        operationPromise,
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = this.timer.setTimeout(() => {
            controller.abort(new Error(`startDevice timeout exhausted while ${phase}`));
            reject(
              new ActionableError(
                `startDevice timeout exhausted while ${phase}; remainingBudgetMs=0`,
              ),
            );
          }, remainingMs);
        }),
        cancellation.promise,
      ]);
    } catch (error) {
      cancellation.throwIfCancelled();
      if (controller.signal.aborted) {
        await this.awaitAbortSettlement(operationPromise);
        throw new ActionableError(
          `startDevice timeout exhausted while ${phase}; remainingBudgetMs=0`,
        );
      }
      throw error;
    } finally {
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
      cancellation.dispose();
    }
  }

  private async awaitAbortSettlement(operation: Promise<unknown>): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timeoutHandle = this.timer.setTimeout(resolve, ABORT_SETTLEMENT_GRACE_MS);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
    }
  }
}

export function enrichBootedDevice(device: BootedDevice, image: DeviceInfo): BootedDevice {
  return {
    ...device,
    osVersion: device.osVersion ?? image.osVersion,
    formFactor: device.formFactor ?? image.formFactor,
    screenWidth: device.screenWidth ?? image.screenWidth,
    screenHeight: device.screenHeight ?? image.screenHeight,
  };
}

export function enrichBootedDevicesFromImages(
  booted: BootedDevice[],
  images: DeviceInfo[],
): BootedDevice[] {
  const imagesById = new Map(
    images.filter((image) => image.deviceId).map((image) => [image.deviceId!, image]),
  );
  const imagesByName = new Map(images.map((image) => [image.name, image]));
  return booted.map((device) => {
    const image =
      (device.deviceId ? imagesById.get(device.deviceId) : undefined) ??
      imagesByName.get(device.name);
    return image ? enrichBootedDevice(device, image) : device;
  });
}
