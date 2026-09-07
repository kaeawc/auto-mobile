import { errorMessage } from "../../utils/describeUnknownError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice } from "../../models";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { logger } from "../../utils/logger";
import { SimCtlClient, type SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";

/**
 * The argv-shaped slice of the simctl client this feature needs. Routing
 * simulator appearance reads/writes through this seam (rather than a raw
 * `xcrun simctl` process spawn) reuses the existing SimCtlClient plumbing that
 * consumes the ambient abort signal and is covered by the repo's direct-simctl
 * guard (issue #6096 review).
 */
type SimctlAppearanceRunner = Pick<SimCtl, "executeCommandArgs">;

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
export type DisplayTheme = "light" | "dark" | "system" | "custom";

/**
 * `"default"` means the Android font-scale setting is absent, which differs
 * from an explicit `1`: restoring it must delete the override rather than
 * silently replacing an inherited/default value with a concrete setting.
 */
export type FontScaleInput = number | "default";

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
  /** System text scale, or `"default"` when Android has no explicit override. */
  fontScale?: FontScaleInput;
  /**
   * Effective display density: an explicit dpi when the device carries a `wm
   * density` override, or the `"default"` bucket when it does not. `"default"`
   * (rather than the bare physical dpi number) keeps this restorable: feeding a
   * physical-density NUMBER back through `density` would take the explicit-dpi
   * branch and force an override where none existed (issue #6096 review).
   */
  density?: DensityInput;
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
  fontScale?: FontScaleInput;
  density?: DensityInput;
  theme?: DisplayTheme;
  /** Restore font scale, density, and theme to device defaults. */
  reset?: boolean;
}

export interface DisplayConfigDependencies {
  adbFactory?: AdbClientFactory;
  /** iOS Simulator appearance seam; defaults to a `SimCtlClient` for the device. */
  simctl?: SimctlAppearanceRunner;
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
 * Preserve the difference between an absent Android setting and an explicit
 * `1.0` value for restore payloads. `parseFontScale` remains the value parser
 * for callers that only need the effective scale.
 */
export function parseFontScaleSnapshot(raw: string): FontScaleInput | undefined {
  const value = raw.trim();
  return !value || value === "null" ? "default" : parseFontScale(value);
}

/**
 * Parse `wm density` free text, preferring the override density when one is set:
 *
 *   Physical density: 440
 *   Override density: 480
 *
 * `effective` is `undefined` when neither line is present/parseable. `overridden`
 * distinguishes "no override present" (effective falls back to physical) from an
 * actual override, so a caller can tell whether the effective number represents a
 * forced state or the device's unmodified default (issue #6096 review).
 */
export function parseWmDensity(raw: string): {
  physical?: number;
  effective?: number;
  overridden: boolean;
} {
  const physicalMatch = raw.match(/Physical density:\s*(\d+)/i);
  const overrideMatch = raw.match(/Override density:\s*(\d+)/i);
  const physical = physicalMatch ? Number.parseInt(physicalMatch[1], 10) : undefined;
  const override = overrideMatch ? Number.parseInt(overrideMatch[1], 10) : undefined;
  const overridden = override !== undefined && Number.isFinite(override);
  return {
    ...(physical !== undefined && Number.isFinite(physical) ? { physical } : {}),
    effective: overridden
      ? override
      : physical !== undefined && Number.isFinite(physical)
        ? physical
        : undefined,
    overridden,
  };
}

/**
 * Parse `cmd uimode night` output ("Night mode: yes|no|auto|custom"). `yes` is
 * dark, `no` is light, `auto` follows the system (mapped to the tool's
 * `system`). `custom` (a user-defined schedule / bedtime mode) is kept as its
 * OWN distinct value rather than collapsed into `system`: collapsing it would
 * make a later restore of `previous.theme` write `cmd uimode night auto`,
 * silently destroying the user's custom schedule instead of restoring it
 * (issue #6096 review).
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
      return "system";
    case "custom":
      return "custom";
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
    // Restores the device's custom night-mode schedule rather than clobbering it
    // with `auto`; `cmd uimode night custom` re-selects the custom schedule mode.
    case "custom":
      return "custom";
  }
}

export class DisplayConfig {
  private device: BootedDevice;

  private adbFactory: AdbClientFactory;

  private simctl: SimctlAppearanceRunner;

  constructor(device: BootedDevice, dependencies: DisplayConfigDependencies = {}) {
    this.device = device;
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.simctl = dependencies.simctl ?? new SimCtlClient(device);
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
    const result = await this.simctl.executeCommandArgs(["ui", this.device.deviceId, "appearance"]);
    const value = (result.stdout ?? "").trim();
    return value === "light" || value === "dark" ? value : undefined;
  }

  /**
   * Set the iOS Simulator appearance via `simctl ui appearance <light|dark>`.
   * `system` and `custom` have no simulator equivalent — there is no "auto" or
   * custom-schedule appearance mode outside physical hardware — so they are
   * reported as an honest per-field refusal rather than silently coerced to
   * light or dark.
   */
  private async setIosAppearance(theme: DisplayTheme): Promise<string[]> {
    if (theme !== "light" && theme !== "dark") {
      return [
        `Cannot set theme '${theme}' on the iOS Simulator: 'simctl ui appearance' only accepts ` +
          "'light' or 'dark'.",
      ];
    }
    try {
      await this.simctl.executeCommandArgs(["ui", this.device.deviceId, "appearance", theme]);
      return [];
    } catch (error) {
      return [`'simctl ui appearance ${theme}' failed: ${errorMessage(error)}`];
    }
  }

