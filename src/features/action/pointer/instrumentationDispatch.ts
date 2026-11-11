import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { runWithAbortSignal } from "../../../utils/AbortContext";
import { throwIfAborted } from "../../../utils/toolUtils";
import { ActionableError } from "../../../models/ActionableError";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { PointerDispatch } from "./DispatchingRoute";
import type { PointerRequest } from "./PointerInjector";
import { pointerDispatchLock } from "./pointerDispatchLock";

/** The instrumentation CtrlProxy ships for stylus and hover injection (#13097). */
export const POINTER_INSTRUMENTATION_COMPONENT =
  "dev.jasonpearson.automobile.ctrlproxy/.pointer.PointerInstrumentation";

/** The first Android release whose `am instrument` has `--no-restart` (measured; see the design note). */
export const POINTER_INSTRUMENTATION_MIN_SDK = 31;

const REQUEST_VERSION = 1;
/** The segment time a point without `durationMs` takes (the same default as `dragPath`). */
const DEFAULT_SEGMENT_MS = 200;
/** Process start, UiAutomation connect and teardown, on top of the planned event time. */
export const INSTRUMENTATION_OVERHEAD_MS = 15_000;

/** Injection can run about 2x slower than the plan on a loaded emulator (measured 2.1x). */
export function instrumentationTimeoutMs(plannedMs: number): number {
  return plannedMs * 2 + INSTRUMENTATION_OVERHEAD_MS;
}

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
async function unreportedFailure(output: string, adb: AdbExecutor): Promise<ActionableError> {
  if (/Unable to find instrumentation|INSTRUMENTATION_FAILED|does not exist/i.test(output)) {
    return new PointerNotSentError(
      "The connected CtrlProxy does not include the pointer instrumentation; update CtrlProxy. No input was sent.",
    );
  }
  if (/Unknown option|--no-restart/i.test(output)) {
    return new PointerNotSentError(
      "This Android version's `am instrument` has no --no-restart, which keeps the injection from restarting CtrlProxy; hover and stylus injection need Android 12 or newer. No input was sent.",
    );
  }
  if (/Process crashed|INSTRUMENTATION_RESULT: shortMsg=/i.test(output)) {
    let note = "";
    try {
      const state = await adb.executeCommand(
        "shell settings get secure enabled_accessibility_services",
        { timeoutMs: 5000 },
      );
      note = state.stdout.includes("dev.jasonpearson.automobile.ctrlproxy")
        ? " CtrlProxy's accessibility service is still enabled."
        : " CtrlProxy's accessibility service is not enabled; re-enable it before retrying.";
    } catch (error) {
      // The diagnostic is optional; preserve the crash error when settings cannot be read.
      logger.warn(
        `Could not read accessibility services after pointer crash: ${errorMessage(error)}`,
        error,
      );
    }
    return new ActionableError(
      "The pointer instrumentation crashed before reporting a result; the hover or stroke may have partially run. Verify state with observe before retrying." +
        note,
    );
  }
  return new ActionableError(
    "The pointer instrumentation did not report a result; the hover or stroke may have partially run. Verify state with observe before retrying.",
  );
}

/** The runner's note when its own CANCEL or HOVER_EXIT was refused after a partial run. */
const UNCLOSED_POINTER = /could not be closed/i;
const POINTER_CANCEL_TIMEOUT_MS = 5000;

/**
 * Best-effort stylus CANCEL at the request's first point. Injection through `UiAutomation` is on
 * virtual device -1, and the dispatcher keeps its pointer down until a CANCEL or UP arrives, so a
 * killed or abandoned run would refuse every later HOVER_ENTER or DOWN (#16028).
 */
async function sendPointerCancel(
  adb: AdbExecutor,
  request: PointerRequest,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  const point = request.points[0];
  try {
    // The ambient signal is set to `signal` too: AdbClient falls back to it when none is passed,
    // so cleanup without a signal must not inherit an already-aborted request.
    await runWithAbortSignal(signal, () =>
      adb.executeCommand(
        `shell input stylus motionevent CANCEL ${Math.round(point.x)} ${Math.round(point.y)}`,
        { timeoutMs: POINTER_CANCEL_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      ),
    );
  } catch (error) {
    // Safe to continue: the caller reports the run's own outcome, and a later refusal retries CANCEL.
    logger.warn(`Could not cancel ${reason}: ${errorMessage(error)}`, error);
  }
}

/**
 * Runs one instrumentation and, when it ends without a report (killed, crashed, timed out or
 * aborted by the caller), closes any pointer it left down before rethrowing. The CANCEL runs
 * without the caller's signal, explicit or ambient: an aborted gesture is exactly the one whose pointer is still open,
 * and the lock is still held so a queued run cannot start on top of it.
 */
async function runClosingOnAbandon(
  run: () => Promise<PointerInstrumentationResult>,
  adb: AdbExecutor,
  request: PointerRequest,
): Promise<PointerInstrumentationResult> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof PointerNotSentError)) {
      await sendPointerCancel(adb, request, "an abandoned pointer run");
    }
    throw error;
  }
}

/**
 * The instrumentation route's transport: `am instrument` with the request, then the reported result.
 * A refusal the instrumentation itself reports (`success=false`) means nothing past the reported
 * count ran; no report at all means the outcome is unknown.
 */
export function createInstrumentationDispatch(adb: AdbExecutor, deviceId: string): PointerDispatch {
  const lock = pointerDispatchLock(deviceId);
  return async (request, signal) => {
    throwIfAborted(signal);
    await lock.runExclusive(async () => {
      // Cancellation while queued must not start another instrumentation process.
      throwIfAborted(signal);
      const run = async () => {
        const result = await adb.executeCommand(pointerInstrumentationCommand(request), {
          timeoutMs: instrumentationTimeoutMs(plannedMs(request)),
          signal,
        });
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        const reported = parsePointerInstrumentationOutput(output);
        if (!reported) {
          throw await unreportedFailure(output, adb);
        }
        return reported;
      };
      let reported = await runClosingOnAbandon(run, adb, request);
      if (!reported.success && reported.injected === 0 && /refused/i.test(reported.error ?? "")) {
        throwIfAborted(signal);
        await sendPointerCancel(adb, request, "refused pointer input", signal);
        throwIfAborted(signal);
        reported = await runClosingOnAbandon(run, adb, request);
      }
      if (!reported.success && UNCLOSED_POINTER.test(reported.error ?? "")) {
        // The runner could not close its own pointer; close it before the lock admits the next run.
        await sendPointerCancel(adb, request, "an unclosed pointer");
      }
      if (!reported.success) {
        throw new ActionableError(
          `The pointer instrumentation failed after ${reported.injected} event${reported.injected === 1 ? "" : "s"}: ${reported.error ?? "unknown error"}`,
        );
      }
    });
  };
}
