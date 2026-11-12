import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { IdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import type { PythonEnvProvisioner } from "./PythonEnvProvisioner";
import type { BleTransportResolver } from "./BleTransportResolver";
import type {
  BleNotification,
  BlePeripheralArgs,
  BlePeripheralConfig,
  BleSidecarStatus,
} from "./blePeripheralSchema";

export interface BlePeripheralSidecar {
  start(python: string, config: BlePeripheralConfig, signal: AbortSignal): Promise<void>;
  notify(notification: BleNotification): Promise<void>;
  status(): Promise<BleSidecarStatus>;
  stop(): Promise<void>;
}
export interface BlePeripheralSidecarFactory {
  create(): BlePeripheralSidecar;
}

interface Peripheral {
  owner: string;
  config?: BlePeripheralConfig;
  sidecar: BlePeripheralSidecar;
  controller: AbortController;
  /** Set when the cleanup stop after a failed start rejected; the sidecar may still be running. */
  cleanupFailed?: boolean;
}

/** Released-session tombstones only fence calls racing the release; the oldest are dropped past this bound. */
export const MAX_ENDED_SESSIONS = 256;

/** Handles are never transferable, and cleanup fences starts before any provisioning await. */
export class BlePeripheralManager {
  private readonly peripherals = new Map<string, Peripheral>();
  private readonly ended = new Set<string>();
  private closed = false;

  constructor(
    private readonly deps: {
      environments: PythonEnvProvisioner;
      transports: BleTransportResolver;
      sidecars: BlePeripheralSidecarFactory;
      ids: IdGenerator;
    },
  ) {}

  async run(owner: string, args: BlePeripheralArgs, signal?: AbortSignal) {
    if (!owner) {
      throw new ActionableError(
        "blePeripheral requires a live device session. Acquire a session first.",
      );
    }
    if (this.closed || this.ended.has(owner)) {
      throw new ActionableError(
        "BLE session ended or daemon is shutting down; acquire a new session.",
      );
    }
    signal?.throwIfAborted();
    if (args.action === "start") {
      return this.start(owner, args, signal);
    }
    const peripheral = this.peripherals.get(args.handle!);
    if (!peripheral || peripheral.owner !== owner || !peripheral.config) {
      throw new ActionableError(
        "Unknown BLE handle for this session. Use a handle returned by this session's start.",
      );
    }
    if (args.action === "stop") {
      // A failed stop keeps the handle so the caller or session cleanup can retry the kill.
      await peripheral.sidecar.stop();
      const status = await peripheral.sidecar.status();
      this.peripherals.delete(args.handle!);
      return { handle: args.handle!, ...peripheral.config, ...status };
    }
    if (args.action === "notify") {
      await peripheral.sidecar.notify(args);
    }
    return { handle: args.handle!, ...peripheral.config, ...(await peripheral.sidecar.status()) };
  }

  private async start(owner: string, args: BlePeripheralArgs, signal?: AbortSignal) {
    const handle = this.deps.ids.next();
    const peripheral: Peripheral = {
      owner,
      sidecar: this.deps.sidecars.create(),
      controller: new AbortController(),
    };
    this.peripherals.set(handle, peripheral);
    const abort = () => peripheral.controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const python = await this.deps.environments.ensure();
      peripheral.controller.signal.throwIfAborted();
      const transport = await this.deps.transports.resolve(args.deviceId, args.transport);
      peripheral.controller.signal.throwIfAborted();
      const config: BlePeripheralConfig = {
        name: args.name!,
        address: args.address ?? "F0:F1:F2:F3:F4:F5",
        presets: args.presets!,
        services: args.services,
        transport,
      };
      peripheral.config = config;
      await peripheral.sidecar.start(python, config, peripheral.controller.signal);
      peripheral.controller.signal.throwIfAborted();
      const status = await peripheral.sidecar.status();
      peripheral.controller.signal.throwIfAborted();
      if (!status.running) {
        throw new ActionableError(
          "BLE sidecar stopped during startup; check the transport and start again.",
        );
      }
      return { handle, ...config, ...status };
    } catch (error) {
      try {
        await peripheral.sidecar.stop();
        this.peripherals.delete(handle);
      } catch (stopError) {
        // The sidecar may still run; keep the owned entry so stop, session release or shutdown retries the kill.
        peripheral.cleanupFailed = true;
        logger.warn("BLE sidecar cleanup after a failed start did not complete", stopError);
      }
      throw toActionableError(
        error,
        "BLE peripheral start failed; check python3, Bumble dependencies and the netsim transport",
      );
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  releaseSession(owner: string): Promise<void> {
    // Sessions which never used BLE need no tombstone; live-session admission is checked by the tool.
    if (![...this.peripherals.values()].some((peripheral) => peripheral.owner === owner)) {
      return Promise.resolve();
    }
    this.ended.add(owner);
    for (const stale of this.ended) {
      if (this.ended.size <= MAX_ENDED_SESSIONS) {
        break;
      }
      this.ended.delete(stale);
    }
    return this.stopMatching((peripheral) => peripheral.owner === owner);
  }

  shutdown(): Promise<void> {
    this.closed = true;
    return this.stopMatching(() => true);
  }

  unbindSession(owner: string): Promise<void> {
    // Rebinding preserves the session identity; only its old transport and pending starts end.
    return this.stopMatching((peripheral) => peripheral.owner === owner);
  }

  private async stopMatching(matches: (peripheral: Peripheral) => boolean): Promise<void> {
    const stops: Promise<void>[] = [];
    for (const [handle, peripheral] of this.peripherals) {
      if (!matches(peripheral)) {
        continue;
      }
      peripheral.controller.abort(new ActionableError("BLE owner released"));
      stops.push(
        peripheral.sidecar.stop().then(() => {
          this.peripherals.delete(handle);
        }),
      );
    }
    const results = await Promise.allSettled(stops);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw toActionableError(failure.reason, "Failed to kill a BLE sidecar; retry cleanup");
    }
  }
}
