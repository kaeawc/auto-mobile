import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice, DisplayRef, Posture } from "../../models";
import { RealObserveScreen } from "../observe/ObserveScreen";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import {
  parseAndroidCommittedStateIdentifier,
  parseAndroidDeviceStates,
  type AndroidDeviceState,
} from "../../utils/android-cmdline-tools/AndroidDisplayInventory";
import { IOSCtrlProxyClient, type IOSCtrlProxy } from "../observe/ios/IOSCtrlProxyClient";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { SimCtlClient, type SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { POSTURE_PANEL_ROLES, type DisplayPanel } from "../../models/DisplayPanel";
import { displayTransitions, type DisplayTransitionSink } from "../observe/DisplayTransition";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  emulatorConsoleFailureReason,
  emulatorConsoleReportsFailure,
} from "../utility/DeviceState";
import { withEpilogueWarning } from "../../utils/bestEffortEpilogue";
import { logger } from "../../utils/logger";
import { displayInventoryOutcome } from "../../models/DeviceInfo";
import {
  acquireDeviceReadinessLock,
  type DeviceReadinessLockRelease,
} from "../../utils/deviceReadinessLock";

import {
  AdbAndroidHingeAngleConsole,
  type AndroidHingeAngleConsole,
  type AndroidHingeAngleReadbackResult,
} from "./AndroidHingeAngleConsole";

export const HINGE_ANGLE_MIN_DEGREES = 0;
export const HINGE_ANGLE_MAX_DEGREES = 180;

export type RequestedPosture = Exclude<Posture, "unknown">;
export type DisplayPreset = "phone" | "unfolded" | "tablet";

interface SetPostureResultBase {
  display: DisplayRef;
  locked?: boolean;
  warnings?: string[];
}

export type SetPostureResult = SetPostureResultBase &
  (
    | {
        posture: RequestedPosture;
        hingeAngle?: never;
        observedHingeAngle?: never;
        postureReason?: never;
      }
    | { posture: Posture; hingeAngle: number; observedHingeAngle?: number; postureReason?: string }
  );

export interface SetHingeAngleOptions {
  displayPreset?: DisplayPreset;
  signal?: AbortSignal;
}

type PostureRequest =
  | { posture: RequestedPosture; hingeAngle?: never }
  | { hingeAngle: number; posture?: never };
type PostureReadBack = { posture: Posture; postureReason?: string };
type FinalPostureRequest =
  | RequestedPosture
  | {
      hingeAngle: number;
      resolvePosture(observation: Awaited<ReturnType<ObserveScreen["execute"]>>): PostureReadBack;
    };

export interface SetPostureUnsupportedResult {
  status: "unsupported";
  message: string;
}

export type SetPostureOutput = SetPostureResult | SetPostureUnsupportedResult;

export interface SetPostureDependencies {
  adbFactory?: AdbClientFactory;
  androidHingeAngleConsole?: AndroidHingeAngleConsole;
  observeFactory?: (device: BootedDevice) => ObserveScreen;
  iosClientProvider?: (device: BootedDevice) => IOSCtrlProxy;
  simctl?: Pick<SimCtl, "getDeviceInfo">;
  timer?: Timer;
  transitionSink?: DisplayTransitionSink;
}

const IOS_POSTURE_POLL_INTERVAL_MS = 250;
const IOS_POSTURE_TIMEOUT_MS = 3000;
const ANDROID_POSTURE_POLL_INTERVAL_MS = 250;
const ANDROID_POSTURE_TIMEOUT_MS = 3000;

// ADB's 15s default command budget exceeds the hinge request's 5s budget.
// Allow one such step plus the existing 3s posture verification before takeover.
const POSTURE_LOCK_WAIT_TIMEOUT_MS = 15_000 + ANDROID_POSTURE_TIMEOUT_MS;
let nextPostureToken = 0;
const latestPostureTokens = new Map<string, number>();

/** Test-only inspection: completed devices must not retain operation identities. */
export function pendingPostureOperationCountForTest(): number {
  return latestPostureTokens.size;
}

