/**
 * Host client for the injected iOS simulator overlay agent (ios/overlay-agent, #10566).
 *
 * The agent listens on a host-allocated loopback port and requires the per-launch token as the
 * first frame: `{type: "hello", token}`. It answers `hello_result` with its build version,
 * protocol version and the request types it handles; anything else, or a wrong token, closes
 * the connection without a reply. After the handshake the connection carries the CtrlProxy
 * overlay message names as newline-delimited JSON: requests answered by `overlay_result`, and
 * unsolicited `overlay_event` pushes. Same-id `show_overlay` is the update path.
 */
import { createConnection, type Socket } from "node:net";
import { ActionableError } from "../../../models/ActionableError";
import type { IdGenerator } from "../../../utils/IdGenerator";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";

/** Must equal `OverlayAgentProtocol.protocolVersion` in the agent. */
export const OVERLAY_AGENT_PROTOCOL_VERSION = 1;
const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Request types the host may send; the agent lists the ones it handles in `capabilities`. */
export type OverlayAgentRequestType =
  | "show_overlay"
  | "dismiss_overlay"
  | "put_overlay_asset"
  | "remove_overlay_asset"
  | "get_overlay_status"
  // Screenshot hide (#9305), advertised together with the `screenshot_hide_overlay_v1` capability.
  | "hide_for_capture"
  | "restore_after_capture"
  // Test hook: the agent advertises it only when launched with
  // AUTOMOBILE_OVERLAY_AGENT_TEST_HOOKS=1 (scripts/ios/overlay-agent-smoke.sh does that).
  | "simulate_tap";

export type OverlayAgentMessage = Record<string, unknown>;

export interface OverlayAgentResult extends OverlayAgentMessage {
  type: "overlay_result";
  requestId: string;
  success: boolean;
  error?: string;
}

export interface OverlayAgentHandshake {
  agentVersion: string;
  protocolVersion: number;
  capabilities: string[];
}

export interface OverlayAgentClient {
  readonly handshake: OverlayAgentHandshake;
  request(type: OverlayAgentRequestType, body?: OverlayAgentMessage): Promise<OverlayAgentResult>;
  /** Subscribes to `overlay_event` pushes; returns an unsubscribe function. */
  onEvent(listener: (event: OverlayAgentMessage) => void): () => void;
  /** Called once when the connection ends; returns an unsubscribe function. */
  onClosed(listener: (error: Error) => void): () => void;
  close(): void;
}

/** A connected byte stream to the agent: UTF-8 text in, text out. */
export interface OverlayAgentSocket {
  write(data: string): void;
  end(): void;
  onData(listener: (chunk: string) => void): void;
  onClose(listener: (error?: Error) => void): void;
}

export interface OverlayAgentConnector {
  /** Connects to the agent on 127.0.0.1:`port`; rejects when nothing is listening. */
  connect(port: number): Promise<OverlayAgentSocket>;
}

/** Port and token for one launch, and the `simctl launch` environment that carries them. */
export interface OverlayAgentLaunchConfig {
  port: number;
  token: string;
  simctlEnvironment: Record<string, string>;
}

/**
 * Builds the per-launch agent configuration. The host allocates the port (one per device and
 * bundle id); the token comes from the injected IdGenerator (crypto-random UUIDs in production).
 */
export function createOverlayAgentLaunchConfig(
  port: number,
  idGenerator: IdGenerator,
): OverlayAgentLaunchConfig {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ActionableError(`Overlay agent port ${port} is not a port in 1..65535.`);
  }
  const token = idGenerator.next();
  return {
    port,
    token,
    simctlEnvironment: {
      SIMCTL_CHILD_AUTOMOBILE_OVERLAY_PORT: String(port),
      SIMCTL_CHILD_AUTOMOBILE_OVERLAY_TOKEN: token,
    },
  };
}

