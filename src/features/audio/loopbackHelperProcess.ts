import type { Readable, Writable } from "node:stream";
import {
  EmulatorAudioError,
  type EmulatorAudioErrorCode,
} from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";

/** Stderr markers written by the audio-loopback helper, one per line. */
export const LOOPBACK_READY_PREFIX = "audio-loopback-ready:";
export const LOOPBACK_ERROR_PREFIX = "audio-loopback-error:";
/** Opening a CoreAudio device takes milliseconds; this only bounds a wedged helper. */
export const LOOPBACK_READY_TIMEOUT_MS = 5_000;

/** The child-process surface the session drives; narrow so tests can fake it. */
export interface LoopbackHelperProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export type LoopbackHelperSpawner = (helperPath: string, args: string[]) => LoopbackHelperProcess;

export type LoopbackOperation = "inject" | "capture";

/** A helper whose device is open; `exited` settles with its exit code (null when killed). */
export interface RunningLoopbackHelper {
  process: LoopbackHelperProcess;
  exited: Promise<number | null>;
  /** The error the helper reported, as a typed tool error. */
  failure(): EmulatorAudioError;
}

interface HelperReport {
  code: string;
  message: string;
}

function parseError(line: string): HelperReport {
  const rest = line.slice(LOOPBACK_ERROR_PREFIX.length).trim();
  const space = rest.indexOf(" ");
  return space < 0
    ? { code: rest, message: "" }
    : { code: rest.slice(0, space), message: rest.slice(space + 1) };
}

/** The tool error for a helper report; a missing loopback device is "unsupported", not a failure. */
export function loopbackError(
  operation: LoopbackOperation,
  report: HelperReport | undefined,
  exitCode: number | null,
): EmulatorAudioError {
  const unsupported: Record<LoopbackOperation, [string, EmulatorAudioErrorCode]> = {
    inject: ["no_loopback_input", "audio_injection_unsupported"],
    capture: ["no_loopback_output", "audio_capture_unsupported"],
  };
  const [missingCode, code] = unsupported[operation];
  if (report?.code === missingCode) {
    return new EmulatorAudioError(code, report.message);
  }
  const detail = report
    ? `${report.code}: ${report.message}`
    : `the helper exited with code ${exitCode ?? "none"} and reported no error`;
  return new EmulatorAudioError(
    "audio_loopback_failed",
    `The host audio loopback ${operation === "inject" ? "playback" : "capture"} failed (${detail}).`,
  );
}

/**
 * Spawns the helper and resolves once it reports its device open. Rejects with a typed error when the
 * helper reports a failure, exits first, or does not answer within {@link LOOPBACK_READY_TIMEOUT_MS}.
 * `onStdout` is attached before the helper can write anything.
 */
export async function startLoopbackHelper(options: {
  launch: () => LoopbackHelperProcess;
  operation: LoopbackOperation;
  timer: Pick<Timer, "setTimeout" | "clearTimeout">;
  onStdout?: (chunk: Uint8Array) => void;
}): Promise<RunningLoopbackHelper> {
  const child = options.launch();
  let exitCode: number | null = null;
  let report: HelperReport | undefined;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let pending = "";
  child.stderr.on("data", (chunk: Uint8Array | string) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith(LOOPBACK_READY_PREFIX)) {
        markReady();
      } else if (line.startsWith(LOOPBACK_ERROR_PREFIX)) {
        report = parseError(line);
      } else if (line.trim()) {
        logger.debug(`audio-loopback-helper: ${line}`);
      }
    }
  });
  if (options.onStdout) {
    child.stdout.on("data", options.onStdout);
  }
  // A helper that dies mid-write closes the pipe; the exit carries the failure.
  child.stdin.on("error", (error: Error) => {
    logger.debug(`audio-loopback-helper stdin closed: ${error.message}`);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      exitCode = code;
      resolve(code);
    });
    child.once("error", (error) => {
      report ??= { code: "spawn_failed", message: error.message };
      resolve(null);
    });
  });
  const helper: RunningLoopbackHelper = {
    process: child,
    exited,
    failure: () => loopbackError(options.operation, report, exitCode),
  };
  await waitForReady(helper, ready, options, () => report);
  return helper;
}

async function waitForReady(
  helper: RunningLoopbackHelper,
  ready: Promise<void>,
  options: { operation: LoopbackOperation; timer: Pick<Timer, "setTimeout" | "clearTimeout"> },
  report: () => HelperReport | undefined,
): Promise<void> {
  const outcome = await new Promise<"ready" | "timeout" | { code: number | null }>((resolve) => {
    const handle = options.timer.setTimeout(() => resolve("timeout"), LOOPBACK_READY_TIMEOUT_MS);
    const settle = (result: "ready" | { code: number | null }) => {
      options.timer.clearTimeout(handle);
      resolve(result);
    };
    void ready.then(() => settle("ready"));
    void helper.exited.then((code) => settle({ code }));
  });
  if (outcome === "ready") {
    return;
  }
  if (outcome === "timeout") {
    helper.process.kill("SIGKILL");
    throw new EmulatorAudioError(
      "audio_loopback_failed",
      `The audio loopback helper did not open its device within ${LOOPBACK_READY_TIMEOUT_MS} ms.`,
    );
  }
  throw loopbackError(options.operation, report(), outcome.code);
}
