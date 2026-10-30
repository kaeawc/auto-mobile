import type { AdbCommandRunner } from "./interfaces/AdbExecutor";
import { defaultTimer, type Timer } from "../SystemTimer";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";

/**
 * The only module that reads `ro.kernel.qemu` and the other identifying build props
 * (#14046). Every emulator-vs-physical probe goes through {@link readAndroidEmulatorFlag}
 * or a {@link DeviceTraits} reader; `test/lint/deviceTraitsSingleReader.test.ts` enforces it.
 */

/** The OEM skin layered over stock Android, e.g. One UI or HyperOS. */
export interface DeviceSkin {
  name: string;
  version: string | null;
}

/**
 * The non-handheld form factors a booted device announces in `ro.build.characteristics`.
 * Handhelds (phone, tablet, foldable) are deliberately left null so their behaviour does
 * not change.
 */
export type TraitFormFactor = "watch" | "automotive" | "tv";

/** Identifying build props of one Android device. A prop that could not be read is null. */
export interface AndroidDeviceTraits {
  /**
   * `ro.kernel.qemu`: true for "1", false for "0" or empty, null for any other value.
   * Null means "could not tell"; callers that need a yes/no treat it as not an emulator.
   */
  isEmulator: boolean | null;
  /** `ro.product.model`. */
  model: string | null;
  /** `ro.build.version.sdk`. */
  sdk: number | null;
  /** `ro.product.cpu.abi`. */
  abi: string | null;
  /** `ro.product.manufacturer`. */
  manufacturer: string | null;
  /** `ro.product.brand`. */
  brand: string | null;
  /**
   * Always null for now: the skin props are not confirmed yet (#14048), and guessing one
   * (e.g. a MIUI or One UI prop) would mislabel devices.
   */
  skin: DeviceSkin | null;
  /**
   * `ro.build.characteristics` containing `watch`, `automotive` or `tv`. Null for everything else,
   * including a prop that could not be read: callers gate special behaviour on a positive
   * match and leave every other device on today's path.
   */
  formFactor: TraitFormFactor | null;
}

export interface DeviceTraitsReadOptions {
  /** Per-getprop subprocess bound. */
  timeoutMs?: number;
}

/** Reads (and caches) the identifying build props of an Android device. */
export interface DeviceTraits {
  /**
   * Resolve the traits of `deviceId`, reading them through `adb` only when no fresh cached
   * read exists. A failed `ro.kernel.qemu` read rejects and is never cached.
   */
  read(
    adb: AdbCommandRunner,
    deviceId: string,
    options?: DeviceTraitsReadOptions,
  ): Promise<AndroidDeviceTraits>;
}

/** The prop whose comma-separated list names the device class, e.g. `emulator,automotive`. */
export const BUILD_CHARACTERISTICS_PROP = "ro.build.characteristics";

/** Interpret a raw `ro.build.characteristics` value; see {@link AndroidDeviceTraits.formFactor}. */
export function parseTraitFormFactor(raw: string | null): TraitFormFactor | null {
  const characteristics = (raw ?? "")
    .split(",")
    .map((characteristic) => characteristic.trim().toLowerCase());
  if (characteristics.includes("automotive")) {
    return "automotive";
  }
  if (characteristics.includes("watch")) {
    return "watch";
  }
  return characteristics.includes("tv") ? "tv" : null;
}

/** True only when the device positively announced an automotive build. */
export function isAutomotive(traits: { formFactor?: TraitFormFactor | null } | undefined): boolean {
  return traits?.formFactor === "automotive";
}

/** True only when the device positively announced a watch build. */
export function isWatch(traits: { formFactor?: TraitFormFactor | null } | undefined): boolean {
  return traits?.formFactor === "watch";
}

export type AndroidEmulatorFlagRunner = (prop: string) => Promise<string>;

/** The emulator flag prop name, exported so other modules can look it up without re-spelling the read. */
export const EMULATOR_FLAG_PROP = "ro.kernel.qemu";

