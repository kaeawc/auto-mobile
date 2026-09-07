import { errorMessage } from "../../utils/describeUnknownError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice } from "../../models";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { logger } from "../../utils/logger";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";

/**
 * The visual display configuration that reshapes an app's layout without changing
 * its content or navigation (issue #6096): the user's font/text scale, the
 * effective display density, and the light/dark theme (night mode). Each is
 * settable, observable in a subsequent screen capture, and restorable to the
 * device default via `reset`.
 *
 * Android supports all three fields. The iOS Simulator supports `theme` only,
 * via `simctl ui appearance` (matching how the device-snapshot iOS settings
 * capture already reads/restores simulator appearance); font scale and density
 * have no simctl/defaults equivalent. Physical iOS devices support none of the
 * three — there is no automatable, per-device control for any of them.
 */
export type DisplayTheme = "light" | "dark" | "system";

/** Relative density buckets, resolved against the device's physical density. */
export type DensityBucket = "smaller" | "default" | "larger";

/** Density input: an explicit effective dpi, or a relative bucket. */
export type DensityInput = number | DensityBucket;

/** Scale factors for the relative density buckets (against physical density). */
const DENSITY_BUCKET_FACTORS: Record<Exclude<DensityBucket, "default">, number> = {
  smaller: 0.85,
  larger: 1.15,
};

/** The AOSP default text scale — restored on `reset`. */
export const DEFAULT_FONT_SCALE = 1.0;

export interface DisplayConfigValues {
  /** System text scale, e.g. 1.0 (default), 1.3, 2.0. */
  fontScale?: number;
  /** Effective display density in dpi. */
  density?: number;
  /** Resolved light/dark/system theme. */
  theme?: DisplayTheme;
}

/**
 * Per-field platform support. `density` is reported as `"partial"` on physical
 * Android devices, where `wm density` overrides are best-effort and may be
 * clamped or ignored by the OEM shell.
 */
export interface DisplayConfigSupport {
  fontScale: boolean;
  density: boolean | "partial";
  theme: boolean;
}

export interface DisplayConfigResult {
  success: boolean;
  deviceId: string;
  platform: "android" | "ios";
  supported: DisplayConfigSupport;
  /** Current values (getter form). */
  current?: DisplayConfigValues;
  /** Values applied by a set/reset. */
  applied?: DisplayConfigValues;
  /** Values read immediately before a set/reset, so the client can restore. */
  previous?: DisplayConfigValues;
  message?: string;
  error?: string;
}

export interface SetDisplayConfigInput {
  fontScale?: number;
  density?: DensityInput;
  theme?: DisplayTheme;
  /** Restore font scale, density, and theme to device defaults. */
  reset?: boolean;
}

export interface DisplayConfigDependencies {
  adbFactory?: AdbClientFactory;
  processExecutor?: HostCommandExecutor;
}

const IOS_PHYSICAL_DISPLAY_CONFIG_UNSUPPORTED_ERROR =
  "Display configuration (font scale, density, theme) cannot be read or set on a physical iOS " +
  "device: there is no automatable, per-device control for the system text size, display zoom, " +
  "or Dark Mode outside the Simulator. simctl has no verb for them on hardware, and the only " +
  "host mechanism is manual Settings toggles. Set these manually in the iOS Settings app.";

const IOS_FONT_SCALE_UNSUPPORTED_ERROR =
  "fontScale is not supported on the iOS Simulator: there is no simctl/defaults control for " +
  "the system text scale.";

const IOS_DENSITY_UNSUPPORTED_ERROR =
  "density is not supported on the iOS Simulator: there is no simctl/defaults control for " +
  "display density.";

const ANDROID_UNSUPPORTED_PLATFORM_ERROR = "Display configuration is only supported on Android.";

/** Android emulators report an `emulator-<port>` serial; everything else is physical. */
function isAndroidEmulatorSerial(deviceId: string): boolean {
  return deviceId.startsWith("emulator-");
}

/**
 * Parse `settings get system font_scale`. An unset value ("null"/empty) means the
 * device is at the AOSP default of 1.0; a malformed value yields `undefined` so
 * the caller does not fabricate a scale it could not read.
 */
