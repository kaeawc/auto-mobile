import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models";
import { RealObserveScreen } from "../observe/ObserveScreen";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import {
  parseAndroidCommittedStateIdentifier,
  type AndroidDeviceState,
} from "../../utils/android-cmdline-tools/AndroidDisplayInventory";
import { type IosCtrlProxy } from "../observe/ios/IOSCtrlProxyClient";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { isIosDuoDeviceType } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { SimCtlClient, type SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { displayTransitions, type DisplayTransitionSink } from "../observe/DisplayTransition";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";
import { errorMessage } from "../../utils/describeUnknownError";
import { withEpilogueWarning } from "../../utils/bestEffortEpilogue";
import { logger } from "../../utils/logger";
import { displayInventoryOutcome } from "../../models/DeviceInfo";
import {
  acquireDeviceReadinessLock,
  type DeviceReadinessLockRelease,
} from "../../utils/deviceReadinessLock";
import {
  defaultPostureKeyguardDismisserFactory,
  readLockBeforePostureChange,
  restoreSwipeKeyguardAfterPostureChange,
  type PostureKeyguardDismisserFactory,
} from "./PostureKeyguardRestore";
import type { DeviceLockState } from "../../models/DeviceLockState";
import {
  AdbAndroidHingeAngleConsole,
  type AndroidHingeAngleConsole,
  type AndroidHingeAngleReadbackResult,
} from "./AndroidHingeAngleConsole";
import {
  HINGE_ANGLE_MIN_DEGREES,
  HINGE_ANGLE_MAX_DEGREES,
  RequestedPosture,
  DisplayPreset,
  SetPostureResult,
  SetHingeAngleOptions,
  PostureRequest,
  PostureReadBack,
  FinalPostureRequest,
  SetPostureUnsupportedResult,
  SetPostureOutput,
  SetPostureDependencies,
  ANDROID_POSTURE_POLL_INTERVAL_MS,
  ANDROID_POSTURE_TIMEOUT_MS,
  POSTURE_LOCK_WAIT_TIMEOUT_MS,
  PostureOperation,
  classifyIosPostureObservation,
  observeIosPosture,
  withWarnings,
  activePanelWarning,
  isEmulator,
  validateSupportedPosture,
  NotFoldableRefusal,
  setEmulatorPosture,
  setPhysicalPosture,
  observeAndroidPosture,
  readAndroidStates,
  readSupportedAndroidStates,
} from "./postureCommands";
import { iosCtrlProxyClientFor } from "../observe/ios/iosCtrlProxyClientFor";
export {
  HINGE_ANGLE_MIN_DEGREES,
  HINGE_ANGLE_MAX_DEGREES,
  type RequestedPosture,
  type DisplayPreset,
  type SetPostureResult,
  type SetHingeAngleOptions,
  type SetPostureUnsupportedResult,
  type SetPostureOutput,
  type SetPostureDependencies,
  classifyIosPostureObservation,
} from "./postureCommands";

let nextPostureToken = 0;
const latestPostureTokens = new Map<string, number>();

/** Test-only inspection: completed devices must not retain operation identities. */
export function pendingPostureOperationCountForTest(): number {
  return latestPostureTokens.size;
}

export class SetPosture {
  private readonly adbFactory: AdbClientFactory;
  private readonly androidHingeAngleConsole: AndroidHingeAngleConsole;
  private readonly observeFactory: (device: BootedDevice) => ObserveScreen;
  private readonly iosClientProvider: (device: BootedDevice) => IosCtrlProxy;
  private readonly simctl?: Pick<SimCtl, "getDeviceInfo">;
  private readonly timer: Timer;
  private readonly transitionSink: DisplayTransitionSink;
  private readonly keyguardDismisserFactory: PostureKeyguardDismisserFactory;

  constructor(
    private readonly device: BootedDevice,
    dependencies: SetPostureDependencies = {},
  ) {
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.androidHingeAngleConsole =
      dependencies.androidHingeAngleConsole ?? new AdbAndroidHingeAngleConsole();
    this.observeFactory =
      dependencies.observeFactory ?? ((target) => new RealObserveScreen(target));
    this.iosClientProvider = dependencies.iosClientProvider ?? iosCtrlProxyClientFor;
    this.simctl = dependencies.simctl;
    this.timer = dependencies.timer ?? defaultTimer;
    this.transitionSink = dependencies.transitionSink ?? displayTransitions;
    this.keyguardDismisserFactory =
      dependencies.keyguardDismisserFactory ?? defaultPostureKeyguardDismisserFactory;
  }

  async execute(
    requested: RequestedPosture,
    displayPreset?: DisplayPreset,
    signal?: AbortSignal,
  ): Promise<SetPostureOutput> {
    return this.executeRequest({ posture: requested }, { displayPreset, signal });
  }

  async executeHingeAngle(
    angle: number,
    options: SetHingeAngleOptions = {},
  ): Promise<SetPostureOutput> {
    return this.executeRequest({ hingeAngle: angle }, options);
  }

  private async executeRequest(
    request: PostureRequest,
    options: SetHingeAngleOptions,
  ): Promise<SetPostureOutput> {
    const { displayPreset, signal } = options;
    throwIfAborted(signal);
    let release: DeviceReadinessLockRelease = () => {};
    let token: number | undefined;
    const operation: PostureOperation = {
      signal,
      assertCurrent: () => {
        if (token !== undefined && latestPostureTokens.get(this.device.deviceId) !== token) {
          throw new ActionableError(
            "Posture request cancelled; superseded by a later setPosture request",
          );
        }
      },
    };
    try {
      const foldability = this.resolveIosFoldability(operation);
      const iosFoldable = typeof foldability === "boolean" ? foldability : await foldability;
      operation.assertCurrent();
      throwIfAborted(signal);
      const iosAngle = this.validateRequest(request, displayPreset, iosFoldable);
      if (typeof iosAngle === "object") {
        return iosAngle;
      }
      const waitTimeout = new Error("setPosture lock wait timed out");
      try {
        release = await acquireDeviceReadinessLock(
          `setPosture:${this.device.platform}:${this.device.deviceId}`,
          {
            timer: this.timer,
            signal,
            timeoutMs: POSTURE_LOCK_WAIT_TIMEOUT_MS,
            timeoutError: () => waitTimeout,
          },
        );
      } catch (error) {
        if (error !== waitTimeout || signal?.aborted) {
          throw toActionableError(
            error,
            "Posture request cancelled; device may still complete the change",
          );
        }
        logger.warn(
          "[SetPosture] Lock wait timed out; superseding the earlier posture request",
          error,
        );
      }
      throwIfAborted(signal);
      token = ++nextPostureToken;
      latestPostureTokens.set(this.device.deviceId, token);
      const result = await this.executeValidatedRequest(
        request,
        { displayPreset, iosAngle },
        operation,
      );
      operation.assertCurrent();
      return result;
    } catch (error) {
      operation.assertCurrent();
      if (signal?.aborted) {
        throw toActionableError(
          error,
          "Posture request cancelled; device may still complete the change",
        );
      }
      throw toActionableError(error, "Failed to set device posture");
    } finally {
      if (token !== undefined && latestPostureTokens.get(this.device.deviceId) === token) {
        latestPostureTokens.delete(this.device.deviceId);
      }
      release();
    }
  }

  private executeValidatedRequest(
    request: PostureRequest,
    options: { displayPreset?: DisplayPreset; iosAngle?: number },
    operation: PostureOperation,
  ): Promise<SetPostureOutput> {
    if (request.hingeAngle !== undefined) {
      return this.device.platform === "ios"
        ? this.executeIosHingeAngle(request.hingeAngle, operation)
        : this.executeAndroidHingeAngle(request.hingeAngle, operation);
    }
    return options.iosAngle !== undefined
      ? this.executeIos(request.posture, options.iosAngle, operation)
      : this.executeAndroid(request.posture, options.displayPreset, operation);
  }

  private validateHingeAngle(
    angle: number,
    displayPreset?: DisplayPreset,
    iosFoldable = false,
  ): SetPostureUnsupportedResult | undefined {
    if (
      !Number.isFinite(angle) ||
      angle < HINGE_ANGLE_MIN_DEGREES ||
      angle > HINGE_ANGLE_MAX_DEGREES
    ) {
      throw new ActionableError(
        `hingeAngle must be finite and between ${HINGE_ANGLE_MIN_DEGREES} and ${HINGE_ANGLE_MAX_DEGREES} degrees inclusive. Nothing was changed.`,
      );
    }
    if (displayPreset !== undefined) {
      throw new ActionableError(
        "displayPreset requires posture and cannot be combined with hingeAngle. Nothing was changed.",
      );
    }
    if (this.device.platform === "ios") {
      const supported = this.validateIosPosture("opened", iosFoldable);
      if (typeof supported === "object") {
        return supported;
      }
    } else if (!isEmulator(this.device)) {
      return {
        status: "unsupported",
        message:
          "Setting a hinge angle needs the Android emulator console; physical Android devices are unsupported. Nothing was changed.",
      };
    }
    return undefined;
  }

  private async executeAndroidHingeAngle(
    angle: number,
    operation: PostureOperation,
  ): Promise<SetPostureOutput> {
    const { signal, assertCurrent } = operation;
    assertCurrent();
    const adb = this.adbFactory.create(this.device);
    const lockBefore = await readLockBeforePostureChange(adb, signal);
    assertCurrent();
    const consoleResult = await awaitWhileRequestIsLive(
      this.androidHingeAngleConsole.setHingeAngle(adb, angle, { signal }),
      signal,
    );
    assertCurrent();
    if (!consoleResult.ok) {
      return {
        status: "unsupported",
        message: `Emulator console rejected 'sensor set hinge-angle0 ${angle}': ${consoleResult.reason}. Hinge angle is best effort; the syntax is unconfirmed on real emulators. Nothing was changed.`,
      };
    }
    const angleReadBack = await this.readAndroidHingeAngle(adb, operation);
    assertCurrent();
    const warning = angleReadBack.ok
      ? Math.abs(angleReadBack.degrees - angle) > 1
        ? `Hinge angle read-back mismatch: requested ${angle} degrees but the emulator reports ${angleReadBack.degrees} degrees. The emulator console returned OK but did not apply the angle (hinge angle is best effort).`
        : undefined
      : `Could not verify hinge angle: ${angleReadBack.reason}. The emulator console accepted the request but the angle was not read back.`;
    const states = await readAndroidStates(adb, operation);
    assertCurrent();
    const readBack = await this.readAndroidHingePosture(adb, states, operation);
    assertCurrent();
    const observe = () => {
      assertCurrent();
      ObservedAndroidDisplayCache.clear(this.device.deviceId);
      return this.observeFactory(this.device).execute({ freshness: "fresh", signal });
    };
    const finalPosture: FinalPostureRequest = {
      hingeAngle: angle,
      resolvePosture: (observation) => {
        const observed = observation.display.posture;
        if (
          readBack.posture !== "unknown" &&
          observed !== "unknown" &&
          readBack.posture !== observed
        ) {
          throw new ActionableError(
            `Hinge angle command returned OK, but committed device posture '${readBack.posture}' disagrees with final observed posture '${observed}'. Re-observe the device before acting.`,
          );
        }
        return readBack;
      },
    };
    const settled = await this.settleAndroidKeyguard(
      adb,
      lockBefore,
      () => this.observeFinalPosture(finalPosture, observe, observe, operation),
      operation,
    );
    assertCurrent();
    return withEpilogueWarning(
      {
        ...settled,
        hingeAngle: angle,
        ...(angleReadBack.ok ? { observedHingeAngle: angleReadBack.degrees } : {}),
      },
      warning,
    );
  }

  private async readAndroidHingeAngle(
    adb: ReturnType<AdbClientFactory["create"]>,
    operation: PostureOperation,
  ): Promise<AndroidHingeAngleReadbackResult> {
    const { signal, assertCurrent } = operation;
    assertCurrent();
    throwIfAborted(signal);
    try {
      const result = await awaitWhileRequestIsLive(
        this.androidHingeAngleConsole.getHingeAngle(adb, { signal }),
        signal,
      );
      assertCurrent();
      throwIfAborted(signal);
      if (!result.ok) {
        logger.warn(`[SetPosture] Could not verify hinge angle: ${result.reason}`);
      }
      return result;
    } catch (error) {
      assertCurrent();
      throwIfAborted(signal);
      logger.warn(`[SetPosture] Hinge angle read-back failed: ${errorMessage(error)}`, error);
      return { ok: false, reason: errorMessage(error) };
    }
  }

  private async readAndroidHingePosture(
    adb: ReturnType<AdbClientFactory["create"]>,
    states: AndroidDeviceState[],
    operation: PostureOperation,
  ): Promise<PostureReadBack> {
    const { signal, assertCurrent } = operation;
    const startedAt = this.timer.now();
    do {
      assertCurrent();
      throwIfAborted(signal);
      try {
        const { stdout } = await awaitWhileRequestIsLive(
          adb.executeCommand("shell cmd device_state state"),
          signal,
        );
        assertCurrent();
        const identifier = parseAndroidCommittedStateIdentifier(stdout);
        const posture = states.find((state) => state.identifier === identifier)?.posture;
        if (posture && posture !== "unknown") {
          return { posture };
        }
      } catch (error) {
        assertCurrent();
        throwIfAborted(signal);
        if (!/can't find service: device_state/i.test(errorMessage(error))) {
          throw toActionableError(
            error,
            "Could not read Android posture after the hinge angle command returned OK",
          );
        }
        logger.warn(`Android device_state service is unavailable: ${errorMessage(error)}`);
        return {
          posture: "unknown",
          postureReason:
            "The hinge angle command returned OK, but the Android device_state service is unavailable.",
        };
      }
      const elapsed = this.timer.now() - startedAt;
      if (elapsed >= ANDROID_POSTURE_TIMEOUT_MS) {
        break;
      }
      await awaitWhileRequestIsLive(
        this.timer.sleep(
          Math.min(ANDROID_POSTURE_POLL_INTERVAL_MS, ANDROID_POSTURE_TIMEOUT_MS - elapsed),
        ),
        signal,
      );
      assertCurrent();
    } while (true);
    return {
      posture: "unknown",
      postureReason:
        "The hinge angle command returned OK, but no committed device state could be mapped to a known posture within 3000 ms.",
    };
  }

  private async executeIosHingeAngle(
    angle: number,
    operation: PostureOperation,
  ): Promise<SetPostureOutput> {
    const { signal, assertCurrent } = operation;
    assertCurrent();
    const client = this.iosClientProvider(this.device);
    const commands = await awaitWhileRequestIsLive(
      client.getSupportedCommands?.() ?? Promise.resolve(null),
      signal,
    );
    assertCurrent();
    if (!commands?.includes("set_hinge_angle")) {
      return {
        status: "unsupported",
        message:
          "Hinge angle requires an iOS runner re-cut/updated to advertise set_hinge_angle (#8547). Nothing was changed.",
      };
    }
    ObservedAndroidDisplayCache.clear(this.device.deviceId);
    const result = await awaitWhileRequestIsLive(client.requestSetHingeAngle(angle), signal);
    assertCurrent();
    if (!result.success) {
      throw new ActionableError(
        `Could not set iPhone Duo hinge angle: ${result.error ?? "unknown runner error"}`,
      );
    }
    this.transitionSink.notifyTransition(
      this.device.deviceId,
      "setPosture changed the iPhone Duo hinge angle",
    );
    const observe = () => this.observeFactory(this.device).execute({ freshness: "fresh", signal });
    const settled = await this.observeFinalPosture(
      {
        hingeAngle: angle,
        resolvePosture: (observation) => {
          const panel = classifyIosPostureObservation(
            observation,
            this.device.displays?.panels,
            "cover",
          );
          if (panel === "expected") {
            return { posture: "closed" };
          }
          if (panel === "old") {
            return {
              posture:
                observation.display.posture === "unknown" ? "opened" : observation.display.posture,
            };
          }
          return {
            posture: "unknown",
            postureReason:
              "The runner accepted the hinge angle, but the active iPhone Duo panel could not be determined.",
          };
        },
      },
      observe,
      observe,
      operation,
    );
    assertCurrent();
    const warning =
      result.angle === undefined
        ? "Hinge angle not verifiable: the iPhone Duo runner did not report the resulting angle."
        : Math.abs(result.angle - angle) > 1
          ? `Hinge angle read-back mismatch: requested ${angle} degrees but the iPhone Duo runner reports ${result.angle} degrees (hinge angle is best effort).`
          : undefined;
    return withEpilogueWarning(
      {
        ...settled,
        hingeAngle: angle,
        ...(result.angle !== undefined ? { observedHingeAngle: result.angle } : {}),
      },
      warning,
    );
  }

  private validateRequest(
    request: PostureRequest,
    displayPreset?: DisplayPreset,
    iosFoldable = false,
  ): number | SetPostureUnsupportedResult | undefined {
    if (request.hingeAngle !== undefined) {
      return this.validateHingeAngle(request.hingeAngle, displayPreset, iosFoldable);
    }
    const requested = request.posture;
    if (this.device.platform === "ios") {
      return this.validateIosPosture(requested, iosFoldable, displayPreset);
    }
    if (displayPreset && !isEmulator(this.device)) {
      throw new ActionableError(
        "displayPreset is supported only by the Resizable Android emulator.",
      );
    }
    // Known inventory refusals do not need the lock or send any commands.
    if (
      this.device[displayInventoryOutcome]?.kind !== "unreadable" &&
      this.device.displays?.postures
    ) {
      validateSupportedPosture(requested, this.device.displays.postures);
    }
    return undefined;
  }

  private async executeAndroid(
    requested: RequestedPosture,
    displayPreset: DisplayPreset | undefined,
    operation: PostureOperation,
  ): Promise<SetPostureResult> {
    const { signal } = operation;
    const emulator = isEmulator(this.device);
    let notFoldable: NotFoldableRefusal | undefined;
    const adb = this.adbFactory.create(this.device);
    const { states, inventoryPostures, supportsOpenedReset } = await readSupportedAndroidStates(
      this.device,
      adb,
      requested,
      operation,
    );
    operation.assertCurrent();

    const lockBefore = await readLockBeforePostureChange(adb, signal);
    operation.assertCurrent();

    if (requested === "rear_display") {
      await setPhysicalPosture(adb, requested, states, supportsOpenedReset, operation);
    } else if (emulator) {
      notFoldable = await setEmulatorPosture(
        adb,
        requested,
        displayPreset,
        states.some((state) => state.posture === "rear_display") ||
          Boolean(inventoryPostures?.includes("rear_display")),
        operation,
      );
    } else {
      await setPhysicalPosture(adb, requested, states, supportsOpenedReset, operation);
    }

    operation.assertCurrent();
    await observeAndroidPosture(
      adb,
      requested,
      { states, notFoldable },
      {
        timer: this.timer,
        observe: () => {
          operation.assertCurrent();
          ObservedAndroidDisplayCache.clear(this.device.deviceId);
          return this.observeFactory(this.device).execute({ freshness: "fresh", signal });
        },
      },
      operation,
    );
    operation.assertCurrent();

    throwIfAborted(signal);
    // A posture-only change need not produce a display push or new geometry.
    operation.assertCurrent();
    ObservedAndroidDisplayCache.clear(this.device.deviceId);
    const result = await this.settleAndroidKeyguard(
      adb,
      lockBefore,
      () =>
        this.observeFinalPosture(
          requested,
          // Clearing panel/posture metadata does not clear CtrlProxy's hierarchy cache.
          () => this.observeFactory(this.device).execute({ freshness: "fresh", signal }),
          () => {
            operation.assertCurrent();
            ObservedAndroidDisplayCache.clear(this.device.deviceId);
            return this.observeFactory(this.device).execute({ freshness: "fresh", signal });
          },
          operation,
        ),
      operation,
    );
    operation.assertCurrent();
    return withWarnings(result, [
      activePanelWarning(requested, result.display.role, this.device.displays?.panels),
    ]);
  }

  /**
   * Runs the final observation and, when the change raised a swipe keyguard on a device that was
   * unlocked, dismisses it and observes again so the result reports the restored state.
   */
  private async settleAndroidKeyguard(
    adb: ReturnType<AdbClientFactory["create"]>,
    lockBefore: DeviceLockState | null,
    finalize: () => Promise<SetPostureResult>,
    operation: PostureOperation,
  ): Promise<SetPostureResult> {
    const result = await finalize();
    operation.assertCurrent();
    const outcome = await restoreSwipeKeyguardAfterPostureChange({
      before: lockBefore,
      lockedAfter: result.locked,
      adb,
      dismisser: this.keyguardDismisserFactory(this.device, adb, this.timer),
      signal: operation.signal,
    });
    operation.assertCurrent();
    if (outcome.kind === "unchanged") {
      return result;
    }
    if (outcome.kind === "failed") {
      return withWarnings(result, [outcome.warning]);
    }
    const restored = await finalize();
    operation.assertCurrent();
    return { ...restored, keyguardDismissed: true };
  }

  private async observeFinalPosture(
    requested: FinalPostureRequest,
    observe: () => Promise<Awaited<ReturnType<ObserveScreen["execute"]>>>,
    observeRetry: () => Promise<Awaited<ReturnType<ObserveScreen["execute"]>>>,
    operation: PostureOperation,
  ): Promise<SetPostureResult> {
    const { signal, assertCurrent } = operation;
    assertCurrent();
    let observation = await awaitWhileRequestIsLive(observe(), signal);
    assertCurrent();
    // Missing provenance cannot certify freshness. Compare the full revision,
    // including iOS geometry changes, before the legitimate settle notification.
    let stale = observation.displayRevision !== this.transitionSink.revision(this.device.deviceId);
    if (stale) {
      throwIfAborted(signal);
      observation = await awaitWhileRequestIsLive(observeRetry(), signal);
      assertCurrent();
      stale = observation.displayRevision !== this.transitionSink.revision(this.device.deviceId);
    }
    throwIfAborted(signal);
    let display = observation.display;
    const readBack =
      typeof requested === "string"
        ? { posture: requested }
        : stale
          ? {
              posture: "unknown" as const,
              postureReason:
                "The final observation has stale or missing display provenance; re-observe to establish the device posture.",
            }
          : requested.resolvePosture(observation);
    if (this.device.platform === "ios") {
      assertCurrent();
      this.transitionSink.notifyTransition(
        this.device.deviceId,
        "setPosture settled on the iPhone Duo display",
      );
      if (!stale && typeof requested === "string") {
        assertCurrent();
        display = this.transitionSink.rememberIosPosture(this.device, display, requested);
      }
    }
    assertCurrent();
    return {
      ...(typeof requested === "string"
        ? { posture: requested }
        : { ...readBack, hingeAngle: requested.hingeAngle }),
      display: {
        ...display,
        // Never certify old coordinates with a newer transition's generation.
        generation: stale
          ? observation.display.generation
          : this.transitionSink.identityRevision(this.device.deviceId),
      },
      ...(observation.deviceLock ? { locked: observation.deviceLock.locked } : {}),
      ...(stale
        ? {
            warnings: [
              "The posture changed, but the returned observation predates it. Re-observe before acting.",
            ],
          }
        : {}),
    };
  }

  private resolveIosFoldability(operation: PostureOperation): boolean | Promise<boolean> {
    const { signal, assertCurrent } = operation;
    assertCurrent();
    throwIfAborted(signal);
    if (
      this.device.platform !== "ios" ||
      resolveIosDeviceKind({ deviceId: this.device.deviceId }) !== "simulator"
    ) {
      return false;
    }
    // Explicit identity wins over stale inventory; Duo panels suffice for session devices.
    if (this.device.deviceType !== undefined) {
      return isIosDuoDeviceType(this.device.deviceType);
    }
    if (
      this.device.displays?.panels.some((panel) => panel.role === "cover") &&
      this.device.displays.panels.some((panel) => panel.role === "inner")
    ) {
      return true;
    }
    return this.lookupIosFoldability(operation);
  }

  private async lookupIosFoldability(operation: PostureOperation): Promise<boolean> {
    const { signal, assertCurrent } = operation;
    try {
      // Resolve the production transport only when identity and inventory are insufficient.
      const deviceInfo = await awaitWhileRequestIsLive(
        (this.simctl ?? new SimCtlClient(this.device)).getDeviceInfo(this.device.deviceId),
        signal,
      );
      assertCurrent();
      throwIfAborted(signal);
      if (!deviceInfo?.deviceTypeIdentifier) {
        logger.warn(
          `[SetPosture] Simulator device type is unavailable for ${this.device.deviceId}`,
        );
        return false;
      }
      return isIosDuoDeviceType(deviceInfo.deviceTypeIdentifier);
    } catch (error) {
      assertCurrent();
      throwIfAborted(signal);
      logger.warn(
        `[SetPosture] Failed to resolve simulator foldability: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }

  private validateIosPosture(
    requested: RequestedPosture,
    foldable: boolean,
    displayPreset?: DisplayPreset,
  ): number | SetPostureUnsupportedResult {
    if (resolveIosDeviceKind({ deviceId: this.device.deviceId }) !== "simulator") {
      return {
        status: "unsupported",
        message: "Physical iOS hinge posture can only be read, not set.",
      };
    }
    if (!foldable) {
      return { status: "unsupported", message: "This iOS simulator is not a foldable device." };
    }
    if (displayPreset) {
      throw new ActionableError("displayPreset is not supported on iOS simulators.");
    }
    const angles: Partial<Record<RequestedPosture, number>> = {
      closed: 0,
      half_opened: 130,
      opened: 180,
    };
    const angle = angles[requested];
    if (angle === undefined) {
      throw new ActionableError(
        `Posture '${requested}' is not supported by the iPhone Duo. Supported postures: closed, half_opened, opened.`,
      );
    }
    return angle;
  }

  private async executeIos(
    requested: RequestedPosture,
    angle: number,
    operation: PostureOperation,
  ): Promise<SetPostureOutput> {
    const { signal, assertCurrent } = operation;
    assertCurrent();
    ObservedAndroidDisplayCache.clear(this.device.deviceId);
    const result = await awaitWhileRequestIsLive(
      this.iosClientProvider(this.device).requestSetHingeAngle(angle),
      signal,
    );
    assertCurrent();
    if (!result.success) {
      throw new ActionableError(
        `Could not set iPhone Duo posture: ${result.error ?? "unknown runner error"}`,
      );
    }
    assertCurrent();
    this.transitionSink.notifyTransition(
      this.device.deviceId,
      "setPosture changed the iPhone Duo hinge angle",
    );
    const expectedRole = requested === "closed" ? "cover" : "inner";
    const observe = () =>
      observeIosPosture(
        () => this.observeFactory(this.device).execute({ freshness: "fresh", signal }),
        this.device.displays?.panels,
        expectedRole,
        this.timer,
        operation,
      );
    const settled = await this.observeFinalPosture(requested, observe, observe, operation);
    assertCurrent();
    return settled;
  }
}
