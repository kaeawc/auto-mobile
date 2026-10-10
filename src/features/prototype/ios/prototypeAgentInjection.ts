/**
 * `launchApp {prototype: true}` on iOS simulators (#10567): resolve the prototype agent dylib, give
 * the launch its own port and token, inject the agent through `SIMCTL_CHILD_*` variables, then
 * connect, check the handshake and record the connection for the device and bundle id so the
 * prototype tool (#10568) can reach it. Injection only happens on a fresh process, so it always
 * relaunches the app and loses its state.
 */
import type { BootedDevice } from "../../../models";
import { ActionableError } from "../../../models/ActionableError";
import { fixedBackoff, type BackoffPolicy } from "../../../utils/Backoff";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { IdGenerator } from "../../../utils/IdGenerator";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import { logger } from "../../../utils/logger";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../../utils/PortManager";
import type { Timer } from "../../../utils/SystemTimer";
import type { ResolvedPrototypeAgent } from "../../prototype-agent/PrototypeAgentProvider";
import type { PrototypeAgentConnections } from "./iosPrototypeTransport";
import {
  connectPrototypeAgent,
  createPrototypeAgentLaunchConfig,
  type PrototypeAgentClient,
  type PrototypeAgentConnector,
  type PrototypeAgentHandshake,
  type PrototypeAgentSocket,
} from "./prototypeAgentClient";

export const SIMCTL_CHILD_DYLD_INSERT_LIBRARIES = "SIMCTL_CHILD_DYLD_INSERT_LIBRARIES";
/** dyld separates `DYLD_INSERT_LIBRARIES` entries with a colon. */
const DYLD_PATH_SEPARATOR = ":";
const SYSTEM_BUNDLE_PREFIX = "com.apple.";
const DEFAULT_CONNECT_ATTEMPTS = 10;
const DEFAULT_CONNECT_RETRY_DELAY_MS = 200;

/** Resolves a verified agent dylib; `PrototypeAgentProvider` implements it. */
export interface PrototypeAgentDylibResolver {
  ensure(): Promise<ResolvedPrototypeAgent>;
}

/** Host loopback ports for agents, one per device and bundle id. */
export interface PrototypeAgentPortAllocator {
  allocate(key: string): number;
  release(key: string): void;
}

/** Connects to the agent on a port and completes the authenticated handshake. */
export type PrototypeAgentConnect = (port: number, token: string) => Promise<PrototypeAgentClient>;

/** `PortManager` keyed per device and bundle id, skipping the fixed iOS SDK port. */
export const portManagerPrototypeAgentPorts: PrototypeAgentPortAllocator = {
  allocate: (key) => PortManager.allocate(key, { reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS }),
  release: (key) => PortManager.release(key),
};

export function prototypeAgentKey(deviceId: string, bundleId: string): string {
  return `prototype-agent:${deviceId}:${bundleId}`;
}

/** Appends the agent to an existing `DYLD_INSERT_LIBRARIES` list instead of replacing it. */
export function mergeDyldInsertLibraries(existing: string | undefined, dylibPath: string): string {
  const entries = (existing ?? "").split(DYLD_PATH_SEPARATOR).filter((entry) => entry.length > 0);
  return entries.includes(dylibPath)
    ? entries.join(DYLD_PATH_SEPARATOR)
    : [...entries, dylibPath].join(DYLD_PATH_SEPARATOR);
}

/**
 * The `simctl launch` environment: the agent's port and token plus `DYLD_INSERT_LIBRARIES`,
 * keeping any libraries the host already passes to simulator apps through
 * `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`.
 */
export function buildPrototypeAgentLaunchEnvironment(
  dylibPath: string,
  simctlEnvironment: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    ...simctlEnvironment,
    [SIMCTL_CHILD_DYLD_INSERT_LIBRARIES]: mergeDyldInsertLibraries(
      hostEnv[SIMCTL_CHILD_DYLD_INSERT_LIBRARIES],
      dylibPath,
    ),
  };
}

/** Rejects targets the agent cannot be injected into, before anything is relaunched. */
export function assertPrototypeInjectionSupported(device: BootedDevice, bundleId: string): void {
  if (device.platform === "android") {
    throw new ActionableError(
      "launchApp prototype:true is for iOS simulators only. Android prototypes need no injection: " +
        "launch the app normally and call the prototype tool.",
    );
  }
  if (device.platform !== "ios") {
    throw new ActionableError(`launchApp prototype:true is not supported on ${device.platform}.`);
  }
  if (resolveIosDeviceKind({ deviceId: device.deviceId }) !== "simulator") {
    throw new ActionableError(
      "launchApp prototype:true works on iOS simulators only: code signing blocks injecting the " +
        "prototype agent on a physical device. On a physical device, add the AutoMobile iOS SDK to " +
        "the app instead.",
    );
  }
  if (bundleId.startsWith(SYSTEM_BUNDLE_PREFIX)) {
    throw new ActionableError(
      `launchApp prototype:true cannot inject the prototype agent into ${bundleId}: SpringBoard and ` +
        "Apple system apps cannot be injected. Launch your own app with prototype:true.",
    );
  }
}

