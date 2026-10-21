/**
 * `launchApp {prototype: true}` on iOS simulators (#10567): resolve the prototype agent dylib, give
 * the launch its own port and token, inject the agent through `SIMCTL_CHILD_*` variables, then
 * connect, check the handshake and record the connection for the device and bundle id so the
 * prototype tool (#10568) can reach it. Injection only happens on a fresh process, so it always
 * relaunches the app and loses its state.
 */
import type { BootedDevice } from "../../../models";
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { IdGenerator } from "../../../utils/IdGenerator";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import type { Timer } from "../../../utils/SystemTimer";
import type { ResolvedPrototypeAgent } from "./PrototypeAgentProvider";
import {
  connectPrototypeAgent,
  createPrototypeAgentLaunchConfig,
  type PrototypeAgentClient,
  type PrototypeAgentConnector,
  type PrototypeAgentHandshake,
} from "./prototypeAgentClient";
import { PrototypeAgentRegistry, prototypeAgentKey } from "./PrototypeAgentRegistry";
import { RetryingPrototypeAgentConnector } from "./RetryingPrototypeAgentConnector";
export { RetryingPrototypeAgentConnector } from "./RetryingPrototypeAgentConnector";
export {
  PrototypeAgentRegistry,
  portManagerPrototypeAgentPorts,
  prototypeAgentKey,
} from "./PrototypeAgentRegistry";

export const SIMCTL_CHILD_DYLD_INSERT_LIBRARIES = "SIMCTL_CHILD_DYLD_INSERT_LIBRARIES";
/** dyld separates `DYLD_INSERT_LIBRARIES` entries with a colon. */
const DYLD_PATH_SEPARATOR = ":";
const SYSTEM_BUNDLE_PREFIX = "com.apple.";

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

/** The production connect: retrying loopback connector plus the authenticated handshake. */
export function createPrototypeAgentConnect(
  connector: PrototypeAgentConnector,
  timer: Timer,
): PrototypeAgentConnect {
  const retrying = new RetryingPrototypeAgentConnector(connector, timer);
  return (port, token) => connectPrototypeAgent({ port, token, connector: retrying, timer });
}
