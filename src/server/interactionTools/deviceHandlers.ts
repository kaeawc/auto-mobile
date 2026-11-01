import { defaultDaemonContext } from "../../daemon/daemonContext";
import { PressButton } from "../../features/action/PressButton";
import { Rotate } from "../../features/action/Rotate";
import { SelectAllText } from "../../features/action/SelectAllText";
import {
  SetPosture,
  type RequestedPosture,
  type SetPostureOutput,
} from "../../features/device/SetPosture";
import { RecompositionTracker } from "../../features/performance/RecompositionTracker";
import {
  ActionableError,
  BootedDevice,
  type PressButtonResult,
  type RotateResult,
  type SelectAllTextResult,
} from "../../models";
import { toActionableError } from "../../models/ActionableError";
import { defaultTimer } from "../../utils/SystemTimer";
import { createStructuredToolResponse, throwIfAborted } from "../../utils/toolUtils";
import { resolveTransportDeadlineMs } from "../formTools";
import type { PressButtonArgs, RotateArgs, SelectAllTextArgs } from "../interactionToolTypes";
import { runSessionRotationMutation } from "../sessionRotation";
import type { InteractionHandlerOptions, InteractionToolDependencies } from "./dependencies";

const defaultSelectAllTextFactory: NonNullable<
  InteractionToolDependencies["selectAllTextFactory"]
> = (device) => new SelectAllText(device);

export async function selectAllTextHandler(
  device: BootedDevice,
  args: SelectAllTextArgs,
  { progress, signal, deps = {} }: InteractionHandlerOptions = {},
) {
  try {
    const selectAllText = (deps.selectAllTextFactory ?? defaultSelectAllTextFactory)(device);
    const result: SelectAllTextResult = await selectAllText.execute(progress, signal, {
      layer: args.layer,
    });

    const message = result.success
      ? "Selected all text in focused input field"
      : `Failed to select all text: ${result.error || "unknown error"}`;
    const response = createStructuredToolResponse({
      message,
      observation: result.observation,
      ...result,
    });
    return result.success ? response : { ...response, isError: true as const };
  } catch (error) {
    throw toActionableError(error, `Failed to select all text`);
  }
}

const defaultPressButtonFactory: NonNullable<InteractionToolDependencies["pressButtonFactory"]> = (
  device,
) => new PressButton(device);

export async function pressButtonHandler(
  device: BootedDevice,
  args: PressButtonArgs,
  { progress, signal, deps = {} }: InteractionHandlerOptions = {},
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  try {
    const pressButton = (deps.pressButtonFactory ?? defaultPressButtonFactory)(device);
    const result: PressButtonResult = await pressButton.execute(args.button, {
      progress,
      signal,
      steps: args.steps,
    });

    const message = result.success
      ? `Pressed button ${args.button}`
      : `Failed to press button ${args.button}: ${result.error || "unknown error"}`;
    const response = createStructuredToolResponse({
      message,
      observation: result.observation,
      ...result,
    });
    return result.success ? response : { ...response, isError: true as const };
  } catch (error) {
    throw toActionableError(error, `Failed to press button`);
  }
}

const defaultRotateFactory: NonNullable<InteractionToolDependencies["rotateFactory"]> = (
  device,
  options,
) => new Rotate(device, { adb: null, timer: defaultTimer, options });

const defaultSetPostureFactory: NonNullable<InteractionToolDependencies["setPostureFactory"]> = (
  device,
) => new SetPosture(device);

export function formatSetPostureMessage(result: SetPostureOutput): string {
  if ("status" in result) {
    return result.message;
  }
  const message =
    result.hingeAngle !== undefined
      ? result.observedHingeAngle === undefined
        ? `Requested hinge angle ${result.hingeAngle} degrees; the resulting angle could not be verified (posture ${result.posture})`
        : Math.abs(result.observedHingeAngle - result.hingeAngle) > 1
          ? `Requested hinge angle ${result.hingeAngle} degrees; the device reports ${result.observedHingeAngle} degrees (posture ${result.posture})`
          : `Set hinge angle to ${result.hingeAngle} degrees; device reports posture ${result.posture}${result.postureReason ? ` (${result.postureReason})` : ""}`
      : `Set device posture to ${result.posture}`;
  return result.keyguardDismissed
    ? `${message}; dismissed the swipe keyguard the change raised (the device was unlocked and has no lock credential)`
    : message;
}

export async function setPostureHandler(
  device: BootedDevice,
  args: {
    posture?: RequestedPosture;
    hingeAngle?: number;
    displayPreset?: "phone" | "unfolded" | "tablet";
  },
  { signal, deps = {} }: InteractionHandlerOptions = {},
) {
  try {
    throwIfAborted(signal);
    // The tool boundary validates public args before injecting execution metadata.
    // Direct callers still need the schema's cross-field invariants.
    if ((args.posture !== undefined) === (args.hingeAngle !== undefined)) {
      throw new ActionableError("Specify exactly one of posture or hingeAngle.");
    }
    if (args.hingeAngle !== undefined && args.displayPreset !== undefined) {
      throw new ActionableError(
        "displayPreset requires posture and cannot be combined with hingeAngle.",
      );
    }
    const action = (deps.setPostureFactory ?? defaultSetPostureFactory)(device);
    const result: SetPostureOutput =
      args.hingeAngle !== undefined
        ? await action.executeHingeAngle(args.hingeAngle, {
            displayPreset: args.displayPreset,
            signal,
          })
        : await action.execute(args.posture!, args.displayPreset, signal);
    return createStructuredToolResponse({ message: formatSetPostureMessage(result), ...result });
  } catch (error) {
    throw toActionableError(error, "Failed to set device posture");
  }
}

export function formatRotateMessage(
  result: Pick<RotateResult, "success" | "orientation" | "error" | "message">,
): string {
  if (!result.success) {
    return `Failed to rotate device: ${result.error || "unknown error"}`;
  }
  return result.message ?? `Rotated device to ${result.orientation} orientation`;
}

export async function rotateHandler(
  device: BootedDevice,
  args: RotateArgs,
  { progress, signal, deps = {} }: InteractionHandlerOptions = {},
) {
  try {
    if (args.lockOrientation !== undefined && device.platform !== "android") {
      throw new ActionableError("lockOrientation is supported only on Android devices.");
    }
    const manager =
      args.sessionUuid && device.platform === "android"
        ? defaultDaemonContext.sessionManager()
        : undefined;
    const deadlineMs = resolveTransportDeadlineMs(args);
    const rotate = (deps.rotateFactory ?? defaultRotateFactory)(device, {
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      sessionRotation: (mutation) =>
        runSessionRotationMutation(manager, args.sessionUuid, device.deviceId, mutation),
    });
    const result = await rotate.execute(args.orientation, {
      progress,
      lockOrientation: args.lockOrientation,
      signal,
      display: args.display,
    });
    const response = createStructuredToolResponse({
      observation: result.observation,
      ...result,
      message: formatRotateMessage(result),
    });
    return result.success ? response : { ...response, isError: true as const };
  } catch (error) {
    throw toActionableError(error, `Failed to rotate device`);
  }
}
