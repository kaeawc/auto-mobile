import { ActionableError } from "../../../models/ActionableError";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { PointerDispatch } from "./DispatchingRoute";
import type { PointerRequest } from "./PointerInjector";

/** The instrumentation CtrlProxy ships for stylus and hover injection (#13097). */
export const POINTER_INSTRUMENTATION_COMPONENT =
  "dev.jasonpearson.automobile.ctrlproxy/.pointer.PointerInstrumentation";

/** The first Android release whose `am instrument` has `--no-restart` (see the design note). */
export const POINTER_INSTRUMENTATION_MIN_SDK = 33;

const REQUEST_VERSION = 1;
/** The segment time a point without `durationMs` takes (the same default as `dragPath`). */
const DEFAULT_SEGMENT_MS = 200;
/** Process start, UiAutomation connect and teardown, on top of the planned event time. */
export const INSTRUMENTATION_OVERHEAD_MS = 15_000;

/** A failure that happened before anything reached the device: retry-safe. */
export class PointerNotSentError extends ActionableError {}

export interface PointerInstrumentationResult {
  success: boolean;
  error?: string;
  injected: number;
  elapsedMs: number;
}

function plannedMs(request: PointerRequest): number {
  return request.points
    .slice(1)
    .reduce((sum, point) => sum + (point.durationMs ?? DEFAULT_SEGMENT_MS), 0);
}

/** The JSON the instrumentation's `request` argument carries, base64 so it is one shell-safe token. */
export function encodePointerRequest(request: PointerRequest): string {
  const body = {
    version: REQUEST_VERSION,
    tool: request.features.toolType,
    hover: request.features.hover === true,
    buttons: request.buttons ?? 0,
    displayId: request.displayId ?? 0,
    points: request.points.map((point, index) => ({
      x: point.x,
      y: point.y,
      // The runner defaults a missing duration to 0, so the host's 200 ms default is sent explicitly.
      ...(index === 0 ? {} : { durationMs: point.durationMs ?? DEFAULT_SEGMENT_MS }),
      ...(point.distance === undefined ? {} : { distance: point.distance }),
      ...(point.pressure === undefined ? {} : { pressure: point.pressure }),
      ...(point.tilt === undefined ? {} : { tilt: point.tilt }),
      ...(point.orientation === undefined ? {} : { orientation: point.orientation }),
    })),
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}

export function pointerInstrumentationCommand(request: PointerRequest): string {
  return `shell am instrument -w -r --no-restart -e request ${encodePointerRequest(request)} ${POINTER_INSTRUMENTATION_COMPONENT}`;
}

/** Reads the `INSTRUMENTATION_RESULT: key=value` lines the instrumentation finishes with. */
export function parsePointerInstrumentationOutput(
  output: string,
): PointerInstrumentationResult | undefined {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^INSTRUMENTATION_RESULT: ([A-Za-z]+)=(.*)$/.exec(line);
    if (match) {
      values.set(match[1], match[2]);
    }
  }
  const success = values.get("success");
  if (success !== "true" && success !== "false") {
    return undefined;
  }
  const error = values.get("error");
  return {
    success: success === "true",
    ...(error ? { error } : {}),
    injected: Number(values.get("injected") ?? 0),
    elapsedMs: Number(values.get("elapsedMs") ?? 0),
  };
}

/** Why a run that reported no result failed, from the shell output, as an actionable error. */
function unreportedFailure(output: string): ActionableError {
  if (/Unable to find instrumentation|INSTRUMENTATION_FAILED|does not exist/i.test(output)) {
    return new PointerNotSentError(
      "The connected CtrlProxy does not include the pointer instrumentation; update CtrlProxy. No input was sent.",
    );
  }
  if (/Unknown option|--no-restart/i.test(output)) {
    return new PointerNotSentError(
      "This Android version's `am instrument` has no --no-restart, which keeps the injection from restarting CtrlProxy; hover and stylus injection need Android 13 or newer. No input was sent.",
    );
  }
  if (/Process crashed|INSTRUMENTATION_RESULT: shortMsg=/i.test(output)) {
    return new ActionableError(
      "The pointer instrumentation crashed before reporting a result; the hover or stroke may have partially run. Verify state with observe before retrying.",
    );
  }
  return new ActionableError(
    "The pointer instrumentation did not report a result; the hover or stroke may have partially run. Verify state with observe before retrying.",
  );
}

/**
 * The instrumentation route's transport: `am instrument` with the request, then the reported result.
 * A refusal the instrumentation itself reports (`success=false`) means nothing past the reported
 * count ran; no report at all means the outcome is unknown.
 */
export function createInstrumentationDispatch(adb: AdbExecutor): PointerDispatch {
  return async (request, signal) => {
    const result = await adb.executeCommand(pointerInstrumentationCommand(request), {
      timeoutMs: plannedMs(request) + INSTRUMENTATION_OVERHEAD_MS,
      signal,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const reported = parsePointerInstrumentationOutput(output);
    if (!reported) {
      throw unreportedFailure(output);
    }
    if (!reported.success) {
      throw new ActionableError(
        `The pointer instrumentation failed after ${reported.injected} event${reported.injected === 1 ? "" : "s"}: ${reported.error ?? "unknown error"}`,
      );
    }
  };
}
