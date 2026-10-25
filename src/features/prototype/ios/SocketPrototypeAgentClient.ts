import { LineFramer } from "../../../daemon/wire/LineFramer";
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { type Timer } from "../../../utils/SystemTimer";
import type { PrototypeRequestHost, PrototypeResponseSender } from "../prototypeRequestHandler";
import {
  PROTOTYPE_REQUEST_CANCEL_MESSAGE_TYPE,
  PROTOTYPE_REQUEST_MESSAGE_TYPE,
  PROTOTYPE_RESPONSE_MESSAGE_TYPE,
} from "../prototypeRequestProtocol";
import { PrototypeAgentFrameTooLargeError } from "./PrototypeAgentFrameTooLargeError";
import { PrototypeAgentRequestTimeoutError } from "./PrototypeAgentRequestTimeoutError";
import type {
  PendingHandshake,
  PrototypeAgentClient,
  PrototypeAgentHandshake,
  PrototypeAgentMessage,
  PrototypeAgentRequestType,
  PrototypeAgentResult,
  PrototypeAgentSocket,
  Waiter,
} from "./prototypeAgentClient";

/** Must equal `PrototypeAgentProtocol.protocolVersion` in the agent. */
export const PROTOTYPE_AGENT_PROTOCOL_VERSION = 1;

export const LOOPBACK_HOST = "127.0.0.1";

export function isObject(value: unknown): value is PrototypeAgentMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHandshake(
  message: PrototypeAgentMessage,
): PrototypeAgentHandshake | undefined {
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

export function isResult(message: PrototypeAgentMessage): message is PrototypeAgentResult {
  return (
    message.type === "prototype_result" &&
    typeof message.requestId === "string" &&
    typeof message.success === "boolean"
  );
}

export class SocketPrototypeAgentClient implements PrototypeAgentClient {
  private readonly framer: LineFramer;
  private nextRequestId = 1;
  private readonly waiters = new Map<string, Waiter>();
  private readonly eventListeners = new Set<(event: PrototypeAgentMessage) => void>();
  private readonly closedListeners = new Set<(error: Error) => void>();
  private pendingHandshake: PendingHandshake | undefined;
  private agentHandshake: PrototypeAgentHandshake | undefined;
  private closedError: Error | undefined;
  private requestHost: PrototypeRequestHost | undefined;

  constructor(
    private readonly socket: PrototypeAgentSocket,
    private readonly port: number,
    private readonly timer: Timer,
    private readonly requestTimeoutMs: number,
    maxFrameBytes: number,
  ) {
    this.framer = new LineFramer(maxFrameBytes, {
      onLine: (line) => {
        // LineFramer can emit several lines in a push; fail() closes dispatch immediately.
        if (this.closedError === undefined && line.trim()) {
          this.receiveLine(line.trim());
        }
      },
      onOverflow: () => this.fail(new PrototypeAgentFrameTooLargeError(maxFrameBytes)),
    });
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
    options: { timeoutMs?: number } = {},
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
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const requestId = `r${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timeout = this.timer.setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new PrototypeAgentRequestTimeoutError(type, timeoutMs));
      }, timeoutMs);
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

  attachRequestHost(host: PrototypeRequestHost | undefined): void {
    this.requestHost = host;
  }

  close(): void {
    this.fail(new ActionableError("Prototype agent connection was closed by the host."));
  }

  private send(message: PrototypeAgentMessage): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    if (this.closedError === undefined) {
      this.framer.push(chunk);
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
    if (message.type === PROTOTYPE_REQUEST_MESSAGE_TYPE) {
      void this.handlePrototypeRequest(message);
      return;
    }
    if (message.type === PROTOTYPE_REQUEST_CANCEL_MESSAGE_TYPE) {
      this.requestHost?.handleCancel(message);
      return;
    }
    // A reply that arrives after its request timed out has nobody waiting; dropping it is safe.
    logger.debug(`[prototype-agent] ignoring unmatched frame: ${JSON.stringify(message)}`);
  }

  /** Answers one `prototype_request` frame with a `prototype_response` on the same socket. */
  private async handlePrototypeRequest(frame: PrototypeAgentMessage): Promise<void> {
    const send: PrototypeResponseSender = (response) => {
      if (this.closedError !== undefined) {
        throw new Error("Prototype agent connection is closed");
      }
      this.send(response);
    };
    if (this.requestHost === undefined) {
      logger.warn("[prototype-agent] prototype_request received but no host proxy is attached");
      send({
        type: PROTOTYPE_RESPONSE_MESSAGE_TYPE,
        requestId: typeof frame.requestId === "string" ? frame.requestId : "",
        ok: false,
        error: { code: "network", message: "The host request proxy is not available." },
        durationMs: 0,
      });
      return;
    }
    try {
      await this.requestHost.handleRequest(frame, send);
    } catch (error) {
      // The host replies by itself; an escape here means nobody can be told, so only trace it.
      logger.warn(`[prototype-agent] prototype_request failed: ${errorMessage(error)}`, error);
    }
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
    this.requestHost?.handleDisconnect();
    this.socket.end();
    this.closedListeners.forEach((listener) => listener(error));
    this.closedListeners.clear();
  }
}
