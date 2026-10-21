import type { ExecResult } from "../../models";
import { runOutsideRequestContext } from "../AbortContext";
import type { Timer } from "../interfaces/Timer";
import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import { AdbCommandTimeoutError } from "./AdbClient";
import type { AdbExecuteOptions, AdbExecutor } from "./interfaces/AdbExecutor";

/** Only the argv execution seam is needed, including for cancellation cleanup. */
export interface AndroidInputTextExecutor extends Pick<AdbExecutor, "execute"> {}

export const INPUT_TEXT_SETTLEMENT_BASE_MS = 3_000;
export const INPUT_TEXT_SETTLEMENT_PER_CHAR_MS = 4;
export const INPUT_TEXT_SETTLEMENT_MAX_MS = 30_000;
/** API 31+ host wait: measured ~15-18 ms per char on an API 36 emulator (#12566). */
export const INPUT_TEXT_HOST_WAIT_PER_CHAR_MS = 20;
export const INPUT_TEXT_HOST_WAIT_MAX_MS = 60_000;
/** App-side consumption of `input text` events (~14 ms/char on API 36), see #12599. */
export const INPUT_TEXT_CONSUME_PER_CHAR_MS = 14;
export const INPUT_TEXT_CONSUME_MARGIN_MS = 500;
const INPUT_TEXT_POLL_MS = 75;
const INPUT_TEXT_PROBE_MS = 500;
const MAX_PID_LINE_LENGTH = 32;

interface AndroidInputTextOptions extends AdbExecuteOptions {
  apiLevel: number | null;
  /** Original payload length only; do not duplicate text in cleanup metadata. */
  textLength: number;
}

/** Execute a pre-quoted `shell input text` plan without releasing a cancelled guest. */
export async function executeAndroidInputText(
  adb: AndroidInputTextExecutor,
  timer: Timer,
  command: string,
  { apiLevel, textLength, ...options }: AndroidInputTextOptions,
): Promise<ExecResult> {
  const input = command.slice("shell ".length);
  const binderClient = apiLevel === null || apiLevel >= 31;
  if (binderClient) {
    return executeUntilHostExit(
      adb,
      timer,
      `echo $$; exec ${apiLevel === null ? "" : "cmd "}${input}`,
      textLength,
      options,
    );
  }
  let pid: number | undefined;
  let firstLine = "";
  let readFirstLine = false;
  const onStdout = (chunk: string) => {
    if (readFirstLine) {
      return;
    }
    firstLine += chunk.slice(0, MAX_PID_LINE_LENGTH + 1);
    const newline = firstLine.indexOf("\n");
    if (newline < 0 && firstLine.length <= MAX_PID_LINE_LENGTH) {
      return;
    }
    readFirstLine = true;
    if (newline < 0 || newline > MAX_PID_LINE_LENGTH) {
      return;
    }
    const line = firstLine.slice(0, newline).trim();
    const value = /^\d+$/.test(line) ? Number(line) : NaN;
    if (Number.isSafeInteger(value) && value > 0) {
      pid = value;
    }
  };
  try {
    // Pre-31 input execs app_process, so the guest PID is the typing process itself.
    const script = `echo $$; exec ${input}`;
    return await adb.execute(["shell", script], {
      ...options,
      // noRetry is forced: replay could launch an untracked, partially duplicated guest.
      noRetry: true,
      waitForProcessSettlementAfterAbort: true,
      onStdout,
    });
  } catch (error) {
    if (pid === undefined) {
      // Known gap: abort before the PID chunk arrives leaves an untracked guest.
      logger.warn("[ADB input text] Guest PID unavailable; using host process settlement only");
    } else {
      logger.warn(`[ADB input text] Dispatch failed; settling guest PID ${pid}`);
      const settlementMs = Math.min(
        INPUT_TEXT_SETTLEMENT_MAX_MS,
        INPUT_TEXT_SETTLEMENT_BASE_MS + INPUT_TEXT_SETTLEMENT_PER_CHAR_MS * textLength,
      );
      await settleGuestInput(adb, timer, pid, true, settlementMs);
    }
    // The caller's cancellation/timeout contract must survive best-effort cleanup.
    throw error;
  }
}

/**
 * API 31+ (and unknown API): `cmd input text` is only a binder client and system_server types.
 * Killing the host adb client closes the shell stream and kills `cmd`, yet typing continues
 * with nothing left to observe (#12566). So the host client is never given the request's abort
 * signal or timeout (nor the ambient request signal): cancel or timeout only stops waiting for
 * a result, then holds until the host exits on its own, then lets the app drain
 * the handed-over events (host exit alone is not "typing done", #12599).
 */
