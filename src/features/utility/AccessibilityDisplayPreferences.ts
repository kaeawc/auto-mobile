import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { errorMessage } from "../../utils/describeUnknownError";
import { registerDeviceIncarnationListener } from "../../utils/deviceIncarnation";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";

/**
 * Accessibility display preferences that change layout and rendering beyond text size and theme:
 * Increase Contrast / high-contrast text, Reduce Motion / Remove animations and Bold Text on both
 * platforms (#14088), and Android's color inversion, color correction, magnification and extra dim
 * (#14076). Each is read back from the platform setting it is stored in.
 */
export const ACCESSIBILITY_DISPLAY_FIELDS = [
  "increaseContrast",
  "reduceMotion",
  "boldText",
  "colorInversion",
  "colorCorrection",
  "magnification",
  "magnificationScale",
  "extraDim",
] as const;

export type AccessibilityDisplayField = (typeof ACCESSIBILITY_DISPLAY_FIELDS)[number];

/** Android color correction (daltonizer) modes; `grayscale` is monochromacy. */
export const COLOR_CORRECTION_MODES = [
  "off",
  "deuteranomaly",
  "protanomaly",
  "tritanomaly",
  "grayscale",
] as const;

export type ColorCorrectionMode = (typeof COLOR_CORRECTION_MODES)[number];

export interface AccessibilityDisplayValues {
  increaseContrast?: boolean;
  reduceMotion?: boolean;
  boldText?: boolean;
  /** Android: color inversion. */
  colorInversion?: boolean;
  /** Android: color correction mode, or `off`. */
  colorCorrection?: ColorCorrectionMode;
  /** Android: the triple-tap magnification gesture. */
  magnification?: boolean;
  /** Android: the magnification gesture's zoom factor. */
  magnificationScale?: number;
  /** Android 12+ (API 31): Extra dim. */
  extraDim?: boolean;
}

type AccessibilityDisplayValue = NonNullable<AccessibilityDisplayValues[AccessibilityDisplayField]>;

/** Per field, the raw platform setting in the form a restore writes back; `null` is unset. */
export type AccessibilityDisplaySnapshot = Partial<
  Record<AccessibilityDisplayField, string | null>
>;

/**
 * `true` when a write is proven by reading the setting back, `"partial"` when the stored setting
 * reads back but running apps may not observe it, `false` when there is no path on this target.
 */
export type AccessibilityDisplaySupportLevel = boolean | "partial";

export type AccessibilityDisplaySupport = Record<
  AccessibilityDisplayField,
  AccessibilityDisplaySupportLevel
>;

/** Why a field is `partial` or unsupported on this target. */
export type AccessibilityDisplayNotes = Partial<Record<AccessibilityDisplayField, string>>;

export interface AccessibilityDisplayRead {
  /** Fields that were read; an unsupported or unreadable field is omitted. */
  values: AccessibilityDisplayValues;
  supported: AccessibilityDisplaySupport;
  notes: AccessibilityDisplayNotes;
}

export interface AccessibilityDisplayChange extends AccessibilityDisplayRead {
  previous: AccessibilityDisplayValues;
  applied: AccessibilityDisplayValues;
  errors: string[];
  /** Fields a reset restored to the value recorded before displayConfig first changed them. */
  restored: AccessibilityDisplayField[];
}

/** Process-lifetime record of each field's raw value before displayConfig first changed it. */
export interface AccessibilityBaselineStore {
  get(deviceId: string): AccessibilityDisplaySnapshot | undefined;
  set(deviceId: string, snapshot: AccessibilityDisplaySnapshot): void;
  delete(deviceId: string): void;
}

const defaultAccessibilityBaselines: AccessibilityBaselineStore = new Map<
  string,
  AccessibilityDisplaySnapshot
>();

registerDeviceIncarnationListener({
  name: "display-config-accessibility-baselines",
  onDeviceIdentityReplaced: (deviceId) => defaultAccessibilityBaselines.delete(deviceId),
  // Snapshot restore and same-device re-pool retain guest settings and their baseline.
  onDeviceIncarnationChanged: () => {},
});

/** The ADB slice these settings need. */
export type SettingsAdb = Pick<AdbExecutor, "executeCommand">;

