import { posix } from "node:path";
import { LineFramer } from "../../../daemon/socketServer/LineFramer";
import type { BootedDevice } from "../../../models";
import { ActionableError } from "../../../models/ActionableError";
import { DefaultFileSystem, type FileSystem } from "../../../utils/filesystem/DefaultFileSystem";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../../utils/logger";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY } from "../../observe/android/ctrlProxyProtocol";
import type { PrototypeAgentConnections } from "./iosPrototypeTransport";
import {
  connectPrototypeAgent,
  NodePrototypeAgentConnector,
  PROTOTYPE_AGENT_CLIENT_MAX_FRAME_BYTES,
  type PrototypeAgentClient,
  type PrototypeAgentConnector,
  type PrototypeAgentMessage,
  type PrototypeAgentRequestType,
  type PrototypeAgentResult,
  type PrototypeAgentSocket,
} from "./prototypeAgentClient";
import type { PrototypeAgentConnect } from "./prototypeAgentInjection";
import {
  parsePrototypeViewerEndpoint,
  PROTOTYPE_VIEWER_ENDPOINT_RELATIVE_PATH,
} from "./prototypeViewerEndpoint";

// Simulator and prototype container paths are POSIX on every host OS.
const { join } = posix;

const REPLAY_LIMIT = 256;

export interface PrototypeViewerRecord {
  bundleId: string;
  client: PrototypeAgentClient;
}

export interface PrototypeViewerLaunchAttacher {
  attach(device: BootedDevice, bundleId: string): Promise<unknown>;
}

/** One attached viewer per device; an old connection's close cannot remove its replacement. */
export class PrototypeViewerConnections implements PrototypeAgentConnections {
  private readonly records = new Map<string, PrototypeViewerRecord>();

  get(deviceId: string, bundleId?: string): PrototypeAgentClient | undefined {
    const record = this.records.get(deviceId);
    return bundleId === undefined || record?.bundleId === bundleId ? record?.client : undefined;
  }

  release(deviceId: string, bundleId?: string): void {
    const client = this.get(deviceId, bundleId);
    if (client !== undefined) {
      this.records.delete(deviceId);
      client.close();
    }
  }

  releaseDevice(deviceId: string): void {
    this.release(deviceId);
  }

  record(deviceId: string, record: PrototypeViewerRecord): void {
    const previous = this.records.get(deviceId);
    this.records.set(deviceId, record);
    record.client.onClosed(() => {
      if (this.records.get(deviceId) === record) {
        this.records.delete(deviceId);
      }
    });
    if (previous !== undefined && previous.client !== record.client) {
      previous.client.close();
    }
  }
}

export class CompositePrototypeAgentConnections implements PrototypeAgentConnections {
  constructor(
    private readonly viewer: PrototypeAgentConnections,
    private readonly injected: PrototypeAgentConnections,
  ) {}
  get(deviceId: string): PrototypeAgentClient | undefined {
    return this.viewer.get(deviceId) ?? this.injected.get(deviceId);
  }
}

export const prototypeViewerConnections = new PrototypeViewerConnections();

export interface PrototypeViewerAttacherDependencies {
  containers: { dataContainer(deviceId: string, bundleId: string): Promise<string> };
  files: { readText(path: string): Promise<string | undefined> };
  connect: PrototypeAgentConnect;
  connections: PrototypeViewerConnections;
}

/** Buffers only until the first subscription; subsequent subscribers receive live events only. */
class BufferedViewerClient implements PrototypeAgentClient {
  private readonly events: PrototypeAgentMessage[] = [];
  private readonly listeners = new Set<(event: PrototypeAgentMessage) => void>();
  private buffering = true;
  private replayDelivered = false;
  private closedError: Error | undefined;
  private readonly closedListeners = new Set<(error: Error) => void>();

  constructor(private readonly client: PrototypeAgentClient) {
    const unsubscribe = client.onEvent((event) => {
      if (this.buffering) {
        if (this.events.length === REPLAY_LIMIT) {
          this.events.shift();
        }
        this.events.push(event);
      } else {
        this.listeners.forEach((listener) => listener(event));
      }
    });
    client.onClosed((error) => {
      this.closedError = error;
      unsubscribe();
      this.events.length = 0;
      this.listeners.clear();
      this.closedListeners.forEach((listener) => listener(error));
      this.closedListeners.clear();
    });
  }