/** One injected agent, recorded for its device and bundle id. */
export interface PrototypeAgentRecord {
  deviceId: string;
  bundleId: string;
  pid?: number;
  port: number;
  token: string;
  dylibPath: string;
  client: PrototypeAgentClient;
  handshake: PrototypeAgentHandshake;
}

/**
 * The recorded agent connections. A record is dropped, its connection closed and its port
 * released when the app is terminated, the session or device is released, the app is relaunched
 * with prototype injection, or the agent closes the connection (the app exited).
 */
export class PrototypeAgentRegistry implements PrototypeAgentConnections {
  /** Insertion-ordered: the newest registration on a device is its last entry. */
  private readonly records = new Map<string, PrototypeAgentRecord>();

  constructor(
    private readonly ports: PrototypeAgentPortAllocator = portManagerPrototypeAgentPorts,
  ) {}

  /**
   * The device's current open agent connection: the most recent `launchApp {prototype: true}`
   * on it whose connection is still open (closed connections are dropped at once).
   */
  get(deviceId: string): PrototypeAgentClient | undefined {
    let current: PrototypeAgentRecord | undefined;
    for (const record of this.records.values()) {
      if (record.deviceId === deviceId) {
        current = record;
      }
    }
    return current?.client;
  }

  getRecord(deviceId: string, bundleId: string): PrototypeAgentRecord | undefined {
    return this.records.get(prototypeAgentKey(deviceId, bundleId));
  }

  /** The recorded agent, or an error that tells the caller how to get one. */
  require(deviceId: string, bundleId: string): PrototypeAgentRecord {
    const record = this.getRecord(deviceId, bundleId);
    if (record === undefined) {
      throw new ActionableError(
        `No prototype agent is recorded for ${bundleId} on ${deviceId}. Relaunch with launchApp ` +
          "{prototype: true}; the relaunch restarts the app and loses its state.",
      );
    }
    return record;
  }

  register(record: PrototypeAgentRecord): void {
    const key = prototypeAgentKey(record.deviceId, record.bundleId);
    const previous = this.records.get(key);
    // Delete before set so the new record becomes the device's newest entry.
    this.records.delete(key);
    if (previous !== undefined && previous.client !== record.client) {
      // The port belongs to the new record now; close only the old connection.
      previous.client.close();
    }
    this.records.set(key, record);
    record.client.onClosed((error) => {
      if (this.records.get(key)?.client === record.client) {
        logger.info(`[prototype-agent] ${record.bundleId} on ${record.deviceId} disconnected`, {
          reason: errorMessage(error),
        });
        this.records.delete(key);
        this.ports.release(key);
      }
    });
  }

  /**
   * Drops the record and closes its connection. The port is released too unless `keepPort` is
   * set: a relaunch reuses the keyed allocation because the old process still holds the listener
   * until the cold launch terminates it.
   */
  release(deviceId: string, bundleId: string, options: { keepPort?: boolean } = {}): void {
    const key = prototypeAgentKey(deviceId, bundleId);
    const record = this.records.get(key);
    if (record === undefined) {
      return;
    }
    this.records.delete(key);
    if (options.keepPort !== true) {
      this.ports.release(key);
    }
    record.client.close();
  }

  releaseDevice(deviceId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.deviceId === deviceId) {
        this.release(record.deviceId, record.bundleId);
      }
    }
  }

  releaseAll(): void {
    for (const record of [...this.records.values()]) {
      this.release(record.deviceId, record.bundleId);
    }
  }

  size(): number {
    return this.records.size;
  }
}

/** Process-wide agent records; the prototype tool (#10568) reads the same instance. */
export const prototypeAgentRegistry = new PrototypeAgentRegistry();

/** A launch prepared for injection: the environment to launch with and what attaching needs. */
export interface PreparedPrototypeLaunch {
  deviceId: string;
  bundleId: string;
  port: number;
  token: string;
  dylib: ResolvedPrototypeAgent;
  environment: Record<string, string>;
}

export interface PrototypeAgentInjectorDependencies {
  dylibResolver: PrototypeAgentDylibResolver;
  ports: PrototypeAgentPortAllocator;
  registry: PrototypeAgentRegistry;
  connect: PrototypeAgentConnect;
  idGenerator: IdGenerator;
  hostEnv: NodeJS.ProcessEnv;
}