/** One preference's read/write path on a target. */
interface PreferenceSetting {
  support: true | "partial";
  note?: string;
  /** The preference a raw setting represents. */
  decode(raw: string | null): AccessibilityDisplayValue;
  /**
   * The raw setting that applies [value]. [baseline] is the raw value displayConfig first
   * replaced, so turning a preference back off can restore what the user had.
   */
  encode(value: AccessibilityDisplayValue, baseline: string | null | undefined): string | null;
  /** Throws when the setting cannot be read. */
  read(): Promise<string | null>;
  /** Throws when the write is rejected. */
  write(raw: string | null): Promise<void>;
}

/** A boolean preference: on is [enabledRaw]; off restores an off baseline, else [disabledRaw]. */
function booleanCodec(
  enabledRaw: string,
  disabledRaw: string,
  isEnabled: (raw: string | null) => boolean,
): Pick<PreferenceSetting, "decode" | "encode"> {
  return {
    decode: isEnabled,
    encode: (value, baseline) =>
      value === true
        ? enabledRaw
        : baseline !== undefined && !isEnabled(baseline)
          ? baseline
          : disabledRaw,
  };
}

type SettingResolution = PreferenceSetting | { unsupported: string };

type ResolvedSettings = Record<AccessibilityDisplayField, SettingResolution>;

interface FieldState {
  /** Present (possibly `null`, an unset setting) only when the read succeeded. */
  raw?: string | null;
  /** The preference as `raw` reads; present exactly when `raw` is. */
  value?: AccessibilityDisplayValue;
  support: AccessibilityDisplaySupportLevel;
  note?: string;
}

type FieldStates = Record<AccessibilityDisplayField, FieldState>;

/** Android API level that added `Settings.Secure.FONT_WEIGHT_ADJUSTMENT` (Bold text). */
export const ANDROID_BOLD_TEXT_MIN_API = 31;

/** `font_weight_adjustment` the Android 12+ Bold text toggle writes (FontStyle.FONT_WEIGHT_BOLD - NORMAL). */
export const ANDROID_BOLD_TEXT_WEIGHT_ADJUSTMENT = "300";

/** The three animation scales Android's "Remove animations" toggle zeroes, in snapshot order. */
export const ANDROID_ANIMATION_SCALE_KEYS = [
  "window_animation_scale",
  "transition_animation_scale",
  "animator_duration_scale",
] as const;

/** iOS Simulator `com.apple.Accessibility` defaults keys for the research-path preferences. */
export const IOS_ACCESSIBILITY_DEFAULTS_DOMAIN = "com.apple.Accessibility";
export const IOS_REDUCE_MOTION_KEY = "ReduceMotionEnabled";
export const IOS_BOLD_TEXT_KEY = "EnhancedTextLegibilityEnabled";

const IOS_DEFAULTS_PARTIAL_NOTE =
  "Written to the Simulator's com.apple.Accessibility defaults and read back from there; " +
  "UIKit reads it at launch, so relaunch the app under test before observing.";

const IOS_PHYSICAL_NOTE =
  "No automatable per-device control on physical iOS; set it in the Settings app.";

const NUMERIC_SETTING = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Parse an Android `settings get` value: `"null"` is unset; anything non-numeric is unreadable. */
export function parseAndroidNumericSetting(stdout: string): string | null {
  const value = stdout.trim();
  if (value === "null") {
    return null;
  }
  if (!NUMERIC_SETTING.test(value)) {
    throw new Error(`unexpected setting value '${value}'`);
  }
  return value;
}

function isNonZero(raw: string | null): boolean {
  return raw !== null && Number(raw) !== 0;
}

/** Remove animations is on only when every animation scale is explicitly zero. */
export function animationScalesRemoved(raw: string | null): boolean {
  return raw !== null && raw.split(",").every((part) => part !== "null" && Number(part) === 0);
}

async function androidShell(adb: SettingsAdb, command: string): Promise<string> {
  const result = await adb.executeCommand(command, { noRetry: true });
  const stderr = result.stderr ?? "";
  if (outputLooksLikeShellFailure(result.stdout, stderr)) {
    throw new Error(`'${command}' reported: ${`${result.stdout} ${stderr}`.trim()}`);
  }
  return result.stdout;
}