async function executeUntilHostExit(
  adb: AndroidInputTextExecutor,
  timer: Timer,
  script: string,
  textLength: number,
  { signal, timeoutMs, ...options }: AdbExecuteOptions,
): Promise<ExecResult> {
  signal?.throwIfAborted();
  const holdMs = hostWaitMs(textLength);
  const hostController = new AbortController();
  let typingStarted = false;
  const host = runOutsideRequestContext(() =>
    adb.execute(["shell", script], {
      ...options,
      // noRetry is forced: replay could launch an untracked, partially duplicated guest.
      noRetry: true,
      // The adb client would otherwise apply its own 15 s default and kill `cmd` mid-typing:
      // the caller's budget plus the hold is the backstop for a host that never exits.
      timeoutMs: (timeoutMs ?? 0) + holdMs,
      signal: hostController.signal,
      // The `echo $$` line proves the guest shell is running, so typing may have begun.
      onStdout: (chunk) => {
        typingStarted ||= chunk.length > 0;
      },
    }),
  );
  const dispatchedAt = timer.now();
  let hostExited = false;
  let hostFailed = false;
  host.then(
    () => {
      hostExited = true;
    },
    () => {
      hostExited = true;
      hostFailed = true;
    },
  );
  try {
    const result = await raceWithDeadline(host, {
      timer,
      timeoutMs,
      signal,
      label: "Android input text",
      timeoutError: () =>
        new AdbCommandTimeoutError(`Android input text timed out after ${timeoutMs}ms`),
    });
    // The host exits when the events are handed over, not when the app has consumed them:
    // pace the call to the consumption rate (not faster, or the backlog grows per chunk) so the backlog a cancel can strand stays small.
    const paceMs = INPUT_TEXT_CONSUME_PER_CHAR_MS * textLength - (timer.now() - dispatchedAt);
    if (paceMs > 0) {
      await pause(timer, paceMs, signal);
    }
    return result;
  } catch (error) {
    // A host that failed by itself says nothing about typing in flight: no drain wait for it.
    const failedOnItsOwn = hostFailed;
    if (!hostExited) {
      if (!typingStarted) {
        // Nothing reached system_server yet: killing the host cannot strand typing, and it
        // stops a stalled dispatch from typing after the caller has moved on.
        hostController.abort(error);
      }
      await waitForHostExit(timer, host, holdMs);
      // Past the hold the caller moves on; do not let a stuck host type late.
      hostController.abort(error);
    }
    if (typingStarted && !failedOnItsOwn) {
      // Host exit is not "typing done" (#12599): let the app drain what was handed over.
      await timer.sleep(INPUT_TEXT_CONSUME_PER_CHAR_MS * textLength + INPUT_TEXT_CONSUME_MARGIN_MS);
    }
    // The caller's cancellation/timeout contract must survive the wait.
    throw error;
  }
}

/** A cancellable delay that stays out of `Timer.sleep` history, which tests use as a settle-poll count. */
function pause(timer: Timer, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      timer.clearTimeout(handle);
      reject(signal?.reason);
    };
    const handle = timer.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function hostWaitMs(textLength: number): number {
  return Math.min(
    INPUT_TEXT_HOST_WAIT_MAX_MS,
    INPUT_TEXT_SETTLEMENT_BASE_MS + INPUT_TEXT_HOST_WAIT_PER_CHAR_MS * textLength,
  );
}

async function waitForHostExit(
  timer: Timer,
  host: Promise<ExecResult>,
  settlementMs: number,
): Promise<void> {
  logger.warn(`[ADB input text] Cancelled; holding for the host client up to ${settlementMs}ms`);
  try {
    await raceWithDeadline(
      host.then(
        () => undefined,
        () => undefined,
      ),
      { timer, timeoutMs: settlementMs, label: "Android input text host settlement" },
    );
  } catch (error) {
    logger.warn(
      `[ADB input text] Host client settlement deadline expired after ${settlementMs}ms`,
      error,
    );
  }
}

/** Match executable/argument positions, never a substring in another process's payload. */
function guestInputProbe(pid: number, terminate: boolean): string[] {
  const input = [
    "input text ",
    "/system/bin/input text ",
    "sh /system/bin/input text ",
    "/system/bin/sh /system/bin/input text ",
    "cmd input text ",
    "/system/bin/cmd input text ",
    "app_process /system/bin com.android.commands.input.Input text ",
    "/system/bin/app_process /system/bin com.android.commands.input.Input text ",
  ]
    .map((prefix) => `"${prefix}"*`)
    .join("|");
  return [
    "shell",
    // Missing tr (or an unreadable cmdline) falls back to bounded natural-exit polling.
    `if [ -r /proc/${pid}/cmdline ]; then if cmdline=$(tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null); then case "$cmdline" in ${input}) ${terminate ? `kill ${pid} 2>/dev/null; ` : ""}echo alive;; esac; else echo alive; fi; fi`,
  ];
}

async function settleGuestInput(
  adb: AndroidInputTextExecutor,
  timer: Timer,
  pid: number,
  terminate: boolean,
  settlementMs: number,
): Promise<void> {
  const deadline = timer.now() + settlementMs;
  const controller = new AbortController();
  let expired = false;
  const poll = async () => {
    while (!expired && timer.now() < deadline) {
      try {
        const result = await adb.execute(guestInputProbe(pid, terminate), {
          signal: controller.signal,
          timeoutMs: Math.min(INPUT_TEXT_PROBE_MS, deadline - timer.now()),
          noRetry: true,
        });
        terminate = false;
        if (result.stdout.trim() !== "alive") {
          return;
        }
      } catch (error) {
        if (expired) {
          // The deadline already reported this failure; a late abort is expected.
          logger.debug(
            `[ADB input text] Probe for guest PID ${pid} ended after settlement deadline`,
            error,
          );
        } else {
          logger.warn(`[ADB input text] Could not verify guest PID ${pid}`, error);
        }
      }
      const remainingMs = deadline - timer.now();
      if (expired || remainingMs <= 0) {
        return;
      }
      await timer.sleep(Math.min(INPUT_TEXT_POLL_MS, remainingMs));
    }
  };
  try {
    await raceWithDeadline(poll, {
      timer,
      timeoutMs: settlementMs,
      label: "Android input text guest settlement",
      onTimeout: () => {
        expired = true;
        controller.abort();
      },
    });
  } catch (error) {
    logger.warn(
      `[ADB input text] Guest PID ${pid} settlement deadline expired after ${settlementMs}ms`,
      error,
    );
  }
}
