import type { BootedDevice } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { registerDeviceIncarnationListener } from "../../utils/deviceIncarnation";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";
import type { DisplayTheme, FontScaleInput } from "./displayConfigTypes";

/**
 * The Simulator's Dynamic Type categories, as `simctl ui <udid> content_size` names them,
 * smallest first (issue #14087).
 */
export const IOS_CONTENT_SIZE_CATEGORIES = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
] as const;

export type IosContentSizeCategory = (typeof IOS_CONTENT_SIZE_CATEGORIES)[number];

/** The iOS default text size category, which `fontScale: "default"` selects. */
export const IOS_DEFAULT_CONTENT_SIZE: IosContentSizeCategory = "large";

/**
 * Body text point size per category, from Apple's Human Interface Guidelines Dynamic Type
 * sizes table. `large` (17 pt) is the default, so a category's font scale is its size / 17.
 */
const BODY_POINT_SIZES: Record<IosContentSizeCategory, number> = {
  "extra-small": 14,
  small: 15,
  medium: 16,
  large: 17,
  "extra-large": 19,
  "extra-extra-large": 21,
  "extra-extra-extra-large": 23,
  "accessibility-medium": 28,
  "accessibility-large": 33,
  "accessibility-extra-large": 40,
  "accessibility-extra-extra-large": 47,
  "accessibility-extra-extra-extra-large": 53,
};

/** The body text scale of a category relative to the default, rounded to two decimals. */
export function contentSizeFontScale(category: IosContentSizeCategory): number {
  return Math.round((BODY_POINT_SIZES[category] / BODY_POINT_SIZES.large) * 100) / 100;
}

/** The category whose body text scale is nearest `fontScale`; a tie picks the larger one. */
export function nearestContentSize(fontScale: number): IosContentSizeCategory {
  const target = fontScale * BODY_POINT_SIZES.large;
  return IOS_CONTENT_SIZE_CATEGORIES.reduce((best, category) =>
    Math.abs(BODY_POINT_SIZES[category] - target) <= Math.abs(BODY_POINT_SIZES[best] - target)
      ? category
      : best,
  );
}

export function isIosContentSizeCategory(value: unknown): value is IosContentSizeCategory {
  return (IOS_CONTENT_SIZE_CATEGORIES as readonly unknown[]).includes(value);
}

/** The category a `fontScale` request selects. */
export function contentSizeForFontScale(fontScale: FontScaleInput): IosContentSizeCategory {
  return fontScale === "default" ? IOS_DEFAULT_CONTENT_SIZE : nearestContentSize(fontScale);
}

/** Process-lifetime record of the category displayConfig first replaced on each Simulator. */
export interface ContentSizeBaselineStore {
  get(deviceId: string): IosContentSizeCategory | undefined;
  set(deviceId: string, category: IosContentSizeCategory): void;
  delete(deviceId: string): void;
}

const defaultContentSizeBaselines: ContentSizeBaselineStore = new Map<
  string,
  IosContentSizeCategory
>();

registerDeviceIncarnationListener({
  name: "ios-display-config-content-size-baselines",
  onDeviceIdentityReplaced: (deviceId) => defaultContentSizeBaselines.delete(deviceId),
  // A same-device re-pool keeps the Simulator's text size and its baseline.
  onDeviceIncarnationChanged: () => {},
});

/** A content-size write that records nothing, for resets that must not become a baseline. */
export const unrecordedContentSizeBaselines: ContentSizeBaselineStore = {
  get: () => undefined,
  set: () => {},
  delete: () => {},
};

/** Theme and Dynamic Type state of a Simulator. `fontScale` is derived from `contentSize`. */
export interface IosSimulatorDisplayValues {
  theme?: DisplayTheme;
  contentSize?: IosContentSizeCategory;
  fontScale?: number;
}

export interface IosSimulatorDisplayInput {
  theme?: DisplayTheme;
  fontScale?: FontScaleInput;
  contentSize?: IosContentSizeCategory;
  density?: unknown;
  reset?: boolean;
}

export interface IosSimulatorDisplayChange {
  /** Restorable values read before the change: theme and contentSize, never the derived scale. */
  previous: IosSimulatorDisplayValues;
  applied?: IosSimulatorDisplayValues;
  errors: string[];
  /** The category a reset restored, when displayConfig had replaced one. */
  restoredContentSize?: IosContentSizeCategory;
}