async function writeAndroidSetting(
  adb: SettingsAdb,
  namespace: "secure" | "global",
  key: string,
  raw: string | null,
): Promise<void> {
  await androidShell(
    adb,
    raw === null
      ? `shell settings delete ${namespace} ${key}`
      : `shell settings put ${namespace} ${key} ${raw}`,
  );
}

function androidSecureFlag(adb: SettingsAdb, key: string, enabledRaw: string): PreferenceSetting {
  return {
    support: true,
    ...booleanCodec(enabledRaw, "0", isNonZero),
    read: async () =>
      parseAndroidNumericSetting(await androidShell(adb, `shell settings get secure ${key}`)),
    write: (raw) => writeAndroidSetting(adb, "secure", key, raw),
  };
}

function androidRemoveAnimations(adb: SettingsAdb): PreferenceSetting {
  return {
    support: true,
    ...booleanCodec("0,0,0", "1,1,1", animationScalesRemoved),
    read: async () => {
      const scales = await Promise.all(
        ANDROID_ANIMATION_SCALE_KEYS.map(async (key) =>
          parseAndroidNumericSetting(await androidShell(adb, `shell settings get global ${key}`)),
        ),
      );
      return scales.map((scale) => scale ?? "null").join(",");
    },
    write: async (raw) => {
      const parts = (raw ?? "null,null,null").split(",");
      if (parts.length !== ANDROID_ANIMATION_SCALE_KEYS.length) {
        throw new Error(`malformed animation scale snapshot '${raw}'`);
      }
      await Promise.all(
        ANDROID_ANIMATION_SCALE_KEYS.map((key, index) =>
          writeAndroidSetting(adb, "global", key, parts[index] === "null" ? null : parts[index]),
        ),
      );
    },
  };
}

/** Android API level that added Extra dim (`Settings.Secure.REDUCE_BRIGHT_COLORS_ACTIVATED`). */
export const ANDROID_EXTRA_DIM_MIN_API = 31;

/** `Settings.Secure.ACCESSIBILITY_DISPLAY_DALTONIZER` values, by mode (AccessibilityManager). */
export const DALTONIZER_MODE_VALUES: Record<Exclude<ColorCorrectionMode, "off">, string> = {
  grayscale: "0",
  protanomaly: "11",
  deuteranomaly: "12",
  tritanomaly: "13",
};

/** The scale the magnification gesture uses when the setting is unset (AOSP default 2.0). */
export const ANDROID_DEFAULT_MAGNIFICATION_SCALE = 2;

/** Color correction is on only when enabled and set to a known mode: raw is `enabled,mode`. */
export function decodeColorCorrection(raw: string | null): ColorCorrectionMode {
  const [enabled, mode] = (raw ?? "null,null").split(",");
  if (enabled !== "1") {
    return "off";
  }
  const match = Object.entries(DALTONIZER_MODE_VALUES).find(([, value]) => value === mode);
  // An enabled daltonizer with an unknown or unset mode is AOSP's default, deuteranomaly.
  return (match?.[0] as ColorCorrectionMode | undefined) ?? "deuteranomaly";
}

const DALTONIZER_KEYS = [
  "accessibility_display_daltonizer_enabled",
  "accessibility_display_daltonizer",
] as const;

function androidColorCorrection(adb: SettingsAdb): PreferenceSetting {
  return {
    support: true,
    decode: decodeColorCorrection,
    encode: (value, baseline) => {
      if (value !== "off") {
        return `1,${DALTONIZER_MODE_VALUES[value as Exclude<ColorCorrectionMode, "off">]}`;
      }
      return baseline !== undefined && decodeColorCorrection(baseline) === "off"
        ? baseline
        : `0,${baseline?.split(",")[1] ?? "null"}`;
    },
    read: async () => {
      const parts = await Promise.all(
        DALTONIZER_KEYS.map(async (key) =>
          parseAndroidNumericSetting(await androidShell(adb, `shell settings get secure ${key}`)),
        ),
      );
      return parts.map((part) => part ?? "null").join(",");
    },
    write: async (raw) => {
      const parts = (raw ?? "null,null").split(",");
      if (parts.length !== DALTONIZER_KEYS.length) {
        throw new Error(`malformed color correction snapshot '${raw}'`);
      }
      // Set the mode before enabling, so the filter never applies with the previous mode.
      for (const index of [1, 0]) {
        const part = parts[index];
        await writeAndroidSetting(
          adb,
          "secure",
          DALTONIZER_KEYS[index],
          part === "null" ? null : part,
        );
      }
    },
  };
}

