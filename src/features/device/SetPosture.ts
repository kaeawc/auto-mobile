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
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { DisplayPanel } from "../../models/DisplayPanel";
import { displayTransitions, type DisplayTransitionSink } from "../observe/DisplayTransition";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

export type RequestedPosture = Exclude<Posture, "unknown">;
export type DisplayPreset = "phone" | "unfolded" | "tablet";

export interface SetPostureResult {
  posture: RequestedPosture;
  display: DisplayRef;
  locked?: boolean;
}

export interface SetPostureUnsupportedResult {
  status: "unsupported";
  message: string;
}

export type SetPostureOutput = SetPostureResult | SetPostureUnsupportedResult;

export interface SetPostureDependencies {
  adbFactory?: AdbClientFactory;
  observeFactory?: (device: BootedDevice) => ObserveScreen;
  iosClientProvider?: (device: BootedDevice) => IOSCtrlProxy;
  timer?: Timer;
  transitionSink?: DisplayTransitionSink;
}

const IOS_POSTURE_POLL_INTERVAL_MS = 250;
const IOS_POSTURE_TIMEOUT_MS = 3000;
const ANDROID_POSTURE_POLL_INTERVAL_MS = 250;
const ANDROID_POSTURE_TIMEOUT_MS = 3000;

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
): Promise<Awaited<ReturnType<ObserveScreen["execute"]>>> {
  const startedAt = timer.now();
  let observation = await observe();
  let match = classifyIosPostureObservation(observation, panels, expectedRole);
  while (match === "old") {
    const elapsed = timer.now() - startedAt;
    if (elapsed >= IOS_POSTURE_TIMEOUT_MS) {
      break;
    }
    await timer.sleep(Math.min(IOS_POSTURE_POLL_INTERVAL_MS, IOS_POSTURE_TIMEOUT_MS - elapsed));
    observation = await observe();
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

const DISPLAY_PRESET_IDS: Record<DisplayPreset, number> = {
  phone: 0,
  unfolded: 1,
  tablet: 2,
};

function isEmulator(device: BootedDevice): boolean {
  return device.deviceId.startsWith("emulator-");
}

function validateInventoryPosture(device: BootedDevice, requested: RequestedPosture): void {
  const supported = device.displays?.postures;
  if (supported && !supported.includes(requested)) {
    throw new ActionableError(
      `Posture '${requested}' is not supported by this device. Supported postures: ${supported.join(", ")}.`,
    );
  }
}

async function setEmulatorPosture(
  adb: ReturnType<AdbClientFactory["create"]>,
  requested: RequestedPosture,
  displayPreset?: DisplayPreset,
  supportsRearDisplay = false,
): Promise<void> {
  if ((requested === "closed" || requested === "opened") && supportsRearDisplay) {
    await adb.executeCommand("shell cmd device_state state reset");
  }
  const command =
    requested === "closed"
      ? "emu fold"
      : requested === "opened"
        ? "emu unfold"
        : `emu posture ${EMULATOR_POSTURE_IDS[requested]}`;
  await adb.executeCommand(command);
  if (displayPreset) {
    await adb.executeCommand(`emu resize-display ${DISPLAY_PRESET_IDS[displayPreset]}`);
  }
}

async function setPhysicalPosture(
  adb: ReturnType<AdbClientFactory["create"]>,
  requested: RequestedPosture,
  states: AndroidDeviceState[],
): Promise<void> {
  const match = states.find((state) => state.posture === requested);
  if (!match && requested !== "opened") {
    const supported = [...new Set(states.map((state) => state.posture))];
    throw new ActionableError(
      `Posture '${requested}' is not supported by this device. Supported postures: ${supported.join(", ") || "none"}.`,
    );
  }
  const command = match
    ? `shell cmd device_state state ${match.identifier}`
    : "shell cmd device_state state reset";
  if (
    (requested === "closed" || requested === "opened") &&
    match &&
    states.some((state) => state.posture === "rear_display")
  ) {
    await adb.executeCommand("shell cmd device_state state reset");
  }
  await adb.executeCommand(command);
}

async function observeAndroidPosture(
  adb: ReturnType<AdbClientFactory["create"]>,
  requested: RequestedPosture,
  states: AndroidDeviceState[],
  timer: Timer,
): Promise<void> {
  if (states.length === 0 || !states.some((state) => state.posture === requested)) {
    return;
  }
  const startedAt = timer.now();
  let actual: AndroidDeviceState | undefined;
  do {
    const { stdout } = await adb.executeCommand("shell cmd device_state state");
    const identifier = parseAndroidCommittedStateIdentifier(stdout);
    actual = states.find((state) => state.identifier === identifier);
    if (actual?.posture === requested) {
      return;
    }
    const elapsed = timer.now() - startedAt;
    if (elapsed >= ANDROID_POSTURE_TIMEOUT_MS) {
      break;
    }
    await timer.sleep(
      Math.min(ANDROID_POSTURE_POLL_INTERVAL_MS, ANDROID_POSTURE_TIMEOUT_MS - elapsed),
    );
  } while (true);
  throw new ActionableError(
    `Android posture did not reach '${requested}' after ${ANDROID_POSTURE_TIMEOUT_MS} ms; committed state is ${actual ? `'${actual.posture}' (${actual.name}, ${actual.identifier})` : "unknown"}. Check whether a device_state override is still active.`,
  );
}

async function readAndroidStates(
  adb: ReturnType<AdbClientFactory["create"]>,
): Promise<AndroidDeviceState[]> {
  try {
    const { stdout } = await adb.executeCommand("shell cmd device_state print-states");
    return parseAndroidDeviceStates(stdout);
  } catch (error) {
    if (/can't find service: device_state/i.test(errorMessage(error))) {
      logger.warn(`Android device_state service is unavailable: ${errorMessage(error)}`);
      return [];
    }
    throw toActionableError(error, "Could not read Android device states");
  }
}

export class SetPosture {
  private readonly adbFactory: AdbClientFactory;
  private readonly observeFactory: (device: BootedDevice) => ObserveScreen;
  private readonly iosClientProvider: (device: BootedDevice) => IOSCtrlProxy;
  private readonly timer: Timer;
  private readonly transitionSink: DisplayTransitionSink;

  constructor(
    private readonly device: BootedDevice,
    dependencies: SetPostureDependencies = {},
  ) {
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.observeFactory =
      dependencies.observeFactory ?? ((target) => new RealObserveScreen(target));
    this.iosClientProvider =
      dependencies.iosClientProvider ?? ((target) => IOSCtrlProxyClient.getInstance(target));
    this.timer = dependencies.timer ?? defaultTimer;
    this.transitionSink = dependencies.transitionSink ?? displayTransitions;
  }

  async execute(
    requested: RequestedPosture,
    displayPreset?: DisplayPreset,
  ): Promise<SetPostureOutput> {
    if (this.device.platform === "ios") {
      return this.executeIos(requested, displayPreset);
    }

    validateInventoryPosture(this.device, requested);

    const adb = this.adbFactory.create(this.device);
    const emulator = isEmulator(this.device);
    if (displayPreset && !emulator) {
      throw new ActionableError(
        "displayPreset is supported only by the Resizable Android emulator.",
      );
    }

    const states = await readAndroidStates(adb);

    if (requested === "rear_display") {
      await setPhysicalPosture(adb, requested, states);
    } else if (emulator) {
      await setEmulatorPosture(
        adb,
        requested,
        displayPreset,
        states.some((state) => state.posture === "rear_display") ||
          (this.device.displays?.postures.includes("rear_display") ?? false),
      );
    } else {
      await setPhysicalPosture(adb, requested, states);
    }

    await observeAndroidPosture(adb, requested, states, this.timer);

    const observation = await this.observeFactory(this.device).execute({});
    return {
      posture: requested,
      display: observation.display,
      ...(observation.deviceLock ? { locked: observation.deviceLock.locked } : {}),
    };
  }

  private async executeIos(
    requested: RequestedPosture,
    displayPreset?: DisplayPreset,
  ): Promise<SetPostureOutput> {
    if (!isIosSimulatorUdid(this.device.deviceId)) {
      return {
        status: "unsupported",
        message: "Physical iOS hinge posture can only be read, not set.",
      };
    }
    if (this.device.deviceType && !this.device.deviceType.endsWith(".iPhone-Duo")) {
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
    const result = await this.iosClientProvider(this.device).requestSetHingeAngle(angle);
    if (!result.success) {
      throw new ActionableError(
        `Could not set iPhone Duo posture: ${result.error ?? "unknown runner error"}`,
      );
    }
    this.transitionSink.notifyTransition(
      this.device.deviceId,
      "setPosture changed the iPhone Duo hinge angle",
    );
    const expectedRole = requested === "closed" ? "cover" : "inner";
    const observation = await observeIosPosture(
      () => this.observeFactory(this.device).execute({ freshness: "fresh" }),
      this.device.displays?.panels,
      expectedRole,
      this.timer,
    );
    this.transitionSink.notifyTransition(
      this.device.deviceId,
      "setPosture settled on the iPhone Duo display",
    );
    return {
      posture: requested,
      display: observation.display,
      ...(observation.deviceLock ? { locked: observation.deviceLock.locked } : {}),
    };
  }
}