  get handshake() {
    return this.client.handshake;
  }
  request(
    type: PrototypeAgentRequestType,
    body?: PrototypeAgentMessage,
    options?: { timeoutMs?: number },
  ): Promise<PrototypeAgentResult> {
    return this.client.request(type, body, options);
  }
  onEvent(listener: (event: PrototypeAgentMessage) => void): () => void {
    this.listeners.add(listener);
    if (!this.replayDelivered) {
      this.replayDelivered = true;
      // Keep live pushes queued during delivery, including reentrant pushes from the listener.
      while (this.events.length > 0) {
        listener(this.events.shift()!);
      }
      this.buffering = false;
    }
    return () => this.listeners.delete(listener);
  }
  onClosed(listener: (error: Error) => void): () => void {
    if (this.closedError !== undefined) {
      listener(this.closedError);
    } else {
      this.closedListeners.add(listener);
    }
    return () => this.closedListeners.delete(listener);
  }
  close(): void {
    this.client.close();
  }
}

export class PrototypeViewerAttacher implements PrototypeViewerLaunchAttacher {
  private readonly inFlight = new Map<string, Promise<PrototypeAgentClient>>();
  constructor(private readonly deps: PrototypeViewerAttacherDependencies) {}

  attach(device: BootedDevice, bundleId: string): Promise<PrototypeAgentClient> {
    const key = JSON.stringify([device.deviceId, bundleId]);
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const pending = this.attachViewer(device, bundleId).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async attachViewer(
    device: BootedDevice,
    bundleId: string,
  ): Promise<PrototypeAgentClient> {
    if (device.platform !== "ios" || resolveIosDeviceKind(device) !== "simulator") {
      throw new ActionableError(
        "Prototype viewers run on simulators only; choose a booted iOS simulator.",
      );
    }
    const existing = this.deps.connections.get(device.deviceId, bundleId);
    if (existing !== undefined) {
      return existing;
    }
    const container = (await this.deps.containers.dataContainer(device.deviceId, bundleId)).trim();
    if (!container) {
      throw new ActionableError(
        "No data container for the prototype viewer; install it on this simulator and retry.",
      );
    }
    const text = await this.deps.files.readText(
      join(container, PROTOTYPE_VIEWER_ENDPOINT_RELATIVE_PATH),
    );
    if (text === undefined) {
      throw new ActionableError(
        "no endpoint file: the viewer is not running or has exited cleanly; open it from the home screen (launchApp) and retry",
      );
    }
    const { port, token } = parsePrototypeViewerEndpoint(text);
    // Free a different viewer's single host slot before opening its replacement.
    this.deps.connections.releaseDevice(device.deviceId);
    let client: PrototypeAgentClient;
    try {
      client = await this.deps.connect(port, token);
    } catch (error) {
      throw new ActionableError(
        "Could not attach to the prototype viewer: the token may be stale (viewer relaunched) or another host is already attached (the viewer accepts one host at a time). Open the viewer and retry.",
        { cause: error },
      );
    }
    if (!client.handshake.capabilities.includes(PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY)) {
      client.close();
      throw new ActionableError(
        "The endpoint is not a prototype viewer: missing prototype_persistence_replay_v1; open the viewer and retry.",
      );
    }
    const buffered =
      client instanceof BufferedViewerClient ? client : new BufferedViewerClient(client);
    this.deps.connections.record(device.deviceId, { bundleId, client: buffered });
    return buffered;
  }
}

/**
 * Forward the first nonempty frame (the hello reply) immediately. Hold subsequent frames until
 * the client has an event listener, even when hello and replay arrive in a single socket chunk.
 * Framing stays in LineFramer; JSON validation and authentication stay in connectPrototypeAgent.
 */
class HandshakeReplaySocket implements PrototypeAgentSocket {
  private readonly lines: string[] = [];
  private firstFrame = true;
  private released = false;
  private dataListener: ((chunk: string) => void) | undefined;
  private closeListener: ((error?: Error) => void) | undefined;
  private failure: Error | undefined;
  private readonly framer = new LineFramer(PROTOTYPE_AGENT_CLIENT_MAX_FRAME_BYTES, {
    onLine: (line) => {
      if (this.failure !== undefined || !line.trim()) {
        return;
      }
      if (this.firstFrame || this.released) {
        this.firstFrame = false;
        this.dataListener?.(`${line}\n`);
      } else {
        if (this.lines.length === REPLAY_LIMIT) {
          this.lines.shift();
        }
        this.lines.push(line);
      }
    },
    onOverflow: () => {
      this.failure = new ActionableError(
        "Prototype viewer response frame exceeded the client limit; reconnect to the viewer.",
      );
      this.lines.length = 0;
      this.socket.end();
      this.closeListener?.(this.failure);
    },
  });