function androidMagnificationScale(adb: SettingsAdb): PreferenceSetting {
  const key = "accessibility_display_magnification_scale";
  return {
    support: true,
    decode: (raw) => (raw === null ? ANDROID_DEFAULT_MAGNIFICATION_SCALE : Number(raw)),
    encode: (value) => String(value),
    read: async () =>
      parseAndroidNumericSetting(await androidShell(adb, `shell settings get secure ${key}`)),
    write: (raw) => writeAndroidSetting(adb, "secure", key, raw),
  };
}

/** Gate a setting on the device API level; an unreadable level gates it off rather than guessing. */
function apiGated(
  label: string,
  minApi: number,
  apiLevel: number | null,
  setting: () => PreferenceSetting,
): SettingResolution {
  if (apiLevel === null) {
    return {
      unsupported: `Could not read the Android API level to gate ${label} (API ${minApi}+).`,
    };
  }
  return apiLevel < minApi
    ? { unsupported: `${label} needs Android API ${minApi}+ (device is API ${apiLevel}).` }
    : setting();
}

function androidSettings(adb: SettingsAdb, apiLevel: number | null): ResolvedSettings {
  return {
    increaseContrast: androidSecureFlag(adb, "high_text_contrast_enabled", "1"),
    reduceMotion: androidRemoveAnimations(adb),
    boldText: apiGated("Bold text", ANDROID_BOLD_TEXT_MIN_API, apiLevel, () =>
      androidSecureFlag(adb, "font_weight_adjustment", ANDROID_BOLD_TEXT_WEIGHT_ADJUSTMENT),
    ),
    colorInversion: androidSecureFlag(adb, "accessibility_display_inversion_enabled", "1"),
    colorCorrection: androidColorCorrection(adb),
    magnification: androidSecureFlag(adb, "accessibility_display_magnification_enabled", "1"),
    magnificationScale: androidMagnificationScale(adb),
    extraDim: apiGated("Extra dim", ANDROID_EXTRA_DIM_MIN_API, apiLevel, () =>
      androidSecureFlag(adb, "reduce_bright_colors_activated", "1"),
    ),
  };
}

export type SimctlRunner = Pick<SimCtl, "executeCommandArgs">;

function iosIncreaseContrast(simctl: SimctlRunner, udid: string): PreferenceSetting {
  return {
    support: true,
    ...booleanCodec("enabled", "disabled", (raw) => raw === "enabled"),
    read: async () => {
      const value = (
        await simctl.executeCommandArgs(["ui", udid, "increase_contrast"])
      ).stdout.trim();
      if (value !== "enabled" && value !== "disabled") {
        throw new Error(`'simctl ui increase_contrast' reported '${value}'`);
      }
      return value;
    },
    write: async (raw) => {
      await simctl.executeCommandArgs(["ui", udid, "increase_contrast", raw ?? "disabled"]);
    },
  };
}

function isMissingDefault(error: unknown): boolean {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
  return /does not exist|could not find key/i.test(`${errorMessage(error)} ${stderr}`);
}

function iosAccessibilityDefault(
  simctl: SimctlRunner,
  udid: string,
  key: string,
): PreferenceSetting {
  const defaults = (...args: string[]) =>
    simctl.executeCommandArgs(["spawn", udid, "defaults", ...args]);
  return {
    support: "partial",
    note: IOS_DEFAULTS_PARTIAL_NOTE,
    ...booleanCodec("1", "0", (raw) => raw === "1"),
    read: async () => {
      try {
        const value = (
          await defaults("read", IOS_ACCESSIBILITY_DEFAULTS_DOMAIN, key)
        ).stdout.trim();
        if (value !== "0" && value !== "1") {
          throw new Error(`'defaults read ${key}' reported '${value}'`);
        }
        return value;
      } catch (error) {
        if (isMissingDefault(error)) {
          // An absent Simulator default is off and must stay absent when restored.
          logger.debug(`[DisplayConfig] Simulator default ${key} is unset`, error);
          return null;
        }
        throw error;
      }
    },
    write: async (raw) => {
      await (raw === null
        ? defaults("delete", IOS_ACCESSIBILITY_DEFAULTS_DOMAIN, key)
        : defaults(
            "write",
            IOS_ACCESSIBILITY_DEFAULTS_DOMAIN,
            key,
            "-bool",
            raw === "1" ? "YES" : "NO",
          ));
    },
  };
}

