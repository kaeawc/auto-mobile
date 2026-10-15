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

/** The store holds a write transaction through verification; peers cannot acquire/rebind meanwhile. */
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
  warn?: typeof logger.warn;
}

export class LegacySlotDeviceRetirement {
  constructor(private readonly options: LegacySlotRetirementOptions) {}

  async retire(store: LegacySlotRetirementStore): Promise<void> {
    const { timer, devices, isOwnerLive } = this.options;
    const controller = new AbortController();
    try {
      await store.withLegacyRows(async (snapshot, remove) => {
        // Race INSIDE the transaction: timeout rolls it back, even if a native call settles late.
        await raceWithDeadline(
          async () => {
            this.assertOwnersDead(snapshot, isOwnerLive);
            const unique = new Map(
              snapshot.devices.map((target) => [JSON.stringify(target), target]),
            );
            for (const target of unique.values()) {
              controller.signal.throwIfAborted();
              this.assertOwnersDead(snapshot, isOwnerLive);
              const device = await devices.inspect(target, controller.signal);
              controller.signal.throwIfAborted();
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
                await devices.stop(device, controller.signal);
                controller.signal.throwIfAborted();
                const after = await devices.inspect(target, controller.signal);
                if (after && (after.isRunning || after.isRunningStateKnown === false)) {
                  throw new ActionableError(
                    `Shutdown of legacy device '${device.name}' is unconfirmed`,
                  );
                }
              }
            }
            controller.signal.throwIfAborted();
            this.assertOwnersDead(snapshot, isOwnerLive);
          },
          {
            timer,
            timeoutMs: this.options.timeoutMs ?? 30_000,
            label: "Legacy slot device retirement",
            onTimeout: () => controller.abort(),
          },
        );
        // Only the joined, successful verification path can touch SQL. A losing native promise
        // may settle late, but it can never run cleanup after this transaction has rolled back.
        controller.signal.throwIfAborted();
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
