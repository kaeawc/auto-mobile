import { ActionableError, toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import type { SimCtlClient } from "./SimCtlClient";
import type {
  AppleVisionSimulatorCatalog,
  AppleVisionSimulatorInventory,
} from "./AppleVisionSimulatorInventory";
import { evaluateRuntimeCompatibility } from "./runtimeCompatibility";
import type { ListedAppleVision } from "./AppleVisionSimulatorBoot";

/** `simctl create` and `simctl delete`; `SimCtlClient` implements them. */
export type AppleVisionSimulatorCreator = Pick<SimCtlClient, "createSimulator" | "deleteSimulator">;

/** The headset listing and catalog the provisioner resolves and validates against. */
export type AppleVisionProvisionInventory = Pick<
  AppleVisionSimulatorInventory,
  "listAppleVisionSimulators" | "readCatalog"
>;

/** An exact headset: its name, optionally its UDID, and the device type and runtime identifiers. */
export interface AppleVisionProvisionRequest {
  name: string;
  deviceId?: string;
  spec: { deviceType: string; runtime: string };
}

export interface AppleVisionProvisionOptions {
  /** The device creation gate's verdict; a headset that does not exist is created only when true. */
  allowCreate: boolean;
  /** Runs immediately before `simctl create`, after every check passed. */
  onBeforeCreate?: () => void;
  /** Lifecycle-fenced cleanup when the listing cannot confirm the newly created headset. */
  discardUnconfirmed?: (
    headset: Pick<ListedAppleVision, "deviceId">,
  ) => Promise<AppleVisionDiscardResult>;
  signal?: AbortSignal;
}

export interface AppleVisionProvisionResult {
  headset: ListedAppleVision;
  created: boolean;
}

/** Whether a headset this provision created was deleted again after a later step failed. */
export type AppleVisionDiscardResult = { deleted: true } | { deleted: false; error: string };

/**
 * Exact Apple Vision Pro simulator provisioning. The spec must name a visionOS runtime and an
 * Apple Vision Pro device type the host lists (identifiers only, as on iOS). An existing headset is
 * adopted only when its name, UDID (if given), device type and runtime all match; anything close
 * is a conflict. A missing headset is created fresh with `simctl create`, never cloned, and only
 * when no UDID was named and device creation is allowed. Failed reads propagate.
 */
export class AppleVisionSimulatorProvisioner {
  constructor(
    private readonly inventory: AppleVisionProvisionInventory,
    private readonly creator: AppleVisionSimulatorCreator,
  ) {}

  async provision(
    request: AppleVisionProvisionRequest,
    options: AppleVisionProvisionOptions,
  ): Promise<AppleVisionProvisionResult> {
    assertAppleVisionSpecInCatalog(request.spec, await this.inventory.readCatalog(options.signal));
    const existing = await this.findExisting(request, options.signal);
    if (existing) {
      assertMatchesSpec(existing, request);
      return { headset: existing, created: false };
    }
    if (request.deviceId) {
      throw new ActionableError(
        `No Apple Vision Pro simulator has UDID ${request.deviceId}. Omit deviceId to create ` +
          `'${request.name}', or pass the UDID of an existing headset.`,
      );
    }
    if (!options.allowCreate) {
      throw new ActionableError(
        `Device creation is disabled; cannot provision exact visionos device '${request.name}'.`,
      );
    }
    options.signal?.throwIfAborted();
    options.onBeforeCreate?.();
    return { headset: await this.create(request, options), created: true };
  }

  /**
   * Deletes a headset this provision created, after a later step (boot, session bind) failed, so
   * a failed call leaves no new simulator behind. `simctl delete` also stops a booted headset.
   */
  async discardCreated(
    headset: Pick<ListedAppleVision, "deviceId">,
  ): Promise<AppleVisionDiscardResult> {
    try {
      // Cleanup must outlive cancellation of the provision request.
      await this.creator.deleteSimulator(headset.deviceId, { signal: AbortSignal.timeout(30_000) });
      return { deleted: true };
    } catch (error) {
      logger.warn(
        `[visionOS] Could not delete Apple Vision Pro simulator ${headset.deviceId} created by a failed provision: ${errorMessage(error)}`,
        error,
      );
      return { deleted: false, error: errorMessage(error) };
    }
  }

  /** The listed headset with this UDID, else undefined; a failed listing throws. */
  async find(udid: string, signal?: AbortSignal): Promise<ListedAppleVision | undefined> {
    return (await this.listed(signal)).find((headset) => headset.deviceId === udid);
  }

  /**
   * deleteDevice's destroy step: `simctl delete`, then a fresh headset listing that must no longer
   * show the headset. A delete that fails, or a headset still listed afterwards, throws.
   */
  async deleteAndConfirmAbsent(udid: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.creator.deleteSimulator(udid, { signal });
    } catch (error) {
      throw toActionableError(error, `Failed to delete Apple Vision Pro simulator ${udid}`);
    }
    if (await this.find(udid, signal)) {
      throw new ActionableError(
        `simctl delete returned, but the headset listing still lists Apple Vision Pro simulator ${udid}.`,
      );
    }
  }

  private async findExisting(
    request: AppleVisionProvisionRequest,
    signal: AbortSignal | undefined,
  ): Promise<ListedAppleVision | undefined> {
    const headsets = await this.listed(signal);
    if (request.deviceId) {
      const headset = headsets.find((candidate) => candidate.deviceId === request.deviceId);
      if (headset && headset.name !== request.name) {
        throw new ActionableError(
          `Apple Vision Pro simulator ${request.deviceId} is named '${headset.name}', not '${request.name}'.`,
        );
      }
      return headset;
    }
    const named = headsets.filter((headset) => headset.name === request.name);
    if (named.length > 1) {
      throw new ActionableError(
        `Apple Vision Pro simulator name '${request.name}' is ambiguous (${named
          .map((headset) => headset.deviceId)
          .join(", ")}); pass deviceId.`,
      );
    }
    return named[0];
  }

  private async create(
    request: AppleVisionProvisionRequest,
    { signal, discardUnconfirmed }: AppleVisionProvisionOptions,
  ): Promise<ListedAppleVision> {
    const { name, spec } = request;
    let udid: string;
    try {
      udid = await this.creator.createSimulator(name, spec.deviceType, spec.runtime, signal);
    } catch (error) {
      throw toActionableError(error, `Failed to create Apple Vision Pro simulator '${name}'`);
    }
    try {
      const headset = (await this.listed(signal)).find((candidate) => candidate.deviceId === udid);
      if (!headset) {
        throw new ActionableError(
          `simctl created Apple Vision Pro simulator ${udid} for '${name}', but the headset listing does not show it.`,
        );
      }
      return headset;
    } catch (error) {
      const discarded = await discardUnconfirmed?.({ deviceId: udid });
      throw new ActionableError(
        `Could not confirm created Apple Vision Pro simulator ${udid}; ` +
          (discarded?.deleted
            ? "the headset was deleted again. Retry provisionDevice"
            : "the headset was left in place; " +
              (discarded ? `deleting it again failed (${discarded.error}); ` : "") +
              "delete it with deleteDevice") +
          `: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async listed(signal: AbortSignal | undefined): Promise<ListedAppleVision[]> {
    return (await this.inventory.listAppleVisionSimulators(signal)).filter(
      (headset): headset is ListedAppleVision => !!headset.deviceId,
    );
  }
}

/** Refuse a headset spec the host catalog does not list (naming what it does) or whose runtime is unavailable. */
export function assertAppleVisionSpecInCatalog(
  spec: AppleVisionProvisionRequest["spec"],
  catalog: AppleVisionSimulatorCatalog,
): void {
  if (!catalog.deviceTypes.some((type) => type.identifier === spec.deviceType)) {
    throw new ActionableError(
      `Unknown Apple Vision Pro device type '${spec.deviceType}'. Available: ` +
        listOrNone(catalog.deviceTypes.map((type) => type.identifier)),
    );
  }
  const runtime = catalog.runtimes.find((entry) => entry.identifier === spec.runtime);
  if (!runtime) {
    throw new ActionableError(
      `Unknown visionOS runtime '${spec.runtime}'. Available: ` +
        listOrNone(catalog.runtimes.map((entry) => entry.identifier)) +
        ". Install it with `xcodebuild -downloadPlatform visionOS`.",
    );
  }
  if (!runtime.isAvailable) {
    throw new ActionableError(
      `visionOS runtime '${spec.runtime}' is unavailable` +
        (runtime.availabilityError ? `: ${runtime.availabilityError}` : "") +
        ". Install it with `xcodebuild -downloadPlatform visionOS`, or name an available runtime.",
    );
  }
  const deviceType = catalog.deviceTypes.find((type) => type.identifier === spec.deviceType)!;
  if (evaluateRuntimeCompatibility(deviceType, runtime.version).status === "unsupported") {
    throw new ActionableError(
      `Apple Vision Pro device type '${spec.deviceType}' is incompatible with visionOS runtime '${spec.runtime}' (${runtime.version}). Pick a compatible pair from automobile:devices/images/visionos.`,
    );
  }
}

function assertMatchesSpec(headset: ListedAppleVision, request: AppleVisionProvisionRequest): void {
  const { deviceType, runtime } = request.spec;
  if (headset.deviceType !== deviceType || headset.runtimeId !== runtime) {
    throw new ActionableError(
      `Apple Vision Pro simulator '${headset.name}' (${headset.deviceId}) is ${headset.deviceType ?? "an unknown device type"} ` +
        `on ${headset.runtimeId ?? "an unknown runtime"}, not ${deviceType} on ${runtime}. ` +
        "Pick another name, or delete that headset first.",
    );
  }
  if (headset.isAvailable === false) {
    throw new ActionableError(
      `Apple Vision Pro simulator ${headset.deviceId} is unavailable` +
        (headset.availabilityError ? `: ${headset.availabilityError}` : ""),
    );
  }
}

function listOrNone(identifiers: string[]): string {
  return identifiers.length > 0 ? identifiers.join(", ") : "none installed";
}
