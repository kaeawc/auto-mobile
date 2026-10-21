import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { androidIntentArgs, type AndroidIntent } from "./androidIntent";

const BROADCAST_TIMEOUT_MS = 30_000;

export interface SendBroadcastRequest {
  appId: string;
  intent: AndroidIntent;
  userId?: number;
}

export type SendBroadcastResult =
  | {
      delivered: true;
      /** The ordered-broadcast result code receivers set (0 when none did). */
      resultCode: number;
      resultData?: string;
      output: string;
    }
  | {
      delivered: false;
      errorCode: "protected_broadcast" | "permission_denied" | "broadcast_failed";
      error: string;
      output: string;
    };

/** `am broadcast` command line for an explicit broadcast into `appId` (#14081). */
export function broadcastCommand(request: SendBroadcastRequest): string {
  return [
    "am",
    "broadcast",
    ...(request.userId === undefined ? [] : ["--user", String(request.userId)]),
    ...androidIntentArgs(request.appId, request.intent),
  ].join(" ");
}

const COMPLETED = /Broadcast completed: result=(-?\d+)(?:, data="([\s\S]*?)")?\s*$/m;
const PROTECTED = /not allowed to send broadcast ([^\s]+?)(?: from|\s|$)/;

/** Classify `am broadcast` output (stdout and stderr, or a thrown command's message). */
export function parseBroadcastOutput(output: string): SendBroadcastResult {
  const completed = COMPLETED.exec(output);
  if (completed) {
    return {
      delivered: true,
      resultCode: Number(completed[1]),
      ...(completed[2] === undefined ? {} : { resultData: completed[2] }),
      output,
    };
  }
  const protectedAction = PROTECTED.exec(output);
  if (protectedAction) {
    return {
      delivered: false,
      errorCode: "protected_broadcast",
      error:
        `${protectedAction[1]} is a protected system broadcast; only the system can send it, ` +
        "not the adb shell. Use an app-defined action the receiver also accepts.",
      output,
    };
  }
  if (/SecurityException|Permission Denial/.test(output)) {
    return {
      delivered: false,
      errorCode: "permission_denied",
      error: "The broadcast was refused: the shell lacks a permission it requires.",
      output,
    };
  }
  return {
    delivered: false,
    errorCode: "broadcast_failed",
    error: "am broadcast did not report completion.",
    output,
  };
}

/** Sends one explicit broadcast and reports the ordered-broadcast result. */
export class SendBroadcast {
  constructor(private readonly adb: Pick<AdbExecutor, "execute">) {}

  async send(request: SendBroadcastRequest, signal?: AbortSignal): Promise<SendBroadcastResult> {
    const command = broadcastCommand(request);
    try {
      const result = await this.adb.execute(["shell", command], {
        timeoutMs: BROADCAST_TIMEOUT_MS,
        noRetry: true,
        signal,
      });
      return parseBroadcastOutput(`${result.stdout}\n${result.stderr}`.trim());
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // `am` exits non-zero for a refused broadcast; its message carries the reason.
      logger.warn(`[sendBroadcast] am broadcast failed: ${errorMessage(error)}`, error);
      return parseBroadcastOutput(errorMessage(error));
    }
  }
}
