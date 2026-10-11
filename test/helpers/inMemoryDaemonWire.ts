import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient, DaemonUnavailableError } from "../../src/daemon/client";
import {
  DEFAULT_SOCKET_PATH,
  PID_FILE_PATH,
  SOCKET_PATH,
  LOCK_FILE_PATH,
} from "../../src/daemon/constants";
import { UnixSocketServer, type McpClientFactory } from "../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { resolveAutoMobileBaseDir } from "../../src/utils/tempDir";
import type { IdGenerator } from "../../src/utils/IdGenerator";
import type { Timer } from "../../src/utils/SystemTimer";

// The daemon's control socket, in memory (#11441).
//
// Real: `UnixSocketServer`'s connection handler (framing, admission queue, handshake, the
// `daemon/*` request handlers, selector-session restore, forward routing, notification fan-out)
// and `DaemonClient` (framing, response and notification dispatch, request timeouts,
// `daemonResponseError`). Nothing listens: each connection is a pair of in-process socket ends.
// Faked: the kernel socket, and the loopback MCP HTTP hop behind the server (`mcpClientFactory`).
//
// The server is opened by `UnixSocketServer.startDetached()`: `start()` minus the socket file, so
// the accept state and the release, list-changed and resource-updated fan-out are the server's
// own wiring and a scenario fails when one of them is cut. The server is built with no
// feature-flag service and no startup identity options.

/** A socket path no process can bind: the in-memory server is never started on it. */
export const IN_MEMORY_SOCKET_PATH = "in-memory://liveness-scenario/control.sock";
/** The data directory of the in-memory file systems a harness daemon is given. */
export const IN_MEMORY_DATA_DIR = "/in-memory/liveness-scenario";

/**
 * Throws when `candidate` is a path the user's own daemon lives at: its control socket, PID or
 * startup-lock file, anything in the AutoMobile data directory, or a `/tmp/auto-mobile-daemon-*`
 * path. A harness passes every path it hands to production code through this.
 */
export function assertNotHostDaemonPath(label: string, candidate: string): string {
  const resolved = path.resolve(candidate);
  const hostFiles = [SOCKET_PATH, DEFAULT_SOCKET_PATH, PID_FILE_PATH, LOCK_FILE_PATH];
  const hostDirs = [resolveAutoMobileBaseDir(), path.join(homedir(), ".auto-mobile")];
  const touchesHost =
    hostFiles.some((file) => resolved === path.resolve(file)) ||
    hostDirs.some(
      (dir) => resolved === dir || resolved.startsWith(`${path.resolve(dir)}${path.sep}`),
    ) ||
    /[\\/]auto-mobile-daemon-/.test(candidate);
  if (touchesHost) {
    throw new Error(
      `Liveness harness refused ${label} "${candidate}": it belongs to the host's AutoMobile daemon`,
    );
  }
  return candidate;
}

/**
 * One process's view of a clock several in-process "processes" share. When the process dies
 * ({@link kill}) none of its pending timers, intervals or sleeps fires again and it can arm no
 * new one, while the other processes' timers on the shared clock run on.
 */
export class ProcessTimer implements Timer {
  private dead = false;
  private readonly timeouts = new Set<NodeJS.Timeout>();
  private readonly intervals = new Set<NodeJS.Timeout>();

  constructor(private readonly clock: Timer) {}

  /** The process is gone. */
  kill(): void {
    this.dead = true;
    for (const handle of this.timeouts) {
      this.clock.clearTimeout(handle);
    }
    for (const handle of this.intervals) {
      this.clock.clearInterval(handle);
    }
    this.timeouts.clear();
    this.intervals.clear();
  }

  async sleep(ms: number): Promise<void> {
    await this.clock.sleep(ms);
    if (this.dead) {
      await new Promise<never>(() => {});
    }
  }

  setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    const handle = this.clock.setTimeout(
      () => {
        this.timeouts.delete(handle);
        if (!this.dead) {
          callback();
        }
      },
      this.dead ? Number.MAX_SAFE_INTEGER : ms,
    );
    if (this.dead) {
      this.clock.clearTimeout(handle);
    } else {
      this.timeouts.add(handle);
    }
    return handle;
  }

  clearTimeout(handle: NodeJS.Timeout): void {
    this.timeouts.delete(handle);
    this.clock.clearTimeout(handle);
  }

  setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    const handle = this.clock.setInterval(() => {
      if (!this.dead) {
        callback();
      }
    }, ms);
    if (this.dead) {
      this.clock.clearInterval(handle);
    } else {
      this.intervals.add(handle);
    }
    return handle;
  }

  clearInterval(handle: NodeJS.Timeout): void {
    this.intervals.delete(handle);
    this.clock.clearInterval(handle);
  }

  now(): number {
    return this.clock.now();
  }

  monotonicNow(): number {
    return this.clock.monotonicNow?.() ?? this.clock.now();
  }

  get monotonicIncludesHostSleep(): boolean {
    return this.clock.monotonicIncludesHostSleep ?? false;
  }
}

/** One end of an in-process connection; what it writes arrives as `data` on its peer. */
class SocketEnd extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  peer!: SocketEnd;

  setTimeout(): this {
    return this;
  }

  write(data: string | Uint8Array, callback?: (error?: Error | null) => void): boolean {
    if (this.destroyed || this.peer.destroyed) {
      callback?.(new Error("in-memory socket is closed"));
      return false;
    }
    this.peer.emit("data", Buffer.from(data));
    callback?.();
    return true;
  }

  end(): this {
    return this.destroy();
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
      this.peer.destroy();
    }
    return this;
  }
}

/** The client's end of a connection to the in-memory control socket. */
export type InMemoryClientSocket = Pick<SocketEnd, "destroyed" | "write" | "destroy" | "on">;

/** What a killed process takes with it. Teardown only, never wiring. */
interface SocketServerTeardown {
  acceptingRequests: boolean;
  closing: boolean;
  listChangedUnsubscribe: (() => void) | null;
  resourceUpdatedUnsubscribe: (() => void) | null;
  sessionReleaseUnsubscribe: (() => void) | null;
}

/** The ids of the connections the server accepts next, in order. */
export interface ConnectionIdQueue extends IdGenerator {
  enqueue(id: string): void;
}

/** A real {@link UnixSocketServer} that accepts in-process connections instead of listening. */
export class InMemoryControlSocket {
  private readonly daemonEnds = new Set<SocketEnd>();
  private open = true;

  private constructor(
    readonly server: UnixSocketServer,
    private readonly connectionIds: ConnectionIdQueue,
    /** The handler the server's own start gives every accepted connection. */
    private readonly accept: (socket: Socket) => void,
  ) {}

  /**
   * Build the control socket server over the process-wide daemon state, as `Daemon` does, and
   * open it for in-process connections. `loopback` stands in for the MCP HTTP hop.
   */
  static attach(deps: {
    timer: Timer;
    connectionIds: ConnectionIdQueue;
    loopback: McpClientFactory;
    startupOptions?: ConstructorParameters<typeof UnixSocketServer>[5];
  }): InMemoryControlSocket {
    const server = new UnixSocketServer(
      assertNotHostDaemonPath("control socket path", IN_MEMORY_SOCKET_PATH),
      "http://in-memory.invalid/mcp",
      undefined,
      deps.timer,
      null,
      deps.startupOptions ?? {},
      deps.connectionIds,
    );
    server.mcpClientFactory = deps.loopback;
    return new InMemoryControlSocket(server, deps.connectionIds, server.startDetached());
  }

  /** A client connects; the server knows the connection as `connectionId`. */
  connect(connectionId: string): InMemoryClientSocket | undefined {
    if (!this.open) {
      return undefined;
    }
    const daemonEnd = new SocketEnd();
    const clientEnd = new SocketEnd();
    daemonEnd.peer = clientEnd;
    clientEnd.peer = daemonEnd;
    this.daemonEnds.add(daemonEnd);
    daemonEnd.on("close", () => this.daemonEnds.delete(daemonEnd));
    this.connectionIds.enqueue(connectionId);
    this.accept(daemonEnd as unknown as Socket);
    return clientEnd;
  }

