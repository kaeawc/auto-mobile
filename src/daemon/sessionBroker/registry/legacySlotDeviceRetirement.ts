import { ActionableError, toActionableError } from "../../../models/ActionableError";
import type { DeviceInfo } from "../../../models/DeviceInfo";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { Timer } from "../../../utils/SystemTimer";
import { isProductBrokerDevice } from "../persistedIdentity";
import type {
  BindingExecOwnerLiveness,
  BindingPlatform,
  BindingProcessIdentity,
} from "./bindingRegistry";

export interface LegacySlotDeviceTarget {
  platform: BindingPlatform;
  stableId: string | null;
  name: string | null;
}

export interface LegacySlotSnapshot {
  devices: readonly LegacySlotDeviceTarget[];
  owners: readonly BindingProcessIdentity[];
}

/** Snapshot without a write lock; remove re-reads and compares atomically before deleting. */
export interface LegacySlotRetirementStore {
  withLegacyRows(
    operation: (snapshot: LegacySlotSnapshot, remove: () => Promise<void>) => Promise<void>,
  ): Promise<void>;
}

/** Read completed native inventory; stop uses the ordinary platform shutdown port, never destroy. */
export interface LegacySlotDeviceStopper {
  inspect(target: LegacySlotDeviceTarget, signal: AbortSignal): Promise<DeviceInfo | undefined>;
  stop(device: DeviceInfo, signal: AbortSignal): Promise<void>;
}

export interface LegacySlotRetirementOptions {
  devices: LegacySlotDeviceStopper;
  isOwnerLive: BindingExecOwnerLiveness;
  timer: Timer;
  timeoutMs?: number;
  signal?: AbortSignal;
  warn?: typeof logger.warn;
}

export class LegacySlotDeviceRetirement {
  constructor(private readonly options: LegacySlotRetirementOptions) {}

  async retire(store: LegacySlotRetirementStore): Promise<void> {
    const { timer, devices, isOwnerLive } = this.options;
    const controller = new AbortController();
    const signal = this.options.signal
      ? AbortSignal.any([controller.signal, this.options.signal])
      : controller.signal;
    try {
      await store.withLegacyRows(async (snapshot, remove) => {
        // The deadline covers native work; a losing promise can never reach remove().
        await raceWithDeadline(
          async () => {
            this.assertOwnersDead(snapshot, isOwnerLive);
            const unique = new Map(
              snapshot.devices.map((target) => [JSON.stringify(target), target]),
            );
            for (const target of unique.values()) {
              signal.throwIfAborted();
              this.assertOwnersDead(snapshot, isOwnerLive);
              const device = await devices.inspect(target, signal);
              signal.throwIfAborted();
              if (!device) {
                continue; // Complete inventory confirmed absence, including interrupted creations.
              }
              if (!isProductBrokerDevice(device.name)) {
                throw new ActionableError(
                  `Refusing to retire non-product device '${device.name}'; reconcile its legacy registry row manually.`,
                );
              }
              if (device.isRunningStateKnown === false) {
                throw new ActionableError(
                  `Running state of legacy device '${device.name}' is unconfirmed`,
                );
              }
              if (device.isRunning) {
                this.assertOwnersDead(snapshot, isOwnerLive);
                await devices.stop(device, signal);
                signal.throwIfAborted();
                const after = await devices.inspect(target, signal);
                if (after && (after.isRunning || after.isRunningStateKnown === false)) {
                  throw new ActionableError(
                    `Shutdown of legacy device '${device.name}' is unconfirmed`,
                  );
                }
              }
            }
            signal.throwIfAborted();
            this.assertOwnersDead(snapshot, isOwnerLive);
          },
          {
            timer,
            signal,
            timeoutMs: this.options.timeoutMs ?? 30_000,
            label: "Legacy slot device retirement",
            onTimeout: () => controller.abort(),
          },
        );
        // Only the joined, successful verification path can touch SQL. A losing native promise
        // may settle late, but it can never run cleanup after timeout or shutdown.
        signal.throwIfAborted();
        await remove();
      });
    } catch (error) {
      (this.options.warn ?? logger.warn)(
        `[Daemon] Legacy slot device retirement deferred: ${errorMessage(error)}`,
        error,
      );
      throw toActionableError(
        error,
        "Legacy slot devices must be retired first; retry daemon startup after resolving the cause",
      );
    }
  }

  private assertOwnersDead(
    snapshot: LegacySlotSnapshot,
    isOwnerLive: BindingExecOwnerLiveness,
  ): void {
    if (snapshot.owners.some((owner) => isOwnerLive(owner))) {
      throw new ActionableError(
        "A live execution or cleanup owner still holds legacy slot devices; let it exit and retry daemon startup",
      );
    }
  }
}

/** Startup policy: a broker cannot serve against an unretired registry; a normal daemon can run. */
export async function prepareBindingRegistryForStartup(options: {
  brokerConfigured: boolean;
  registryExists: boolean;
  open: () => Promise<unknown>;
  warn?: typeof logger.warn;
}): Promise<void> {
  if (!options.brokerConfigured && !options.registryExists) {
    return;
  }
  try {
    await options.open();
  } catch (error) {
    (options.warn ?? logger.warn)(
      `[Daemon] Binding registry upgrade deferred: ${errorMessage(error)}`,
      error,
    );
    if (options.brokerConfigured) {
      throw toActionableError(
        error,
        "Session broker cannot start until legacy slot retirement and registry upgrade complete",
      );
    }
  }
}

/** One best-effort post-listener upgrade, cancelled and joined by the registry shutdown stage. */
export class BackgroundBindingRegistryUpgrade {
  private readonly controller = new AbortController();
  private task: Promise<void> | undefined;

  constructor(private readonly open: (signal: AbortSignal) => Promise<unknown>) {}

  start(): void {
    if (this.controller.signal.aborted) {
      return;
    }
    this.task ??= prepareBindingRegistryForStartup({
      brokerConfigured: false,
      registryExists: true,
      open: () => this.open(this.controller.signal),
    });
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.task;
  }
}
