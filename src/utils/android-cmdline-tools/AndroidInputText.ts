import type { ExecResult } from "../../models";
import type { Timer } from "../interfaces/Timer";
import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import type { AdbExecuteOptions, AdbExecutor } from "./interfaces/AdbExecutor";

/** Only the argv execution seam is needed, including for cancellation cleanup. */
export interface AndroidInputTextExecutor extends Pick<AdbExecutor, "execute"> {}

export const INPUT_TEXT_SETTLEMENT_MS = 3_000;
const INPUT_TEXT_POLL_MS = 75;
const INPUT_TEXT_PROBE_MS = 500;
const MAX_PID_LINE_LENGTH = 32;

/** Execute a pre-quoted `shell input text` plan without releasing a cancelled guest. */
export async function executeAndroidInputText(
  adb: AndroidInputTextExecutor,
  timer: Timer,
  command: string,
  options: AdbExecuteOptions = {},
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
    // API 31+ /system/bin/input is a shell script that waits on `cmd input`.
    // Exec that child directly so terminating our PID stops the actual typing.
    // Older input scripts exec app_process themselves, preserving our PID.
    const script = `if [ "$(getprop ro.build.version.sdk)" -ge 31 ]; then echo $$; exec cmd ${command.slice("shell ".length)}; else echo $$; exec ${command.slice("shell ".length)}; fi`;
    return await adb.execute(["shell", script], {
      ...options,
      // Retrying can launch a second, untracked guest after a partially-typed failure.
      noRetry: true,
      waitForProcessSettlementAfterAbort: true,
      onStdout,
    });
  } catch (error) {
    if (pid === undefined) {
      logger.warn("[ADB input text] Guest PID unavailable; using host process settlement only");
    } else {
      logger.warn(`[ADB input text] Dispatch failed; settling guest PID ${pid}`);
      await settleGuestInput(adb, timer, pid);
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
    `if [ -r /proc/${pid}/cmdline ]; then cmdline=$(tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null); case "$cmdline" in ${input}) ${terminate ? `kill ${pid} 2>/dev/null; ` : ""}echo alive;; esac; fi`,
  ];
}

async function settleGuestInput(
  adb: AndroidInputTextExecutor,
  timer: Timer,
  pid: number,
): Promise<void> {
  const deadline = timer.now() + INPUT_TEXT_SETTLEMENT_MS;
  const controller = new AbortController();
  let expired = false;
  const poll = async () => {
    let terminate = true;
    while (!expired && timer.now() < deadline) {
      try {
        const result = await adb.execute(guestInputProbe(pid, terminate), {
          signal: controller.signal,
          timeoutMs: Math.min(INPUT_TEXT_PROBE_MS, deadline - timer.now()),
          noRetry: true,
        });
        if (result.stdout.trim() !== "alive") {
          return;
        }
      } catch (error) {
        if (!expired) {
          logger.warn(`[ADB input text] Could not verify guest PID ${pid}`, error);
        }
      }
      terminate = false;
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
      timeoutMs: INPUT_TEXT_SETTLEMENT_MS,
      label: "Android input text guest settlement",
      onTimeout: () => {
        expired = true;
        controller.abort();
      },
    });
  } catch (error) {
    logger.warn(
      `[ADB input text] Guest PID ${pid} settlement deadline expired after ${INPUT_TEXT_SETTLEMENT_MS}ms`,
      error,
    );
  }
}