interface PostureOperation {
  signal?: AbortSignal;
  assertCurrent(): void;
}

type IosPanelMatch = "expected" | "old" | "indeterminate";

function sizeMatchesPanel(
  size: { width: number; height: number },
  panel: DisplayPanel,
  observedScale?: number,
): boolean {
  const matchesSize = (width: number, height: number): boolean =>
    (size.width === width && size.height === height) ||
    (size.width === height && size.height === width);
  if (matchesSize(panel.sizePx.width, panel.sizePx.height)) {
    return true;
  }
  const scale = panel.scale ?? observedScale;
  return (
    scale !== undefined &&
    scale > 0 &&
    matchesSize(Math.round(panel.sizePx.width / scale), Math.round(panel.sizePx.height / scale))
  );
}

function scaleFromObservation(
  observation: Awaited<ReturnType<ObserveScreen["execute"]>>,
): number | undefined {
  const pixels = observation.viewHierarchy;
  const points = observation.screenSize;
  if (!pixels?.pixelWidth || !pixels.pixelHeight || points.width <= 0 || points.height <= 0) {
    return undefined;
  }
  const longScale =
    Math.max(pixels.pixelWidth, pixels.pixelHeight) / Math.max(points.width, points.height);
  const shortScale =
    Math.min(pixels.pixelWidth, pixels.pixelHeight) / Math.min(points.width, points.height);
  return Math.abs(longScale - shortScale) < 0.01 ? longScale : undefined;
}

export function classifyIosPostureObservation(
  observation: Awaited<ReturnType<ObserveScreen["execute"]>>,
  panels: DisplayPanel[] | undefined,
  expectedRole: "cover" | "inner",
): IosPanelMatch {
  const expected = panels?.find((panel) => panel.role === expectedRole);
  const old = panels?.find(
    (panel) => panel.role === (expectedRole === "cover" ? "inner" : "cover"),
  );
  if (!expected || !old) {
    return "indeterminate";
  }
  const observedScale = scaleFromObservation(observation);
  const matchesPanel = (panel: DisplayPanel): boolean =>
    sizeMatchesPanel(observation.screenSize, panel, observedScale) &&
    (observation.display.role === "unknown" || observation.display.role === panel.role);
  if (matchesPanel(expected)) {
    return "expected";
  }
  return matchesPanel(old) ? "old" : "indeterminate";
}

async function observeIosPosture(
  observe: () => Promise<Awaited<ReturnType<ObserveScreen["execute"]>>>,
  panels: DisplayPanel[] | undefined,
  expectedRole: "cover" | "inner",
  timer: Timer,
  operation: PostureOperation,
): Promise<Awaited<ReturnType<ObserveScreen["execute"]>>> {
  const { signal, assertCurrent } = operation;
  assertCurrent();
  throwIfAborted(signal);
  const startedAt = timer.now();
  throwIfAborted(signal);
  let observation = await awaitWhileRequestIsLive(observe(), signal);
  assertCurrent();
  let match = classifyIosPostureObservation(observation, panels, expectedRole);
  while (match === "old") {
    const elapsed = timer.now() - startedAt;
    if (elapsed >= IOS_POSTURE_TIMEOUT_MS) {
      break;
    }
    throwIfAborted(signal);
    await awaitWhileRequestIsLive(
      timer.sleep(Math.min(IOS_POSTURE_POLL_INTERVAL_MS, IOS_POSTURE_TIMEOUT_MS - elapsed)),
      signal,
    );
    assertCurrent();
    throwIfAborted(signal);
    observation = await awaitWhileRequestIsLive(observe(), signal);
    assertCurrent();
    match = classifyIosPostureObservation(observation, panels, expectedRole);
  }
  if (match === "old") {
    const oldRole = expectedRole === "cover" ? "inner" : "cover";
    throw new ActionableError(
      `The iPhone Duo hinge event was accepted, but the active display is still the ${oldRole} panel after ${IOS_POSTURE_TIMEOUT_MS} ms. The simulator did not apply the posture.`,
    );
  }
  if (match === "indeterminate") {
    logger.warn(
      "[SetPosture] Could not determine the active iPhone Duo panel after the hinge event",
    );
  }
  return observation;
}

