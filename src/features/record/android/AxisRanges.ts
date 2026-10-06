import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";

export interface AxisRanges {
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
 * A scaler whose rotation and display size depend on when a touch happened.
 * The gesture classifier resolves it once per contact, at the contact's DOWN
 * frame, so a rotation mid-recording only affects touches that start after it.
 */
export interface TimedCoordScaler {
  scalerAt(time: number): CoordScaler;
}

export type GestureScaler = CoordScaler | TimedCoordScaler;

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
export async function queryDisplaySize(
  adb: AdbExecutor,
): Promise<{ width: number; height: number }> {
  const { stdout } = await adb.executeCommand("shell wm size");
  const match = stdout.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) {
    throw new Error(`Could not parse display size from wm size output: ${stdout}`);
  }
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
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