export class PrototypeAgentInjector {
  /** The token of the newest prepared launch per key; only that launch may free the port. */
  private readonly launchOwners = new Map<string, string>();

  constructor(private readonly deps: PrototypeAgentInjectorDependencies) {}

  /** Validates the target, resolves the dylib, allocates a port and builds the launch env. */
  async prepare(device: BootedDevice, bundleId: string): Promise<PreparedPrototypeLaunch> {
    assertPrototypeInjectionSupported(device, bundleId);
    const dylib = await this.deps.dylibResolver.ensure();
    // The relaunch ends any earlier agent for this app; close its connection but keep its port,
    // which the old process's listener still holds until the cold launch terminates it.
    this.deps.registry.release(device.deviceId, bundleId, { keepPort: true });
    const key = prototypeAgentKey(device.deviceId, bundleId);
    let port: number;
    try {
      port = this.deps.ports.allocate(key);
    } catch (error) {
      throw new ActionableError(
        `No host port is free for the prototype agent of ${bundleId}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    try {
      const config = createPrototypeAgentLaunchConfig(port, this.deps.idGenerator);
      this.launchOwners.set(key, config.token);
      return {
        deviceId: device.deviceId,
        bundleId,
        port,
        token: config.token,
        dylib,
        environment: buildPrototypeAgentLaunchEnvironment(
          dylib.path,
          config.simctlEnvironment,
          this.deps.hostEnv,
        ),
      };
    } catch (error) {
      this.deps.ports.release(key);
      throw error;
    }
  }

  /** Connects to the launched agent, checks the handshake and records the connection. */
  async attach(prepared: PreparedPrototypeLaunch, pid?: number): Promise<PrototypeAgentRecord> {
    let client: PrototypeAgentClient;
    try {
      client = await this.deps.connect(prepared.port, prepared.token);
    } catch (error) {
      this.abort(prepared);
      throw error;
    }
    const record: PrototypeAgentRecord = {
      deviceId: prepared.deviceId,
      bundleId: prepared.bundleId,
      ...(pid === undefined ? {} : { pid }),
      port: prepared.port,
      token: prepared.token,
      dylibPath: prepared.dylib.path,
      client,
      handshake: client.handshake,
    };
    this.deps.registry.register(record);
    this.disown(prepared);
    return record;
  }

  /**
   * Releases the port of a prepared launch that never attached, unless a newer launch for the
   * same device and bundle has since prepared and now owns the keyed allocation.
   */
  abort(prepared: PreparedPrototypeLaunch): void {
    if (this.disown(prepared)) {
      this.deps.ports.release(prototypeAgentKey(prepared.deviceId, prepared.bundleId));
    }
  }

  /** Clears this launch's ownership; true when it was still the newest launch for its key. */
  private disown(prepared: PreparedPrototypeLaunch): boolean {
    const key = prototypeAgentKey(prepared.deviceId, prepared.bundleId);
    if (this.launchOwners.get(key) !== prepared.token) {
      return false;
    }
    this.launchOwners.delete(key);
    return true;
  }
}

/**
 * Retries refused connections while the app's agent starts its listener. Only `connect` is
 * retried; a handshake failure is a real error and surfaces at once.
 */
export class RetryingPrototypeAgentConnector implements PrototypeAgentConnector {
  constructor(
    private readonly connector: PrototypeAgentConnector,
    private readonly timer: Timer,
    private readonly attempts: number = DEFAULT_CONNECT_ATTEMPTS,
    private readonly backoff: BackoffPolicy = fixedBackoff(DEFAULT_CONNECT_RETRY_DELAY_MS),
  ) {}

  async connect(port: number): Promise<PrototypeAgentSocket> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        return await this.connector.connect(port);
      } catch (error) {
        lastError = error;
        if (attempt < this.attempts) {
          // A refused connection is expected until the agent's listener is up; retry.
          logger.debug(
            `[prototype-agent] connect to ${port} attempt ${attempt} failed: ${errorMessage(error)}`,
          );
          await this.timer.sleep(this.backoff.delayForAttempt(attempt));
        }
      }
    }
    throw lastError;
  }
}

/** The production connect: retrying loopback connector plus the authenticated handshake. */
export function createPrototypeAgentConnect(
  connector: PrototypeAgentConnector,
  timer: Timer,
): PrototypeAgentConnect {
  const retrying = new RetryingPrototypeAgentConnector(connector, timer);
  return (port, token) => connectPrototypeAgent({ port, token, connector: retrying, timer });
}