  /** The daemon process is gone: every connection drops and nothing is accepted or pushed. */
  kill(): void {
    this.open = false;
    const internals = this.server as unknown as SocketServerTeardown;
    internals.acceptingRequests = false;
    internals.closing = true;
    for (const fanOut of [
      "listChangedUnsubscribe",
      "resourceUpdatedUnsubscribe",
      "sessionReleaseUnsubscribe",
    ] as const) {
      internals[fanOut]?.();
      internals[fanOut] = null;
    }
    for (const end of Array.from(this.daemonEnds)) {
      end.destroy();
    }
  }
}

interface DaemonClientInternals {
  connected: boolean;
  socket: unknown;
  connectionClosedHandlers: Set<() => void>;
  pendingRequests: Map<
    string,
    {
      reject(error: Error): void;
      timeout: NodeJS.Timeout;
      removeAbortListener?: () => void;
      disconnectCause?: unknown;
    }
  >;
  timer: Timer;
}

/**
 * The real {@link DaemonClient} over an in-process connection. Only `connect()` differs: it dials
 * the in-memory control socket instead of a socket file, and wires the data and close listeners
 * the real `connect()` installs on its socket.
 */
export class InMemoryDaemonClient extends DaemonClient {
  constructor(
    private readonly dial: () => InMemoryClientSocket | undefined,
    timer: Timer,
    idGenerator: IdGenerator,
  ) {
    super(
      assertNotHostDaemonPath("client socket path", IN_MEMORY_SOCKET_PATH),
      undefined,
      timer,
      // The stale-socket hint must never read the host's PID file.
      { pidFilePath: `${IN_MEMORY_DATA_DIR}/no-daemon.pid`, isProcessRunning: () => true },
      undefined,
      idGenerator,
    );
  }

  override async connect(): Promise<void> {
    if ((this as unknown as DaemonClientInternals).connected) {
      return;
    }
    const socket = this.dial();
    if (!socket) {
      throw new DaemonUnavailableError(`Daemon socket not found: ${IN_MEMORY_SOCKET_PATH}`);
    }
    socket.on("data", (data: Buffer) => this.simulateIncomingDataForTesting(data));
    socket.on("close", () => this.socketClosed(socket));
    this.attachSocketForTesting(socket as unknown as Duplex);
  }

  /** The socket this client is connected on now, if it is. */
  get liveSocket(): InMemoryClientSocket | undefined {
    const internals = this as unknown as DaemonClientInternals;
    const socket = internals.socket as InMemoryClientSocket | null;
    return internals.connected && socket && !socket.destroyed ? socket : undefined;
  }

  /** `DaemonClient.connectOnce`'s `close` listener. */
  private socketClosed(socket: InMemoryClientSocket): void {
    const internals = this as unknown as DaemonClientInternals;
    if (internals.socket !== null && internals.socket !== socket) {
      return;
    }
    internals.connected = false;
    internals.socket = null;
    for (const handler of Array.from(internals.connectionClosedHandlers)) {
      handler();
    }
    for (const pending of internals.pendingRequests.values()) {
      internals.timer.clearTimeout(pending.timeout);
      pending.removeAbortListener?.();
      pending.reject(
        new DaemonUnavailableError("Daemon socket connection lost: connection closed", {
          cause: pending.disconnectCause,
        }),
      );
    }
    internals.pendingRequests.clear();
  }
}

/** The response envelope a raw frame is answered with, minus its per-request `id` and `type`. */
export type WireEnvelope = Omit<DaemonResponse, "id" | "type">;

/**
 * A client that speaks raw frames (the desktop, a JUnit runner, a `--cli` call): each request
 * resolves with the envelope the socket wrote, success or not.
 */
export class RawFrameClient {
  private socket: InMemoryClientSocket | undefined;
  private readonly waiters = new Map<string, (response: DaemonResponse) => void>();
  private sequence = 0;

