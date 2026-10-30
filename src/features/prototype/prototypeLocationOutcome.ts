import { applyPrototypeDataWrite } from "./prototypeDataWrite";
import { prototypeRequestMetaPath } from "./prototypeRequest";
import type { PrototypeData } from "./prototypeSpec";

/**
 * What a `location.request` call does with its result (#14324). The executable reference for the
 * device runtimes, like `applyPrototypeRequestOutcome` for `request`:
 *
 * - A valid fix is written to `into` as a flat object (only the reported optional fields), then
 *   `{durationMs, approximate}` to `<into>__meta`; the status is `success`. A grant of approximate
 *   location only is still a success, with `approximate: true`.
 * - A failure, or a fix outside the coordinate ranges, leaves `into` untouched, writes
 *   `{durationMs, error}` to `<into>__meta` and the status is `error`. Codes outside
 *   `PROTOTYPE_LOCATION_ERROR_CODES` are reported as `platform_error`; only `unavailable` keeps a
 *   `reason` (`disabled` when location services are off).
 * - The writes are atomic: if `<into>__meta` cannot be written beside the fix, the fix is rolled
 *   back and the call is a `platform_error`.
 */

export const PROTOTYPE_LOCATION_ERROR_CODES = [
  "permission_denied",
  "unavailable",
  "timeout",
  "platform_error",
] as const;
export type PrototypeLocationErrorCode = (typeof PROTOTYPE_LOCATION_ERROR_CODES)[number];

export interface PrototypeLocationFix {
  latitude: number;
  longitude: number;
  accuracyM: number;
  altitudeM?: number;
  speedMps?: number;
  bearingDeg?: number;
  timestampMs: number;
  approximate: boolean;
}

export interface PrototypeLocationError {
  code: PrototypeLocationErrorCode;
  message: string;
  reason?: "disabled";
}

export type PrototypeLocationOutcome =
  | { ok: true; fix: PrototypeLocationFix; durationMs: number }
  | { ok: false; error: { code: string; message: string; reason?: string }; durationMs: number };

export interface PrototypeLocationMeta {
  durationMs: number;
  approximate?: boolean;
  error?: PrototypeLocationError;
}

export interface PrototypeLocationOutcomeResult {
  status: "success" | "error";
  data: PrototypeData;
  meta: PrototypeLocationMeta;
  wroteInto: boolean;
}

const finiteIn = (value: unknown, min: number, max: number): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

const OPTIONAL_RANGES = {
  altitudeM: [-20000, 100000],
  speedMps: [0, 1000],
  bearingDeg: [0, 360],
} as const;

/** Why a reported fix cannot be written, or undefined when it is in range. */
export function prototypeLocationFixError(fix: PrototypeLocationFix): string | undefined {
  if (!finiteIn(fix.latitude, -90, 90) || !finiteIn(fix.longitude, -180, 180)) {
    return "fix coordinates are out of range";
  }
  if (
    !finiteIn(fix.accuracyM, 0, Number.MAX_VALUE) ||
    !finiteIn(fix.timestampMs, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return "fix accuracy or timestamp is invalid";
  }
  const bad = Object.entries(OPTIONAL_RANGES).find(
    ([key, [min, max]]) =>
      fix[key as keyof typeof OPTIONAL_RANGES] !== undefined &&
      !finiteIn(fix[key as keyof typeof OPTIONAL_RANGES], min, max),
  );
  if (bad) {
    return `fix ${bad[0]} is out of range`;
  }
  return typeof fix.approximate === "boolean" ? undefined : "fix approximate must be a boolean";
}

/** The written fix: the required fields plus only the optional ones the platform reported. */
function fixValue(fix: PrototypeLocationFix): PrototypeLocationFix {
  const { altitudeM, speedMps, bearingDeg } = fix;
  return {
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracyM: fix.accuracyM,
    ...(altitudeM === undefined ? {} : { altitudeM }),
    ...(speedMps === undefined ? {} : { speedMps }),
    ...(bearingDeg === undefined ? {} : { bearingDeg }),
    timestampMs: fix.timestampMs,
    approximate: fix.approximate,
  };
}

function typedError(error: {
  code: string;
  message: string;
  reason?: string;
}): PrototypeLocationError {
  const code = (PROTOTYPE_LOCATION_ERROR_CODES as readonly string[]).includes(error.code)
    ? (error.code as PrototypeLocationErrorCode)
    : "platform_error";
  return code === "unavailable" && error.reason === "disabled"
    ? { code, message: error.message, reason: "disabled" }
    : { code, message: error.message };
}

function withMeta(
  data: PrototypeData,
  into: string,
  meta: PrototypeLocationMeta,
): PrototypeData | undefined {
  const written = applyPrototypeDataWrite(data, {
    op: "set",
    path: prototypeRequestMetaPath(into),
    value: meta,
  });
  return written.success ? written.data : undefined;
}

function failure(
  data: PrototypeData,
  into: string | undefined,
  durationMs: number,
  error: PrototypeLocationError,
): PrototypeLocationOutcomeResult {
  const meta = { durationMs, error };
  const next = into === undefined ? data : (withMeta(data, into, meta) ?? data);
  return { status: "error", data: next, meta, wroteInto: false };
}

/** Applies one `location.request` result. `into` is the authored `/data/<pointer>`, if any. */
export function applyPrototypeLocationOutcome(
  data: PrototypeData,
  into: string | undefined,
  outcome: PrototypeLocationOutcome,
): PrototypeLocationOutcomeResult {
  if (!outcome.ok) {
    return failure(data, into, outcome.durationMs, typedError(outcome.error));
  }
  const invalid = prototypeLocationFixError(outcome.fix);
  if (invalid !== undefined) {
    return failure(data, into, outcome.durationMs, { code: "platform_error", message: invalid });
  }
  const meta = { durationMs: outcome.durationMs, approximate: outcome.fix.approximate };
  if (into === undefined) {
    return { status: "success", data, meta, wroteInto: false };
  }
  const written = applyPrototypeDataWrite(data, {
    op: "set",
    path: into,
    value: fixValue(outcome.fix),
  });
  if (!written.success) {
    return failure(data, into, outcome.durationMs, {
      code: "platform_error",
      message: `into ${written.error.message}`,
    });
  }
  const next = withMeta(written.data, into, meta);
  return next === undefined
    ? failure(data, into, outcome.durationMs, {
        code: "platform_error",
        message: "fix and metadata exceed the data limit",
      })
    : { status: "success", data: next, meta, wroteInto: true };
}
