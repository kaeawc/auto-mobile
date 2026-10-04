import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { TouchInputNode } from "./TouchNodeDiscovery";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";

interface AxisRanges {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** Logical pixels from `adb shell wm size` (physical, not rotated) */
  displayWidth: number;
  displayHeight: number;
  /** 0=portrait, 1=landscape90, 2=reverse-portrait, 3=landscape270 */
  rotation: number;
}

export interface CoordScaler {
  toScreenPoint(rawX: number, rawY: number): { x: number; y: number };
}

/**
 * Build a coordinate scaler that maps raw sensor values to logical display pixels.
 * Rotation follows Android's touch-device mapping: 90 uses raw Y for screen X
 * and inverted raw X for screen Y; 270 reverses those inversions.
 */
export function buildScaler(ranges: AxisRanges): CoordScaler {
  const scaleX = (rawX: number, inverted: boolean): number =>
    Math.round(
      ((inverted ? ranges.xMax - rawX : rawX - ranges.xMin) / (ranges.xMax - ranges.xMin + 1)) *
        ranges.displayWidth,
    );
  const scaleY = (rawY: number, inverted: boolean): number =>
    Math.round(
      ((inverted ? ranges.yMax - rawY : rawY - ranges.yMin) / (ranges.yMax - ranges.yMin + 1)) *
        ranges.displayHeight,
    );
  return {
    toScreenPoint(rawX: number, rawY: number): { x: number; y: number } {
      switch (ranges.rotation) {
        case 1:
          return { x: scaleY(rawY, false), y: scaleX(rawX, true) };
        case 2:
          return { x: scaleX(rawX, true), y: scaleY(rawY, true) };
        case 3:
          return { x: scaleY(rawY, true), y: scaleX(rawX, false) };
        default:
          return { x: scaleX(rawX, false), y: scaleY(rawY, false) };
      }
    },
  };
}

/**
 * Parse the physical display size from `adb shell wm size` output.
 * Returns { width, height } in physical pixels (before rotation).
 */
async function queryDisplaySize(adb: AdbExecutor): Promise<{ width: number; height: number }> {
  const { stdout } = await adb.executeCommand("shell wm size");
  const match = stdout.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) {
    throw new Error(`Could not parse display size from wm size output: ${stdout}`);
  }
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}

/**
 * Query the current display rotation from `adb shell dumpsys window displays`.
 * Returns 0 (portrait) if the rotation cannot be determined.
 *
 * Android reports rotation as named constants whose suffix is either the
 * 0-3 index (older devices/emulators) or the degree value (90/180/270).
 * Both forms are normalized to the 0-3 index expected by buildScaler.
 */
export async function queryRotation(adb: AdbExecutor): Promise<number> {
  try {
    const { stdout } = await adb.executeCommand("shell dumpsys window displays");
    const match = stdout.match(/mCurrentRotation=ROTATION_(\d+)/);
    if (match) {
      return normalizeDumpsysRotation(parseInt(match[1], 10));
    }
  } catch (error) {
    logger.warn(
      `[AxisRanges] Failed to query rotation; using portrait: ${errorMessage(error)}`,
      error,
    );
  }
  return 0;
}

/**
 * Maps dumpsys rotation suffix to a 0-3 index.
 * Handles both index form (0/1/2/3) and degree form (0/90/180/270).
 */
function normalizeDumpsysRotation(value: number): number {
  switch (value) {
    case 90:
      return 1;
    case 180:
      return 2;
    case 270:
      return 3;
    default:
      return value <= 3 ? value : 0;
  }
}

/**
 * Parse display density from `adb shell wm density` and return dp multiplier.
 * Falls back to 2.75 (440 dpi) if parsing fails.
 */
export async function queryDensity(adb: AdbExecutor): Promise<number> {
  try {
    const { stdout } = await adb.executeCommand("shell wm density");
    const match = stdout.match(/Physical density:\s*(\d+)/);
    if (match) {
      return parseInt(match[1], 10) / 160;
    }
  } catch (error) {
    logger.warn(
      `[AxisRanges] Failed to query density; using 440 dpi: ${errorMessage(error)}`,
      error,
    );
  }
  return 2.75;
}

/**
 * Build AxisRanges from the touch node axis info + current display size + rotation.
 * @param rotation 0-3 from AccessibilityHierarchy.rotation
 */
export async function buildAxisRanges(
  adb: AdbExecutor,
  node: TouchInputNode,
  rotation: number,
): Promise<AxisRanges> {
  const { width, height } = await queryDisplaySize(adb);
  return {
    xMin: node.axisXMin,
    xMax: node.axisXMax,
    yMin: node.axisYMin,
    yMax: node.axisYMax,
    displayWidth: width,
    displayHeight: height,
    rotation,
  };
}
