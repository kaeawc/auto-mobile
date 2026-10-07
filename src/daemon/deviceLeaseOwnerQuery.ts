import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { z } from "zod";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { errorMessage } from "../utils/describeUnknownError";
import { DAEMON_DEVICE_LEASE_STATUS_METHOD } from "./constants";
import type {
  ForwardLeaseOwnerProbe,
  ForwardLeaseOwnerReport,
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

const responseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  result: z
    .object({
      pid: z.number().int(),
      deviceId: z.string(),
      sessionId: z.string().nullable(),
      activeExecutions: z.number().int().nonnegative(),
      streaming: z.boolean().optional(),
      idleForMs: z.number().nonnegative().nullable(),
    })
    .optional(),
});

/**
 * Asks a forwarding-lease owner over its daemon control socket whether it still
 * uses a device (issue #10497). Observation-only: it never unlinks or repairs
 * the owner's socket, unlike `DaemonClient.connect`.
 */
export class DaemonDeviceLeaseOwnerProbe implements ForwardLeaseOwnerProbe {
  constructor(
    private readonly exchange: DaemonSocketExchange = rawDaemonSocketExchange,
    private readonly timer: Timer = defaultTimer,
    private readonly ids: IdGenerator = defaultIdGenerator,
    private readonly timeoutMs: number = DEVICE_LEASE_OWNER_QUERY_TIMEOUT_MS,
  ) {}

  async query(socketPath: string, deviceId: string): Promise<ForwardLeaseOwnerReport> {
    const frame =
      JSON.stringify({
        id: this.ids.next(),
        type: "daemon_request",
        method: DAEMON_DEVICE_LEASE_STATUS_METHOD,
        params: { deviceId },
        timeoutMs: this.timeoutMs,
      }) + "\n";
    const outcome = await this.exchange(socketPath, frame, this.timeoutMs, this.timer);
    if (outcome.kind === "connect-failed") {
      return { kind: "unreachable", detail: outcome.detail };
    }
    if (outcome.kind === "timeout") {
      return { kind: "no-response", detail: `no answer within ${this.timeoutMs}ms` };
    }
    return parseLeaseStatusResponse(outcome.line);
  }
}

function parseLeaseStatusResponse(line: string): ForwardLeaseOwnerReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return { kind: "unsupported", detail: `unparseable response: ${errorMessage(error)}` };
  }
  const response = responseSchema.safeParse(parsed);
  if (!response.success) {
    return { kind: "unsupported", detail: "unexpected response shape" };
  }
  if (!response.data.success || !response.data.result) {
    return { kind: "unsupported", detail: response.data.error ?? "request failed" };
  }
  return { kind: "status", status: response.data.result };
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
    let connection: Socket;
    try {
      connection = createConnection(socketPath, () => {
        connected = true;
        connection.write(frame);
      });
    } catch (error) {
      settle({
        kind: "connect-failed",
        detail: (error as NodeJS.ErrnoException).code ?? errorMessage(error),
      });
      return;
    }
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
  });
