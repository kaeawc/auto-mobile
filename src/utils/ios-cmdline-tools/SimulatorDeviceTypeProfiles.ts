import { defaultTimer, type Timer } from "../SystemTimer";
import { runWithAbortSignal } from "../AbortContext";
import { raceWithDeadline } from "../raceWithDeadline";
import {
  FileSimulatorProfileStore,
  simulatorProfileCacheSchema,
  type SimulatorProfileStore,
} from "./SimulatorProfileStore";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
import { PlistClient, type PlistReader } from "./PlistClient";
import { SimCtlClient, type AppleDeviceType } from "./SimCtlClient";

export interface SimulatorDeviceTypeProfile {
  deviceTypeId: string;
  productFamily: string | null;
  modelIdentifier: string | null;
  // mainScreenWidth/mainScreenHeight from profile.plist are the panel's PIXEL dimensions
  // (iPhone 17: 1206x2622 at mainScreenScale 3 = 402x874 UIKit points) — the same unit
  // Android reports. `dpi` is the panel density (mainScreenWidthDPI); `scale` is UIScreen.scale.
  pixelWidth: number | null;
  pixelHeight: number | null;
  scale: number | null;
  dpi: number | null;
}

export interface SimulatorDeviceTypeProfileSource {
  prepare?(): Promise<void>;
  profileFor(
    deviceTypeId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SimulatorDeviceTypeProfile | null>;
}

export interface SimulatorDeviceTypeLister {
  getDeviceTypes(signal?: AbortSignal): Promise<AppleDeviceType[]>;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Best-effort reader for simulator device type display metadata. */
export class SimCtlSimulatorDeviceTypeProfiles implements SimulatorDeviceTypeProfileSource {
  private readonly profiles = new Map<string, SimulatorDeviceTypeProfile | null>();
  private deviceTypes: Promise<AppleDeviceType[]> | undefined;
  private readonly inFlight = new Map<string, Promise<SimulatorDeviceTypeProfile | null>>();
  private initialized: Promise<void> | undefined;
  private cacheKey: string | null = null;
  private listedTypes: AppleDeviceType[] = [];
  private publication: Promise<void> = Promise.resolve();

  constructor(
    private readonly deviceTypeLister: SimulatorDeviceTypeLister = new SimCtlClient(),
    private readonly plist: PlistReader = new PlistClient(),
    private readonly store?: SimulatorProfileStore,
    private readonly timer: Timer = defaultTimer,
  ) {}

