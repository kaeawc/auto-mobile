import { isDeepStrictEqual } from "node:util";
import type { H264CaptureSourceOptions } from "./H264CaptureSource";

export type CaptureHintField = "bitrateBps" | "size" | "quality" | "fps";
const captureHintFields: readonly CaptureHintField[] = ["bitrateBps", "size", "quality", "fps"];
export function conflictingCaptureHints(
  actual: H264CaptureSourceOptions,
  requested: H264CaptureSourceOptions,
  flexible: readonly CaptureHintField[] = [],
): string[] {
  const fields: string[] = captureHintFields.filter(
    (field) =>
      !flexible.includes(field) &&
      requested[field] !== undefined &&
      !isDeepStrictEqual(actual[field], requested[field]),
  );
  if (requested.audioEnabled && !actual.audioEnabled) {
    fields.push("audioEnabled");
  }
  return fields;
}
/**
 * Undefined joiner values (and flexible defaults) mean no preference. Defined values must
 * deep-equal the creator's actual settings; an undefined actual value is an unknown device
 * default, never an explicit match. Audio is directional: an audio source can serve video only.
 */
export function captureHintsCompatible(
  actual: H264CaptureSourceOptions,
  requested: H264CaptureSourceOptions,
  flexible: readonly CaptureHintField[] = [],
): boolean {
  return conflictingCaptureHints(actual, requested, flexible).length === 0;
}