const ANDROID_ONLY = { unsupported: "Android only: the iOS Simulator has no control for it." };

function iosSimulatorSettings(simctl: SimctlRunner, udid: string): ResolvedSettings {
  return {
    increaseContrast: iosIncreaseContrast(simctl, udid),
    reduceMotion: iosAccessibilityDefault(simctl, udid, IOS_REDUCE_MOTION_KEY),
    boldText: iosAccessibilityDefault(simctl, udid, IOS_BOLD_TEXT_KEY),
    colorInversion: ANDROID_ONLY,
    colorCorrection: ANDROID_ONLY,
    magnification: ANDROID_ONLY,
    magnificationScale: ANDROID_ONLY,
    extraDim: ANDROID_ONLY,
  };
}

/** Support for a target with no path for any field (physical iOS). */
export function unsupportedAccessibilityDisplay(note: string = IOS_PHYSICAL_NOTE): {
  supported: AccessibilityDisplaySupport;
  notes: AccessibilityDisplayNotes;
} {
  return {
    supported: Object.fromEntries(
      ACCESSIBILITY_DISPLAY_FIELDS.map((field) => [field, false]),
    ) as AccessibilityDisplaySupport,
    notes: Object.fromEntries(ACCESSIBILITY_DISPLAY_FIELDS.map((field) => [field, note])),
  };
}

/** Requested fields, in canonical order. */
export function requestedAccessibilityFields(
  values: AccessibilityDisplayValues,
): AccessibilityDisplayField[] {
  return ACCESSIBILITY_DISPLAY_FIELDS.filter((field) => values[field] !== undefined);
}

function isSetting(resolution: SettingResolution): resolution is PreferenceSetting {
  return !("unsupported" in resolution);
}

export interface AccessibilityDisplayDependencies {
  /** Android executor, created only when an Android field is touched. */
  adb?: () => SettingsAdb;
  simctl?: SimctlRunner;
  /** Whether the iOS target is a Simulator; physical iOS has no path for any field. */
  iosSimulator?: boolean;
  baselines?: AccessibilityBaselineStore;
}

/** Read, set and restore the accessibility display preferences on one device (#14088). */
export class AccessibilityDisplayPreferences {
  private readonly baselines: AccessibilityBaselineStore;
  private settingsPromise?: Promise<ResolvedSettings | undefined>;

  constructor(
    private readonly device: BootedDevice,
    private readonly dependencies: AccessibilityDisplayDependencies = {},
  ) {
    this.baselines = dependencies.baselines ?? defaultAccessibilityBaselines;
  }

  /** Whether a reset has anything recorded to restore, without touching the device. */
  hasBaseline(): boolean {
    return Object.keys(this.baselines.get(this.device.deviceId) ?? {}).length > 0;
  }

  /** Current values, with per-field support. Never throws: an unreadable field is unsupported. */
  async read(): Promise<AccessibilityDisplayRead> {
    const settings = await this.settings();
    if (!settings) {
      return { values: {}, ...unsupportedAccessibilityDisplay() };
    }
    return summarize(await this.readAll(settings));
  }

  /** Apply each requested field, returning previous and read-back values. */
  async set(input: AccessibilityDisplayValues): Promise<AccessibilityDisplayChange> {
    const settings = await this.settings();
    if (!settings) {
      return this.unsupportedChange(requestedAccessibilityFields(input));
    }
    const before = await this.readAll(settings);
    const errors: string[] = [];
    const written: AccessibilityDisplayField[] = [];
    for (const field of requestedAccessibilityFields(input)) {
      const fieldErrors = await this.applyField(
        field,
        input[field] as AccessibilityDisplayValue,
        settings[field],
        before[field],
      );
      errors.push(...fieldErrors);
      if (fieldErrors.length === 0) {
        written.push(field);
      }
    }
    const after = await this.readAll(settings);
    // Only verify what was written: a refused or failed write already carries its own error.
    errors.push(...verifyRequested(input, written, after));
    return change(before, after, errors, []);
  }