export const IOS_DENSITY_UNSUPPORTED_ERROR =
  "density is not supported on iOS: there is no simctl, defaults or XCUITest control for " +
  "display density.";

type SimctlRunner = Pick<SimCtl, "executeCommandArgs">;

/** Theme and text size on an iOS Simulator, via `simctl ui appearance` and `content_size`. */
export class IosSimulatorDisplayConfig {
  constructor(
    private readonly device: BootedDevice,
    private readonly simctl: SimctlRunner,
    private readonly baselines: ContentSizeBaselineStore = defaultContentSizeBaselines,
  ) {}

  /** Current theme and text size. Throws when the appearance is unreadable. */
  async read(): Promise<IosSimulatorDisplayValues> {
    const [theme, contentSize] = await Promise.all([
      this.readTheme(),
      this.readContentSizeOrUndefined(),
    ]);
    return { theme, ...withScale(contentSize) };
  }

  /** Restorable theme and text size for recording a device default (#11145). */
  async readRestorable(): Promise<IosSimulatorDisplayValues> {
    const [theme, contentSize] = await Promise.all([
      this.readThemeOrUndefined(),
      this.readContentSizeOrUndefined(),
    ]);
    return {
      ...(theme !== undefined ? { theme } : {}),
      ...(contentSize !== undefined ? { contentSize } : {}),
    };
  }

  /**
   * Apply a theme and/or text size, or reset. Throws only when the pre-read fails, before
   * anything changed; every later failure is returned in `errors` beside `previous`.
   */
  async set(input: IosSimulatorDisplayInput): Promise<IosSimulatorDisplayChange> {
    const reset = input.reset === true;
    const targetSize = reset
      ? this.baselines.get(this.device.deviceId)
      : requestedContentSize(input);
    const previous = await this.readPrevious(targetSize !== undefined);
    if (!reset && targetSize !== undefined && previous.contentSize !== undefined) {
      this.recordBaseline(previous.contentSize);
    }
    // Light remains the iOS Simulator reset appearance (issue #6096).
    const targetTheme = reset ? "light" : input.theme;
    const errors = await this.apply(input, targetTheme, targetSize);
    const { applied, readError } = await this.readApplied();
    errors.push(...(readError ? [readError] : []), ...verify(applied, targetTheme, targetSize));
    const restoredContentSize = reset ? this.confirmRestore(applied, targetSize) : undefined;
    return {
      previous,
      ...(applied ? { applied } : {}),
      errors,
      ...(restoredContentSize ? { restoredContentSize } : {}),
    };
  }

  private async apply(
    input: IosSimulatorDisplayInput,
    theme: DisplayTheme | undefined,
    contentSize: IosContentSizeCategory | undefined,
  ): Promise<string[]> {
    return [
      ...(input.density !== undefined && !input.reset ? [IOS_DENSITY_UNSUPPORTED_ERROR] : []),
      ...(theme !== undefined ? await this.setAppearance(theme) : []),
      ...(contentSize !== undefined ? await this.setContentSize(contentSize) : []),
    ];
  }

  /** Clear the baseline once a reset is confirmed; a failed restore keeps it for a retry. */
  private confirmRestore(
    applied: IosSimulatorDisplayValues | undefined,
    baseline: IosContentSizeCategory | undefined,
  ): IosContentSizeCategory | undefined {
    if (baseline === undefined || applied?.contentSize !== baseline) {
      return undefined;
    }
    this.baselines.delete(this.device.deviceId);
    return baseline;
  }

  private recordBaseline(category: IosContentSizeCategory): void {
    if (this.baselines.get(this.device.deviceId) === undefined) {
      this.baselines.set(this.device.deviceId, category);
    }
  }

  private async readPrevious(needsContentSize: boolean): Promise<IosSimulatorDisplayValues> {
    const [theme, contentSize] = await Promise.all([
      this.readTheme(),
      needsContentSize ? this.readContentSize() : this.readContentSizeOrUndefined(),
    ]);
    return { theme, ...(contentSize !== undefined ? { contentSize } : {}) };
  }

