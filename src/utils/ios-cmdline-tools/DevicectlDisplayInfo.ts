import { errorMessage } from "../describeUnknownError";
import { logger, type Logger } from "../logger";
import {
  asRecord,
  asString,
  parseDevicectlFailureEnvelope,
  type DevicectlFailureEnvelope,
} from "./devicectlFailureEnvelope";

interface DisplaySize {
  width: number;
  height: number;
}

/** Captured fields only; neither primary nor backlightState implies a posture-active panel. */
export interface DevicectlDisplayInfo {
  uniqueId: string;
  displayId: number;
  name?: string;
  primary?: boolean;
  typeKind?: string;
  bounds?: { origin: { x: number; y: number }; size: DisplaySize };
  nativeSize?: DisplaySize;
  /** The capture does not establish the unit of physicalSize. */
  physicalSize?: DisplaySize;
  pointScale?: number;
  currentOrientation?: string;
  nativeOrientation?: string;
  backlightState?: string;
  chromeIdentifier?: string;
  framebufferMaskIdentifier?: string;
}

interface DisplayInfoFailure {
  kind: "failed";
  reason: "invalid-json" | "command-failed" | "unexpected-shape";
  message: string;
  coreDeviceError?: DevicectlFailureEnvelope;
}

interface DisplayOrientation {
  currentDeviceNonFlatOrientation?: string;
  currentDeviceOrientation?: string;
  currentDeviceOrientationLocked?: boolean;
}

type DisplayInfoResult =
  | {
      kind: "ok";
      displays: DevicectlDisplayInfo[];
      commandType: "devicectl.device.info.displays";
      jsonVersion?: number;
      version?: string;
      backlightState?: string;
      orientation?: DisplayOrientation;
    }
  | DisplayInfoFailure;

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readPair(value: unknown): [number, number] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    !Number.isFinite(value[0]) ||
    typeof value[1] !== "number" ||
    !Number.isFinite(value[1])
  ) {
    return undefined;
  }
  return [value[0], value[1]];
}

function readSize(value: unknown): DisplaySize | undefined {
  const pair = readPair(value);
  return pair ? { width: pair[0], height: pair[1] } : undefined;
}

function readBounds(value: unknown): DevicectlDisplayInfo["bounds"] {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }
  const origin = readPair(value[0]);
  const size = readSize(value[1]);
  return origin && size ? { origin: { x: origin[0], y: origin[1] }, size } : undefined;
}

function readTypeKind(value: unknown): string | undefined {
  const type = asRecord(value);
  const keys = type ? Object.keys(type) : [];
  return keys.length === 1 && asRecord(type?.[keys[0]]) ? asString(keys[0]) : undefined;
}

function readOrientation(value: unknown): DisplayOrientation | undefined {
  const orientation = asRecord(value);
  return orientation
    ? {
        currentDeviceNonFlatOrientation: asString(orientation.currentDeviceNonFlatOrientation),
        currentDeviceOrientation: asString(orientation.currentDeviceOrientation),
        currentDeviceOrientationLocked: readBoolean(orientation.currentDeviceOrientationLocked),
      }
    : undefined;
}

function readDisplay(value: unknown): DevicectlDisplayInfo | undefined {
  const record = asRecord(value);
  const uniqueId = asString(record?.uniqueId);
  const displayId = readNumber(record?.displayId);
  if (!record || !uniqueId || displayId === undefined) {
    return undefined;
  }
  return {
    uniqueId,
    displayId,
    name: asString(record.name),
    primary: readBoolean(record.primary),
    typeKind: readTypeKind(record.type),
    bounds: readBounds(record.bounds),
    nativeSize: readSize(record.nativeSize),
    physicalSize: readSize(record.physicalSize),
    pointScale: readNumber(record.pointScale),
    currentOrientation: asString(record.currentOrientation),
    nativeOrientation: asString(record.nativeOrientation),
    backlightState: asString(record.backlightState),
    chromeIdentifier: asString(record.chromeIdentifier),
    framebufferMaskIdentifier: asString(record.framebufferMaskIdentifier),
  };
}

/** Pure, unwired parser of the JSON output file. An empty displays array is a valid empty listing. */
export function parseDevicectlDisplayInfo(text: string, log: Logger = logger): DisplayInfoResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const message = `Invalid devicectl display info JSON: ${errorMessage(error)}`;
    log.warn(message, error);
    return { kind: "failed", reason: "invalid-json", message };
  }

  const fail = (
    reason: DisplayInfoFailure["reason"],
    message: string,
    coreDeviceError?: DevicectlFailureEnvelope,
  ): DisplayInfoFailure => {
    log.warn(message);
    return { kind: "failed", reason, message, ...(coreDeviceError ? { coreDeviceError } : {}) };
  };
  const root = asRecord(data) ?? {};
  const info = asRecord(root.info) ?? {};
  const outcome = asString(info.outcome);
  if (!outcome) {
    return fail("unexpected-shape", "Expected a devicectl display info object with info.outcome.");
  }
  if (outcome !== "success") {
    return fail(
      "command-failed",
      "devicectl display info command did not succeed.",
      parseDevicectlFailureEnvelope(data),
    );
  }
  if (info.commandType !== "devicectl.device.info.displays") {
    return fail("unexpected-shape", "Expected commandType devicectl.device.info.displays.");
  }
  const result = asRecord(root.result);
  if (!result || !Array.isArray(result.displays)) {
    return fail(
      "unexpected-shape",
      "Expected devicectl display info result.displays to be an array.",
    );
  }
  const displays: DevicectlDisplayInfo[] = [];
  for (const [index, value] of result.displays.entries()) {
    const display = readDisplay(value);
    if (!display) {
      return fail(
        "unexpected-shape",
        `Invalid display at index ${index}: expected a non-empty uniqueId and numeric displayId.`,
      );
    }
    displays.push(display);
  }
  return {
    kind: "ok",
    displays,
    commandType: info.commandType,
    jsonVersion: readNumber(info.jsonVersion),
    version: asString(info.version),
    backlightState: asString(result.backlightState),
    orientation: readOrientation(result.orientation),
  };
}
