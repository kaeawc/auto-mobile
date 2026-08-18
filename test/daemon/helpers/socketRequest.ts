import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import type { DaemonRequest, DaemonResponse } from "../../../src/daemon/types";

/**
 * Canonical BOUNDED unix-socket request helpers for the daemon socket-server
 * suites.
 *
 * Every suite that talks to a real `UnixSocketServer` over a real unix domain
 * socket must go through these instead of hand-rolling a `Socket` + `Promise`
 * pair: a raw read on a socket the server never answers never settles, and the
 * leaked handle keeps the worker process alive after the test times out —
 * exactly the hang class that wedged the macos CI `bun test` run behind the
 * #5391 watchdog. Each helper enforces a hard client-side deadline and
 * destroys its socket on EVERY settle path (response, error, close, deadline),
 * so a server bug degrades into a fast red failure with a diagnostic instead
 * of a silent 12-minute wall-clock abort.
 */

/**
 * Hard client-side ceiling for one connect + write + response round trip over
 * a loopback unix socket. Healthy round trips take single-digit milliseconds;
 * 10s absorbs macos-runner contention while still failing an actually-hung
 * server well inside bun's 20s CI test timeout.
 */
export const SOCKET_REQUEST_DEADLINE_MS = 10_000;

export interface SocketRequestOptions {
  /** Hard client-side deadline for the whole round trip. */
  deadlineMs?: number;
  /** Runs inside the connect callback, before the request line is written. */
  onConnect?: () => void;
  /**
   * "first" (default) resolves on the first complete JSON frame and destroys
   * the socket immediately. "drain" half-closes after each frame and resolves
   * on close with the LAST frame plus the total frame count, so a test can
   * assert exactly how many frames the server wrote.
   */
  resolveOn?: "first" | "drain";
}

export interface SocketRequestResult {
  response: DaemonResponse;
  /** Complete JSON frames received before the promise settled. */
  frameCount: number;
}

/**
 * Send one newline-framed JSON request over a fresh unix-socket connection and
 * resolve with the response. An `id` is generated unless `request` carries one.
 */
export function sendRawSocketRequest(
  socketPath: string,
  request: DaemonRequest | Record<string, unknown>,
  options: SocketRequestOptions = {},
): Promise<SocketRequestResult> {
  const { deadlineMs = SOCKET_REQUEST_DEADLINE_MS, onConnect, resolveOn = "first" } = options;
  const label = String((request as Record<string, unknown>).method ?? (request as Record<string, unknown>).type ?? "request");
  return new Promise((resolve, reject) => {
    const client = new Socket();
    let buffer = "";
    let frameCount = 0;
    let lastResponse: DaemonResponse | undefined;
    let settled = false;

    const settle = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      defaultTimer.clearTimeout(deadline);
      client.destroy();
      action();
    };
    const deadline = defaultTimer.setTimeout(() => {
      settle(() => reject(new Error(
        `No response to ${label} on ${socketPath} within ${deadlineMs}ms — `
        + "bounded socket-test deadline hit (the server hung or dropped the request)"
      )));
    }, deadlineMs);

    client.connect(socketPath, () => {
      onConnect?.();
      client.write(JSON.stringify({ id: randomUUID(), ...request }) + "\n");
    });

    client.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        let parsed: DaemonResponse;
        try {
          parsed = JSON.parse(line) as DaemonResponse;
        } catch {
          // Not yet a complete/valid frame; keep reading until the deadline.
          continue;
        }
        frameCount++;
        lastResponse = parsed;
        if (resolveOn === "first") {
          settle(() => resolve({ response: parsed, frameCount }));
          return;
        }
        client.end();
      }
    });

    client.on("error", error => settle(() => reject(error)));
    client.on("close", () => {
      const response = lastResponse;
      if (response) {
        settle(() => resolve({ response, frameCount }));
      } else {
        settle(() => reject(new Error("Connection closed without response")));
      }
    });
  });
}

/**
 * The common `mcp_request` round trip. `requestTimeoutMs` is the SERVER-side
 * per-request timeout embedded in the request payload — the client-side
 * deadline is `options.deadlineMs`.
 */
export async function sendSocketRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  requestTimeoutMs?: number,
  options: SocketRequestOptions = {},
): Promise<DaemonResponse> {
  const request: DaemonRequest = {
    id: randomUUID(),
    type: "mcp_request",
    method,
    params,
    ...(requestTimeoutMs === undefined ? {} : { timeoutMs: requestTimeoutMs }),
  };
  const { response } = await sendRawSocketRequest(socketPath, request, options);
  return response;
}

/**
 * Await an already-configured client socket's `connect` (or reject on `error`
 * or after `deadlineMs`), for stream suites that attach `data` handlers before
 * connecting. Destroys the socket on the failure paths so nothing leaks.
 */
export function connectBounded(
  socket: Socket,
  socketPath: string,
  deadlineMs: number = SOCKET_REQUEST_DEADLINE_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void, destroy: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      defaultTimer.clearTimeout(deadline);
      socket.off("error", onError);
      if (destroy) {
        socket.destroy();
      }
      action();
    };
    const deadline = defaultTimer.setTimeout(() => {
      settle(() => reject(new Error(
        `Socket did not connect to ${socketPath} within ${deadlineMs}ms — bounded socket-test deadline hit`
      )), true);
    }, deadlineMs);
    const onError = (error: Error) => settle(() => reject(error), true);
    socket.once("error", onError);
    socket.connect(socketPath, () => settle(() => resolve(), false));
  });
}
