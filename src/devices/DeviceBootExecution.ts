import type { BootedDevice, DeviceInfo } from "../models";
import { ActionableError } from "../models";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../models/BootedDeviceDiscoveryIncompleteError";
import { isEmulatorLaunchCancelledError } from "../utils/android-cmdline-tools/EmulatorLaunchCancelledError";
import { runWithAbortSignal } from "../utils/AbortContext";
import type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
import { type Timer } from "../utils/SystemTimer";
import { TransitionalWaitBudget } from "../utils/TransitionalWaitBudget";
import { resetAdbDeviceListCache } from "../utils/android-cmdline-tools/AdbClient";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { runPhaseWithSettlement } from "../utils/runPhaseWithSettlement";
import { DeviceBootTimeoutError } from "./DeviceBootTimeoutError";
import { enrichBootedDevice, findImageForBootedDevice } from "./bootedDeviceEnrichment";
import {
  awaitTerminationWithinRequest,
  terminateColdBootProcess,
  terminateOwnedEmulatorProcess,
  type OwnedTermination,
  type OwnedTerminationWait,
} from "./coldBootProcessTermination";
import type { BootDeadlineContext } from "./deviceBootContext";
import type {
  DeviceBootProgress,
  DeviceBootRequest,
  DeviceBootResult,
  DeviceBootServiceDependencies,
} from "./deviceBootService";
import { waitForDeviceReadyOrCancel, type BootedDeviceDiscoveryOptions } from "./deviceUtils";
const ABORT_SETTLEMENT_GRACE_MS = 1_000;
/** Deadline-bound discovery, launch and cleanup of processes owned by a boot. */
export class DeviceBootExecution {
  constructor(
    private readonly dependencies: DeviceBootServiceDependencies,
    private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
  ) {}

  async discoverBootedDevices(
    platform: DeviceBootRequest["platform"],
    context: BootDeadlineContext,
    phase: string,
    bypassAndroidCache = false,
    awaitAbortSettlement = true,
    presentationOrder?: BootedDeviceDiscoveryOptions["presentationOrder"],
  ): Promise<BootedDevice[]> {
    // Android completeness can only be judged from the detailed discovery
    // result (`succeededPlatforms`), so android always takes this path — a
    // plain `getBootedDevices` call cannot distinguish a transient ADB
    // failure from a genuinely empty result (#7179).
    const useDetailed = platform === "android" || presentationOrder !== undefined;
    const options: BootedDeviceDiscoveryOptions = {
      skipForeignEnrichment: true,
      ...(bypassAndroidCache ? { bypassAndroidDeviceListCache: true } : {}),
      ...(presentationOrder !== undefined ? { presentationOrder } : {}),
    };
    if (useDetailed) {
      const discovery = await this.runPhase(
        context,
        phase,
        (signal) =>
          this.dependencies.deviceManager.getBootedDevicesDetailed(platform, {
            ...options,
            signal,
          }),
        awaitAbortSettlement,
      );
      if (platform === "android" && !discovery.succeededPlatforms.has("android")) {
        throw new AndroidBootedDeviceDiscoveryIncompleteError(discovery.discoveryErrors?.android);
      }
      return discovery.devices.filter((device) => !device.foreignOwned);
    }
    return await this.runPhase(
      context,
      phase,
      () => this.dependencies.deviceManager.getBootedDevices(platform),
      awaitAbortSettlement,
    );
  }

  async enrichBootedDeviceFromImage(
    device: BootedDevice,
    context: BootDeadlineContext,
  ): Promise<{ device: BootedDevice; image: DeviceInfo | undefined }> {
    const images = await this.runPhase(
      context,
      `resolving ${device.platform} device metadata`,
      (signal) => this.dependencies.deviceManager.listDeviceImages(device.platform, signal),
    );
    const image = findImageForBootedDevice(device, images);
    return {
      device: image ? enrichBootedDevice(device, image) : device,
      image,
    };
  }