const EMULATOR_POSTURE_IDS: Partial<Record<RequestedPosture, number>> = {
  half_opened: 2,
  flipped: 4,
  tent: 5,
};
// IDs follow Android's documented `adb emu posture` order. Closed and opened
// use the dedicated fold/unfold commands; rear display is a device state:
// https://developer.android.com/blog/posts/emulator-control-for-adaptive-app-development

/**
 * `emu posture` IDs for closed/opened (same enum: 1 closed, 3 opened). Flip AVDs
 * (am-flip-6p7) answer `KO: Device is not foldable` to `emu fold`/`emu unfold` yet
 * accept `emu posture <n>`, so these are the fallback when fold/unfold is refused.
 */
const EMULATOR_FOLD_FALLBACK_POSTURE_IDS: Partial<Record<RequestedPosture, number>> = {
  closed: 1,
  opened: 3,
};
const NOT_FOLDABLE_REFUSAL = /device is not foldable/i;

const DISPLAY_PRESET_IDS: Record<DisplayPreset, number> = {
  phone: 0,
  unfolded: 1,
  tablet: 2,
};

function withWarnings(
  result: SetPostureResult,
  candidates: (string | undefined)[],
): SetPostureResult {
  const added = candidates.filter((warning): warning is string => warning !== undefined);
  return added.length === 0
    ? result
    : { ...result, warnings: [...(result.warnings ?? []), ...added] };
}

/** A committed posture whose panel has not swapped yet; panel roles come from the inventory. */
function activePanelWarning(
  requested: RequestedPosture,
  activeRole: DisplayPanel["role"],
  panels: DisplayPanel[] | undefined,
): string | undefined {
  const expectedRole = POSTURE_PANEL_ROLES.find(
    ([posture]) => posture === requested && posture !== "rear_display",
  )?.[1];
  const hasBothPanels =
    panels?.some((panel) => panel.role === "cover") &&
    panels.some((panel) => panel.role === "inner");
  if (!expectedRole || !hasBothPanels || activeRole === "unknown" || activeRole === expectedRole) {
    return undefined;
  }
  return `The device committed posture '${requested}', but the active display is still the ${activeRole} panel rather than the ${expectedRole} panel. Re-observe before acting.`;
}

function isEmulator(device: BootedDevice): boolean {
  return device.deviceId.startsWith("emulator-");
}

function validateSupportedPosture(
  requested: RequestedPosture,
  supported: Posture[],
  states?: AndroidDeviceState[],
): void {
  if (!supported.includes(requested)) {
    throw new ActionableError(
      `Posture '${requested}' is not supported by this device. Supported postures: ${supported.join(", ") || "none"}. Nothing was changed. ${states ? `Supported states: ${states.map((state) => `${state.name} (${state.identifier})`).join(", ") || "none"}. ` : ""}Select a device that reports display panels and the requested posture and retry.`,
    );
  }
}

const POSTURE_REFUSED = "The posture did not change.";

/** The console answers `OK`/`KO: <reason>` with a zero adb exit code either way. */
async function runEmulatorConsoleCommand(
  adb: ReturnType<AdbClientFactory["create"]>,
  command: string,
  refusal: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const reason = await emulatorConsoleRefusal(adb, command, signal);
  if (reason !== undefined) {
    throw new ActionableError(`The emulator console refused '${command}': ${reason}. ${refusal}`);
  }
}

/** Runs a console command; returns the refusal reason, or undefined when it answered OK. */
async function emulatorConsoleRefusal(
  adb: ReturnType<AdbClientFactory["create"]>,
  command: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const { stdout, stderr } = await awaitWhileRequestIsLive(adb.executeCommand(command), signal);
  return emulatorConsoleReportsFailure(stdout, stderr)
    ? emulatorConsoleFailureReason(stdout, stderr)
    : undefined;
}

/** The console's not-foldable refusal of `emu fold`/`emu unfold`, kept for the read-back error. */
interface NotFoldableRefusal {
  command: string;
  reason: string;
  fallback: string;
}

