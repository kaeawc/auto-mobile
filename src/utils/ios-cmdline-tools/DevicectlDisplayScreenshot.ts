import { ActionableError } from "../../models/ActionableError";
import type { CoreDeviceCapabilityResult } from "./CoreDeviceCapabilityProbe";

/** Unwired argv builder; xcrun is the command, not part of its arguments. */
export function buildDevicectlDisplayScreenshotArgs(options: {
  deviceId: string;
  destination: string;
  displayUniqueId?: string;
}): string[] {
  const { deviceId, destination, displayUniqueId } = options;
  if (!deviceId || deviceId.startsWith("-")) {
    throw new ActionableError(
      "Provide a non-empty device ID that does not start with '-' to capture a screenshot.",
    );
  }
  if (displayUniqueId !== undefined && (!displayUniqueId || displayUniqueId.startsWith("-"))) {
    throw new ActionableError(
      "Provide a non-empty display unique ID that does not start with '-', or omit it to capture the primary display.",
    );
  }
  if (!destination.toLowerCase().endsWith(".png")) {
    throw new ActionableError("Provide a screenshot destination ending in '.png'.");
  }
  return [
    "devicectl",
    "device",
    "capture",
    "screenshot",
    "--device",
    deviceId,
    "--destination",
    destination,
    ...(displayUniqueId ? ["--display-unique-id", displayUniqueId] : []),
  ];
}

/** A future executor supplies capture; no device command is executed by this seam. */
export interface SimulatorDisplayScreenshotCapture {
  capture(options: {
    deviceId: string;
    displayUniqueId: string;
    signal?: AbortSignal;
  }): Promise<Buffer>;
}

/** Use only a supported command with a known unique ID for multi-display capture. */
export function chooseSimulatorPanelScreenshotTransport(input: {
  panelCount: number;
  panelKey: string;
  displayUniqueId: string | undefined;
  capability: CoreDeviceCapabilityResult;
}):
  | { kind: "devicectl"; displayUniqueId: string }
  | {
      kind: "simctl";
      display: string;
      reason: "single-display" | "no-unique-id" | "coredevice-unsupported";
    } {
  if (input.panelCount < 2) {
    return { kind: "simctl", display: input.panelKey, reason: "single-display" };
  }
  if (input.capability.kind !== "supported") {
    return { kind: "simctl", display: input.panelKey, reason: "coredevice-unsupported" };
  }
  if (!input.displayUniqueId) {
    return { kind: "simctl", display: input.panelKey, reason: "no-unique-id" };
  }
  return { kind: "devicectl", displayUniqueId: input.displayUniqueId };
}
