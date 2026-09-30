import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice, DisplayRef, Posture } from "../../models";
import { RealObserveScreen } from "../observe/ObserveScreen";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { parseAndroidDeviceStates } from "../../utils/android-cmdline-tools/AndroidDisplayInventory";
import { IOSCtrlProxyClient, type IOSCtrlProxy } from "../observe/ios/IOSCtrlProxyClient";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { DisplayPanel } from "../../models/DisplayPanel";
import { displayTransitions, type DisplayTransitionSink } from "../observe/DisplayTransition";

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

type IosPanelMatch = "expected" | "old" | "indeterminate";

function sizeMatchesPanel(size: { width: number; height: number }, panel: DisplayPanel): boolean {
  const matchesSize = (width: number, height: number): boolean =>
    (size.width === width && size.height === height) ||
    (size.width === height && size.height === width);
  if (matchesSize(panel.sizePx.width, panel.sizePx.height)) {
    return true;
  }
  return (
    panel.scale !== undefined &&
    matchesSize(
      Math.round(panel.sizePx.width / panel.scale),
      Math.round(panel.sizePx.height / panel.scale),
    )
  );
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
  const matchesPanel = (panel: DisplayPanel): boolean =>
    observation.display.role === panel.role || sizeMatchesPanel(observation.screenSize, panel);
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
  return observation;
}

const EMULATOR_POSTURE_IDS: Record<RequestedPosture, number> = {
  closed: 1,
  half_opened: 2,
  opened: 3,
  rear_display: 1,
  flipped: 4,
  tent: 5,
};
// IDs follow Android's documented `adb emu posture` order. rear_display uses
// the closed state, which activates the emulator's cover display:
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
): Promise<void> {
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
): Promise<void> {
  const { stdout } = await adb.executeCommand("shell cmd device_state print-states");
  const states = parseAndroidDeviceStates(stdout);
  const match = states.find((state) => state.posture === requested);
  if (!match && requested !== "opened") {
    const supported = [...new Set(states.map((state) => state.posture))];
    throw new ActionableError(
      `Posture '${requested}' is not supported by this device. Supported postures: ${supported.join(", ")}.`,
    );
  }
  const command = match
    ? `shell cmd device_state state ${match.identifier}`
    : "shell cmd device_state state reset";
  await adb.executeCommand(command);
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

    if (emulator) {
      await setEmulatorPosture(adb, requested, displayPreset);
    } else {
      await setPhysicalPosture(adb, requested);
    }

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
      () => this.observeFactory(this.device).execute({}),
      this.device.displays?.panels,
      expectedRole,
      this.timer,
    );
    return {
      posture: requested,
      display: observation.display,
      ...(observation.deviceLock ? { locked: observation.deviceLock.locked } : {}),
    };
  }
}
