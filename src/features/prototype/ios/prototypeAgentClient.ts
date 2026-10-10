/**
 * Host client for the injected iOS simulator prototype agent (ios/prototype-agent, #10566).
 *
 * The agent listens on a host-allocated loopback port and requires the per-launch token as the
 * first frame: `{type: "hello", token}`. It answers `hello_result` with its build version,
 * protocol version and the request types it handles; anything else, or a wrong token, closes
 * the connection without a reply. After the handshake the connection carries the CtrlProxy
 * prototype message names as newline-delimited JSON: requests answered by `prototype_result`, and
 * unsolicited `prototype_event` pushes. Same-id `show_prototype` is the update path.
 */
import { createConnection, type Socket } from "node:net";
import { ActionableError } from "../../../models/ActionableError";
import type { IdGenerator } from "../../../utils/IdGenerator";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";

/** Must equal `PrototypeAgentProtocol.protocolVersion` in the agent. */
export const PROTOTYPE_AGENT_PROTOCOL_VERSION = 1;
const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Request types the host may send; the agent lists the ones it handles in `capabilities`. */
export type PrototypeAgentRequestType =
  | "show_prototype"
  | "dismiss_prototype"
  | "put_prototype_asset"
  | "remove_prototype_asset"
  | "get_prototype_status"
  // Screenshot hide (#9305), advertised together with the `screenshot_hide_prototype_v1` capability.
  | "hide_for_capture"
  | "restore_after_capture"
  // Test hook: the agent advertises it only when launched with
  // AUTOMOBILE_PROTOTYPE_AGENT_TEST_HOOKS=1 (scripts/ios/prototype-agent-smoke.sh does that).
  | "simulate_tap";

export type PrototypeAgentMessage = Record<string, unknown>;

export interface PrototypeAgentResult extends PrototypeAgentMessage {
  type: "prototype_result";
  requestId: string;
  success: boolean;
  error?: string;
}

export interface PrototypeAgentHandshake {
  agentVersion: string;
  protocolVersion: number;
  capabilities: string[];
}

export interface PrototypeAgentClient {
  readonly handshake: PrototypeAgentHandshake;
  request(
    type: PrototypeAgentRequestType,
    body?: PrototypeAgentMessage,
  ): Promise<PrototypeAgentResult>;
  /** Subscribes to `prototype_event` pushes; returns an unsubscribe function. */
  onEvent(listener: (event: PrototypeAgentMessage) => void): () => void;
  /** Called once when the connection ends; returns an unsubscribe function. */
  onClosed(listener: (error: Error) => void): () => void;
  close(): void;
}

/** A connected byte stream to the agent: UTF-8 text in, text out. */
export interface PrototypeAgentSocket {
  write(data: string): void;
  end(): void;
  onData(listener: (chunk: string) => void): void;
  onClose(listener: (error?: Error) => void): void;
}

export interface PrototypeAgentConnector {
  /** Connects to the agent on 127.0.0.1:`port`; rejects when nothing is listening. */
  connect(port: number): Promise<PrototypeAgentSocket>;
}

/** Port and token for one launch, and the `simctl launch` environment that carries them. */
export interface PrototypeAgentLaunchConfig {
  port: number;
  token: string;
  simctlEnvironment: Record<string, string>;
}

/**
 * Builds the per-launch agent configuration. The host allocates the port (one per device and
 * bundle id); the token comes from the injected IdGenerator (crypto-random UUIDs in production).
 */
export function createPrototypeAgentLaunchConfig(
  port: number,
  idGenerator: IdGenerator,
): PrototypeAgentLaunchConfig {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ActionableError(`Prototype agent port ${port} is not a port in 1..65535.`);
  }
  const token = idGenerator.next();
  return {
    port,
    token,
    simctlEnvironment: {
      SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_PORT: String(port),
      SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_TOKEN: token,
    },
  };
}