/**
 * `emu fold`/`emu unfold`, falling back to the numeric `emu posture` command when the
 * console says the device is not foldable (flip AVDs). Other refusals throw unchanged.
 * Returns the not-foldable refusal when the fallback ran: a flip AVD then changes posture, but a
 * plain (non-foldable) AVD accepts the command and stays put, and the read-back must say so.
 */
async function runEmulatorPostureCommand(
  adb: ReturnType<AdbClientFactory["create"]>,
  requested: RequestedPosture,
  operation: PostureOperation,
): Promise<NotFoldableRefusal | undefined> {
  const { signal, assertCurrent } = operation;
  const fallbackId = EMULATOR_FOLD_FALLBACK_POSTURE_IDS[requested];
  if (fallbackId === undefined) {
    await runEmulatorConsoleCommand(
      adb,
      `emu posture ${EMULATOR_POSTURE_IDS[requested]}`,
      POSTURE_REFUSED,
      signal,
    );
    return undefined;
  }
  const command = requested === "closed" ? "emu fold" : "emu unfold";
  const reason = await emulatorConsoleRefusal(adb, command, signal);
  if (reason === undefined) {
    return undefined;
  }
  if (!NOT_FOLDABLE_REFUSAL.test(reason)) {
    throw new ActionableError(
      `The emulator console refused '${command}': ${reason}. ${POSTURE_REFUSED}`,
    );
  }
  logger.info(
    `[SetPosture] '${command}' refused (${reason}); falling back to 'emu posture ${fallbackId}'`,
  );
  assertCurrent();
  throwIfAborted(signal);
  const fallback = `emu posture ${fallbackId}`;
  await runEmulatorConsoleCommand(adb, fallback, POSTURE_REFUSED, signal);
  return { command, reason, fallback };
}

const presetRefused = (preset: DisplayPreset): string =>
  `The posture command was accepted, but the '${preset}' display preset was not applied. ` +
  "Emulators refuse resize-display when run headless (-no-window) and when the AVD is not the Resizable profile.";

async function setEmulatorPosture(
  adb: ReturnType<AdbClientFactory["create"]>,
  requested: RequestedPosture,
  displayPreset: DisplayPreset | undefined,
  supportsRearDisplay: boolean,
  operation: PostureOperation,
): Promise<NotFoldableRefusal | undefined> {
  const { signal, assertCurrent } = operation;
  assertCurrent();
  throwIfAborted(signal);
  if (supportsRearDisplay && ["closed", "opened"].includes(requested)) {
    throwIfAborted(signal);
    await awaitWhileRequestIsLive(adb.executeCommand("shell cmd device_state state reset"), signal);
    assertCurrent();
  }
  throwIfAborted(signal);
  let presetPending = Boolean(displayPreset);
  try {
    const notFoldable = await runEmulatorPostureCommand(adb, requested, operation);
    assertCurrent();
    if (displayPreset) {
      throwIfAborted(signal);
      presetPending = false;
      await runEmulatorConsoleCommand(
        adb,
        `emu resize-display ${DISPLAY_PRESET_IDS[displayPreset]}`,
        presetRefused(displayPreset),
        signal,
      );
      assertCurrent();
    }
    return notFoldable;
  } catch (error) {
    assertCurrent();
    const cancelled = signal?.aborted;
    if (cancelled && presetPending) {
      throw new ActionableError(
        "Posture request cancelled; posture command sent, display preset not applied",
        { cause: error },
      );
    }
    throw toActionableError(
      error,
      cancelled
        ? "Posture request cancelled; device may still complete the change"
        : "Failed to set device posture",
    );
  }
}

