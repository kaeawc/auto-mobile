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
import type { DeviceProvisioner, DeviceProvisioningIdentityHooks } from "./deviceProvisioning";
import { NoopDeviceBootRecovery, type DeviceBootRecovery } from "./deviceBootRecovery";
import { defaultTimer, type Timer } from "./SystemTimer";
import { runWithAbortSignal } from "./AbortContext";
import type { StableVirtualDeviceIdentity } from "./virtualDeviceLifecycleCoordinator";
import {
  getVirtualDeviceLifecycleCoordinator,
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
} from "./virtualDeviceLifecycleCoordinator";
import { stableStringify } from "./stableStringify";

const ABORT_SETTLEMENT_GRACE_MS = 1_000;

/**
 * True for an `AbortSignal.reason` that carries no caller-supplied context: a
 * literal `undefined` (used by synthetic/fake signals in tests), or the
 * platform's own default `DOMException` that `AbortController.abort()`
 * synthesizes when called with no argument (`name: "AbortError"`).
 *
 * A bare `abort()` never leaves `reason` as `undefined` on a real
 * `AbortSignal` — the runtime fills in that default `DOMException` — so this
 * is the actual signal a generic/unlabeled external cancellation needs to be
 * detected by. An explicit `abort(null)` deliberately stays "not default":
 * `null !== undefined` and `null` is not a `DOMException`, so a caller who
 * explicitly cancels with a `null` reason still gets that reason back as-is.
 * Any other explicit reason (`Error`, `DeviceLostError`, string, etc.) is
 * likewise left untouched — only this platform sentinel is relabeled with
 * boot-phase context (issue #5394).
 */
function isDefaultAbortReason(reason: unknown): boolean {
  return reason === undefined || (reason instanceof DOMException && reason.name === "AbortError");
}

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
  /** Internal identity policy: select a named runtime only when its name is an exact match. */
  matchExactName?: boolean;
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
  /** Bind a selector reservation to canonical identity before mutating the device. */
  onIdentityResolved?: (identity: StableVirtualDeviceIdentity) => Promise<void>;
  lifecycleCoordinator?: VirtualDeviceLifecycleCoordinator;
  /** Existing lease held by a caller through later session/readiness work. */
  lifecycleLease?: VirtualDeviceLifecycleLease;
}

interface BootDeadlineContext {
  deadlineMs: number;
  signal?: AbortSignal;
  lifecycleLease?: VirtualDeviceLifecycleLease;
  ownsLifecycleLease: boolean;
}

interface PhaseCancellation {
  promise: Promise<never>;
  throwIfCancelled(): void;
  dispose(): void;
}

