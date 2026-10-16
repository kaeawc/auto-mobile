import type { ExecResult } from "../../models";
import type { Timer } from "../interfaces/Timer";
import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import type { AdbExecuteOptions, AdbExecutor } from "./interfaces/AdbExecutor";

/** Only the argv execution seam is needed, including for cancellation cleanup. */
export interface AndroidInputTextExecutor extends Pick<AdbExecutor, "execute"> {}

export const INPUT_TEXT_SETTLEMENT_BASE_MS = 3_000;
export const INPUT_TEXT_SETTLEMENT_PER_CHAR_MS = 4;
export const INPUT_TEXT_SETTLEMENT_MAX_MS = 30_000;
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
    // API 31+ cmd is a binder client: system_server keeps typing if it dies.
    // Its natural exit is the completion signal. Pre-31 input execs app_process.
    const input = command.slice("shell ".length);
    const script = `echo $$; exec ${apiLevel !== null && apiLevel >= 31 ? "cmd " : ""}${input}`;
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
      // An unknown API must not risk killing a binder client and releasing early.
      await settleGuestInput(adb, timer, pid, apiLevel !== null && apiLevel < 31, settlementMs);
    }
    // The caller's cancellation/timeout contract must survive best-effort cleanup.
    throw error;
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