export interface ConnectPrototypeAgentOptions {
  port: number;
  token: string;
  connector: PrototypeAgentConnector;
  timer?: Timer;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** Connects, authenticates and checks the protocol version; rejects with an ActionableError. */
export async function connectPrototypeAgent(
  options: ConnectPrototypeAgentOptions,
): Promise<PrototypeAgentClient> {
  const { port, connector } = options;
  let socket: PrototypeAgentSocket;
  try {
    socket = await connector.connect(port);
  } catch (error) {
    throw new ActionableError(
      `No prototype agent is listening on ${LOOPBACK_HOST}:${port}. Relaunch the app with prototype ` +
        `injection, and check that it is still running (${errorMessage(error)}).`,
      { cause: error },
    );
  }
  const client = new SocketPrototypeAgentClient(
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
  resolve: (message: PrototypeAgentResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingHandshake {
  resolve: (handshake: PrototypeAgentHandshake) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

function isObject(value: unknown): value is PrototypeAgentMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHandshake(message: PrototypeAgentMessage): PrototypeAgentHandshake | undefined {
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

function isResult(message: PrototypeAgentMessage): message is PrototypeAgentResult {
  return (
    message.type === "prototype_result" &&
    typeof message.requestId === "string" &&
    typeof message.success === "boolean"
  );
}

class SocketPrototypeAgentClient implements PrototypeAgentClient {
  private buffer = "";
  private nextRequestId = 1;
  private readonly waiters = new Map<string, Waiter>();
  private readonly eventListeners = new Set<(event: PrototypeAgentMessage) => void>();
  private readonly closedListeners = new Set<(error: Error) => void>();
  private pendingHandshake: PendingHandshake | undefined;
  private agentHandshake: PrototypeAgentHandshake | undefined;
  private closedError: Error | undefined;

  constructor(
    private readonly socket: PrototypeAgentSocket,
    private readonly port: number,
    private readonly timer: Timer,
    private readonly requestTimeoutMs: number,
  ) {
    socket.onData((chunk) => this.receive(chunk));
    socket.onClose((error) => this.handleClose(error));
  }

  get handshake(): PrototypeAgentHandshake {
    if (this.agentHandshake === undefined) {
      throw new ActionableError("Prototype agent handshake has not completed.");
    }
    return this.agentHandshake;
  }

  authenticate(token: string, timeoutMs: number): Promise<PrototypeAgentHandshake> {
    return new Promise((resolve, reject) => {
      const timeout = this.timer.setTimeout(() => {
        this.fail(
          new ActionableError(
            `Prototype agent on ${LOOPBACK_HOST}:${this.port} did not answer the handshake within ` +
              `${timeoutMs} ms. Another process may hold the port; relaunch the app with prototype injection.`,
          ),
        );
      }, timeoutMs);
      this.pendingHandshake = { resolve, reject, timeout };
      this.send({ type: "hello", token, protocolVersion: PROTOTYPE_AGENT_PROTOCOL_VERSION });
    });
  }

  request(
    type: PrototypeAgentRequestType,
    body: PrototypeAgentMessage = {},
  ): Promise<PrototypeAgentResult> {
    if (this.closedError !== undefined) {
      return Promise.reject(this.closedError);
    }
    if (!this.handshake.capabilities.includes(type)) {
      return Promise.reject(
        new ActionableError(
          `Prototype agent ${this.handshake.agentVersion} does not support ${type}. ` +
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
            `Prototype agent did not answer ${type} within ${this.requestTimeoutMs} ms.`,
          ),
        );
      }, this.requestTimeoutMs);
      this.waiters.set(requestId, { resolve, reject, timeout });
      this.send({ ...body, type, requestId });
    });
  }

  onEvent(listener: (event: PrototypeAgentMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClosed(listener: (error: Error) => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  close(): void {
    this.fail(new ActionableError("Prototype agent connection was closed by the host."));
  }

  private send(message: PrototypeAgentMessage): void {
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
        new ActionableError(`Prototype agent sent a line that is not JSON: ${errorMessage(error)}`),
      );
      return;
    }
    if (!isObject(message)) {
      this.fail(new ActionableError("Prototype agent sent a frame that is not a JSON object."));
      return;
    }
    if (this.pendingHandshake !== undefined) {
      this.completeHandshake(this.pendingHandshake, message);
      return;
    }
    this.dispatch(message);
  }

  private completeHandshake(pending: PendingHandshake, message: PrototypeAgentMessage): void {
    const handshake = parseHandshake(message);
    if (handshake === undefined) {
      this.fail(
        new ActionableError(
          `Prototype agent answered the handshake with ${JSON.stringify(message.type)} instead of ` +
            "hello_result. Rebuild the prototype agent from this AutoMobile version and relaunch the app.",
        ),
      );
      return;
    }
    if (handshake.protocolVersion !== PROTOTYPE_AGENT_PROTOCOL_VERSION) {
      this.fail(
        new ActionableError(
          `Prototype agent ${handshake.agentVersion} speaks protocol ${handshake.protocolVersion}, ` +
            `but this AutoMobile host speaks protocol ${PROTOTYPE_AGENT_PROTOCOL_VERSION}. Use the ` +
            "prototype agent built for this AutoMobile version and relaunch the app.",
        ),
      );
      return;
    }
    this.pendingHandshake = undefined;
    this.timer.clearTimeout(pending.timeout);
    this.agentHandshake = handshake;
    pending.resolve(handshake);
  }

  private dispatch(message: PrototypeAgentMessage): void {
    if (isResult(message)) {
      const waiter = this.waiters.get(message.requestId);
      if (waiter !== undefined) {
        this.waiters.delete(message.requestId);
        this.timer.clearTimeout(waiter.timeout);
        waiter.resolve(message);
        return;
      }
    }
    if (message.type === "prototype_event") {
      this.eventListeners.forEach((listener) => listener(message));
      return;
    }
    // A reply that arrives after its request timed out has nobody waiting; dropping it is safe.
    logger.debug(`[prototype-agent] ignoring unmatched frame: ${JSON.stringify(message)}`);
  }

  private handleClose(error: Error | undefined): void {
    if (this.pendingHandshake !== undefined) {
      this.fail(
        new ActionableError(
          `Prototype agent on ${LOOPBACK_HOST}:${this.port} closed the connection during the ` +
            "handshake. The auth token does not match this launch (or another app holds the port); " +
            "relaunch the app with prototype injection.",
          { cause: error },
        ),
      );
      return;
    }
    const detail = error === undefined ? "" : ` (${errorMessage(error)})`;
    this.fail(
      new ActionableError(
        `Prototype agent closed the connection; the app may have exited${detail}.`,
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

class NodePrototypeAgentSocket implements PrototypeAgentSocket {
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
export class NodePrototypeAgentConnector implements PrototypeAgentConnector {
  connect(port: number): Promise<PrototypeAgentSocket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: LOOPBACK_HOST, port });
      const onError = (error: Error) => reject(error);
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(new NodePrototypeAgentSocket(socket));
      });
    });
  }
}
