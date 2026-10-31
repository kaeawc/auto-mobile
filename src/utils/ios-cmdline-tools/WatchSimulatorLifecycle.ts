import { ActionableError, type BootedDevice, type DeviceInfo } from "../../models";
import type { IosBootInstrumentation } from "../../models/IosBootInstrumentation";
import { getAbortSignal } from "../AbortContext";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../deviceTimeouts";
import { logger } from "../logger";
import type { SimCtl } from "./SimCtlClient";
import type { WatchSimulatorInventory } from "./WatchSimulatorInventory";

/** The simctl boot and shutdown primitives the watch lifecycle drives; `SimCtlClient` implements them. */
export type WatchLifecycleSimctl = Pick<SimCtl, "waitForSimulatorReady" | "killSimulator">;

/**
 * The host's simulator boot admission. A watch is a simulator: it occupies the same host
 * capacity the iOS gate counts (every Booted simulator, whatever its runtime), so a cold watch
 * boot is admitted against that one limit like an iPhone boot.
 */
export type WatchBootAdmission = Pick<IosBootInstrumentation, "run">;

/** The watch listing the lifecycle resolves targets from. */
export type WatchLifecycleInventory = Pick<WatchSimulatorInventory, "listWatchSimulators">;

/** Exact watch selector: a simulator UDID, an exact display name, or both naming one watch. */
export interface WatchSelector {
  deviceId?: string;
  name?: string;
}

/** A listed watch; the listing always carries its UDID. */
export type ListedWatch = DeviceInfo & { deviceId: string };

export interface WatchBootResult {
  device: BootedDevice;
  acquisition: "already-booted" | "cold-boot";
}

/**
 * Boots and shuts down Apple Watch simulators (#14908). Targets resolve only from the watch
 * listing, so a UDID that is not a watch (an iPhone, say) is refused before any simctl command.
 * Boot reuses `waitForSimulatorReady` (`bootstatus -b` with state verification and retries) and
 * never presents Simulator.app; shutdown reuses `killSimulator`, which waits for `Shutdown`.
 */
export class WatchSimulatorLifecycle {
  constructor(
    private readonly simctl: WatchLifecycleSimctl,
    private readonly inventory: WatchLifecycleInventory,
    private readonly admission?: WatchBootAdmission,
  ) {}

  async findWatch(selector: WatchSelector, signal?: AbortSignal): Promise<ListedWatch> {
    if (!selector.deviceId && !selector.name) {
      throw new ActionableError(
        "A watchOS target needs deviceId (the watch simulator UDID) or its exact name.",
      );
    }
    const watches = (await this.inventory.listWatchSimulators(signal)).filter(
      (watch): watch is ListedWatch => !!watch.deviceId,
    );
    const matches = watches.filter(
      (watch) =>
        (selector.deviceId === undefined || watch.deviceId === selector.deviceId) &&
        (selector.name === undefined || watch.name === selector.name),
    );
    if (matches.length === 0) {
      throw new ActionableError(
        `No Apple Watch simulator matches ${describeSelector(selector)}. ${describeAvailable(watches)}`,
      );
    }
    if (matches.length > 1) {
      throw new ActionableError(
        `Apple Watch simulator name '${selector.name}' is ambiguous; pass deviceId. ${describeAvailable(matches)}`,
      );
    }
    const watch = matches[0]!;
    if (watch.isAvailable === false) {
      throw new ActionableError(
        `Apple Watch simulator ${watch.deviceId} is unavailable` +
          (watch.availabilityError ? `: ${watch.availabilityError}` : ""),
      );
    }
    return watch;
  }

  async boot(
    watch: ListedWatch,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<WatchBootResult> {
    const udid = watch.deviceId;
    if (watch.isRunning) {
      return {
        device: { name: watch.name, platform: "watchos", deviceId: udid },
        acquisition: "already-booted",
      };
    }
    const bootWatch = () => this.simctl.waitForSimulatorReady(udid, options.timeoutMs);
    // At the simulator limit the admission refuses with the typed retryable capacity error.
    const booted = this.admission
      ? await this.admission.run(
          {
            udid,
            reason: "restart",
            runtime: watch.runtimeId,
            timeoutMs: options.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS,
            // A cancelled or expired request must leave the admission queue, not hold its place.
            signal: options.signal ?? getAbortSignal(),
          },
          bootWatch,
        )
      : await bootWatch();
    // The shared boot path labels what it booted "ios"; this UDID came from the watch listing.
    return { device: { ...booted, platform: "watchos" }, acquisition: "cold-boot" };
  }

  async shutdown(
    device: BootedDevice,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (device.platform !== "watchos") {
      throw new ActionableError(
        `Cannot shut down ${device.platform} device ${device.deviceId} as an Apple Watch simulator.`,
      );
    }
    const watch = await this.findWatch({ deviceId: device.deviceId }, options.signal);
    if (!watch.isRunning) {
      logger.debug(`[watchOS] ${device.deviceId} is already shut down; nothing to stop`);
      return;
    }
    await this.simctl.killSimulator(device, options);
  }
}

function describeSelector(selector: WatchSelector): string {
  return [
    selector.deviceId ? `UDID ${selector.deviceId}` : undefined,
    selector.name ? `name '${selector.name}'` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" and ");
}

function describeAvailable(watches: readonly DeviceInfo[]): string {
  if (watches.length === 0) {
    return "No Apple Watch simulators exist on this host.";
  }
  const listed = watches.map((watch) => `${watch.name} (${watch.deviceId}, ${watch.state})`);
  return `Available watches: ${listed.join(", ")}.`;
}