  private async getIosSimulatorConfig(): Promise<DisplayConfigResult> {
    try {
      const theme = await this.readIosTheme();
      if (theme === undefined) {
        throw new Error("simctl did not report a readable Simulator appearance");
      }
      return {
        success: true,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        current: { theme },
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

  /** Shape a single `readIosTheme()` call into a `DisplayConfigValues` snapshot. */
  private async readIosThemeSnapshot(): Promise<DisplayConfigValues> {
    const theme = await this.readIosTheme();
    if (theme === undefined) {
      throw new Error("simctl did not report a readable Simulator appearance");
    }
    return { theme };
  }

  /** Build the failure response for a pre-read that rejects before any mutation ran. */
  private iosPreReadFailure(error: unknown): DisplayConfigResult {
    logger.warn(
      `[DisplayConfig] setConfig pre-read failed (iOS simulator): ${errorMessage(error)}`,
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

  /**
   * Read the post-mutation theme, isolated in its own try/catch from the
   * pre-read: a failure here must not discard the already-captured `previous`
   * restoration state, since the Simulator may now be modified even though this
   * verification read failed (issue #6096 review).
   */
  private async readIosAppliedSnapshot(): Promise<{
    applied?: DisplayConfigValues;
    readError?: string;
  }> {
    try {
      return { applied: await this.readIosThemeSnapshot() };
    } catch (error) {
      logger.warn(
        `[DisplayConfig] setConfig post-read failed (iOS simulator): ${errorMessage(error)}`,
        error,
      );
      return { readError: `failed to read applied theme: ${errorMessage(error)}` };
    }
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

    // A request containing only an unsupported field cannot produce a useful
    // Simulator mutation. Reject it before requiring a theme snapshot, while a
    // supported theme mutation still fails closed if its baseline is unreadable.
    if (!input.reset && input.theme === undefined) {
      if (input.fontScale !== undefined) {
        return this.unsupported(IOS_FONT_SCALE_UNSUPPORTED_ERROR);
      }
      if (input.density !== undefined) {
        return this.unsupported(IOS_DENSITY_UNSUPPORTED_ERROR);
      }
    }

    // Read the pre-change state first. If this fails, no mutation has run, so
    // there is nothing to restore and no `previous` to advertise.
    let previous: DisplayConfigValues;
    try {
      previous = await this.readIosThemeSnapshot();
    } catch (error) {
      return this.iosPreReadFailure(error);
    }

    // `setIosAppearance`/`applyIosChanges` catch their own `executeCommandArgs`
    // rejection and return it as an error fragment (mirroring the Android
    // `runChecked` pattern), so the mutation step itself never throws here.
    // Light is the platform default appearance, matching the Android reset's
    // choice of the AOSP default theme (issue #6096).
    const errors = input.reset
      ? await this.setIosAppearance("light")
      : await this.applyIosChanges(input);

    const { applied, readError } = await this.readIosAppliedSnapshot();
    const allErrors = readError ? [...errors, readError] : [...errors];
    // `simctl ui appearance` can accept a write while the simulator has not
    // actually adopted it. A successful command is only an attempted mutation;
    // report success only when the authoritative post-read confirms the target.
    const expectedTheme = input.reset ? "light" : input.theme;
    if (applied && expectedTheme && applied.theme !== expectedTheme) {
      allErrors.push(
        `Simulator appearance remained ${applied.theme} after requesting ${expectedTheme}`,
      );
    }
    const error = allErrors.length > 0 ? allErrors.join("; ") : undefined;
    return {
      success: error === undefined,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      supported: this.support(),
      ...(applied ? { applied } : {}),
      previous,
      ...(error ? { error } : {}),
    };
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

  private invalidRequest(error: string): DisplayConfigResult {
    return {
      success: false,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      supported: this.support(),
      error,
    };
  }

  /** Apply a font scale, density, and/or theme change, or reset to defaults. */
  async setConfig(input: SetDisplayConfigInput): Promise<DisplayConfigResult> {
    // `reset` restores every field to its device default, so pairing it with an
    // explicit fontScale/density/theme is contradictory — the explicit value
    // would be silently dropped (reset wins) or race the reset. Reject it up
    // front rather than half-honoring the request (issue #6096 review).
    if (
      input.reset === true &&
      (input.fontScale !== undefined || input.density !== undefined || input.theme !== undefined)
    ) {
      return this.invalidRequest(
        "reset cannot be combined with an explicit fontScale, density, or theme: reset restores " +
          "all three to their device defaults. Send reset on its own, or send only the explicit " +
          "fields you want to change.",
      );
    }
    if (this.device.platform === "ios") {
      if (!this.isIosSimulator()) {
        return this.unsupported(IOS_PHYSICAL_DISPLAY_CONFIG_UNSUPPORTED_ERROR);
      }
      return this.setIosSimulatorConfig(input);
    }
    if (this.device.platform !== "android") {
      return this.unsupported(ANDROID_UNSUPPORTED_PLATFORM_ERROR);
    }
    return this.setAndroidConfig(input);
  }

  private async setAndroidConfig(input: SetDisplayConfigInput): Promise<DisplayConfigResult> {
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

    const adb = this.adbFactory.create(this.device);

    // Read the pre-change state first. If this fails, no mutation has run, so
    // there is nothing to restore and no `previous` to advertise.
    let previous: DisplayConfigValues;
    let physicalDensity: number | undefined;
    try {
      const raw = await this.readRawValues(adb);
      previous = raw.values;
      physicalDensity = raw.physicalDensity;
    } catch (error) {
      logger.warn(`[DisplayConfig] setConfig pre-read failed: ${errorMessage(error)}`, error);
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        error: errorMessage(error),
      };
    }

    // Mutations are applied per-field and any failure (a shell-reported error OR
    // a rejected `adb.executeCommand`) is collected into `errors` by `runChecked`
    // rather than thrown, so an earlier field that already changed the device is
    // never dropped from the restoration state (issue #6096 review). The device
    // may now be partially modified, so we still read post-mutation state and
    // always return `previous` so the caller can restore what changed.
    const errors = input.reset
      ? await this.applyReset(adb)
      : await this.applyChanges(adb, input, physicalDensity);

    let applied: DisplayConfigValues | undefined;
    let readError: string | undefined;
    try {
      applied = await this.readValues(adb);
    } catch (error) {
      logger.warn(`[DisplayConfig] setConfig post-read failed: ${errorMessage(error)}`, error);
      readError = `failed to read applied values: ${errorMessage(error)}`;
    }

    const allErrors = readError ? [...errors, readError] : errors;
    const error = allErrors.length > 0 ? allErrors.join("; ") : undefined;
    return {
      success: error === undefined,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      supported: this.support(),
      ...(applied ? { applied } : {}),
      previous,
      ...(error ? { error } : {}),
    };
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
    const fontScale = parseFontScaleSnapshot(fontRaw);
    const theme = parseNightMode(nightRaw);
    const unreadable: string[] = [];
    if (fontScale === undefined) {
      unreadable.push("font scale");
    }
    if (parsedDensity.effective === undefined) {
      unreadable.push("display density");
    }
    if (theme === undefined) {
      unreadable.push("night mode");
    }
    if (unreadable.length > 0) {
      throw new Error(`Could not parse Android display baseline: ${unreadable.join(", ")}.`);
    }

    // Every advertised Android field has a restorable baseline. Returning a
    // partial success would permit a later mutation with no corresponding
    // value for the caller to restore.
    const values: DisplayConfigValues = {
      fontScale,
      // See DisplayConfigValues.density: only report a number when a `wm
      // density` override is actually present, else the restorable `"default"`
      // bucket (issue #6096 review).
      density: parsedDensity.overridden ? parsedDensity.effective : "default",
      theme,
    };
    return { values, physicalDensity: parsedDensity.physical };
  }

  private async applyChanges(
    adb: AdbExecutor,
    input: SetDisplayConfigInput,
    physicalDensity: number | undefined,
  ): Promise<string[]> {
    const errors: string[] = [];
    if (input.fontScale !== undefined) {
      const command =
        input.fontScale === "default"
          ? "shell settings delete system font_scale"
          : `shell settings put system font_scale ${input.fontScale}`;
      errors.push(...(await this.runChecked(adb, command)));
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
    errors.push(...(await this.runChecked(adb, "shell settings delete system font_scale")));
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

  /**
   * Read a command's stdout, rejecting shell-reported failures rather than
   * fabricating a restoration baseline from partial output.
   */
  private async run(adb: AdbExecutor, command: string): Promise<string> {
    const result = await adb.executeCommand(command, undefined, undefined, true);
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (outputLooksLikeShellFailure(stdout, stderr)) {
      throw new Error(`'${command}' reported: ${`${stdout} ${stderr}`.trim()}`);
    }
    return stdout;
  }

  /**
   * Run a mutating command, returning an error fragment when the shell reports
   * failure OR when the ADB invocation itself rejects. Catching the rejection
   * here (instead of letting it propagate) keeps a multi-field set atomic in its
   * bookkeeping: a later field's failure never discards the `previous`/`applied`
   * restoration state for an earlier field that already changed the device
   * (issue #6096 review).
   */
  private async runChecked(adb: AdbExecutor, command: string): Promise<string[]> {
    try {
      const result = await adb.executeCommand(command, undefined, undefined, true);
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      if (outputLooksLikeShellFailure(stdout, stderr)) {
        return [`'${command}' reported: ${`${stdout} ${stderr}`.trim()}`];
      }
      return [];
    } catch (error) {
      return [`'${command}' failed: ${errorMessage(error)}`];
    }
  }
}
