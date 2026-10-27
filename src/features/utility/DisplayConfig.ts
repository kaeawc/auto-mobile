import { ActionableError } from "../../models/ActionableError";
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
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import { registerDeviceIncarnationListener } from "../../utils/deviceIncarnation";
import {
  invalidateAfterDensityChange,
  resolveDensityCommand,
  type DensityInput,
} from "./androidDensityCommand";
import {
  AndroidDisplayGeometry,
  GEOMETRY_ANDROID_ONLY_ERROR,
  displayGeometrySupport,
  hasDisplayGeometryField,
  withoutGeometryFields,
  type DisplayGeometryAvailability,
  type DisplayGeometryInput,
  type DisplayGeometryOptions,
  type DisplayGeometrySupport,
  type DisplayGeometryValues,
} from "./AndroidDisplayGeometry";
import { DEFAULT_FONT_SCALE, type DisplayTheme, type FontScaleInput } from "./displayConfigTypes";
import {
  nightModeArg,
  parseFontScaleSnapshot,
  parseNightMode,
  parseWmDensity,
} from "./displayConfigParsers";
import {
  IOS_DENSITY_UNSUPPORTED_ERROR,
  IosSimulatorDisplayConfig,
  type ContentSizeBaselineStore,
  type IosContentSizeCategory,
  type IosSimulatorDisplayChange,
} from "./IosSimulatorDisplayConfig";
import {
  androidResultMessage,
  setFactoryDisplayConfig,
  accessibilityValuesOf,
  displayFieldsOf,
  mergeGeometryChange,
  hasDisplayField,
  mergedMessage,
  setInputContradiction,
} from "./displayConfigInput";
import {
  AccessibilityDisplayPreferences,
  requestedAccessibilityFields,
  unsupportedAccessibilityDisplay,
  type AccessibilityBaselineStore,
  type AccessibilityDisplayChange,
  type AccessibilityDisplayField,
  type AccessibilityDisplayNotes,
  type AccessibilityDisplayRead,
  type AccessibilityDisplaySupportLevel,
  type AccessibilityDisplayValues,
} from "./AccessibilityDisplayPreferences";
import type { CtrlProxyAppearanceResult } from "../observe/ios/types";
import { iosCtrlProxyClientFor } from "../observe/ios/iosCtrlProxyClientFor";

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
 * device baseline via `reset` (Android night mode only when this tool changed it).
 *
 * Android supports all three fields. The iOS Simulator supports `theme` via
 * `simctl ui appearance` and font scale as a Dynamic Type category via
 * `simctl ui content_size` (#14087; see {@link IosSimulatorDisplayConfig}),
 * matching how the device-snapshot iOS settings capture reads/restores both;
 * density has no simctl/defaults equivalent. Physical iOS devices support none
 * of the three — there is no automatable, per-device control for any of them.
 *
 * The accessibility display preferences (increaseContrast, reduceMotion,
 * boldText; issue #14088) live in {@link AccessibilityDisplayPreferences} and
 * are merged into the same read/apply/previous/reset results here.
 */
export { type DisplayTheme, type FontScaleInput } from "./displayConfigTypes";
export {
  parseFontScale,
  parseFontScaleSnapshot,
  parseNightMode,
  parseWmDensity,
} from "./displayConfigParsers";

export {
  MAX_ANDROID_DENSITY_DPI,
  MIN_ANDROID_DENSITY_DPI,
  type DensityBucket,
  type DensityInput,
} from "./androidDensityCommand";

export interface DisplayConfigValues extends AccessibilityDisplayValues, DisplayGeometryValues {
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
  /** iOS Simulator Dynamic Type category; `fontScale` is derived from it there (#14087). */
  contentSize?: IosContentSizeCategory;
}

/**
 * Per-field platform support. `density` is reported as `"partial"` on physical
 * Android devices, where `wm density` overrides are best-effort and may be
 * clamped or ignored by the OEM shell.
 */
export interface DisplayConfigSupport
  extends
    Partial<Record<AccessibilityDisplayField, AccessibilityDisplaySupportLevel>>,
    Partial<DisplayGeometrySupport> {
  fontScale: boolean;
  density: boolean | "partial";
  theme: boolean;
}

export interface DisplayConfigResult {
  success: boolean;
  deviceId: string;
  platform: "android" | "ios";
  supported: DisplayConfigSupport;
  /** Why an accessibility display field is `partial` or unsupported on this target. */
  supportNotes?: AccessibilityDisplayNotes;
  /** Current values (getter form). */
  current?: DisplayConfigValues;
  /** Values observed immediately after a set/reset. */
  applied?: DisplayConfigValues;
  /** Values read immediately before a set/reset, so the client can restore. */
  previous?: DisplayConfigValues;
  available?: DisplayGeometryAvailability;
  message?: string;
  error?: string;
}

export interface SetDisplayConfigInput extends AccessibilityDisplayValues, DisplayGeometryInput {
  fontScale?: FontScaleInput;
  density?: DensityInput;
  theme?: DisplayTheme;
  /** iOS Simulator: an exact Dynamic Type category, instead of the nearest one to `fontScale`. */
  contentSize?: IosContentSizeCategory;
  /**
   * Android: reset font/density defaults and restore only night mode changed by this tool.
   * Both platforms: restore each accessibility display preference this tool changed.
   */
  reset?: boolean;
  /** With `reset`: also force platform defaults whatever baselines were recorded (#15337). */
  factory?: boolean;
}

/** Process-lifetime baseline for the first night-mode value this tool replaces. */
export interface ThemeBaselineStore {
  get(deviceId: string): DisplayTheme | undefined;
  set(deviceId: string, theme: DisplayTheme): void;
  delete(deviceId: string): void;
}

const defaultThemeBaselines: ThemeBaselineStore = new Map<string, DisplayTheme>();

registerDeviceIncarnationListener({
  name: "android-display-config-theme-baselines",
  onDeviceIdentityReplaced: (deviceId) => defaultThemeBaselines.delete(deviceId),
  // Snapshot restore and same-device re-pool retain guest night-mode state and its baseline.
  onDeviceIncarnationChanged: () => {},
});

export interface DisplayConfigDependencies {
  themeBaselines?: ThemeBaselineStore;
  adbFactory?: AdbClientFactory;
  /** iOS Simulator appearance seam; defaults to a `SimCtlClient` for the device. */
  simctl?: SimctlAppearanceRunner;
  /** Process-lifetime baselines for accessibility display preferences this tool replaced. */
  accessibilityBaselines?: AccessibilityBaselineStore;
  /** Physical iOS appearance seam (#14092); defaults to the device's CtrlProxy runner client. */
  iosRunnerAppearance?: IosRunnerAppearanceClient;
  /** Process-lifetime baselines for the Simulator text size category this tool replaced. */
  contentSizeBaselines?: ContentSizeBaselineStore;
  geometry?: DisplayGeometryOptions;
}

/** The runner's `request_appearance` (`XCUIDevice.appearance`); physical iOS has no simctl. */
export interface IosRunnerAppearanceClient {
  requestAppearance(appearance?: "light" | "dark"): Promise<CtrlProxyAppearanceResult>;
}

/** Reads and writes a physical iOS device's light/dark appearance through the CtrlProxy runner. */
interface IosAppearanceBackend {
  /** Names the target in errors. */
  readonly target: string;
  read(): Promise<DisplayTheme | undefined>;
  /** Resolves on success; rejects with the backend's own error. */
  write(theme: "light" | "dark"): Promise<void>;
}

const IOS_FONT_SCALE_UNSUPPORTED_ERROR =
  "fontScale is not supported on iOS devices: there is no simctl, defaults or XCUITest " +
  "control for the system text scale. The iOS Simulator supports it as a Dynamic Type category.";

const ANDROID_CONTENT_SIZE_UNSUPPORTED_ERROR =
  "contentSize is an iOS Dynamic Type category and is only supported on the iOS Simulator; " +
  "use fontScale on Android.";

const ANDROID_UNSUPPORTED_PLATFORM_ERROR = "Display configuration is only supported on Android.";

export class DisplayConfig {
  private device: BootedDevice;

  private adbFactory: AdbClientFactory;

  private simctl: SimctlAppearanceRunner;

  private iosRunnerAppearance?: IosRunnerAppearanceClient;

  private themeBaselines: ThemeBaselineStore;

  private accessibilityBaselines?: AccessibilityBaselineStore;

  private contentSizeBaselines?: ContentSizeBaselineStore;

  private geometryOptions: DisplayGeometryOptions;

  constructor(device: BootedDevice, dependencies: DisplayConfigDependencies = {}) {
    this.device = device;
    this.themeBaselines = dependencies.themeBaselines ?? defaultThemeBaselines;
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.simctl = dependencies.simctl ?? new SimCtlClient(device);
    this.accessibilityBaselines = dependencies.accessibilityBaselines;
    this.iosRunnerAppearance = dependencies.iosRunnerAppearance;
    this.contentSizeBaselines = dependencies.contentSizeBaselines;
    this.geometryOptions = dependencies.geometry ?? {};
  }

  /** The accessibility display preferences (#14088) on this device, sharing this tool's seams. */
  accessibility(): AccessibilityDisplayPreferences {
    return new AccessibilityDisplayPreferences(this.device, {
      adb: () => this.adbFactory.create(this.device),
      simctl: this.simctl,
      iosSimulator: this.device.platform === "ios" && this.isIosSimulator(),
      ...(this.accessibilityBaselines ? { baselines: this.accessibilityBaselines } : {}),
    });
  }

  /** Physical iOS appearance through the runner; the Simulator uses {@link IosSimulatorDisplayConfig}. */
  private iosAppearance(): IosAppearanceBackend {
    const runner = this.iosRunnerAppearance ?? iosCtrlProxyClientFor(this.device);
    const call = async (appearance?: "light" | "dark") => {
      const result = await runner.requestAppearance(appearance);
      if (!result.success) {
        throw new Error(
          `CtrlProxy runner appearance request failed: ${result.error ?? "unknown error"}. ` +
            "Physical-device theme control needs a runner that supports request_appearance.",
        );
      }
      return result.appearance === "light" || result.appearance === "dark"
        ? result.appearance
        : undefined;
    };
    return {
      target: "device",
      read: () => call(),
      write: async (theme) => {
        await call(theme);
      },
    };
  }

  /** iOS simulators expose `simctl`/`defaults`; physical iOS devices use the runner instead. */
  private isIosSimulator(): boolean {
    return resolveIosDeviceKind({ deviceId: this.device.deviceId }) === "simulator";
  }

  private support(): DisplayConfigSupport {
    if (this.device.platform === "ios") {
      // Theme uses `simctl ui appearance` on the Simulator and the runner's
      // `XCUIDevice.appearance` on hardware (#14092). The Simulator also supports font scale
      // as a Dynamic Type category (`simctl ui content_size`, #14087); density has no
      // equivalent on either iOS target (#6096), and physical iOS has no path for the
      // font scale or the accessibility preferences (#14088).
      const simulator = this.isIosSimulator();
      return {
        fontScale: simulator,
        density: false,
        theme: true,
        ...(simulator ? {} : unsupportedAccessibilityDisplay().supported),
      };
    }
    return {
      fontScale: true,
      theme: true,
      // `wm density` overrides are reliable on emulators but best-effort on
      // physical/OEM devices, so report them as `partial` there (issue #6096).
      density: isAndroidEmulatorSerial(this.device.deviceId) ? true : "partial",
      ...displayGeometrySupport(this.device),
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

  /** Read the current physical iOS theme from the runner. */
  private async readIosTheme(): Promise<DisplayTheme | undefined> {
    return this.iosAppearance().read();
  }

  /**
   * Set a physical iOS device's appearance through the runner. `system` and `custom` have no
   * runner equivalent, so they are reported as an honest per-field refusal rather than silently
   * coerced to light or dark.
   */
  private async setIosAppearance(theme: DisplayTheme): Promise<string[]> {
    const backend = this.iosAppearance();
    if (theme !== "light" && theme !== "dark") {
      return [
        `Cannot set theme '${theme}' on the iOS ${backend.target}: only 'light' or 'dark' can be set.`,
      ];
    }
    try {
      await backend.write(theme);
      return [];
    } catch (error) {
      return [
        `Setting the iOS ${backend.target} appearance to ${theme} failed: ${errorMessage(error)}`,
      ];
    }
  }

  private iosSimulator(): IosSimulatorDisplayConfig {
    return new IosSimulatorDisplayConfig(this.device, this.simctl, this.contentSizeBaselines);
  }

  /** The Simulator's theme and text size, or a physical device's theme from the runner. */
  private async getIosConfig(): Promise<DisplayConfigResult> {
    try {
      const current = this.isIosSimulator()
        ? await this.iosSimulator().read()
        : await this.readIosThemeSnapshot();
      return this.withAccessibilityRead(current, await this.accessibility().read());
    } catch (error) {
      logger.warn(`[DisplayConfig] getConfig failed (iOS): ${errorMessage(error)}`, error);
      return this.failure(errorMessage(error));
    }
  }

  private failure(error: string): DisplayConfigResult {
    return {
      success: false,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      supported: this.support(),
      error,
    };
  }

  private async applyIosChanges(input: SetDisplayConfigInput): Promise<string[]> {
    const errors: string[] = [];
    if (input.fontScale !== undefined || input.contentSize !== undefined) {
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
      throw new Error(`iOS did not report a readable ${this.iosAppearance().target} appearance`);
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
   * restoration state, since the device may now be modified even though this
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

  /** Reject requests that cannot produce a physical iOS mutation before a baseline read. */
  private validateIosDeviceSetInput(input: SetDisplayConfigInput): DisplayConfigResult | undefined {
    // A request containing only an unsupported field cannot produce a useful
    // mutation. Reject it before requiring a theme snapshot, while a supported
    // theme mutation still fails closed if its baseline is unreadable.
    if (!input.reset && input.theme === undefined) {
      if (input.fontScale !== undefined || input.contentSize !== undefined) {
        return this.unsupported(IOS_FONT_SCALE_UNSUPPORTED_ERROR);
      }
      if (input.density !== undefined) {
        return this.unsupported(IOS_DENSITY_UNSUPPORTED_ERROR);
      }
    }
    return undefined;
  }

  /**
   * `setIosAppearance`/`applyIosChanges` return failures as error fragments (mirroring the
   * Android `runChecked` pattern), so this never throws. A physical device resets to the theme
   * this tool first replaced there, which the user chose (#14092).
   */
  private async applyIosMutation(
    input: SetDisplayConfigInput,
    previous: DisplayConfigValues,
  ): Promise<{ errors: string[]; expectedTheme?: DisplayTheme }> {
    if (!input.reset) {
      if (input.theme !== undefined) {
        this.recordIosThemeBaseline(previous);
      }
      return { errors: await this.applyIosChanges(input), expectedTheme: input.theme };
    }
    const resetTheme = this.iosResetTheme();
    const errors = await this.setIosAppearance(resetTheme);
    if (errors.length === 0) {
      this.themeBaselines.delete(this.device.deviceId);
    }
    return { errors, expectedTheme: resetTheme };
  }

  /** Physical iOS only: the first appearance this tool replaced, restored by `reset`. */
  private recordIosThemeBaseline(previous: DisplayConfigValues): void {
    const id = this.device.deviceId;
    if (previous.theme && !this.themeBaselines.get(id)) {
      this.themeBaselines.set(id, previous.theme);
    }
  }

  private iosResetTheme(): DisplayTheme {
    return this.themeBaselines.get(this.device.deviceId) ?? "light";
  }

  private async setIosDeviceConfig(input: SetDisplayConfigInput): Promise<DisplayConfigResult> {
    const invalidInput = this.validateIosDeviceSetInput(input);
    if (invalidInput) {
      return invalidInput;
    }

    // Read the pre-change state first. If this fails, no mutation has run, so
    // there is nothing to restore and no `previous` to advertise.
    let previous: DisplayConfigValues;
    try {
      previous = await this.readIosThemeSnapshot();
    } catch (error) {
      return this.iosPreReadFailure(error);
    }

    const { errors, expectedTheme } = await this.applyIosMutation(input, previous);

    const { applied, readError } = await this.readIosAppliedSnapshot();
    const allErrors = readError ? [...errors, readError] : [...errors];
    // The runner can accept a write while the device has not actually adopted it. A successful command is only an attempted mutation;
    // report success only when the authoritative post-read confirms the target.
    if (applied && expectedTheme && applied.theme !== expectedTheme) {
      allErrors.push(
        `iOS ${this.iosAppearance().target} appearance remained ${applied.theme} after requesting ${expectedTheme}`,
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

  private async setIosSimulatorConfig(input: SetDisplayConfigInput): Promise<DisplayConfigResult> {
    // A density-only request cannot produce a Simulator mutation: refuse it before a
    // baseline read, while a supported mutation still fails closed on an unreadable baseline.
    if (
      !input.reset &&
      input.theme === undefined &&
      input.fontScale === undefined &&
      input.contentSize === undefined &&
      input.density !== undefined
    ) {
      return this.unsupported(IOS_DENSITY_UNSUPPORTED_ERROR);
    }
    let change: IosSimulatorDisplayChange;
    try {
      change = await this.iosSimulator().set(input);
    } catch (error) {
      // The pre-read failed, so nothing changed and there is no `previous` to advertise.
      logger.warn(
        `[DisplayConfig] setConfig pre-read failed (iOS simulator): ${errorMessage(error)}`,
        error,
      );
      return this.failure(errorMessage(error));
    }
    const error = change.errors.length > 0 ? change.errors.join("; ") : undefined;
    const restored = change.restoredContentSize;
    return {
      success: error === undefined,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      supported: this.support(),
      ...(change.applied ? { applied: change.applied } : {}),
      previous: change.previous,
      ...(error ? { error } : {}),
      ...(restored && !error
        ? {
            message: `Restored the Simulator content size to ${restored} (changed earlier by displayConfig).`,
          }
        : {}),
    };
  }

  /** Read the current font scale, density, and theme. */
  async getConfig(): Promise<DisplayConfigResult> {
    if (this.device.platform === "ios") {
      return this.getIosConfig();
    }
    try {
      const adb = this.adbFactory.create(this.device);
      const current = await this.readValues(adb);
      const geometry = await this.geometry(adb).read();
      const result = this.withAccessibilityRead(
        { ...current, ...geometry.values },
        await this.accessibility().read(),
      );
      return geometry.available ? { ...result, available: geometry.available } : result;
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

  private withAccessibilityRead(
    current: DisplayConfigValues,
    accessibility: AccessibilityDisplayRead,
  ): DisplayConfigResult {
    return {
      success: true,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      supported: { ...this.support(), ...accessibility.supported },
      ...supportNotes(accessibility.notes),
      current: { ...current, ...accessibility.values },
    };
  }

  /**
   * Current values in the form `setConfig` accepts back (Android's `"default"` tokens for an
   * absent font-scale or density override), for recording a device default (#11145). Fields the
   * platform cannot read are omitted; failures propagate.
   */
  async getRestorableConfig(): Promise<DisplayConfigValues> {
    if (this.device.platform === "ios") {
      if (this.isIosSimulator()) {
        return this.iosSimulator().readRestorable();
      }
      const theme = await this.readIosTheme();
      return theme === undefined ? {} : { theme };
    }
    return (await this.readRawValues(this.adbFactory.create(this.device))).restorableValues;
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
    if (input.factory === true && input.reset === true) {
      return setFactoryDisplayConfig(this, this.device.platform);
    }
    const refusal = this.refuseSetInput(input);
    if (refusal) {
      return refusal;
    }
    if (
      this.device.platform === "android" &&
      (input.reset === true || hasDisplayGeometryField(input))
    ) {
      return this.setWithGeometry(input);
    }
    return this.setNonGeometry(input);
  }

  /** Forget every recorded baseline: theme, accessibility preferences and Simulator text size. */
  clearBaselines(): void {
    this.themeBaselines.delete(this.device.deviceId);
    this.accessibility().clearBaseline();
    if (this.device.platform === "ios") {
      this.iosSimulator().clearBaseline();
    }
  }

  private geometry(adb: AdbExecutor): AndroidDisplayGeometry {
    return new AndroidDisplayGeometry(this.device, adb, this.geometryOptions);
  }

  /** Android size/navigation/cutout (#14101): validated before any write, reported as one result. */
  private async setWithGeometry(input: SetDisplayConfigInput): Promise<DisplayConfigResult> {
    const geometry = this.geometry(this.adbFactory.create(this.device));
    const reset = input.reset === true;
    const prepared = reset ? undefined : await geometry.prepare(input);
    if (prepared && "refusal" in prepared) {
      return this.invalidRequest(prepared.refusal);
    }
    const rest = withoutGeometryFields(input);
    const display = Object.keys(rest).length > 0 ? await this.setNonGeometry(rest) : undefined;
    if (display && !display.success && display.previous === undefined) {
      return display;
    }
    const change = prepared ? await geometry.apply(prepared) : await geometry.reset();
    return mergeGeometryChange(display, change, {
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      supported: this.support(),
    });
  }

  private async setNonGeometry(input: SetDisplayConfigInput): Promise<DisplayConfigResult> {
    const reset = input.reset === true;
    const accessibility = this.accessibility();
    const runAccessibility =
      requestedAccessibilityFields(input).length > 0 || (reset && accessibility.hasBaseline());
    const display =
      reset || hasDisplayField(input)
        ? await this.setDisplayFields(displayFieldsOf(input))
        : undefined;
    // A display-field refusal or pre-read failure changed nothing: keep it that way.
    if (display && (!runAccessibility || (!display.success && display.previous === undefined))) {
      return display;
    }
    const change = reset
      ? await accessibility.reset()
      : await accessibility.set(accessibilityValuesOf(input));
    return this.mergeAccessibilityChange(display, change, reset);
  }

  /** Requests refused before any device command: contradictory, empty, or unsupported target. */
  private refuseSetInput(input: SetDisplayConfigInput): DisplayConfigResult | undefined {
    const contradiction = setInputContradiction(input);
    if (contradiction !== undefined) {
      return this.invalidRequest(contradiction);
    }
    if (this.device.platform === "android" && input.contentSize !== undefined) {
      return this.unsupported(ANDROID_CONTENT_SIZE_UNSUPPORTED_ERROR);
    }
    if (this.device.platform !== "android" && this.device.platform !== "ios") {
      return this.unsupported(ANDROID_UNSUPPORTED_PLATFORM_ERROR);
    }
    if (this.device.platform !== "android" && hasDisplayGeometryField(input)) {
      return this.unsupported(GEOMETRY_ANDROID_ONLY_ERROR);
    }
    return undefined;
  }

  private setDisplayFields(input: SetDisplayConfigInput): Promise<DisplayConfigResult> {
    if (this.device.platform !== "ios") {
      return this.setAndroidConfig(input);
    }
    return this.isIosSimulator()
      ? this.setIosSimulatorConfig(input)
      : this.setIosDeviceConfig(input);
  }

  private mergeAccessibilityChange(
    display: DisplayConfigResult | undefined,
    change: AccessibilityDisplayChange,
    reset: boolean,
  ): DisplayConfigResult {
    const errors = [...(display?.error ? [display.error] : []), ...change.errors];
    const error = errors.length > 0 ? errors.join("; ") : undefined;
    const message = mergedMessage(error, display?.message, reset, change.restored);
    return {
      success: error === undefined,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      supported: { ...(display?.supported ?? this.support()), ...change.supported },
      ...supportNotes(change.notes),
      applied: { ...display?.applied, ...change.applied },
      previous: { ...display?.previous, ...change.previous },
      ...(error ? { error } : {}),
      ...(message ? { message } : {}),
    };
  }

  private async setAndroidConfig(input: SetDisplayConfigInput): Promise<DisplayConfigResult> {
    const adb = this.adbFactory.create(this.device);

    // Read the pre-change state first. If this fails, no mutation has run, so
    // there is nothing to restore and no `previous` to advertise.
    let previous: DisplayConfigValues;
    let physicalDensity: number | undefined;
    try {
      const raw = await this.readRawValues(adb);
      previous = raw.restorableValues;
      physicalDensity = raw.physicalDensity;
    } catch (error) {
      logger.warn(`[DisplayConfig] setConfig pre-read failed: ${errorMessage(error)}`, error);
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        supported: this.support(),
        error: errorMessage(error),
        message: errorMessage(error),
      };
    }

    // Mutations are applied per-field and any failure (a shell-reported error OR
    // a rejected `adb.executeCommand`) is collected into `errors` by `runChecked`
    // rather than thrown, so an earlier field that already changed the device is
    // never dropped from the restoration state (issue #6096 review). The device
    // may now be partially modified, so we still read post-mutation state and
    // always return `previous` so the caller can restore what changed.
    const expectedTheme = this.prepareAndroidTheme(input, previous);
    const mutation = input.reset
      ? await this.applyReset(adb, expectedTheme)
      : await this.applyChanges(adb, input, physicalDensity);
    const { errors, issuedDensity } = mutation;
    invalidateAfterDensityChange(this.device, issuedDensity, this.geometryOptions);

    let applied: DisplayConfigValues | undefined;
    try {
      const postMutation = await this.readRawValues(adb);
      applied = postMutation.values;
      const verificationErrors = this.verifyAndroidAppliedConfig(
        input,
        postMutation,
        issuedDensity,
        expectedTheme,
      );
      this.confirmAndroidThemeRestore(mutation.restoredTheme, postMutation.values.theme);
      errors.push(...verificationErrors);
    } catch (error) {
      logger.warn(`[DisplayConfig] setConfig post-read failed: ${errorMessage(error)}`, error);
      errors.push(`failed to read applied values: ${errorMessage(error)}`);
    }

    const error = errors.length > 0 ? errors.join("; ") : undefined;
    const message = androidResultMessage(input.reset, expectedTheme, error);
    return {
      success: error === undefined,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      supported: this.support(),
      ...(applied ? { applied } : {}),
      previous,
      ...(error ? { error } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  private prepareAndroidTheme(
    input: SetDisplayConfigInput,
    previous: DisplayConfigValues,
  ): DisplayTheme | undefined {
    if (input.reset) {
      return this.themeBaselines.get(this.device.deviceId);
    }
    // Capture before dispatch: even a rejected write can leave a partially changed device.
    if (
      input.theme !== undefined &&
      previous.theme !== undefined &&
      this.themeBaselines.get(this.device.deviceId) === undefined
    ) {
      this.themeBaselines.set(this.device.deviceId, previous.theme);
    }
    return input.theme;
  }

  private confirmAndroidThemeRestore(
    restoredTheme: DisplayTheme | undefined,
    appliedTheme: DisplayTheme | undefined,
  ): void {
    if (restoredTheme !== undefined && appliedTheme === restoredTheme) {
      this.themeBaselines.delete(this.device.deviceId);
    }
  }

  private async readValues(adb: AdbExecutor): Promise<DisplayConfigValues> {
    return (await this.readRawValues(adb)).values;
  }

  /**
   * Like {@link readValues}, but also surfaces the device's PHYSICAL density
   * so relative density
   * buckets can be resolved against the true hardware density rather than a
   * prior override, which would otherwise compound (issue #6096).
   */
  private async readRawValues(adb: AdbExecutor): Promise<{
    values: DisplayConfigValues;
    restorableValues: DisplayConfigValues;
    physicalDensity: number | undefined;
  }> {
    const [fontRaw, densityRaw, nightRaw] = await Promise.all([
      this.run(adb, "shell settings get system font_scale", "font scale"),
      this.run(adb, "shell wm density", "density"),
      this.run(adb, "shell cmd uimode night", "night mode"),
    ]);
    const parsedDensity = parseWmDensity(densityRaw);
    const fontScaleSnapshot = parseFontScaleSnapshot(fontRaw);
    const theme = parseNightMode(nightRaw);
    const unreadable: string[] = [];
    if (fontScaleSnapshot === undefined) {
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

    // `values` reports the actual effective font scale/density for observations
    // and post-mutation confirmation, never the restoration token: a "default"
    // font scale means Android has no override, whose effective scale is the
    // AOSP default (issue #6303 review). `restorableValues` retains the
    // distinct no-override token for `previous`, because replaying the
    // effective number would create an override where none existed.
    const effectiveFontScale =
      fontScaleSnapshot === "default" ? DEFAULT_FONT_SCALE : fontScaleSnapshot;
    const values: DisplayConfigValues = {
      fontScale: effectiveFontScale,
      density: parsedDensity.effective,
      theme,
    };
    const restorableValues: DisplayConfigValues = {
      ...values,
      fontScale: fontScaleSnapshot,
      density: parsedDensity.overridden ? parsedDensity.effective : "default",
    };
    return { values, restorableValues, physicalDensity: parsedDensity.physical };
  }

  private async applyChanges(
    adb: AdbExecutor,
    input: SetDisplayConfigInput,
    physicalDensity: number | undefined,
  ): Promise<{
    errors: string[];
    issuedDensity?: number | "default";
    restoredTheme?: DisplayTheme;
  }> {
    const errors: string[] = [];
    if (input.fontScale !== undefined) {
      const command =
        input.fontScale === "default"
          ? "shell settings delete system font_scale"
          : `shell settings put system font_scale ${input.fontScale}`;
      errors.push(...(await this.runChecked(adb, command, "font scale")));
    }
    // `issuedDensity` stays `undefined` unless a `wm density` command was
    // actually dispatched. When `resolveDensityCommand` rejects the request
    // (e.g. a relative bucket resolving below Android's dpi floor), no command
    // runs, so verification must not independently recompute an "expected"
    // density and report a second, misleading failure alongside the resolution
    // error already collected above (issue #6303 review).
    let issuedDensity: number | "default" | undefined;
    if (input.density !== undefined) {
      const resolution = resolveDensityCommand(input.density, physicalDensity);
      if ("error" in resolution) {
        errors.push(resolution.error);
      } else {
        errors.push(...(await this.runChecked(adb, resolution.command, "density")));
        issuedDensity = resolution.target;
      }
    }
    if (input.theme !== undefined) {
      errors.push(
        ...(await this.runChecked(
          adb,
          `shell cmd uimode night ${nightModeArg(input.theme)}`,
          "night mode",
        )),
      );
    }
    return { errors, issuedDensity };
  }

  private async applyReset(
    adb: AdbExecutor,
    theme: DisplayTheme | undefined,
  ): Promise<{ errors: string[]; issuedDensity: "default"; restoredTheme?: DisplayTheme }> {
    const errors: string[] = [];
    errors.push(
      ...(await this.runChecked(adb, "shell settings delete system font_scale", "font scale")),
    );
    errors.push(...(await this.runChecked(adb, "shell wm density reset", "density")));
    let restoredTheme: DisplayTheme | undefined;
    if (theme !== undefined) {
      const themeErrors = await this.runChecked(
        adb,
        `shell cmd uimode night ${nightModeArg(theme)}`,
        "night mode",
      );
      errors.push(...themeErrors);
      if (themeErrors.length === 0) {
        restoredTheme = theme;
      }
    }
    return { errors, issuedDensity: "default", restoredTheme };
  }

  private verifyAndroidAppliedConfig(
    input: SetDisplayConfigInput,
    postMutation: Awaited<ReturnType<DisplayConfig["readRawValues"]>>,
    issuedDensity: number | "default" | undefined,
    expectedTheme: DisplayTheme | undefined,
  ): string[] {
    const errors: string[] = [];
    const expectedFontScale = input.reset ? "default" : input.fontScale;
    const appliedFontScale = postMutation.restorableValues.fontScale;
    const fontScaleMatches =
      expectedFontScale === "default"
        ? appliedFontScale === "default" || appliedFontScale === DEFAULT_FONT_SCALE
        : appliedFontScale === expectedFontScale;
    if (expectedFontScale !== undefined && !fontScaleMatches) {
      errors.push(
        `Font scale remained ${String(appliedFontScale)} after requesting ${String(expectedFontScale)}.`,
      );
    }

    // `issuedDensity` is the density actually dispatched to the device (from
    // `applyChanges`/`applyReset`), not a recomputation from `input`: when
    // `resolveDensityCommand` rejected the request, no `wm density` command
    // ran, so there is nothing to verify here (its own error is already in
    // `errors` from the mutation step) rather than reporting a second,
    // misleading "density remained X" failure (issue #6303 review).
    const expectedDensity = issuedDensity;
    if (expectedDensity !== undefined) {
      const actualDensity =
        expectedDensity === "default"
          ? postMutation.restorableValues.density
          : postMutation.values.density;
      if (actualDensity !== expectedDensity) {
        errors.push(
          `Display density remained ${String(actualDensity)} after requesting ${String(expectedDensity)}.`,
        );
      }
    }

    if (expectedTheme !== undefined && postMutation.values.theme !== expectedTheme) {
      errors.push(
        `Night mode remained ${String(postMutation.values.theme)} after requesting ${expectedTheme}.`,
      );
    }
    return errors;
  }

  /**
   * Read a command's stdout, rejecting shell-reported failures rather than
   * fabricating a restoration baseline from partial output.
   */
  private async run(adb: AdbExecutor, command: string, setting: string): Promise<string> {
    try {
      const result = await adb.executeCommand(command, { noRetry: true });
      const stdout = result.stdout;
      const stderr = result.stderr ?? "";
      if (outputLooksLikeShellFailure(stdout, stderr)) {
        throw new Error(`'${command}' reported: ${`${stdout} ${stderr}`.trim()}`);
      }
      return stdout;
    } catch (error) {
      throw new ActionableError(`${setting}: failed to read '${command}': ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Run a mutating command, returning an error fragment when the shell reports
   * failure OR when the ADB invocation itself rejects. Catching the rejection
   * here (instead of letting it propagate) keeps a multi-field set atomic in its
   * bookkeeping: a later field's failure never discards the `previous`/`applied`
   * restoration state for an earlier field that already changed the device
   * (issue #6096 review).
   */
  private async runChecked(adb: AdbExecutor, command: string, setting: string): Promise<string[]> {
    try {
      const result = await adb.executeCommand(command, { noRetry: true });
      const stdout = result.stdout;
      const stderr = result.stderr ?? "";
      if (outputLooksLikeShellFailure(stdout, stderr)) {
        return [`${setting}: '${command}' reported: ${`${stdout} ${stderr}`.trim()}`];
      }
      return [];
    } catch (error) {
      logger.warn(`[DisplayConfig] ${setting} command failed: ${errorMessage(error)}`, error);
      return [`${setting}: '${command}' failed: ${errorMessage(error)}`];
    }
  }
}

function supportNotes(notes: AccessibilityDisplayNotes): {
  supportNotes?: AccessibilityDisplayNotes;
} {
  return Object.keys(notes).length > 0 ? { supportNotes: notes } : {};
}