  async profileFor(
    deviceTypeId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SimulatorDeviceTypeProfile | null> {
    if (options.signal?.aborted || (options.timeoutMs !== undefined && options.timeoutMs <= 0)) {
      return null;
    }
    let flight = this.inFlight.get(deviceTypeId);
    if (!flight) {
      flight = this.loadProfile(deviceTypeId).finally(() => this.inFlight.delete(deviceTypeId));
      this.inFlight.set(deviceTypeId, flight);
    }
    try {
      return await raceWithDeadline(flight, {
        timer: this.timer,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        label: "simulator device type profile",
      });
    } catch (error) {
      // Optional enrichment can be abandoned without cancelling another caller's shared read.
      logger.debug(`Stopped waiting for simulator profile: ${String(error)}`);
      return null;
    }
  }

  async prepare(): Promise<void> {
    try {
      await this.getDeviceTypes();
    } catch (error) {
      // Prefetch is optional; a later profile read retries a failed listing.
      logger.debug(`Failed to prepare simulator device types: ${String(error)}`);
    }
  }

  private async loadProfile(deviceTypeId: string): Promise<SimulatorDeviceTypeProfile | null> {
    await this.initialize();
    if (this.profiles.has(deviceTypeId)) {
      return this.profiles.get(deviceTypeId) ?? null;
    }
    let deviceTypes: AppleDeviceType[];
    try {
      deviceTypes = await this.getDeviceTypes();
    } catch (error) {
      // Device type listing is optional best-effort enrichment, so a transient failure is safe to swallow and retry.
      logger.debug(`Failed to list iOS simulator device types: ${String(error)}`);
      return null;
    }

    try {
      const deviceType = deviceTypes.find((candidate) => candidate.identifier === deviceTypeId);
      if (!deviceType?.bundlePath) {
        this.profiles.set(deviceTypeId, null);
        return null;
      }
      const plist = await this.plist.readJsonFile(
        `${deviceType.bundlePath}/Contents/Resources/profile.plist`,
        { timeoutMs: 15_000 },
      );
      const values = plist !== null && typeof plist === "object" ? plist : {};
      const profile = {
        deviceTypeId,
        productFamily: optionalString(deviceType.productFamily),
        modelIdentifier: optionalString(deviceType.modelIdentifier),
        pixelWidth: optionalNumber((values as Record<string, unknown>).mainScreenWidth),
        pixelHeight: optionalNumber((values as Record<string, unknown>).mainScreenHeight),
        scale: optionalNumber((values as Record<string, unknown>).mainScreenScale),
        dpi:
          optionalNumber((values as Record<string, unknown>).mainScreenWidthDPI) ??
          optionalNumber((values as Record<string, unknown>).mainScreenHeightDPI),
      } satisfies SimulatorDeviceTypeProfile;
      this.profiles.set(deviceTypeId, profile);
      this.persist();
      return profile;
    } catch (error) {
      // Display dimensions are optional best-effort enrichment, so a failed lookup is safe to swallow.
      logger.debug(
        `Failed to read iOS simulator device type profile for ${deviceTypeId}: ${String(error)}`,
      );
      // A cancelled/timed-out read says nothing about the profile; only a completed
      // failure is worth remembering.
      if (!isAbortOrTimeout(error)) {
        this.profiles.set(deviceTypeId, null);
      }
      return null;
    }
  }

  private async getDeviceTypes(): Promise<AppleDeviceType[]> {
    await this.initialize();
    if (!this.deviceTypes) {
      const controller = new AbortController();
      this.deviceTypes = raceWithDeadline(
        () =>
          runWithAbortSignal(controller.signal, () =>
            this.deviceTypeLister.getDeviceTypes(controller.signal),
          ),
        {
          timer: this.timer,
          timeoutMs: 15_000,
          label: "simulator device types",
          onTimeout: () => controller.abort(),
        },
      )
        .then((types) => {
          this.listedTypes = types;
          this.persist();
          return types;
        })
        .catch((error) => {
          this.deviceTypes = undefined;
          throw error;
        });
    }
    return this.deviceTypes;
  }

  private initialize(): Promise<void> {
    this.initialized ??= this.restore();
    return this.initialized;
  }

  private async restore(): Promise<void> {
    if (!this.store) {
      return;
    }
    try {
      this.cacheKey = await this.store.currentKey();
      if (!this.cacheKey) {
        return;
      }
      const contents = await this.store.read();
      if (!contents) {
        return;
      }
      const cached = simulatorProfileCacheSchema.parse(JSON.parse(contents));
      if (cached.key !== this.cacheKey) {
        return;
      }
      this.listedTypes = cached.deviceTypes;
      this.deviceTypes = Promise.resolve(cached.deviceTypes);
      for (const profile of cached.profiles) {
        this.profiles.set(profile.deviceTypeId, profile);
      }
    } catch (error) {
      // Missing, stale or corrupt optional cache data must fall back to live discovery.
      logger.debug(`Failed to restore simulator profiles: ${String(error)}`);
    }
  }

  /**
   * Resolves once every snapshot queued so far has been written or has failed.
   * Discovery never waits on this; it exists so callers that need the cache on
   * disk (tests, a restart in the same process) can observe completion.
   */
  flushPersistence(): Promise<void> {
    return this.publication;
  }

  /**
   * Queue a cache snapshot without blocking discovery (#14514): a stalled
   * AUTOMOBILE_DATA_DIR must not delay or drop the live result. The queue never
   * rejects, so leaving it un-awaited cannot become an unhandled rejection.
   */
  private persist(): void {
    if (!this.store || !this.cacheKey) {
      return;
    }
    const store = this.store;
    const contents = JSON.stringify({
      version: 1,
      key: this.cacheKey,
      deviceTypes: this.listedTypes,
      profiles: [...this.profiles.values()].filter((profile) => profile !== null),
    });
    // Serialize snapshots so a slower earlier write cannot discard newer profiles.
    this.publication = this.publication.then(async () => {
      try {
        await store.write(contents);
      } catch (error) {
        // Persistence is an optional startup optimization, never a discovery requirement;
        // warn so an unwritable data directory still leaves a trace.
        logger.warn(`Failed to persist simulator profiles: ${errorMessage(error)}`);
      }
    });
  }
}

function isAbortOrTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || /timed out|timeout|cancelled/i.test(error.message);
}

/** Production wiring kept outside the size-capped SimCtlClient. Direct readers may omit disk storage. */
export function simulatorProfiles(
  lister: SimulatorDeviceTypeLister,
  plist: PlistReader,
  timer: Timer,
): SimulatorDeviceTypeProfileSource {
  return new SimCtlSimulatorDeviceTypeProfiles(
    lister,
    plist,
    new FileSimulatorProfileStore(),
    timer,
  );
}
