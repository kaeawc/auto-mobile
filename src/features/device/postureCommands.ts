import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice, DisplayRef, Posture } from "../../models";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import { type AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import {
  parseAndroidCommittedStateIdentifier,
  parseAndroidDeviceStates,
  type AndroidDeviceState,
} from "../../utils/android-cmdline-tools/AndroidDisplayInventory";
import { type IosCtrlProxy } from "../observe/ios/IOSCtrlProxyClient";
import { type SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { type Timer } from "../../utils/SystemTimer";
import { POSTURE_PANEL_ROLES, type DisplayPanel } from "../../models/DisplayPanel";
import { type DisplayTransitionSink } from "../observe/DisplayTransition";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  emulatorConsoleFailureReason,
  emulatorConsoleReportsFailure,
} from "../utility/DeviceState";
import { logger } from "../../utils/logger";
import { displayInventoryOutcome } from "../../models/DeviceInfo";
import { type PostureKeyguardDismisserFactory } from "./PostureKeyguardRestore";
import { type AndroidHingeAngleConsole } from "./AndroidHingeAngleConsole";

export const HINGE_ANGLE_MIN_DEGREES = 0;

export const HINGE_ANGLE_MAX_DEGREES = 180;

export type RequestedPosture = Exclude<Posture, "unknown">;

export type DisplayPreset = "phone" | "unfolded" | "tablet";

interface SetPostureResultBase {
  display: DisplayRef;
  locked?: boolean;
  /** Android: the posture change raised a swipe keyguard on an unlocked device and it was dismissed. */
  keyguardDismissed?: true;
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

export type PostureRequest =
  | { posture: RequestedPosture; hingeAngle?: never }
  | { hingeAngle: number; posture?: never };

export type PostureReadBack = { posture: Posture; postureReason?: string };

export type FinalPostureRequest =
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
  iosClientProvider?: (device: BootedDevice) => IosCtrlProxy;
  simctl?: Pick<SimCtl, "getDeviceInfo">;
  timer?: Timer;
  transitionSink?: DisplayTransitionSink;
  keyguardDismisserFactory?: PostureKeyguardDismisserFactory;
}

const IOS_POSTURE_POLL_INTERVAL_MS = 250;

const IOS_POSTURE_TIMEOUT_MS = 3000;

export const ANDROID_POSTURE_POLL_INTERVAL_MS = 250;

export const ANDROID_POSTURE_TIMEOUT_MS = 3000;

// ADB's 15s default command budget exceeds the hinge request's 5s budget.
// Allow one such step plus the existing 3s posture verification before takeover.
export const POSTURE_LOCK_WAIT_TIMEOUT_MS = 15_000 + ANDROID_POSTURE_TIMEOUT_MS;

export interface PostureOperation {
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

export async function observeIosPosture(
  observe: () => Promise<Awaited<ReturnType<ObserveScreen["execute"]>>>,
  panels: DisplayPanel[] | undefined,
  expectedRole: "cover" | "inner",
  { timer, operation }: { timer: Timer; operation: PostureOperation },
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

export function withWarnings(
  result: SetPostureResult,
  candidates: (string | undefined)[],
): SetPostureResult {
  const added = candidates.filter((warning): warning is string => warning !== undefined);
  return added.length === 0
    ? result
    : { ...result, warnings: [...(result.warnings ?? []), ...added] };
}

/** A committed posture whose panel has not swapped yet; panel roles come from the inventory. */
export function activePanelWarning(
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

export function isEmulator(device: BootedDevice): boolean {
  return device.deviceId.startsWith("emulator-");
}

export function validateSupportedPosture(
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
export interface NotFoldableRefusal {
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

export async function setEmulatorPosture(
  adb: ReturnType<AdbClientFactory["create"]>,
  requested: RequestedPosture,
  displayPreset: DisplayPreset | undefined,
  { supportsRearDisplay, operation }: { supportsRearDisplay: boolean; operation: PostureOperation },
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

export async function setPhysicalPosture(
  adb: ReturnType<AdbClientFactory["create"]>,
  requested: RequestedPosture,
  states: AndroidDeviceState[],
  { supportsOpenedReset, operation }: { supportsOpenedReset: boolean; operation: PostureOperation },
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

export async function observeAndroidPosture(
  adb: ReturnType<AdbClientFactory["create"]>,
  requested: RequestedPosture,
  { states, notFoldable }: { states: AndroidDeviceState[]; notFoldable?: NotFoldableRefusal },
  {
    timer,
    observe,
    operation,
  }: {
    timer: Timer;
    observe: () => Promise<Awaited<ReturnType<ObserveScreen["execute"]>>>;
    operation: PostureOperation;
  },
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

export async function readAndroidStates(
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

export async function readSupportedAndroidStates(
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
