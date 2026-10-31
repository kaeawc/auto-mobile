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
import { MAX_PROTOTYPE_SPEC_BYTES } from "../prototypeSpec";
import { createConnection } from "node:net";
import { ActionableError } from "../../../models/ActionableError";
import type { IdGenerator } from "../../../utils/IdGenerator";
import { errorMessage } from "../../../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import type { PrototypeRequestHost } from "../prototypeRequestHandler";
import type { PrototypeChannelHost } from "../prototypeChannelHost";
import { NodePrototypeAgentSocket } from "./NodePrototypeAgentSocket";
import { LOOPBACK_HOST, SocketPrototypeAgentClient } from "./SocketPrototypeAgentClient";
export { PROTOTYPE_AGENT_PROTOCOL_VERSION } from "./SocketPrototypeAgentClient";
export { PrototypeAgentRequestTimeoutError } from "./PrototypeAgentRequestTimeoutError";
export { PrototypeAgentFrameTooLargeError } from "./PrototypeAgentFrameTooLargeError";

/**
 * Status and events carry state capped at MAX_PROTOTYPE_SPEC_BYTES (1 MiB) by
 * PrototypeStateValidator's JSONEncoder without slash escaping. JSONSerialization
 * doubles slash bytes on the wire: up to ~2 MiB of state. A single-key change
 * copies its value into payload (~4 MiB total); multi-key test-hook changes also
 * repeat keys in payload.keys and payload.values (~6 MiB). The 8 MiB ceiling is
 * above every case, with room for pages/assets/appearance and the event envelope.
 * The agent's 64 MiB inbound budget is for host-to-agent screenshot assets.
 */
export const PROTOTYPE_AGENT_CLIENT_MAX_FRAME_BYTES = 8 * MAX_PROTOTYPE_SPEC_BYTES;

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Request types the host may send; the agent lists the ones it handles in `capabilities`. */
export type PrototypeAgentRequestType =
  | "show_prototype"
  | "patch_prototype"
  | "dismiss_prototype"
  // Wipes a prototype's stored `storage` values (#12522), advertised as `prototype_storage_v1`.
  | "advance_prototype_clock"
  | "clear_prototype_storage"
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
  /** A show of a spec with `window.backdrop` (`prototype_backdrop_v1`): `blur` or `fallback`. */
  backdrop?: string;
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
    options?: { timeoutMs?: number },
  ): Promise<PrototypeAgentResult>;
  /** Subscribes to `prototype_event` pushes; returns an unsubscribe function. */
  onEvent(listener: (event: PrototypeAgentMessage) => void): () => void;
  /** Called once when the connection ends; returns an unsubscribe function. */
  onClosed(listener: (error: Error) => void): () => void;
  /**
   * Routes the agent's `prototype_request` frames (`via: "host"`, #12529) to the host proxy and
   * cancels its running requests when the connection ends. Replaces any earlier host.
   */
  attachRequestHost?(host: PrototypeRequestHost | undefined): void;
  /**
   * Routes the agent's `prototype_channel_*` frames (`via: "host"` channels, #14268) to the host
   * channel proxy and closes its open connections when the connection ends. Replaces any earlier host.
   */
  attachChannelHost?(host: PrototypeChannelHost | undefined): void;
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
  maxFrameBytes?: number;
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
  const client = new SocketPrototypeAgentClient(socket, port, options.timer ?? defaultTimer, {
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxFrameBytes: options.maxFrameBytes ?? PROTOTYPE_AGENT_CLIENT_MAX_FRAME_BYTES,
  });
  await client.authenticate(
    options.token,
    options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
  );
  return client;
}

export interface Waiter {
  resolve: (message: PrototypeAgentResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface PendingHandshake {
  resolve: (handshake: PrototypeAgentHandshake) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
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