export interface ConnectOverlayAgentOptions {
  port: number;
  token: string;
  connector: OverlayAgentConnector;
  timer?: Timer;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** Connects, authenticates and checks the protocol version; rejects with an ActionableError. */
export async function connectOverlayAgent(
  options: ConnectOverlayAgentOptions,
): Promise<OverlayAgentClient> {
  const { port, connector } = options;
  let socket: OverlayAgentSocket;
  try {
    socket = await connector.connect(port);
  } catch (error) {
    throw new ActionableError(
      `No overlay agent is listening on ${LOOPBACK_HOST}:${port}. Relaunch the app with overlay ` +
        `injection, and check that it is still running (${errorMessage(error)}).`,
      { cause: error },
    );
  }
  const client = new SocketOverlayAgentClient(
    socket,
    port,
    options.timer ?? defaultTimer,
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  await client.authenticate(
    options.token,
    options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
  );
  return client;
}

interface Waiter {
  resolve: (message: OverlayAgentResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingHandshake {
  resolve: (handshake: OverlayAgentHandshake) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

function isObject(value: unknown): value is OverlayAgentMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHandshake(message: OverlayAgentMessage): OverlayAgentHandshake | undefined {
  const { agentVersion, protocolVersion, capabilities } = message;
  if (
    message.type !== "hello_result" ||
    typeof agentVersion !== "string" ||
    typeof protocolVersion !== "number" ||
    !Array.isArray(capabilities) ||
    !capabilities.every((capability): capability is string => typeof capability === "string")
  ) {
    return undefined;
  }
  return { agentVersion, protocolVersion, capabilities };
}

function isResult(message: OverlayAgentMessage): message is OverlayAgentResult {
  return (
    message.type === "overlay_result" &&
    typeof message.requestId === "string" &&
    typeof message.success === "boolean"
  );
}

class SocketOverlayAgentClient implements OverlayAgentClient {
  private buffer = "";
  private nextRequestId = 1;
  private readonly waiters = new Map<string, Waiter>();
  private readonly eventListeners = new Set<(event: OverlayAgentMessage) => void>();
  private readonly closedListeners = new Set<(error: Error) => void>();
  private pendingHandshake: PendingHandshake | undefined;
  private agentHandshake: OverlayAgentHandshake | undefined;
  private closedError: Error | undefined;

  constructor(
    private readonly socket: OverlayAgentSocket,
    private readonly port: number,
    private readonly timer: Timer,
    private readonly requestTimeoutMs: number,
  ) {
    socket.onData((chunk) => this.receive(chunk));
    socket.onClose((error) => this.handleClose(error));
  }

  get handshake(): OverlayAgentHandshake {
    if (this.agentHandshake === undefined) {
      throw new ActionableError("Overlay agent handshake has not completed.");
    }
    return this.agentHandshake;
  }

  authenticate(token: string, timeoutMs: number): Promise<OverlayAgentHandshake> {
    return new Promise((resolve, reject) => {
      const timeout = this.timer.setTimeout(() => {
        this.fail(
          new ActionableError(
            `Overlay agent on ${LOOPBACK_HOST}:${this.port} did not answer the handshake within ` +
              `${timeoutMs} ms. Another process may hold the port; relaunch the app with overlay injection.`,
          ),
        );
      }, timeoutMs);
      this.pendingHandshake = { resolve, reject, timeout };
      this.send({ type: "hello", token, protocolVersion: OVERLAY_AGENT_PROTOCOL_VERSION });
    });
  }

  request(
    type: OverlayAgentRequestType,
    body: OverlayAgentMessage = {},
  ): Promise<OverlayAgentResult> {
    if (this.closedError !== undefined) {
      return Promise.reject(this.closedError);
    }
    if (!this.handshake.capabilities.includes(type)) {
      return Promise.reject(
        new ActionableError(
          `Overlay agent ${this.handshake.agentVersion} does not support ${type}. ` +
            `Supported: ${this.handshake.capabilities.join(", ")}.`,
        ),
      );
    }
    const requestId = `r${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timeout = this.timer.setTimeout(() => {
        this.waiters.delete(requestId);
        reject(
          new ActionableError(
            `Overlay agent did not answer ${type} within ${this.requestTimeoutMs} ms.`,
          ),
        );
      }, this.requestTimeoutMs);
      this.waiters.set(requestId, { resolve, reject, timeout });
      this.send({ ...body, type, requestId });
    });
  }

  onEvent(listener: (event: OverlayAgentMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClosed(listener: (error: Error) => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  close(): void {
    this.fail(new ActionableError("Overlay agent connection was closed by the host."));
  }

  private send(message: OverlayAgentMessage): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0 && this.closedError === undefined) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        this.receiveLine(line);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private receiveLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.fail(
        new ActionableError(`Overlay agent sent a line that is not JSON: ${errorMessage(error)}`),
      );
      return;
    }
    if (!isObject(message)) {
      this.fail(new ActionableError("Overlay agent sent a frame that is not a JSON object."));
      return;
    }
    if (this.pendingHandshake !== undefined) {
      this.completeHandshake(this.pendingHandshake, message);
      return;
    }
    this.dispatch(message);
  }

  private completeHandshake(pending: PendingHandshake, message: OverlayAgentMessage): void {
    const handshake = parseHandshake(message);
    if (handshake === undefined) {
      this.fail(
        new ActionableError(
          `Overlay agent answered the handshake with ${JSON.stringify(message.type)} instead of ` +
            "hello_result. Rebuild the overlay agent from this AutoMobile version and relaunch the app.",
        ),
      );
      return;
    }
    if (handshake.protocolVersion !== OVERLAY_AGENT_PROTOCOL_VERSION) {
      this.fail(
        new ActionableError(
          `Overlay agent ${handshake.agentVersion} speaks protocol ${handshake.protocolVersion}, ` +
            `but this AutoMobile host speaks protocol ${OVERLAY_AGENT_PROTOCOL_VERSION}. Use the ` +
            "overlay agent built for this AutoMobile version and relaunch the app.",
        ),
      );
      return;
    }
    this.pendingHandshake = undefined;
    this.timer.clearTimeout(pending.timeout);
    this.agentHandshake = handshake;
    pending.resolve(handshake);
  }

  private dispatch(message: OverlayAgentMessage): void {
    if (isResult(message)) {
      const waiter = this.waiters.get(message.requestId);
      if (waiter !== undefined) {
        this.waiters.delete(message.requestId);
        this.timer.clearTimeout(waiter.timeout);
        waiter.resolve(message);
        return;
      }
    }
    if (message.type === "overlay_event") {
      this.eventListeners.forEach((listener) => listener(message));
      return;
    }
    // A reply that arrives after its request timed out has nobody waiting; dropping it is safe.
    logger.debug(`[overlay-agent] ignoring unmatched frame: ${JSON.stringify(message)}`);
  }

  private handleClose(error: Error | undefined): void {
    if (this.pendingHandshake !== undefined) {
      this.fail(
        new ActionableError(
          `Overlay agent on ${LOOPBACK_HOST}:${this.port} closed the connection during the ` +
            "handshake. The auth token does not match this launch (or another app holds the port); " +
            "relaunch the app with overlay injection.",
          { cause: error },
        ),
      );
      return;
    }
    const detail = error === undefined ? "" : ` (${errorMessage(error)})`;
    this.fail(
      new ActionableError(
        `Overlay agent closed the connection; the app may have exited${detail}.`,
        {
          cause: error,
        },
      ),
    );
  }

  /** Settles everything still waiting, closes the socket and notifies once. */
  private fail(error: Error): void {
    if (this.closedError !== undefined) {
      return;
    }
    this.closedError = error;
    const pending = this.pendingHandshake;
    this.pendingHandshake = undefined;
    if (pending !== undefined) {
      this.timer.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    for (const waiter of this.waiters.values()) {
      this.timer.clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
    this.socket.end();
    this.closedListeners.forEach((listener) => listener(error));
    this.closedListeners.clear();
  }
}

class NodeOverlayAgentSocket implements OverlayAgentSocket {
  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
  }

  write(data: string): void {
    this.socket.write(data);
  }

  end(): void {
    this.socket.end();
  }

  onData(listener: (chunk: string) => void): void {
    this.socket.on("data", (chunk: string) => listener(chunk));
  }

  onClose(listener: (error?: Error) => void): void {
    let lastError: Error | undefined;
    this.socket.on("error", (error) => {
      lastError = error;
    });
    this.socket.on("close", () => listener(lastError));
  }
}

/** Connects over node:net to the agent's loopback listener. */
export class NodeOverlayAgentConnector implements OverlayAgentConnector {
  connect(port: number): Promise<OverlayAgentSocket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: LOOPBACK_HOST, port });
      const onError = (error: Error) => reject(error);
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(new NodeOverlayAgentSocket(socket));
      });
    });
  }
}