  constructor(private readonly socket: PrototypeAgentSocket) {}
  write(data: string): void {
    this.socket.write(data);
  }
  end(): void {
    this.lines.length = 0;
    this.socket.end();
  }
  onData(listener: (chunk: string) => void): void {
    this.dataListener = listener;
    this.socket.onData((chunk) => this.framer.push(chunk));
  }
  onClose(listener: (error?: Error) => void): void {
    this.closeListener = listener;
    this.socket.onClose((error) => {
      this.failure = error ?? new ActionableError("Prototype viewer closed the connection.");
      this.lines.length = 0;
      listener(this.failure);
    });
  }
  release(): void {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    // Preserve ordering if forwarding a frame synchronously causes more socket data.
    while (this.lines.length > 0) {
      this.dataListener?.(`${this.lines.shift()!}\n`);
    }
    this.released = true;
  }
}

export interface PrototypeViewerProductionDependencies {
  simctl?: Pick<SimCtlClient, "executeCommandArgs">;
  files?: Pick<FileSystem, "readFile" | "existsSync">;
  connector?: PrototypeAgentConnector;
  timer?: Timer;
  connections?: PrototypeViewerConnections;
}

/** Production adapters remain lazy: constructing an attacher performs no device or file I/O. */
export function createPrototypeViewerAttacher(
  deps: PrototypeViewerProductionDependencies = {},
): PrototypeViewerAttacher {
  const simctl = deps.simctl ?? new SimCtlClient();
  const files = deps.files ?? new DefaultFileSystem();
  const connector = deps.connector ?? new NodePrototypeAgentConnector();
  return new PrototypeViewerAttacher({
    containers: {
      dataContainer: async (deviceId, bundleId) => {
        try {
          return (
            await simctl.executeCommandArgs(["get_app_container", deviceId, bundleId, "data"])
          ).stdout.trim();
        } catch (error) {
          throw new ActionableError(
            "Could not resolve the prototype viewer data container; check that it is installed on this simulator.",
            { cause: error },
          );
        }
      },
    },
    files: {
      readText: async (path) => {
        if (!files.existsSync(path)) {
          return undefined;
        }
        try {
          return await files.readFile(path, "utf8");
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            // The viewer can remove its endpoint between the existence check and read.
            logger.debug("Prototype viewer endpoint disappeared before it could be read.");
            return undefined;
          }
          throw new ActionableError(
            "Could not read the prototype viewer endpoint file; check its permissions and retry.",
            { cause: error },
          );
        }
      },
    },
    connect: async (port, token) => {
      const socket = new HandshakeReplaySocket(await connector.connect(port));
      try {
        const raw = await connectPrototypeAgent({
          port,
          token,
          connector: { connect: async () => socket },
          timer: deps.timer ?? defaultTimer,
        });
        const buffered = new BufferedViewerClient(raw);
        socket.release();
        return buffered;
      } catch (error) {
        socket.end();
        throw new ActionableError(
          "Prototype viewer authentication failed; reopen the viewer and retry.",
          { cause: error },
        );
      }
    },
    connections: deps.connections ?? prototypeViewerConnections,
  });
}