  constructor(
    private readonly name: string,
    private readonly dial: () => InMemoryClientSocket | undefined,
  ) {}

  request(method: string, params: Record<string, unknown>): Promise<WireEnvelope> {
    const socket = this.connected();
    const request: DaemonRequest = {
      id: `${this.name}-${++this.sequence}`,
      type: "mcp_request",
      method,
      params,
    };
    const response = new Promise<DaemonResponse>((resolve) => {
      this.waiters.set(request.id, resolve);
    });
    socket.write(`${JSON.stringify(request)}\n`);
    return response.then(({ id: _id, type: _type, ...envelope }) => envelope);
  }

  close(): void {
    this.socket?.destroy();
  }

  private connected(): InMemoryClientSocket {
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }
    const socket = this.dial();
    if (!socket) {
      throw new DaemonUnavailableError(`Daemon socket not found: ${IN_MEMORY_SOCKET_PATH}`);
    }
    socket.on("data", (data: Buffer) => {
      for (const line of data.toString("utf8").split("\n")) {
        if (line.length === 0) {
          continue;
        }
        const frame = JSON.parse(line) as DaemonResponse;
        this.waiters.get(frame.id ?? "")?.(frame);
        this.waiters.delete(frame.id ?? "");
      }
    });
    socket.on("close", () => {
      for (const [id, resolve] of this.waiters) {
        resolve({
          id,
          type: "mcp_response",
          success: false,
          error: "Daemon socket connection lost: connection closed",
        });
      }
      this.waiters.clear();
    });
    this.socket = socket;
    return socket;
  }
}

/** What the loopback MCP hop runs for one forwarded `tools/call`. */
export type LoopbackToolCall = (
  name: string,
  args: Record<string, unknown>,
  /** The MCP request's signal, aborted when the client gives up on the request. */
  requestSignal: AbortSignal,
) => Promise<unknown>;

/**
 * The loopback MCP client the socket server forwards to, without HTTP. A session the connection
 * is bound to travels in the loopback transport header in production (the server strips it from
 * the arguments); it is put back on the arguments here, where the daemon's MCP entry reads it.
 */
export function loopbackMcpClientFactory(
  callTool: LoopbackToolCall,
  timer: Timer,
): McpClientFactory {
  return async (boundSessionUuid) =>
    ({
      callTool: async (
        params: { name: string; arguments?: Record<string, unknown> },
        _resultSchema?: unknown,
        options?: { signal?: AbortSignal; timeout?: number },
      ) => {
        const args = { ...params.arguments };
        if (args.sessionUuid === undefined && boundSessionUuid !== undefined) {
          args.sessionUuid = boundSessionUuid;
        }
        const signal = options?.signal;
        signal?.throwIfAborted();
        // The MCP client gives up on a request two ways: the daemon aborts it (the caller's
        // cancel, or a progress-capable call's deadline), or its own request timeout passes
        // (every other call's deadline). Either way it rejects at once and tells the server,
        // whose handler sees its request signal abort and may still be running.
        const request = new AbortController();
        let stop = () => {};
        const gaveUp = new Promise<never>((_resolve, reject) => {
          const giveUp = (reason: unknown) => {
            request.abort(reason);
            reject(reason);
          };
          const abort = () => giveUp(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          const timeoutMs = options?.timeout;
          const timeout =
            timeoutMs === undefined
              ? undefined
              : timer.setTimeout(
                  () =>
                    giveUp(
                      new McpError(ErrorCode.RequestTimeout, "Request timed out", {
                        timeout: timeoutMs,
                      }),
                    ),
                  timeoutMs,
                );
          stop = () => {
            signal?.removeEventListener("abort", abort);
            if (timeout !== undefined) {
              timer.clearTimeout(timeout);
            }
          };
        });
        try {
          return await Promise.race([callTool(params.name, args, request.signal), gaveUp]);
        } finally {
          stop();
        }
      },
      listTools: async () => ({ tools: [] }),
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      readResource: async () => ({ contents: [] }),
      close: async () => {},
    }) as unknown as Client;
}