/** Interpret a raw `ro.kernel.qemu` value; see {@link AndroidDeviceTraits.isEmulator}. */
export function parseAndroidEmulatorFlag(raw: string): boolean | null {
  const value = raw.trim();
  if (value === "1") {
    return true;
  }
  if (value === "0" || value === "") {
    return false;
  }
  return null;
}

/**
 * Uncached `ro.kernel.qemu` read through a caller-supplied getprop runner. Transport identity
 * probes use this directly because their answer must come from the transport just probed,
 * never from a cache keyed by a serial a different device may now answer on.
 */
export async function readAndroidEmulatorFlag(
  getprop: AndroidEmulatorFlagRunner,
): Promise<boolean | null> {
  return parseAndroidEmulatorFlag(await getprop(EMULATOR_FLAG_PROP));
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Cached reads expire so a serial reused by a different AVD (emulator-5554 after a pool
 * replacement) cannot keep reporting the old device's model forever.
 */
export const DEVICE_TRAITS_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  readAt: number;
  traits: Promise<AndroidDeviceTraits>;
}

function nonEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseSdk(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const sdk = Number.parseInt(value, 10);
  return Number.isFinite(sdk) ? sdk : null;
}

export class AndroidDeviceTraitsReader implements DeviceTraits {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly ttlMs: number = DEVICE_TRAITS_CACHE_TTL_MS,
  ) {}

  read(
    adb: AdbCommandRunner,
    deviceId: string,
    options: DeviceTraitsReadOptions = {},
  ): Promise<AndroidDeviceTraits> {
    const now = this.timer.now();
    const cached = this.cache.get(deviceId);
    if (cached && now - cached.readAt < this.ttlMs) {
      return cached.traits;
    }
    const traits = this.readUncached(adb, options);
    const entry: CacheEntry = { readAt: now, traits };
    this.cache.set(deviceId, entry);
    traits.catch((error: unknown) => {
      // A failed read is retried by the next caller; it must not pin the failure.
      logger.debug(`[DeviceTraits] read failed for ${deviceId}: ${errorMessage(error)}`);
      if (this.cache.get(deviceId) === entry) {
        this.cache.delete(deviceId);
      }
    });
    return traits;
  }

  /** Drop the cached read for `deviceId`, e.g. after the device behind the serial changed. */
  forget(deviceId: string): void {
    this.cache.delete(deviceId);
  }

  private async readUncached(
    adb: AdbCommandRunner,
    options: DeviceTraitsReadOptions,
  ): Promise<AndroidDeviceTraits> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const getprop = async (prop: string): Promise<string> =>
      (await adb.executeCommand(`shell getprop ${prop}`, { noRetry: true, timeoutMs })).stdout;
    // The emulator flag is the one prop every caller decides on, so its failure fails the read.
    const optional = async (prop: string): Promise<string | null> => {
      try {
        return nonEmpty(await getprop(prop));
      } catch (error) {
        // Descriptive props are advisory; a missing one leaves that field null.
        logger.debug(`[DeviceTraits] getprop ${prop} failed: ${errorMessage(error)}`);
        return null;
      }
    };
    const [isEmulator, model, sdk, abi, manufacturer, brand, characteristics] = await Promise.all([
      readAndroidEmulatorFlag(getprop),
      optional("ro.product.model"),
      optional("ro.build.version.sdk"),
      optional("ro.product.cpu.abi"),
      optional("ro.product.manufacturer"),
      optional("ro.product.brand"),
      optional(BUILD_CHARACTERISTICS_PROP),
    ]);
    return {
      isEmulator,
      model,
      sdk: parseSdk(sdk),
      abi,
      manufacturer,
      brand,
      skin: null,
      formFactor: parseTraitFormFactor(characteristics),
    };
  }
}

/** Process-wide reader, so each device is read once per TTL across features. */
export const defaultDeviceTraits: DeviceTraits = new AndroidDeviceTraitsReader();