export function parseFontScale(raw: string): number | undefined {
  const value = raw.trim();
  if (!value || value === "null") {
    return DEFAULT_FONT_SCALE;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Parse `wm density` free text, preferring the override density when one is set:
 *
 *   Physical density: 440
 *   Override density: 480
 *
 * Returns `undefined` when neither line is present/parseable.
 */
export function parseWmDensity(raw: string): { physical?: number; effective?: number } {
  const physicalMatch = raw.match(/Physical density:\s*(\d+)/i);
  const overrideMatch = raw.match(/Override density:\s*(\d+)/i);
  const physical = physicalMatch ? Number.parseInt(physicalMatch[1], 10) : undefined;
  const override = overrideMatch ? Number.parseInt(overrideMatch[1], 10) : undefined;
  return {
    ...(physical !== undefined && Number.isFinite(physical) ? { physical } : {}),
    effective:
      override !== undefined && Number.isFinite(override)
        ? override
        : physical !== undefined && Number.isFinite(physical)
          ? physical
          : undefined,
  };
}

/**
 * Parse `cmd uimode night` output ("Night mode: yes|no|auto"). `yes` is dark,
 * `no` is light, `auto` follows the system, mapped to the tool's `system`.
 */
export function parseNightMode(raw: string): DisplayTheme | undefined {
  const match = raw.match(/Night mode:\s*(\w+)/i);
  const value = (match?.[1] ?? raw.trim()).toLowerCase();
  switch (value) {
    case "yes":
      return "dark";
    case "no":
      return "light";
    case "auto":
    case "custom":
      return "system";
    default:
      return undefined;
  }
}

/** Map the tool's theme enum to the `cmd uimode night` argument. */
function nightModeArg(theme: DisplayTheme): string {
  switch (theme) {
    case "dark":
      return "yes";
    case "light":
      return "no";
    case "system":
      return "auto";
  }
}

export class DisplayConfig {
  private device: BootedDevice;

  private adbFactory: AdbClientFactory;

  private processExecutor: HostCommandExecutor;

  constructor(device: BootedDevice, dependencies: DisplayConfigDependencies = {}) {
    this.device = device;
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.processExecutor = dependencies.processExecutor ?? new DefaultHostCommandExecutor();
  }

  /** iOS simulators expose `simctl`/`defaults`; physical iOS devices expose neither. */
  private isIosSimulator(): boolean {
    return isIosSimulatorUdid(this.device.deviceId);
  }

  private support(): DisplayConfigSupport {
    if (this.device.platform === "ios") {
      // `simctl ui appearance` supports the iOS Simulator only; font scale and
      // density have no simctl/defaults equivalent on either iOS target (#6096).
      return { fontScale: false, density: false, theme: this.isIosSimulator() };
    }
    return {
      fontScale: true,
      theme: true,
      // `wm density` overrides are reliable on emulators but best-effort on
      // physical/OEM devices, so report them as `partial` there (issue #6096).
      density: isAndroidEmulatorSerial(this.device.deviceId) ? true : "partial",
    };
  }

  private unsupported(error: string): DisplayConfigResult {
    return {
      success: false,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      supported: this.support(),
      error,
    };
  }

  /** Read the current iOS Simulator theme via `simctl ui appearance` (no value = get). */
  private async readIosTheme(): Promise<DisplayTheme | undefined> {
    const result = await this.processExecutor.executeCommand("xcrun", [
      "simctl",
      "ui",
      this.device.deviceId,
      "appearance",
    ]);
    const value = (result.stdout ?? "").trim();
    return value === "light" || value === "dark" ? value : undefined;
  }

  /**
   * Set the iOS Simulator appearance via `simctl ui appearance <light|dark>`.
   * `system` has no simulator equivalent — there is no "auto" appearance mode
   * outside physical hardware — so it is reported as an honest per-field
   * refusal rather than silently coerced to light or dark.
   */
  private async setIosAppearance(theme: DisplayTheme): Promise<string[]> {
    if (theme === "system") {
      return [
        "Cannot set theme 'system' on the iOS Simulator: 'simctl ui appearance' only accepts " +
          "'light' or 'dark'.",
      ];
    }
    try {
      await this.processExecutor.executeCommand("xcrun", [
        "simctl",
        "ui",
        this.device.deviceId,
        "appearance",
        theme,
      ]);
      return [];
    } catch (error) {
      return [`'simctl ui appearance ${theme}' failed: ${errorMessage(error)}`];
    }
  }

  private async getIosSimulatorConfig(): Promise<DisplayConfigResult> {
    try {
      const theme = await this.readIosTheme();
      return {
        success: true,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        current: theme !== undefined ? { theme } : {},
      };
    } catch (error) {
      logger.warn(
        `[DisplayConfig] getConfig failed (iOS simulator): ${errorMessage(error)}`,
        error,
      );
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        error: errorMessage(error),
      };
    }
  }

  private async applyIosChanges(input: SetDisplayConfigInput): Promise<string[]> {
    const errors: string[] = [];
    if (input.fontScale !== undefined) {
      errors.push(IOS_FONT_SCALE_UNSUPPORTED_ERROR);
    }
    if (input.density !== undefined) {
      errors.push(IOS_DENSITY_UNSUPPORTED_ERROR);
    }
    if (input.theme !== undefined) {
      errors.push(...(await this.setIosAppearance(input.theme)));
    }
    return errors;
  }

  private async setIosSimulatorConfig(input: SetDisplayConfigInput): Promise<DisplayConfigResult> {
    if (
      !input.reset &&
      input.fontScale === undefined &&
      input.density === undefined &&
      input.theme === undefined
    ) {
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        error:
          "At least one of fontScale, density, theme, or reset must be provided to set display config.",
      };
    }

    try {
      const previousTheme = await this.readIosTheme();
      const previous: DisplayConfigValues =
        previousTheme !== undefined ? { theme: previousTheme } : {};
      // Light is the platform default appearance, matching the Android reset's
      // choice of the AOSP default theme (issue #6096).
      const errors = input.reset
        ? await this.setIosAppearance("light")
        : await this.applyIosChanges(input);
      const appliedTheme = await this.readIosTheme();
      const applied: DisplayConfigValues =
        appliedTheme !== undefined ? { theme: appliedTheme } : {};
      const error = errors.length > 0 ? errors.join("; ") : undefined;
      return {
        success: error === undefined,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        applied,
        previous,
        ...(error ? { error } : {}),
      };
    } catch (error) {
      logger.warn(
        `[DisplayConfig] setConfig failed (iOS simulator): ${errorMessage(error)}`,
        error,
      );
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        error: errorMessage(error),
      };
    }
  }

  /** Read the current font scale, density, and theme. */
  async getConfig(): Promise<DisplayConfigResult> {
    if (this.device.platform === "ios") {
      if (!this.isIosSimulator()) {
        return this.unsupported(IOS_PHYSICAL_DISPLAY_CONFIG_UNSUPPORTED_ERROR);
      }
      return this.getIosSimulatorConfig();
    }
    try {
      const adb = this.adbFactory.create(this.device);
      const current = await this.readValues(adb);
      return {
        success: true,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        current,
      };
    } catch (error) {
      logger.warn(`[DisplayConfig] getConfig failed: ${errorMessage(error)}`, error);
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        error: errorMessage(error),
      };
    }
  }

  /** Apply a font scale, density, and/or theme change, or reset to defaults. */
  async setConfig(input: SetDisplayConfigInput): Promise<DisplayConfigResult> {
    if (this.device.platform === "ios") {
      if (!this.isIosSimulator()) {
        return this.unsupported(IOS_PHYSICAL_DISPLAY_CONFIG_UNSUPPORTED_ERROR);
      }
      return this.setIosSimulatorConfig(input);
    }
    if (this.device.platform !== "android") {
      return this.unsupported(ANDROID_UNSUPPORTED_PLATFORM_ERROR);
    }
    if (
      !input.reset &&
      input.fontScale === undefined &&
      input.density === undefined &&
      input.theme === undefined
    ) {
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        error:
          "At least one of fontScale, density, theme, or reset must be provided to set display config.",
      };
    }

    try {
      const adb = this.adbFactory.create(this.device);
      const { values: previous, physicalDensity } = await this.readRawValues(adb);
      const errors = input.reset
        ? await this.applyReset(adb)
        : await this.applyChanges(adb, input, physicalDensity);
      const applied = await this.readValues(adb);
      const error = errors.length > 0 ? errors.join("; ") : undefined;
      return {
        success: error === undefined,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        applied,
        previous,
        ...(error ? { error } : {}),
      };
    } catch (error) {
      logger.warn(`[DisplayConfig] setConfig failed: ${errorMessage(error)}`, error);
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        error: errorMessage(error),
      };
    }
  }

  private async readValues(adb: AdbExecutor): Promise<DisplayConfigValues> {
    return (await this.readRawValues(adb)).values;
  }

  /**
   * Like {@link readValues}, but also surfaces the device's PHYSICAL density
   * (discarded from the public `DisplayConfigValues.density`, which reports the
   * EFFECTIVE — possibly already-overridden — density) so relative density
   * buckets can be resolved against the true hardware density rather than a
   * prior override, which would otherwise compound (issue #6096).
   */
  private async readRawValues(
    adb: AdbExecutor,
  ): Promise<{ values: DisplayConfigValues; physicalDensity: number | undefined }> {
    const [fontRaw, densityRaw, nightRaw] = await Promise.all([
      this.run(adb, "shell settings get system font_scale"),
      this.run(adb, "shell wm density"),
      this.run(adb, "shell cmd uimode night"),
    ]);
    const parsedDensity = parseWmDensity(densityRaw);
    const values: DisplayConfigValues = {};
    const fontScale = parseFontScale(fontRaw);
    if (fontScale !== undefined) {
      values.fontScale = fontScale;
    }
    if (parsedDensity.effective !== undefined) {
      values.density = parsedDensity.effective;
    }
    const theme = parseNightMode(nightRaw);
    if (theme !== undefined) {
      values.theme = theme;
    }
    return { values, physicalDensity: parsedDensity.physical };
  }

  private async applyChanges(
    adb: AdbExecutor,
    input: SetDisplayConfigInput,
    physicalDensity: number | undefined,
  ): Promise<string[]> {
    const errors: string[] = [];
    if (input.fontScale !== undefined) {
      errors.push(
        ...(await this.runChecked(adb, `shell settings put system font_scale ${input.fontScale}`)),
      );
    }
    if (input.density !== undefined) {
      const command = this.resolveDensityCommand(input.density, physicalDensity);
      if (command === null) {
        errors.push(
          `Cannot resolve relative density bucket '${String(input.density)}': the device's ` +
            "physical density could not be read.",
        );
      } else {
        errors.push(...(await this.runChecked(adb, command)));
      }
    }
    if (input.theme !== undefined) {
      errors.push(
        ...(await this.runChecked(adb, `shell cmd uimode night ${nightModeArg(input.theme)}`)),
      );
    }
    return errors;
  }

  private async applyReset(adb: AdbExecutor): Promise<string[]> {
    const errors: string[] = [];
    errors.push(
      ...(await this.runChecked(adb, `shell settings put system font_scale ${DEFAULT_FONT_SCALE}`)),
    );
    errors.push(...(await this.runChecked(adb, "shell wm density reset")));
    // `no` is the AOSP default (light); an app can still opt into `system` itself.
    errors.push(...(await this.runChecked(adb, "shell cmd uimode night no")));
    return errors;
  }

  /**
   * Resolve a density input to a `wm density` command. A number is an explicit
   * dpi; `default` resets to physical; `smaller`/`larger` scale the physical
   * density (returns null when it could not be read, so buckets are never guessed).
   */
  private resolveDensityCommand(
    density: DensityInput,
    physical: number | undefined,
  ): string | null {
    if (typeof density === "number") {
      return `shell wm density ${Math.round(density)}`;
    }
    if (density === "default") {
      return "shell wm density reset";
    }
    if (physical === undefined) {
      return null;
    }
    const scaled = Math.round(physical * DENSITY_BUCKET_FACTORS[density]);
    return `shell wm density ${scaled}`;
  }

  /** Read a command's stdout, tolerating an empty/failed read as an empty string. */
  private async run(adb: AdbExecutor, command: string): Promise<string> {
    const result = await adb.executeCommand(command, undefined, undefined, true);
    return result.stdout ?? "";
  }

  /** Run a mutating command, returning an error fragment when the shell reports failure. */
  private async runChecked(adb: AdbExecutor, command: string): Promise<string[]> {
    const result = await adb.executeCommand(command, undefined, undefined, true);
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (outputLooksLikeShellFailure(stdout, stderr)) {
      return [`'${command}' reported: ${`${stdout} ${stderr}`.trim()}`];
    }
    return [];
  }
}