  /** Restore every field displayConfig changed on this device to its recorded baseline. */
  async reset(): Promise<AccessibilityDisplayChange> {
    const baseline = this.baselines.get(this.device.deviceId) ?? {};
    const fields = ACCESSIBILITY_DISPLAY_FIELDS.filter((field) => field in baseline);
    const settings = await this.settings();
    if (!settings) {
      return this.unsupportedChange(fields);
    }
    const before = await this.readAll(settings);
    const errors = await this.writeSnapshot(settings, pickSnapshot(baseline, fields));
    const after = await this.readAll(settings);
    const restored = fields.filter(
      (field) => "raw" in after[field] && after[field].raw === baseline[field],
    );
    const remaining = { ...baseline };
    for (const field of restored) {
      delete remaining[field];
    }
    this.storeBaseline(remaining);
    for (const field of fields.filter((candidate) => !restored.includes(candidate))) {
      if (!errors.some((error) => error.startsWith(`${field}:`))) {
        errors.push(
          `${field}: remained ${describeRaw(after[field])} after restoring ${String(baseline[field])}`,
        );
      }
    }
    return change(before, after, errors, restored);
  }

  /** Raw values of `fields` for recording a device default (#11145); unreadable fields are omitted. */
  async readSnapshot(
    fields: readonly AccessibilityDisplayField[],
  ): Promise<AccessibilityDisplaySnapshot> {
    const settings = await this.settings();
    if (!settings || fields.length === 0) {
      return {};
    }
    const states = await this.readAll(settings);
    return Object.fromEntries(
      fields.filter((field) => "raw" in states[field]).map((field) => [field, states[field].raw]),
    ) as AccessibilityDisplaySnapshot;
  }

  /** Write raw recorded defaults back (#11145); returns the fields written. Never records a baseline. */
  async restoreSnapshot(
    snapshot: AccessibilityDisplaySnapshot,
  ): Promise<AccessibilityDisplayField[]> {
    const settings = await this.settings();
    if (!settings) {
      return [];
    }
    const errors = await this.writeSnapshot(settings, snapshot);
    for (const error of errors) {
      logger.warn(`[DisplayConfig] Failed to restore ${error} on ${this.device.deviceId}`);
    }
    return ACCESSIBILITY_DISPLAY_FIELDS.filter(
      (field) => field in snapshot && !errors.some((error) => error.startsWith(`${field}:`)),
    );
  }

  private unsupportedChange(fields: AccessibilityDisplayField[]): AccessibilityDisplayChange {
    const support = unsupportedAccessibilityDisplay();
    return {
      values: {},
      ...support,
      previous: {},
      applied: {},
      errors: fields.map((field) => `${field}: ${support.notes[field]}`),
      restored: [],
    };
  }

  /** Resolved per-field paths, or `undefined` on a target with none (physical iOS). */
  private settings(): Promise<ResolvedSettings | undefined> {
    this.settingsPromise ??= this.resolveSettings();
    return this.settingsPromise;
  }

  private async resolveSettings(): Promise<ResolvedSettings | undefined> {
    if (this.device.platform === "ios") {
      const simctl = this.dependencies.simctl;
      return this.dependencies.iosSimulator && simctl
        ? iosSimulatorSettings(simctl, this.device.deviceId)
        : undefined;
    }
    const adb = this.dependencies.adb?.();
    if (!adb) {
      return undefined;
    }
    return androidSettings(adb, await readAndroidDeviceApiLevel(adb));
  }

  private async readAll(settings: ResolvedSettings): Promise<FieldStates> {
    const states = await Promise.all(
      ACCESSIBILITY_DISPLAY_FIELDS.map(
        async (field) => [field, await this.readField(field, settings[field])] as const,
      ),
    );
    return Object.fromEntries(states) as FieldStates;
  }

