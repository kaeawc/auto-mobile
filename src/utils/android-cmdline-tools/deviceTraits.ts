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
   * `watch` or `automotive` from `ro.build.characteristics`; null for a phone, tablet, foldable or
   * when the prop is empty or unreadable. Other form factors are deliberately left unclassified:
   * geometry cannot tell a car screen from a tablet, but the build characteristics can.
   */
  formFactor: AndroidDeviceFormFactor | null;
}

export type AndroidDeviceFormFactor = "watch" | "automotive";

/** `ro.build.characteristics` is a comma-separated list such as `emulator,watch`. */
export const BUILD_CHARACTERISTICS_PROP = "ro.build.characteristics";

/** Interpret a raw `ro.build.characteristics` value; see {@link AndroidDeviceTraits.formFactor}. */
export function parseAndroidFormFactor(raw: string | null): AndroidDeviceFormFactor | null {
  const characteristics = (raw ?? "")
    .toLowerCase()
    .split(",")
    .map((entry) => entry.trim());
  if (characteristics.includes("watch")) {
    return "watch";
  }
  return characteristics.includes("automotive") ? "automotive" : null;
}

/** Whether the traits describe a Wear OS watch. Absent traits are not a watch. */
export function isWatch(traits: Pick<AndroidDeviceTraits, "formFactor"> | undefined): boolean {
  return traits?.formFactor === "watch";
}

/** Whether the traits describe an Android Automotive OS device. Absent traits are not a car. */
export function isAutomotive(traits: Pick<AndroidDeviceTraits, "formFactor"> | undefined): boolean {
  return traits?.formFactor === "automotive";
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
      formFactor: parseAndroidFormFactor(characteristics),
    };
  }
}

/** Process-wide reader, so each device is read once per TTL across features. */
export const defaultDeviceTraits: DeviceTraits = new AndroidDeviceTraitsReader();