  /**
   * Read the post-mutation state, isolated from the pre-read: a failure here must not
   * discard the already-captured `previous` restoration state (issue #6096 review).
   */
  private async readApplied(): Promise<{
    applied?: IosSimulatorDisplayValues;
    readError?: string;
  }> {
    try {
      return { applied: await this.read() };
    } catch (error) {
      logger.warn(
        `[DisplayConfig] setConfig post-read failed (iOS simulator): ${errorMessage(error)}`,
        error,
      );
      return { readError: `failed to read applied theme: ${errorMessage(error)}` };
    }
  }

  /** Read the appearance via `simctl ui appearance` (no value = get). */
  private async readTheme(): Promise<DisplayTheme> {
    const theme = await this.readThemeOrUndefined();
    if (theme === undefined) {
      throw new Error("simctl did not report a readable Simulator appearance");
    }
    return theme;
  }

  private async readThemeOrUndefined(): Promise<DisplayTheme | undefined> {
    const result = await this.simctl.executeCommandArgs(["ui", this.device.deviceId, "appearance"]);
    const value = result.stdout.trim();
    return value === "light" || value === "dark" ? value : undefined;
  }

  private async readContentSize(): Promise<IosContentSizeCategory> {
    const result = await this.simctl.executeCommandArgs([
      "ui",
      this.device.deviceId,
      "content_size",
    ]);
    const value = result.stdout.trim().toLowerCase();
    if (!isIosContentSizeCategory(value)) {
      throw new Error(`simctl reported an unknown Simulator content size '${value}'`);
    }
    return value;
  }

  /** The text size when readable; a read-only caller still gets the theme without it. */
  private async readContentSizeOrUndefined(): Promise<IosContentSizeCategory | undefined> {
    try {
      return await this.readContentSize();
    } catch (error) {
      logger.warn(
        `[DisplayConfig] content_size read failed on ${this.device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  /**
   * Set the appearance via `simctl ui appearance <light|dark>`. `system` and `custom` have no
   * Simulator equivalent, so they are refused per field rather than coerced to light or dark.
   */
  private async setAppearance(theme: DisplayTheme): Promise<string[]> {
    if (theme !== "light" && theme !== "dark") {
      return [
        `Cannot set theme '${theme}' on the iOS Simulator: 'simctl ui appearance' only accepts ` +
          "'light' or 'dark'.",
      ];
    }
    return this.run(["ui", this.device.deviceId, "appearance", theme], `appearance ${theme}`);
  }

  private setContentSize(category: IosContentSizeCategory): Promise<string[]> {
    return this.run(
      ["ui", this.device.deviceId, "content_size", category],
      `content_size ${category}`,
    );
  }

  /** Run a write, returning its failure as an error fragment so `previous` is never lost. */
  private async run(args: string[], label: string): Promise<string[]> {
    try {
      await this.simctl.executeCommandArgs(args);
      return [];
    } catch (error) {
      logger.warn(`[DisplayConfig] 'simctl ui ${label}' failed: ${errorMessage(error)}`, error);
      return [`'simctl ui ${label}' failed: ${errorMessage(error)}`];
    }
  }
}

function withScale(contentSize: IosContentSizeCategory | undefined): IosSimulatorDisplayValues {
  return contentSize === undefined
    ? {}
    : { contentSize, fontScale: contentSizeFontScale(contentSize) };
}

function requestedContentSize(input: IosSimulatorDisplayInput): IosContentSizeCategory | undefined {
  if (input.contentSize !== undefined) {
    return input.contentSize;
  }
  return input.fontScale === undefined ? undefined : contentSizeForFontScale(input.fontScale);
}

/**
 * `simctl ui` can accept a write the Simulator has not adopted, so success needs the
 * post-read to confirm each target.
 */
function verify(
  applied: IosSimulatorDisplayValues | undefined,
  theme: DisplayTheme | undefined,
  contentSize: IosContentSizeCategory | undefined,
): string[] {
  if (!applied) {
    return [];
  }
  return [
    ...(theme !== undefined && applied.theme !== theme
      ? [`Simulator appearance remained ${applied.theme} after requesting ${theme}`]
      : []),
    ...(contentSize !== undefined && applied.contentSize !== contentSize
      ? [
          `Simulator content size remained ${String(applied.contentSize)} after requesting ${contentSize}`,
        ]
      : []),
  ];
}
