import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { z } from "zod";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { errorMessage } from "../utils/describeUnknownError";
import {
  DAEMON_DEVICE_LEASE_STATUS_METHOD,
  DAEMON_RELINQUISH_DEVICE_LEASE_METHOD,
} from "./constants";
import type {
  ForwardLeaseOwnerProbe,
  ForwardLeaseOwnerReport,
  ForwardLeaseRelinquishProbe,
  ForwardLeaseRelinquishReport,
} from "../features/observe/shared/ctrlProxyForwardLeaseOwnership";

/** Outcome of one request/response exchange over a daemon control socket. */
export type DaemonSocketExchangeOutcome =
  | { kind: "connect-failed"; detail: string }
  | { kind: "timeout" }
  | { kind: "response"; line: string };

/** Sends one newline-framed request and resolves with the first response line. */
export type DaemonSocketExchange = (
  socketPath: string,
  frame: string,
  timeoutMs: number,
  timer: Timer,
) => Promise<DaemonSocketExchangeOutcome>;

/** Bounded wait for the lease owner's answer; a busy owner is never treated as gone. */
export const DEVICE_LEASE_OWNER_QUERY_TIMEOUT_MS = 2_000;

/**
 * A relinquishing owner answers only after closing its CtrlProxy client, which
 * removes its ADB forward, so it gets longer than a status read.
 */
export const DEVICE_LEASE_RELINQUISH_TIMEOUT_MS = 5_000;

const statusSchema = z.object({
  pid: z.number().int(),
  deviceId: z.string(),
  sessionId: z.string().nullable(),
  activeExecutions: z.number().int().nonnegative(),
  inFlightRequests: z.number().int().nonnegative().optional(),
  streaming: z.boolean().optional(),
  idleForMs: z.number().nonnegative().nullable(),
});

const relinquishSchema = statusSchema.extend({
  released: z.boolean(),
  reason: z.string(),
  transient: z.boolean().optional(),
});

const envelopeSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  result: z.unknown().optional(),
});

/** An owner reply, or why there is none; `status`/`relinquish` kinds are added by callers. */
type OwnerAnswer<T> =
  | { kind: "unreachable"; detail: string }
  | { kind: "no-response"; detail: string }
  | { kind: "unsupported"; detail: string }
  | { kind: "answer"; result: T };

/**
 * Asks a forwarding-lease owner over its daemon control socket whether it still
 * uses a device, or to give the lease up when it does not (issue #10497).
 * Observation-only on the socket: it never unlinks or repairs the owner's
 * socket, unlike `DaemonClient.connect`.
 */
export class DaemonDeviceLeaseOwnerProbe
  implements ForwardLeaseOwnerProbe, ForwardLeaseRelinquishProbe
{
  constructor(
    private readonly exchange: DaemonSocketExchange = rawDaemonSocketExchange,
    private readonly timer: Timer = defaultTimer,
    private readonly ids: IdGenerator = defaultIdGenerator,
    private readonly timeoutMs: number = DEVICE_LEASE_OWNER_QUERY_TIMEOUT_MS,
    private readonly relinquishTimeoutMs: number = DEVICE_LEASE_RELINQUISH_TIMEOUT_MS,
  ) {}

  async query(socketPath: string, deviceId: string): Promise<ForwardLeaseOwnerReport> {
    const answer = await this.request(
      socketPath,
      DAEMON_DEVICE_LEASE_STATUS_METHOD,
      deviceId,
      this.timeoutMs,
      statusSchema,
    );
    return answer.kind === "answer" ? { kind: "status", status: answer.result } : answer;
  }

  /** Ask the owner to give the lease up if it no longer uses the device (#10506 review). */
  async requestRelinquish(
    socketPath: string,
    deviceId: string,
  ): Promise<ForwardLeaseRelinquishReport> {
    const answer = await this.request(
      socketPath,
      DAEMON_RELINQUISH_DEVICE_LEASE_METHOD,
      deviceId,
      this.relinquishTimeoutMs,
      relinquishSchema,
    );
    return answer.kind === "answer" ? { kind: "relinquish", result: answer.result } : answer;
  }

  private async request<T>(
    socketPath: string,
    method: string,
    deviceId: string,
    timeoutMs: number,
    resultSchema: z.ZodType<T>,
  ): Promise<OwnerAnswer<T>> {
    const frame =
      JSON.stringify({
        id: this.ids.next(),
        type: "daemon_request",
        method,
        params: { deviceId },
        timeoutMs,
      }) + "\n";
    const outcome = await this.exchange(socketPath, frame, timeoutMs, this.timer);
    if (outcome.kind === "connect-failed") {
      return { kind: "unreachable", detail: outcome.detail };
    }
    if (outcome.kind === "timeout") {
      return { kind: "no-response", detail: `no answer within ${timeoutMs}ms` };
    }
    return parseOwnerResponse(outcome.line, resultSchema);
  }
}

function parseOwnerResponse<T>(line: string, resultSchema: z.ZodType<T>): OwnerAnswer<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return { kind: "unsupported", detail: `unparseable response: ${errorMessage(error)}` };
  }
  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return { kind: "unsupported", detail: "unexpected response shape" };
  }
  if (!envelope.data.success || envelope.data.result === undefined) {
    return { kind: "unsupported", detail: envelope.data.error ?? "request failed" };
  }
  const result = resultSchema.safeParse(envelope.data.result);
  if (!result.success) {
    return { kind: "unsupported", detail: "unexpected response shape" };
  }
  return { kind: "answer", result: result.data };
}

/** Real exchange over a Unix socket / named pipe. */
export const rawDaemonSocketExchange: DaemonSocketExchange = (
  socketPath,
  frame,
  timeoutMs,
  timer,
) =>
  new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let buffer = "";
    const held: { socket?: Socket } = {};
    const settle = (outcome: DaemonSocketExchangeOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      timer.clearTimeout(timeout);
      held.socket?.destroy();
      resolve(outcome);
    };
    // A slow connect or answer means a live but busy owner, never a gone one.
    const timeout = timer.setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
    // A missing Unix socket means nothing listens; Bun raises its connect error
    // synchronously, before listeners attach, so check first (as DaemonSocketReachability does).
    if (process.platform !== "win32" && !existsSync(socketPath)) {
      settle({ kind: "connect-failed", detail: "ENOENT" });
      return;
    }
    // Attach listeners before connecting: Bun on Windows raises a missing-pipe
    // error synchronously inside connect(), which is uncaught with no listener.
    const connection = new Socket();
    held.socket = connection;
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        settle({ kind: "response", line: buffer.slice(0, newline) });
      }
    });
    connection.on("error", (error: NodeJS.ErrnoException) => {
      settle(
        connected ? { kind: "timeout" } : { kind: "connect-failed", detail: error.code ?? "error" },
      );
    });
    connection.on("close", () => {
      settle(connected ? { kind: "timeout" } : { kind: "connect-failed", detail: "closed" });
    });
    try {
      connection.connect(socketPath, () => {
        connected = true;
        connection.write(frame);
      });
    } catch (error) {
      settle({
        kind: "connect-failed",
        detail: (error as NodeJS.ErrnoException).code ?? errorMessage(error),
      });
    }
  });