async function setPhysicalPosture(
  adb: ReturnType<AdbClientFactory["create"]>,
  requested: RequestedPosture,
  states: AndroidDeviceState[],
  supportsOpenedReset: boolean,
  operation: PostureOperation,
): Promise<void> {
  const { signal, assertCurrent } = operation;
  assertCurrent();
  throwIfAborted(signal);
  const match = states.find((state) => state.posture === requested);
  if (!match && !(requested === "opened" && supportsOpenedReset)) {
    const supported = [...new Set(states.map((state) => state.posture))];
    validateSupportedPosture(requested, supported, states);
  }
  const command = match
    ? `shell cmd device_state state ${match.identifier}`
    : "shell cmd device_state state reset";
  if (
    (requested === "closed" || requested === "opened") &&
    match &&
    states.some((state) => state.posture === "rear_display")
  ) {
    throwIfAborted(signal);
    await awaitWhileRequestIsLive(adb.executeCommand("shell cmd device_state state reset"), signal);
    assertCurrent();
  }
  throwIfAborted(signal);
  await awaitWhileRequestIsLive(adb.executeCommand(command), signal);
  assertCurrent();
}

async function observeAndroidPosture(
  adb: ReturnType<AdbClientFactory["create"]>,
  requested: RequestedPosture,
  { states, notFoldable }: { states: AndroidDeviceState[]; notFoldable?: NotFoldableRefusal },
  timer: Timer,
  observe: () => Promise<Awaited<ReturnType<ObserveScreen["execute"]>>>,
  operation: PostureOperation,
): Promise<void> {
  const { signal, assertCurrent } = operation;
  assertCurrent();
  throwIfAborted(signal);
  const hasStateMapping = states.some((state) => state.posture === requested);
  const startedAt = timer.now();
  let actual: AndroidDeviceState | undefined;
  let observedPosture: Posture = "unknown";
  do {
    throwIfAborted(signal);
    if (hasStateMapping) {
      const { stdout } = await awaitWhileRequestIsLive(
        adb.executeCommand("shell cmd device_state state"),
        signal,
      );
      assertCurrent();
      const identifier = parseAndroidCommittedStateIdentifier(stdout);
      actual = states.find((state) => state.identifier === identifier);
      observedPosture = actual?.posture ?? "unknown";
    } else {
      // Console-only postures and reset-to-open devices need observed evidence,
      // rather than treating a missing committed-state mapping as success.
      observedPosture = (await awaitWhileRequestIsLive(observe(), signal)).display.posture;
      assertCurrent();
    }
    if (observedPosture === requested) {
      return;
    }
    const elapsed = timer.now() - startedAt;
    if (elapsed >= ANDROID_POSTURE_TIMEOUT_MS) {
      break;
    }
    throwIfAborted(signal);
    await awaitWhileRequestIsLive(
      timer.sleep(Math.min(ANDROID_POSTURE_POLL_INTERVAL_MS, ANDROID_POSTURE_TIMEOUT_MS - elapsed)),
      signal,
    );
    assertCurrent();
  } while (true);
  if (notFoldable) {
    // A non-foldable AVD refuses fold/unfold and silently accepts the numeric fallback, so the
    // posture never changes; no device_state override is involved.
    throw new ActionableError(
      `This emulator is not foldable: the console answered '${notFoldable.command}' with '${notFoldable.reason}', and the '${notFoldable.fallback}' fallback did not change the posture to '${requested}' after ${ANDROID_POSTURE_TIMEOUT_MS} ms (observed posture is '${observedPosture}'). Use a foldable or flip AVD to change posture.`,
    );
  }
  throw new ActionableError(
    `Posture command was sent, but the posture did not change to '${requested}' after ${ANDROID_POSTURE_TIMEOUT_MS} ms; ${hasStateMapping ? `committed state is ${actual ? `'${actual.posture}' (${actual.name}, ${actual.identifier})` : "unknown"}` : `observed posture is '${observedPosture}'`}. Check whether a device_state override is still active.`,
  );
}

async function readAndroidStates(
  adb: ReturnType<AdbClientFactory["create"]>,
  operation: PostureOperation,
): Promise<AndroidDeviceState[]> {
  const { signal, assertCurrent } = operation;
  assertCurrent();
  throwIfAborted(signal);
  try {
    throwIfAborted(signal);
    const { stdout } = await awaitWhileRequestIsLive(
      adb.executeCommand("shell cmd device_state print-states"),
      signal,
    );
    assertCurrent();
    return parseAndroidDeviceStates(stdout);
  } catch (error) {
    assertCurrent();
    throwIfAborted(signal);
    if (/can't find service: device_state/i.test(errorMessage(error))) {
      logger.warn(`Android device_state service is unavailable: ${errorMessage(error)}`);
      return [];
    }
    throw toActionableError(error, "Could not read Android device states");
  }
}