  // An unrelated emulator's shutdown can briefly hide whether this AVD is already running.
  async recheckRunningState(image: DeviceInfo, context: BootDeadlineContext): Promise<DeviceInfo> {
    if (image.platform !== "android") {
      return image;
    }
    const wait = new TransitionalWaitBudget({
      timer: this.timer,
      getSignal: () => context.signal,
      budgetMs: Math.min(5_000, Math.max(0, context.deadlineMs - this.timer.now())),
    });
    while (await wait.waitForNextAttempt()) {
      if (context.deadlineMs <= this.timer.now()) {
        break;
      }
      const images = await this.runPhase(
        context,
        "rechecking Android image running state",
        (signal) => {
          (this.dependencies.invalidateAndroidDeviceList ?? resetAdbDeviceListCache)();
          return this.dependencies.deviceManager.listDeviceImages("android", signal);
        },
      );
      const refreshed = images.find((candidate) => candidate.name === image.name);
      if (!refreshed) {
        break;
      }
      if (refreshed.isRunningStateKnown === false) {
        continue;
      }
      if (refreshed.isRunning) {
        throw new AndroidBootedDeviceDiscoveryIncompleteError(
          undefined,
          `Cannot safely cold-boot Android AVD '${image.name}': it turned out to be running. Retry the request.`,
        );
      }
      return refreshed;
    }
    return image;
  }

