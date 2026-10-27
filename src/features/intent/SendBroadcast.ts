import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { packageListingContains } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
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
      errorCode:
        | "package_not_installed"
        | "no_matching_receiver"
        | "protected_broadcast"
        | "permission_denied"
        | "broadcast_failed";
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

const PRECHECK_TIMEOUT_MS = 10_000;

/** `cmd package query-receivers` for the same explicit intent, listing component names (#14740). */
export function queryReceiversCommand(request: SendBroadcastRequest): string {
  return [
    "cmd",
    "package",
    "query-receivers",
    "--components",
    ...(request.userId === undefined ? [] : ["--user", String(request.userId)]),
    ...androidIntentArgs(request.appId, request.intent),
  ].join(" ");
}

/** Sends one explicit broadcast and reports the ordered-broadcast result. */
export class SendBroadcast {
  constructor(private readonly adb: Pick<AdbExecutor, "execute">) {}

  async send(request: SendBroadcastRequest, signal?: AbortSignal): Promise<SendBroadcastResult> {
    const refused = await this.precheck(request, signal);
    if (refused) {
      return refused;
    }
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

  /**
   * `am broadcast` prints "Broadcast completed: result=0" even when nothing received it, so
   * "delivered" needs a separate check that the package exists and, for an explicit component,
   * that it resolves to a manifest-declared receiver (#14740). A check that cannot run fails open
   * to the broadcast itself.
   */
  private async precheck(
    request: SendBroadcastRequest,
    signal?: AbortSignal,
  ): Promise<SendBroadcastResult | null> {
    const packages = await this.probe(
      `pm list packages${request.userId === undefined ? "" : ` --user ${request.userId}`}`,
      signal,
    );
    if (packages !== null && !packageListingContains(packages, request.appId)) {
      return {
        delivered: false,
        errorCode: "package_not_installed",
        error: `${request.appId} is not installed, so nothing can receive the broadcast.`,
        output: packages,
      };
    }
    if (!request.intent.component) {
      return null;
    }
    const receivers = await this.probe(queryReceiversCommand(request), signal);
    if (receivers !== null && !receivers.includes(`${request.appId}/`)) {
      return {
        delivered: false,
        errorCode: "no_matching_receiver",
        error:
          `${request.appId} declares no receiver ${request.intent.component} for ` +
          `${request.intent.action ?? "this intent"}; the broadcast was not sent.`,
        output: receivers,
      };
    }
    return null;
  }

  private async probe(command: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const result = await this.adb.execute(["shell", command], {
        timeoutMs: PRECHECK_TIMEOUT_MS,
        noRetry: true,
        signal,
      });
      return result.stdout;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      logger.warn(`[sendBroadcast] precheck "${command}" failed: ${errorMessage(error)}`, error);
      return null;
    }
  }
}