  private async readField(
    field: AccessibilityDisplayField,
    resolution: SettingResolution,
  ): Promise<FieldState> {
    if (!isSetting(resolution)) {
      return { support: false, note: resolution.unsupported };
    }
    try {
      const raw = await resolution.read();
      return {
        raw,
        value: resolution.decode(raw),
        support: resolution.support,
        ...(resolution.note ? { note: resolution.note } : {}),
      };
    } catch (error) {
      logger.warn(
        `[DisplayConfig] ${field} read failed on ${this.device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return { support: false, note: `Could not read ${field}: ${errorMessage(error)}` };
    }
  }

  private async applyField(
    field: AccessibilityDisplayField,
    value: AccessibilityDisplayValue,
    resolution: SettingResolution,
    before: FieldState,
  ): Promise<string[]> {
    if (!isSetting(resolution)) {
      return [`${field}: ${resolution.unsupported}`];
    }
    if (!("raw" in before)) {
      return [`${field}: ${before.note ?? "current value is unreadable"}; left unchanged`];
    }
    const previousRaw = before.raw ?? null;
    this.recordBaseline(field, previousRaw);
    const baselineRaw = this.baselines.get(this.device.deviceId)?.[field];
    return this.writeField(field, resolution, resolution.encode(value, baselineRaw));
  }

  private async writeSnapshot(
    settings: ResolvedSettings,
    snapshot: AccessibilityDisplaySnapshot,
  ): Promise<string[]> {
    const errors: string[] = [];
    for (const field of ACCESSIBILITY_DISPLAY_FIELDS.filter((candidate) => candidate in snapshot)) {
      const resolution = settings[field];
      errors.push(
        ...(isSetting(resolution)
          ? await this.writeField(field, resolution, snapshot[field] ?? null)
          : [`${field}: ${resolution.unsupported}`]),
      );
    }
    return errors;
  }

  private async writeField(
    field: AccessibilityDisplayField,
    setting: PreferenceSetting,
    raw: string | null,
  ): Promise<string[]> {
    try {
      await setting.write(raw);
      return [];
    } catch (error) {
      logger.warn(
        `[DisplayConfig] ${field} write failed on ${this.device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return [`${field}: write failed: ${errorMessage(error)}`];
    }
  }

  /** Keep the first value displayConfig replaced; capture before dispatch, as a rejected write may still apply. */
  private recordBaseline(field: AccessibilityDisplayField, raw: string | null): void {
    const baseline = this.baselines.get(this.device.deviceId) ?? {};
    if (!(field in baseline)) {
      this.storeBaseline({ ...baseline, [field]: raw });
    }
  }

  private storeBaseline(snapshot: AccessibilityDisplaySnapshot): void {
    if (Object.keys(snapshot).length === 0) {
      this.baselines.delete(this.device.deviceId);
    } else {
      this.baselines.set(this.device.deviceId, snapshot);
    }
  }
}

function pickSnapshot(
  snapshot: AccessibilityDisplaySnapshot,
  fields: readonly AccessibilityDisplayField[],
): AccessibilityDisplaySnapshot {
  return Object.fromEntries(fields.map((field) => [field, snapshot[field] ?? null]));
}

function describeRaw(state: FieldState): string {
  return "raw" in state ? String(state.raw) : "unreadable";
}

function valuesOf(states: FieldStates): AccessibilityDisplayValues {
  return Object.fromEntries(
    ACCESSIBILITY_DISPLAY_FIELDS.filter((field) => "raw" in states[field]).map((field) => [
      field,
      states[field].value,
    ]),
  ) as AccessibilityDisplayValues;
}

function summarize(states: FieldStates): AccessibilityDisplayRead {
  return {
    values: valuesOf(states),
    supported: Object.fromEntries(
      ACCESSIBILITY_DISPLAY_FIELDS.map((field) => [field, states[field].support]),
    ) as AccessibilityDisplaySupport,
    notes: Object.fromEntries(
      ACCESSIBILITY_DISPLAY_FIELDS.filter((field) => states[field].note !== undefined).map(
        (field) => [field, states[field].note],
      ),
    ) as AccessibilityDisplayNotes,
  };
}

function change(
  before: FieldStates,
  after: FieldStates,
  errors: string[],
  restored: AccessibilityDisplayField[],
): AccessibilityDisplayChange {
  const summary = summarize(after);
  return { ...summary, previous: valuesOf(before), applied: summary.values, errors, restored };
}

function verifyRequested(
  input: AccessibilityDisplayValues,
  written: readonly AccessibilityDisplayField[],
  after: FieldStates,
): string[] {
  return written.flatMap((field) => {
    const state = after[field];
    if (state.value === undefined) {
      return [`${field}: could not read back the applied value`];
    }
    const applied = state.value;
    return applied === input[field]
      ? []
      : [`${field} remained ${String(applied)} after requesting ${String(input[field])}`];
  });
}