  async bootImageOnceWithOwnedLaunchTracking(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    provisioned: boolean,
  ): Promise<DeviceBootResult> {
    let disposeStartHandleCancellation = () => {};
    const handle = await this.runPhase(context, "starting the device", async (signal) => {
      const started = await this.startDeviceOwningCancelledLaunch(image, context);
      const cancelStarted = () => {
        if (started) {
          // No lease ordering is possible here: the phase already rejected. Still escalate so
          // a late handle that ignores SIGTERM is not left running with nothing tracking it.
          void terminateColdBootProcess(started, image.name, this.timer).confirmed.catch(
            (error: unknown) => {
              logger.warn(
                `[startDevice] Late start handle cleanup failed for ${image.name}: ${errorMessage(error)}`,
                error,
              );
            },
          );
        }
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
    let termination: Promise<OwnedTermination> | undefined;
    let cleanupWait: Promise<OwnedTerminationWait> | undefined;
    // Idempotent: the abort listener, the readiness failure path and the catch
    // block share one termination, and the two that wait share one bounded wait.
    const cancelHandle = (): Promise<OwnedTermination> => {
      if (!handle) {
        return Promise.resolve({ state: "confirmed" });
      }
      termination ??= this.terminateOwnedHandle(handle, image, context);
      return termination;
    };
    const awaitCleanup = (): Promise<OwnedTerminationWait> => {
      cleanupWait ??= this.awaitOwnedCleanup(cancelHandle(), context);
      return cleanupWait;
    };
    const cancelOnAbort = () => {
      void cancelHandle();
    };
    context.signal?.addEventListener("abort", cancelOnAbort, { once: true });
    try {
      await this.reportProgress(context, progress, 60, "Device started, waiting for readiness...");
      const ready = await this.runPhase(context, "waiting for device boot readiness", () =>
        waitForDeviceReadyOrCancel(this.dependencies.deviceManager, image, handle, {
          timeoutMs: this.remaining(context, "waiting for device boot readiness"),
          signal: context.signal,
          timer: this.timer,
          cancelOwnedBoot: async () => {
            await awaitCleanup();
          },
          createTimeoutError: () => this.timeoutError(context, "waiting for device boot readiness"),
          // A freshly-provisioned Android AVD's first boot is a genuine cold
          // boot; opt it into bounded ADB-offline recovery (#7054). Fresh state
          // arrives either from this call site (`provisioned`) or from the
          // request when a just-created device is booted by serial through
          // `bootKnownDevice` (`context.freshProvision`). A cold boot of a
          // pre-existing AVD keeps the wait-out behavior, as does any iOS boot.
          readinessOptions:
            image.platform === "android" && (provisioned || context.freshProvision === true)
              ? { freshProvision: true }
              : undefined,
        }),
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
      const wait = await awaitCleanup();
      throw annotateTerminationOutcome(error, wait, handle);
    } finally {
      context.signal?.removeEventListener("abort", cancelOnAbort);
    }
  }

  /**
   * Terminates the emulator this boot started (never an adopted one). A survivor
   * is marked on the lease and watched until its pid is gone, and that watch is
   * retained so the AVD's lifecycle lease is not handed out while it still holds
   * the AVD (#9901); the watch's liveness re-check bounds how long (#9920).
   */
  private async terminateOwnedHandle(
    handle: ChildProcess,
    image: DeviceInfo,
    context: BootDeadlineContext,
  ): Promise<OwnedTermination> {
    const outcome = await terminateOwnedEmulatorProcess(handle, image.name, this.timer, {
      markHeldByUnkillableProcess: (pid) =>
        context.lifecycleLease?.markHeldByUnkillableProcess?.(pid),
      isProcessRunning: this.dependencies.isProcessRunning,
    });
    if (outcome.state === "survived") {
      context.unconfirmedProcessExits.push(outcome.gone);
      this.dependencies.retainLeaseUntil?.(outcome.gone);
    }
    return outcome;
  }

  /**
   * Waits for the owned emulator's termination, but only while the request is
   * live. When the request is cancelled or out of budget the cleanup carries on
   * in the background and keeps the lease held (#9920), but only for a long-lived
   * owner (`cleanupMayOutliveRequest`) with a lease it can hold. A one-shot CLI
   * process, or a lease this service does not own and cannot hand the survivor
   * to, is still waited on in full.
   */
  private async awaitOwnedCleanup(
    termination: Promise<OwnedTermination>,
    context: BootDeadlineContext,
  ): Promise<OwnedTerminationWait> {
    if (!this.canHoldCleanup(context)) {
      return (await termination).state;
    }
    const wait = await awaitTerminationWithinRequest(termination, {
      timer: this.timer,
      deadlineMs: context.deadlineMs,
      signal: context.signal,
    });
    if (wait === "pending") {
      this.holdLeaseUntilSettled(termination, context);
    }
    return wait;
  }

  /**
   * Whether the cleanup of an emulator this boot started may outlive the request:
   * a long-lived owner (`cleanupMayOutliveRequest`) with a lease it can hold.
   */
  private canHoldCleanup(context: BootDeadlineContext): boolean {
    return (
      this.dependencies.cleanupMayOutliveRequest === true &&
      (context.ownsLifecycleLease || this.dependencies.retainLeaseUntil !== undefined)
    );
  }

  /**
   * Keeps the AVD's lifecycle lease held until `termination` has settled (and, for a
   * survivor, until it is finally gone): the request stopped waiting for it.
   */
  private holdLeaseUntilSettled(
    termination: Promise<OwnedTermination>,
    context: BootDeadlineContext,
  ): void {
    const settled = termination.then(
      (outcome) => (outcome.state === "survived" ? outcome.gone : undefined),
      () => undefined,
    );
    context.pendingTerminations.push(settled);
    this.dependencies.retainLeaseUntil?.(settled);
  }

  /**
   * Starts the device, and when the launch is cancelled after the emulator was
   * spawned (a cancel during its startup validation), takes the child from the
   * cancellation error: it terminates it with the same SIGTERM -> bounded wait ->
   * SIGKILL escalation as any other owned handle and holds the lease until the exit
   * is confirmed. The phase rejects on the abort regardless, so this must register
   * its hold before returning (#10075).
   */
  private async startDeviceOwningCancelledLaunch(
    image: DeviceInfo,
    context: BootDeadlineContext,
  ): Promise<ChildProcess | null> {
    try {
      return await this.dependencies.deviceManager.startDevice(
        image,
        this.remaining(context, "starting the device"),
        context.request.cameraPosterPath === undefined
          ? undefined
          : { cameraPosterPath: context.request.cameraPosterPath },
      );
    } catch (error) {
      if (isEmulatorLaunchCancelledError(error) && error.process) {
        this.ownCancelledLaunchTermination(
          this.terminateOwnedHandle(error.process, image, context),
          context,
        );
      }
      throw error;
    }
  }

  /**
   * A service that can hold the lease keeps it until the termination settles and
   * lets the phase reject at once. One that cannot (a lease it neither owns nor can
   * retain, or a one-shot owner) records the termination on the context and `boot`
   * awaits it before the failure reaches the caller, so the caller never releases its
   * lease while the child is still shutting down. A child that survives SIGKILL is the
   * one case left uncovered there, as in `awaitOwnedCleanup`: it is logged and the
   * caller's lease is released.
   */
  private ownCancelledLaunchTermination(
    termination: Promise<OwnedTermination>,
    context: BootDeadlineContext,
  ): void {
    if (this.canHoldCleanup(context)) {
      this.holdLeaseUntilSettled(termination, context);
      return;
    }
    context.unheldLaunchTermination = termination;
  }

  async reportProgress(
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

  remaining(context: BootDeadlineContext, phase: string): number {
    const remainingMs = Math.floor(context.deadlineMs - this.timer.now());
    if (remainingMs <= 0) {
      throw this.timeoutError(context, phase);
    }
    return remainingMs;
  }

  async runPhase<T>(
    context: BootDeadlineContext,
    phase: string,
    operation: (signal: AbortSignal) => Promise<T>,
    awaitAbortSettlement = true,
  ): Promise<T> {
    const remainingMs = this.remaining(context, phase);
    if (context.signal?.aborted) {
      throw new ActionableError(`startDevice cancelled while ${phase}`);
    }
    return await runPhaseWithSettlement(
      {
        timer: this.timer,
        timeoutMs: remainingMs,
        signal: context.signal,
        graceMs: ABORT_SETTLEMENT_GRACE_MS,
        label: phase,
        timeoutError: () => this.timeoutError(context, phase),
        defaultAbortError: () => new ActionableError(`startDevice cancelled while ${phase}`),
        awaitAbortSettlement,
        preferOperationFailureOnTimeout: true,
      },
      (signal) => runWithAbortSignal(signal, () => operation(signal)),
    );
  }

  private timeoutError(context: BootDeadlineContext, phase: string): DeviceBootTimeoutError {
    return new DeviceBootTimeoutError(
      context.operationName,
      phase,
      this.timer.now() - context.startedAtMs,
      Math.max(0, context.deadlineMs - context.startedAtMs),
      context.deviceLabel ?? context.request.name ?? context.request.deviceId,
    );
  }
}
function annotateTerminationOutcome(
  error: unknown,
  wait: OwnedTerminationWait,
  handle: ChildProcess | null,
): unknown {
  const pid = handle?.pid ?? "unknown";
  if (wait === "cleanup-unconfirmed") {
    return withCleanupNote(error, "Cleanup also failed: device shutdown could not be confirmed.");
  }
  if (wait === "survived") {
    return withCleanupNote(
      error,
      `Cleanup also failed: emulator process ${pid} did not exit after SIGTERM and SIGKILL, ` +
        "so its AVD stays reserved until the process is gone (its liveness is re-checked " +
        "periodically); terminate that process manually if it does not.",
    );
  }
  if (wait === "unobservable") {
    return withCleanupNote(
      error,
      `Cleanup also failed: the exit of emulator process ${pid} could not be observed, so its ` +
        "AVD was released; terminate that process manually if it is still running.",
    );
  }
  return error;
}

function withCleanupNote(error: unknown, note: string): unknown {
  if (error instanceof Error && !(error instanceof DOMException)) {
    const copy: Error = Object.create(
      Object.getPrototypeOf(error),
      Object.getOwnPropertyDescriptors(error),
    );
    Object.defineProperty(copy, "message", {
      value: `${error.message} ${note}`,
      writable: true,
      configurable: true,
    });
    return copy;
  }
  return new ActionableError(`${errorMessage(error)} ${note}`, { cause: error });
}