async function readSupportedAndroidStates(
  device: BootedDevice,
  adb: ReturnType<AdbClientFactory["create"]>,
  requested: RequestedPosture,
  operation: PostureOperation,
) {
  const { assertCurrent } = operation;
  assertCurrent();
  // Posture inventory can be useful even on AVDs with no panel inventory;
  // classifyDisplayInventory classifies panels, so use the hydration outcome.
  const inventoryPostures =
    device[displayInventoryOutcome]?.kind === "unreadable" ? undefined : device.displays?.postures;
  if (inventoryPostures) {
    validateSupportedPosture(requested, inventoryPostures);
  }
  const states = await readAndroidStates(adb, operation);
  assertCurrent();
  const supported = inventoryPostures ?? [...new Set(states.map((state) => state.posture))];
  const supportsOpenedReset = supported.some(
    (posture) => posture !== "unknown" && posture !== "opened",
  );
  if (!inventoryPostures) {
    validateSupportedPosture(
      requested,
      !isEmulator(device) && supportsOpenedReset ? [...supported, "opened"] : supported,
      states,
    );
  }
  return { states, inventoryPostures, supportsOpenedReset };
}

export class SetPosture {
  private readonly adbFactory: AdbClientFactory;
  private readonly androidHingeAngleConsole: AndroidHingeAngleConsole;
  private readonly observeFactory: (device: BootedDevice) => ObserveScreen;
  private readonly iosClientProvider: (device: BootedDevice) => IOSCtrlProxy;
  private readonly simctl?: Pick<SimCtl, "getDeviceInfo">;
  private readonly timer: Timer;
  private readonly transitionSink: DisplayTransitionSink;

  constructor(
    private readonly device: BootedDevice,
    dependencies: SetPostureDependencies = {},
  ) {
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.androidHingeAngleConsole =
      dependencies.androidHingeAngleConsole ?? new AdbAndroidHingeAngleConsole();
    this.observeFactory =
      dependencies.observeFactory ?? ((target) => new RealObserveScreen(target));
    this.iosClientProvider =
      dependencies.iosClientProvider ?? ((target) => IOSCtrlProxyClient.getInstance(target));
    this.simctl = dependencies.simctl;
    this.timer = dependencies.timer ?? defaultTimer;
    this.transitionSink = dependencies.transitionSink ?? displayTransitions;
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
    const settled = await this.observeFinalPosture(
      {
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
      },
      observe,
      observe,
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
      this.timer,
      () => {
        operation.assertCurrent();
        ObservedAndroidDisplayCache.clear(this.device.deviceId);
        return this.observeFactory(this.device).execute({ freshness: "fresh", signal });
      },
      operation,
    );
    operation.assertCurrent();

    throwIfAborted(signal);
    // A posture-only change need not produce a display push or new geometry.
    operation.assertCurrent();
    ObservedAndroidDisplayCache.clear(this.device.deviceId);
    const result = await this.observeFinalPosture(
      requested,
      // Clearing panel/posture metadata does not clear CtrlProxy's hierarchy cache.
      () => this.observeFactory(this.device).execute({ freshness: "fresh", signal }),
      () => {
        operation.assertCurrent();
        ObservedAndroidDisplayCache.clear(this.device.deviceId);
        return this.observeFactory(this.device).execute({ freshness: "fresh", signal });
      },
      operation,
    );
    operation.assertCurrent();
    return withWarnings(result, [
      activePanelWarning(requested, result.display.role, this.device.displays?.panels),
    ]);
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
      return this.device.deviceType.endsWith(".iPhone-Duo");
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
      return deviceInfo.deviceTypeIdentifier.endsWith(".iPhone-Duo");
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
