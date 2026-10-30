import { ActionableError, toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import type { SimCtlClient } from "./SimCtlClient";
import type { WatchSimulatorCatalog, WatchSimulatorInventory } from "./WatchSimulatorInventory";
import type { ListedWatch } from "./WatchSimulatorLifecycle";

/** `simctl create` and `simctl delete`; `SimCtlClient` implements them. */
export type WatchSimulatorCreator = Pick<SimCtlClient, "createSimulator" | "deleteSimulator">;

/** The watch listing and catalog the provisioner resolves and validates against. */
export type WatchProvisionInventory = Pick<
  WatchSimulatorInventory,
  "listWatchSimulators" | "readCatalog"
>;

/** An exact watch: its name, optionally its UDID, and the device type and runtime identifiers. */
export interface WatchProvisionRequest {
  name: string;
  deviceId?: string;
  spec: { deviceType: string; runtime: string };
}

export interface WatchProvisionOptions {
  /** The device creation gate's verdict; a watch that does not exist is created only when true. */
  allowCreate: boolean;
  /** Runs immediately before `simctl create`, after every check passed. */
  onBeforeCreate?: () => void;
  signal?: AbortSignal;
}

export interface WatchProvisionResult {
  watch: ListedWatch;
  created: boolean;
}

/** Whether a watch this provision created was deleted again after a later step failed. */
export type WatchDiscardResult = { deleted: true } | { deleted: false; error: string };

/**
 * Exact Apple Watch simulator provisioning (#15882). The spec must name a watchOS runtime and an
 * Apple Watch device type the host lists (identifiers only, as on iOS). An existing watch is
 * adopted only when its name, UDID (if given), device type and runtime all match; anything close
 * is a conflict. A missing watch is created fresh with `simctl create`, never cloned, and only
 * when no UDID was named and device creation is allowed. Failed reads propagate.
 */
export class WatchSimulatorProvisioner {
  constructor(
    private readonly inventory: WatchProvisionInventory,
    private readonly creator: WatchSimulatorCreator,
  ) {}

  async provision(
    request: WatchProvisionRequest,
    options: WatchProvisionOptions,
  ): Promise<WatchProvisionResult> {
    assertSpecInCatalog(request.spec, await this.inventory.readCatalog(options.signal));
    const existing = await this.findExisting(request, options.signal);
    if (existing) {
      assertMatchesSpec(existing, request);
      return { watch: existing, created: false };
    }
    if (request.deviceId) {
      throw new ActionableError(
        `No Apple Watch simulator has UDID ${request.deviceId}. Omit deviceId to create ` +
          `'${request.name}', or pass the UDID of an existing watch.`,
      );
    }
    if (!options.allowCreate) {
      throw new ActionableError(
        `Device creation is disabled; cannot provision exact watchos device '${request.name}'.`,
      );
    }
    options.signal?.throwIfAborted();
    options.onBeforeCreate?.();
    return { watch: await this.create(request, options.signal), created: true };
  }

  /**
   * Deletes a watch this provision created, after a later step (boot, session bind) failed, so
   * a failed call leaves no new simulator behind. `simctl delete` also stops a booted watch.
   */
  async discardCreated(watch: ListedWatch): Promise<WatchDiscardResult> {
    try {
      await this.creator.deleteSimulator(watch.deviceId);
      return { deleted: true };
    } catch (error) {
      logger.warn(
        `[watchOS] Could not delete Apple Watch simulator ${watch.deviceId} created by a failed provision: ${errorMessage(error)}`,
        error,
      );
      return { deleted: false, error: errorMessage(error) };
    }
  }

  private async findExisting(
    request: WatchProvisionRequest,
    signal: AbortSignal | undefined,
  ): Promise<ListedWatch | undefined> {
    const watches = await this.listed(signal);
    if (request.deviceId) {
      const watch = watches.find((candidate) => candidate.deviceId === request.deviceId);
      if (watch && watch.name !== request.name) {
        throw new ActionableError(
          `Apple Watch simulator ${request.deviceId} is named '${watch.name}', not '${request.name}'.`,
        );
      }
      return watch;
    }
    const named = watches.filter((watch) => watch.name === request.name);
    if (named.length > 1) {
      throw new ActionableError(
        `Apple Watch simulator name '${request.name}' is ambiguous (${named
          .map((watch) => watch.deviceId)
          .join(", ")}); pass deviceId.`,
      );
    }
    return named[0];
  }

  private async create(
    request: WatchProvisionRequest,
    signal: AbortSignal | undefined,
  ): Promise<ListedWatch> {
    const { name, spec } = request;
    let udid: string;
    try {
      udid = await this.creator.createSimulator(name, spec.deviceType, spec.runtime, signal);
    } catch (error) {
      throw toActionableError(error, `Failed to create Apple Watch simulator '${name}'`);
    }
    const watch = (await this.listed(signal)).find((candidate) => candidate.deviceId === udid);
    if (!watch) {
      throw new ActionableError(
        `simctl created Apple Watch simulator ${udid} for '${name}', but the watch listing does ` +
          "not show it. Retry provisionDevice; it adopts the watch once it is listed.",
      );
    }
    return watch;
  }

  private async listed(signal: AbortSignal | undefined): Promise<ListedWatch[]> {
    return (await this.inventory.listWatchSimulators(signal)).filter(
      (watch): watch is ListedWatch => !!watch.deviceId,
    );
  }
}

function assertSpecInCatalog(
  spec: WatchProvisionRequest["spec"],
  catalog: WatchSimulatorCatalog,
): void {
  if (!catalog.deviceTypes.some((type) => type.identifier === spec.deviceType)) {
    throw new ActionableError(
      `Unknown Apple Watch device type '${spec.deviceType}'. Available: ` +
        listOrNone(catalog.deviceTypes.map((type) => type.identifier)),
    );
  }
  const runtime = catalog.runtimes.find((entry) => entry.identifier === spec.runtime);
  if (!runtime) {
    throw new ActionableError(
      `Unknown watchOS runtime '${spec.runtime}'. Available: ` +
        listOrNone(catalog.runtimes.map((entry) => entry.identifier)),
    );
  }
  if (!runtime.isAvailable) {
    throw new ActionableError(
      `watchOS runtime '${spec.runtime}' is unavailable` +
        (runtime.availabilityError ? `: ${runtime.availabilityError}` : "") +
        ". Install it with Xcode, or name an available runtime.",
    );
  }
}

function assertMatchesSpec(watch: ListedWatch, request: WatchProvisionRequest): void {
  const { deviceType, runtime } = request.spec;
  if (watch.deviceType !== deviceType || watch.runtimeId !== runtime) {
    throw new ActionableError(
      `Apple Watch simulator '${watch.name}' (${watch.deviceId}) is ${watch.deviceType ?? "an unknown device type"} ` +
        `on ${watch.runtimeId ?? "an unknown runtime"}, not ${deviceType} on ${runtime}. ` +
        "Pick another name, or delete that watch first.",
    );
  }
  if (watch.isAvailable === false) {
    throw new ActionableError(
      `Apple Watch simulator ${watch.deviceId} is unavailable` +
        (watch.availabilityError ? `: ${watch.availabilityError}` : ""),
    );
  }
}

function listOrNone(identifiers: string[]): string {
  return identifiers.length > 0 ? identifiers.join(", ") : "none installed";
}
