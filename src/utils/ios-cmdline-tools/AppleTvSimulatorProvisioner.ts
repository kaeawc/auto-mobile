import { ActionableError, toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import type { SimCtlClient } from "./SimCtlClient";
import type {
  AppleTvSimulatorCatalog,
  AppleTvSimulatorInventory,
} from "./AppleTvSimulatorInventory";
import { evaluateRuntimeCompatibility } from "./runtimeCompatibility";
import type { ListedAppleTv } from "./AppleTvSimulatorBoot";

/** `simctl create` and `simctl delete`; `SimCtlClient` implements them. */
export type AppleTvSimulatorCreator = Pick<SimCtlClient, "createSimulator" | "deleteSimulator">;

/** The TV listing and catalog the provisioner resolves and validates against. */
export type AppleTvProvisionInventory = Pick<
  AppleTvSimulatorInventory,
  "listAppleTvSimulators" | "readCatalog"
>;

/** An exact TV: its name, optionally its UDID, and the device type and runtime identifiers. */
export interface AppleTvProvisionRequest {
  name: string;
  deviceId?: string;
  spec: { deviceType: string; runtime: string };
}

export interface AppleTvProvisionOptions {
  /** The device creation gate's verdict; a TV that does not exist is created only when true. */
  allowCreate: boolean;
  /** Runs immediately before `simctl create`, after every check passed. */
  onBeforeCreate?: () => void;
  signal?: AbortSignal;
}

export interface AppleTvProvisionResult {
  tv: ListedAppleTv;
  created: boolean;
}

/** Whether a TV this provision created was deleted again after a later step failed. */
export type AppleTvDiscardResult = { deleted: true } | { deleted: false; error: string };

/**
 * Exact Apple TV simulator provisioning (#15889). The spec must name a tvOS runtime and an
 * Apple TV device type the host lists (identifiers only, as on iOS). An existing TV is
 * adopted only when its name, UDID (if given), device type and runtime all match; anything close
 * is a conflict. A missing TV is created fresh with `simctl create`, never cloned, and only
 * when no UDID was named and device creation is allowed. Failed reads propagate.
 */
export class AppleTvSimulatorProvisioner {
  constructor(
    private readonly inventory: AppleTvProvisionInventory,
    private readonly creator: AppleTvSimulatorCreator,
  ) {}

  async provision(
    request: AppleTvProvisionRequest,
    options: AppleTvProvisionOptions,
  ): Promise<AppleTvProvisionResult> {
    assertAppleTvSpecInCatalog(request.spec, await this.inventory.readCatalog(options.signal));
    const existing = await this.findExisting(request, options.signal);
    if (existing) {
      assertMatchesSpec(existing, request);
      return { tv: existing, created: false };
    }
    if (request.deviceId) {
      throw new ActionableError(
        `No Apple TV simulator has UDID ${request.deviceId}. Omit deviceId to create ` +
          `'${request.name}', or pass the UDID of an existing TV.`,
      );
    }
    if (!options.allowCreate) {
      throw new ActionableError(
        `Device creation is disabled; cannot provision exact tvos device '${request.name}'.`,
      );
    }
    options.signal?.throwIfAborted();
    options.onBeforeCreate?.();
    return { tv: await this.create(request, options.signal), created: true };
  }

  /**
   * Deletes a TV this provision created, after a later step (boot, session bind) failed, so
   * a failed call leaves no new simulator behind. `simctl delete` also stops a booted TV.
   */
  async discardCreated(tv: Pick<ListedAppleTv, "deviceId">): Promise<AppleTvDiscardResult> {
    try {
      // Cleanup must outlive cancellation of the provision request.
      await this.creator.deleteSimulator(tv.deviceId, { signal: AbortSignal.timeout(30_000) });
      return { deleted: true };
    } catch (error) {
      logger.warn(
        `[tvOS] Could not delete Apple TV simulator ${tv.deviceId} created by a failed provision: ${errorMessage(error)}`,
        error,
      );
      return { deleted: false, error: errorMessage(error) };
    }
  }

  /** The listed TV with this UDID, else undefined; a failed listing throws. */
  async find(udid: string, signal?: AbortSignal): Promise<ListedAppleTv | undefined> {
    return (await this.listed(signal)).find((tv) => tv.deviceId === udid);
  }

  /**
   * deleteDevice's destroy step: `simctl delete`, then a fresh TV listing that must no longer
   * show the TV. A delete that fails, or a TV still listed afterwards, throws.
   */
  async deleteAndConfirmAbsent(udid: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.creator.deleteSimulator(udid, { signal });
    } catch (error) {
      throw toActionableError(error, `Failed to delete Apple TV simulator ${udid}`);
    }
    if (await this.find(udid, signal)) {
      throw new ActionableError(
        `simctl delete returned, but the TV listing still lists Apple TV simulator ${udid}.`,
      );
    }
  }

  private async findExisting(
    request: AppleTvProvisionRequest,
    signal: AbortSignal | undefined,
  ): Promise<ListedAppleTv | undefined> {
    const tvs = await this.listed(signal);
    if (request.deviceId) {
      const tv = tvs.find((candidate) => candidate.deviceId === request.deviceId);
      if (tv && tv.name !== request.name) {
        throw new ActionableError(
          `Apple TV simulator ${request.deviceId} is named '${tv.name}', not '${request.name}'.`,
        );
      }
      return tv;
    }
    const named = tvs.filter((tv) => tv.name === request.name);
    if (named.length > 1) {
      throw new ActionableError(
        `Apple TV simulator name '${request.name}' is ambiguous (${named
          .map((tv) => tv.deviceId)
          .join(", ")}); pass deviceId.`,
      );
    }
    return named[0];
  }

  private async create(
    request: AppleTvProvisionRequest,
    signal: AbortSignal | undefined,
  ): Promise<ListedAppleTv> {
    const { name, spec } = request;
    let udid: string;
    try {
      udid = await this.creator.createSimulator(name, spec.deviceType, spec.runtime, signal);
    } catch (error) {
      throw toActionableError(error, `Failed to create Apple TV simulator '${name}'`);
    }
    try {
      const tv = (await this.listed(signal)).find((candidate) => candidate.deviceId === udid);
      if (!tv) {
        throw new ActionableError(
          `simctl created Apple TV simulator ${udid} for '${name}', but the TV listing does not show it.`,
        );
      }
      return tv;
    } catch (error) {
      const discarded = await this.discardCreated({ deviceId: udid });
      throw new ActionableError(
        `Could not confirm created Apple TV simulator ${udid}; ` +
          (discarded.deleted
            ? "the TV was deleted again. Retry provisionDevice"
            : `deleting it again failed (${discarded.error}); delete it with deleteDevice`) +
          `: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async listed(signal: AbortSignal | undefined): Promise<ListedAppleTv[]> {
    return (await this.inventory.listAppleTvSimulators(signal)).filter(
      (tv): tv is ListedAppleTv => !!tv.deviceId,
    );
  }
}

/** Refuse a TV spec the host catalog does not list (naming what it does) or whose runtime is unavailable. */
export function assertAppleTvSpecInCatalog(
  spec: AppleTvProvisionRequest["spec"],
  catalog: AppleTvSimulatorCatalog,
): void {
  if (!catalog.deviceTypes.some((type) => type.identifier === spec.deviceType)) {
    throw new ActionableError(
      `Unknown Apple TV device type '${spec.deviceType}'. Available: ` +
        listOrNone(catalog.deviceTypes.map((type) => type.identifier)),
    );
  }
  const runtime = catalog.runtimes.find((entry) => entry.identifier === spec.runtime);
  if (!runtime) {
    throw new ActionableError(
      `Unknown tvOS runtime '${spec.runtime}'. Available: ` +
        listOrNone(catalog.runtimes.map((entry) => entry.identifier)) +
        ". Install it with `xcodebuild -downloadPlatform tvOS`.",
    );
  }
  if (!runtime.isAvailable) {
    throw new ActionableError(
      `tvOS runtime '${spec.runtime}' is unavailable` +
        (runtime.availabilityError ? `: ${runtime.availabilityError}` : "") +
        ". Install it with `xcodebuild -downloadPlatform tvOS`, or name an available runtime.",
    );
  }
  const deviceType = catalog.deviceTypes.find((type) => type.identifier === spec.deviceType)!;
  if (evaluateRuntimeCompatibility(deviceType, runtime.version).status === "unsupported") {
    throw new ActionableError(
      `Apple TV device type '${spec.deviceType}' is incompatible with tvOS runtime '${spec.runtime}' (${runtime.version}). Pick a compatible pair from automobile:devices/images/tvos.`,
    );
  }
}

function assertMatchesSpec(tv: ListedAppleTv, request: AppleTvProvisionRequest): void {
  const { deviceType, runtime } = request.spec;
  if (tv.deviceType !== deviceType || tv.runtimeId !== runtime) {
    throw new ActionableError(
      `Apple TV simulator '${tv.name}' (${tv.deviceId}) is ${tv.deviceType ?? "an unknown device type"} ` +
        `on ${tv.runtimeId ?? "an unknown runtime"}, not ${deviceType} on ${runtime}. ` +
        "Pick another name, or delete that TV first.",
    );
  }
  if (tv.isAvailable === false) {
    throw new ActionableError(
      `Apple TV simulator ${tv.deviceId} is unavailable` +
        (tv.availabilityError ? `: ${tv.availabilityError}` : ""),
    );
  }
}

function listOrNone(identifiers: string[]): string {
  return identifiers.length > 0 ? identifiers.join(", ") : "none installed";
}