function createPhaseCancellation(
  signal: AbortSignal | undefined,
  phase: string,
): PhaseCancellation {
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
  private readonly lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;

  constructor(private readonly dependencies: DeviceBootServiceDependencies) {
    this.bootRecovery = dependencies.bootRecovery ?? new NoopDeviceBootRecovery();
    this.timer = dependencies.timer ?? defaultTimer;
    this.lifecycleCoordinator =
      dependencies.lifecycleCoordinator ??
      (dependencies.timer
        ? new InMemoryVirtualDeviceLifecycleCoordinator(dependencies.timer)
        : getVirtualDeviceLifecycleCoordinator());
  }

  async boot(request: DeviceBootRequest, progress?: DeviceBootProgress): Promise<DeviceBootResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
    const context: BootDeadlineContext = {
      deadlineMs: request.totalDeadlineMs ?? this.timer.now() + timeoutMs,
      signal: request.signal,
      lifecycleLease: this.dependencies.lifecycleLease,
      ownsLifecycleLease: false,
    };
    if (!context.lifecycleLease && !this.dependencies.onIdentityResolved) {
      context.lifecycleLease = await this.lifecycleCoordinator.reserve(
        {
          kind: "selector",
          platform: request.platform,
          selector: stableStringify({
            deviceId: request.deviceId,
            name: request.name,
            minOsVersion: request.minOsVersion,
            maxOsVersion: request.maxOsVersion,
            formFactor: request.formFactor,
            screenSize: request.screenSize,
          }),
        },
        {
          operation: "start",
          deadlineMs: context.deadlineMs,
          signal: request.signal,
        },
      );
      context.ownsLifecycleLease = true;
      context.signal = request.signal
        ? AbortSignal.any([request.signal, context.lifecycleLease.signal])
        : context.lifecycleLease.signal;
    }
    try {
      if (request.deviceId) {
        return await this.bootKnownDevice(
          { ...request, deviceId: request.deviceId },
          context,
          progress,
        );
      }
      return await this.bootMatchingDevice(request, context, progress);
    } finally {
      if (context.ownsLifecycleLease) {
        context.lifecycleLease?.release();
      }
    }
  }

  private async bindLifecycleIdentity(
    context: BootDeadlineContext,
    identity: StableVirtualDeviceIdentity,
  ): Promise<void> {
    if (context.lifecycleLease) {
      await context.lifecycleLease.bindCanonicalIdentity(identity);
    }
    await this.dependencies.onIdentityResolved?.(identity);
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
    const image =
      request.matchExactName && request.name
        ? (images.find((candidate) => candidate.name === request.name) ?? null)
        : deviceMatcher.matchDeviceImage(criteria, images, matchingStrategy);
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
    const booted = await this.runPhase(
      context,
      "discovering running devices",
      () => this.dependencies.deviceManager.getBootedDevices(request.platform),
      false,
    );
    const enriched = enrichBootedDevicesFromImages(booted, images);
    const match =
      request.matchExactName && request.name
        ? (enriched.find((candidate) => candidate.name === request.name) ?? null)
        : this.dependencies.deviceMatcher.matchBootedDevice(
            criteria,
            enriched,
            this.dependencies.matchingStrategy,
          );
    if (!match) {
      return undefined;
    }
    await this.reportProgress(context, progress, 100, "Found matching running device");
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
    const result = await this.waitForRunningDevice(
      enrichBootedDevice(running, image),
      context,
      progress,
    );
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
    const identityHooks: DeviceProvisioningIdentityHooks = {
      reserveBeforeCreate: async (identity) => {
        if (identity.platform === "android") {
          await this.bindLifecycleIdentity(context, {
            platform: "android",
            stableId: identity.name,
          });
        }
        return context.signal;
      },
      bindAfterCreate: async (device) => {
        if (device.platform === "ios") {
          if (!device.deviceId) {
            throw new ActionableError(
              `Created iOS simulator '${device.name}' has no lifecycle identity.`,
            );
          }
          await this.bindLifecycleIdentity(context, {
            platform: "ios",
            stableId: device.deviceId,
          });
        }
      },
    };
    const provisioned = await this.runPhase(context, "provisioning a device", (signal) =>
      this.dependencies.deviceProvisioner.provision(criteria, signal, identityHooks),
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
    if (device.platform === "ios") {
      await this.bindLifecycleIdentity(context, {
        platform: "ios",
        stableId: device.deviceId,
      });
    } else if (
      device.deviceId.startsWith("emulator-") &&
      device.name !== `Unknown (${device.deviceId})`
    ) {
      await this.bindLifecycleIdentity(context, {
        platform: "android",
        stableId: device.name,
      });
    }
    const recoveryTarget: DeviceInfo = { ...device, isRunning: true };
    let attempts = 0;
    return this.bootRecovery.run(
      recoveryTarget,
      async () => {
        attempts++;
        if (attempts > 1) {
          return this.bootImageOnce(recoveryTarget, context, progress, false);
        }
        const ready = await this.runPhase(context, "waiting for a running device", (signal) =>
          this.dependencies.deviceManager.waitForDeviceReady(
            { ...device, isRunning: true },
            this.remaining(context.deadlineMs, "waiting for a running device"),
            undefined,
            signal,
          ),
        );
        return { device: { ...device, ...ready }, source: "booted", provisioned: false };
      },
      context.signal,
    );
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
    await this.bindLifecycleIdentity(context, {
      platform: image.platform,
      stableId: image.platform === "android" ? image.name : image.deviceId!,
    });
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
    let disposeStartHandleCancellation = () => {};
    const handle = await this.runPhase(context, "starting the device", async (signal) => {
      const started = await this.dependencies.deviceManager.startDevice(
        image,
        this.remaining(context.deadlineMs, "starting the device"),
      );
      const cancelStarted = () => {
        started?.kill();
      };
      if (signal.aborted) {
        cancelStarted();
      } else {
        signal.addEventListener("abort", cancelStarted, { once: true });
        disposeStartHandleCancellation = () => signal.removeEventListener("abort", cancelStarted);
      }
      return started;
    });
    disposeStartHandleCancellation();
    let handleCancelled = false;
    const cancelHandle = () => {
      if (handle && !handleCancelled) {
        handleCancelled = true;
        handle.kill();
      }
    };
    context.signal?.addEventListener("abort", cancelHandle, { once: true });
    try {
      await this.reportProgress(context, progress, 60, "Device started, waiting for readiness...");
      const ready = await this.runPhase(context, "waiting for device boot readiness", (signal) =>
        waitForDeviceReadyOrCancel(
          this.dependencies.deviceManager,
          image,
          handle,
          this.remaining(context.deadlineMs, "waiting for device boot readiness"),
          signal,
          this.timer,
          cancelHandle,
        ),
      );
      await this.reportProgress(context, progress, 100, "Device is ready for use");
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

  private async reportProgress(
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    current: number,
    message: string,
  ): Promise<void> {
    if (!progress) {
      return;
    }
    await this.runPhase(
      context,
      `reporting ${current}% device boot progress`,
      () => progress.report(current, 100, message),
      false,
    );
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
    awaitAbortSettlement = true,
  ): Promise<T> {
    const remainingMs = this.remaining(context.deadlineMs, phase);
    const cancellation = createPhaseCancellation(context.signal, phase);
    cancellation.throwIfCancelled();
    const controller = new AbortController();
    const externalSignal = context.signal;
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let removeExternalAbortListener: (() => void) | undefined;
    const externalAbortPromise = externalSignal
      ? new Promise<never>((_resolve, reject) => {
          const rejectForAbort = () => {
            reject(
              isDefaultAbortReason(externalSignal.reason)
                ? new ActionableError(`startDevice request cancelled while ${phase}`)
                : externalSignal.reason,
            );
          };
          if (externalSignal.aborted) {
            rejectForAbort();
            return;
          }
          externalSignal.addEventListener("abort", rejectForAbort, { once: true });
          removeExternalAbortListener = () =>
            externalSignal.removeEventListener("abort", rejectForAbort);
        })
      : undefined;
    let operationFailureRecorded = false;
    let operationFailure: unknown;
    const operationPromise = runWithAbortSignal(signal, () => operation(signal)).catch((error) => {
      operationFailureRecorded = true;
      operationFailure = error;
      throw error;
    });
    void operationPromise.catch(() => {});
    try {
      return await Promise.race([
        operationPromise,
        ...(externalAbortPromise ? [externalAbortPromise] : []),
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
      await this.awaitAbortSettlementIfNeeded(
        operationPromise,
        awaitAbortSettlement && (controller.signal.aborted || externalSignal?.aborted === true),
      );
      this.throwExternalAbortReason(externalSignal, phase);
      cancellation.throwIfCancelled();
      if (controller.signal.aborted) {
        throw this.phaseTimeoutFailure(
          controller,
          operationFailureRecorded,
          operationFailure,
          phase,
        );
      }
      throw error;
    } finally {
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
      cancellation.dispose();
      removeExternalAbortListener?.();
    }
  }

  private phaseTimeoutFailure(
    controller: AbortController,
    operationFailureRecorded: boolean,
    operationFailure: unknown,
    phase: string,
  ): unknown {
    if (operationFailureRecorded && operationFailure !== controller.signal.reason) {
      return operationFailure;
    }
    return new ActionableError(`startDevice timeout exhausted while ${phase}; remainingBudgetMs=0`);
  }

  private throwExternalAbortReason(signal: AbortSignal | undefined, phase: string): void {
    if (signal?.aborted) {
      if (isDefaultAbortReason(signal.reason)) {
        throw new ActionableError(`startDevice cancelled while ${phase}`);
      }
      throw signal.reason;
    }
  }

  private async awaitAbortSettlementIfNeeded(
    operation: Promise<unknown>,
    shouldAwait: boolean,
  ): Promise<void> {
    if (shouldAwait) {
      await this.awaitAbortSettlement(operation);
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
