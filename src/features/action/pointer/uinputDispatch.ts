import { Mutex } from "async-mutex";
import { ActionableError } from "../../../models/ActionableError";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readWindowManagerRotation } from "../../../utils/android-cmdline-tools/readWindowManagerRotation";
import { errorMessage } from "../../../utils/describeUnknownError";
import { throwIfAborted } from "../../../utils/toolUtils";
import { queryDisplaySize } from "../../record/android/AxisRanges";
import type { PointerDispatch } from "./DispatchingRoute";
import { PointerNotSentError } from "./instrumentationDispatch";
import { uinputPenScript, uinputPlannedMs, type UinputDisplayGeometry } from "./uinputPenScript";

const GEOMETRY_READ_TIMEOUT_MS = 5_000;
/** adb start-up and the device shell, on top of the planned registration and event time. */
const UINPUT_OVERHEAD_MS = 10_000;
/**
 * adbd runs the command as one `sh -c` argument, which Linux caps at 128 KiB; the base64 script
 * stays well under that (roughly ten seconds of stroke).
 */
const MAX_ENCODED_SCRIPT_BYTES = 100_000;
const EXIT_MARKER = "automobile-uinput-exit=";

export interface UinputScriptResult {
  /** The `uinput` tool's exit status, or null when the shell never reported one. */
  exitCode: number | null;
  /** What `uinput` printed (stdout and stderr). */
  stderr: string;
}

export interface UinputDispatchDeps {
  readGeometry(signal?: AbortSignal): Promise<UinputDisplayGeometry>;
  runScript(script: string, timeoutMs: number, signal?: AbortSignal): Promise<UinputScriptResult>;
}

const dispatchLocks = new WeakMap<AdbExecutor, Mutex>();

/** The default display's natural size (`wm size`) and current rotation. */
async function readAdbGeometry(
  adb: AdbExecutor,
  signal?: AbortSignal,
): Promise<UinputDisplayGeometry> {
  const size = await queryDisplaySize(adb, { timeoutMs: GEOMETRY_READ_TIMEOUT_MS });
  const rotation = await readWindowManagerRotation(adb, {
    timeoutMs: GEOMETRY_READ_TIMEOUT_MS,
    signal,
  });
  if (rotation === null) {
    throw new Error("WindowManager did not report the display rotation");
  }
  return { ...size, rotation };
}

/**
 * Pipes the script through base64 on the device (no quoting can break it, the same as the perfetto
 * config) into `uinput -`, then prints the tool's exit status so the shell itself always exits 0.
 */
export async function runAdbUinputScript(
  adb: AdbExecutor,
  script: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<UinputScriptResult> {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const result = await adb.execute(
    ["shell", `echo ${encoded} | base64 -d | uinput - 2>&1; echo ${EXIT_MARKER}$?`],
    { timeoutMs, noRetry: true, signal },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const match = new RegExp(`${EXIT_MARKER}(\\d+)`).exec(output);
  return {
    exitCode: match ? Number(match[1]) : null,
    stderr: output.replace(new RegExp(`${EXIT_MARKER}\\d+`), "").trim(),
  };
}

function scriptFailure(result: UinputScriptResult): ActionableError {
  const output = result.stderr || `exit ${result.exitCode ?? "unknown"}`;
  if (result.exitCode === 127 || /not found/i.test(result.stderr)) {
    return new PointerNotSentError(
      `This device has no uinput tool, so the uinput route cannot inject a stylus: ${output}. No input was sent.`,
    );
  }
  if (/permission denied|eacces/i.test(result.stderr)) {
    return new PointerNotSentError(
      `/dev/uinput is not writable; run adb root on an emulator or userdebug build: ${output}. No input was sent.`,
    );
  }
  return new ActionableError(
    `The uinput pen failed and may have played part of the stroke or hover: ${output}. Verify state with observe before retrying.`,
  );
}

/**
 * The uinput route's transport: register a virtual pen for the default display in its current
 * rotation, play the request, and close the device. Runs are serialised per device so two pens are
 * never live at once.
 */
export function createUinputDispatch(
  adb: AdbExecutor,
  deps: UinputDispatchDeps = {
    readGeometry: (signal) => readAdbGeometry(adb, signal),
    runScript: (script, timeoutMs, signal) => runAdbUinputScript(adb, script, timeoutMs, signal),
  },
): PointerDispatch {
  let lock = dispatchLocks.get(adb);
  if (!lock) {
    lock = new Mutex();
    dispatchLocks.set(adb, lock);
  }
  return async (request, signal) => {
    throwIfAborted(signal);
    if ((request.displayId ?? 0) !== 0) {
      throw new PointerNotSentError(
        `display ${request.displayId} is not supported; the uinput route injects on the default display. No input was sent.`,
      );
    }
    await lock.runExclusive(async () => {
      throwIfAborted(signal);
      const geometry = await deps.readGeometry(signal).catch((error: unknown) => {
        throw signal?.aborted
          ? error
          : new PointerNotSentError(
              `Could not read the display geometry for the uinput pen: ${errorMessage(error)}. No input was sent.`,
            );
      });
      const script = uinputPenScript(request, geometry);
      if (Buffer.byteLength(script, "utf8") * (4 / 3) > MAX_ENCODED_SCRIPT_BYTES) {
        throw new PointerNotSentError(
          "The stroke is too long for one uinput script; split it into shorter gestures. No input was sent.",
        );
      }
      throwIfAborted(signal);
      const result = await deps.runScript(
        script,
        uinputPlannedMs(request.points) + UINPUT_OVERHEAD_MS,
        signal,
      );
      if (result.exitCode !== 0) {
        throw scriptFailure(result);
      }
    });
  };
}
