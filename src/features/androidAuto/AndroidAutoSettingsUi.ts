import { ActionableError } from "../../models/ActionableError";
import type { AndroidAutoPhone } from "./AndroidAutoPhone";

/** The Android Auto phone-screen steps that have no adb equivalent. */
export interface AndroidAutoSettingsUi {
  isDeveloperModeEnabled(signal?: AbortSignal): Promise<boolean>;
  enableDeveloperMode(signal?: AbortSignal): Promise<void>;
  isUnknownSourcesEnabled(signal?: AbortSignal): Promise<boolean>;
  enableUnknownSources(signal?: AbortSignal): Promise<void>;
  startHeadUnitServer(signal?: AbortSignal): Promise<void>;
  isOnboardingPending(signal?: AbortSignal): Promise<boolean>;
  acceptOnboarding(signal?: AbortSignal): Promise<void>;
}

/** One visible label, or every label a row is known to read as (a row can relabel mid-script). */
export type ScreenText = string | readonly string[];

/** The labels a {@link ScreenText} matches, in order. */
export function screenTextVariants(text: ScreenText): readonly string[] {
  return typeof text === "string" ? [text] : text;
}

/** A {@link ScreenText} quoted for an error message: `"Version" or "Version and permission info"`. */
export function describeScreenText(text: ScreenText): string {
  return screenTextVariants(text)
    .map((variant) => `"${variant}"`)
    .join(" or ");
}

/** Text-level phone screen access (observe + tap), narrowed to what the settings script uses. */
export interface AndroidAutoScreenDriver {
  isTextVisible(text: string, signal?: AbortSignal): Promise<boolean>;
  /** Taps the first node reading any variant of `text`. */
  tapText(text: ScreenText, signal?: AbortSignal): Promise<void>;
  /** Scrolls the current list until any variant of `text` is on screen; throws when none appears. */
  scrollToText(text: ScreenText, signal?: AbortSignal): Promise<void>;
  /** Whether the switch on the row labelled `label` is on. */
  isSwitchOn(label: string, signal?: AbortSignal): Promise<boolean>;
  openOverflowMenu(signal?: AbortSignal): Promise<void>;
  pressBack(signal?: AbortSignal): Promise<void>;
}

/** Android Auto's English UI labels, as they read on Android Auto 18.1. */
export interface AndroidAutoUiLabels {
  /**
   * Every label the **Version** row reads as. Android Auto 18.1 relabels it to "Version and
   * permission info" after the first tap (#17884), so each tap matches any of them.
   */
  version: readonly string[];
  developerModeDialog: string;
  developerModeConfirm: string;
  developerSettings: string;
  unknownSources: string;
  startHeadUnitServer: string;
  onboardingTitle: string;
  onboardingContinue: string;
}

export const DEFAULT_ANDROID_AUTO_UI_LABELS: AndroidAutoUiLabels = {
  version: ["Version", "Version and permission info"],
  developerModeDialog: "Allow development settings?",
  developerModeConfirm: "OK",
  developerSettings: "Developer settings",
  unknownSources: "Unknown sources",
  startHeadUnitServer: "Start head unit server",
  onboardingTitle: "Welcome to Android Auto",
  onboardingContinue: "Continue",
};

/** Taps on **Version**, counted across its relabels, that unlock developer mode. */
export const DEVELOPER_MODE_VERSION_TAPS = 10;

/** Drives Android Auto's settings screens by visible text, starting each step from a fresh settings launch. */
export class ScriptedAndroidAutoSettingsUi implements AndroidAutoSettingsUi {
  constructor(
    private readonly phone: Pick<AndroidAutoPhone, "openAndroidAutoSettings">,
    private readonly screen: AndroidAutoScreenDriver,
    private readonly labels: AndroidAutoUiLabels = DEFAULT_ANDROID_AUTO_UI_LABELS,
  ) {}

  /** **Developer settings** appears in the overflow menu only once developer mode is on. */
  async isDeveloperModeEnabled(signal?: AbortSignal): Promise<boolean> {
    await this.openOverflow(signal);
    const enabled = await this.screen.isTextVisible(this.labels.developerSettings, signal);
    await this.screen.pressBack(signal);
    return enabled;
  }

  async enableDeveloperMode(signal?: AbortSignal): Promise<void> {
    await this.phone.openAndroidAutoSettings(signal);
    await this.screen.scrollToText(this.labels.version, signal);
    for (let tap = 0; tap < DEVELOPER_MODE_VERSION_TAPS; tap++) {
      await this.screen.tapText(this.labels.version, signal);
    }
    if (!(await this.screen.isTextVisible(this.labels.developerModeDialog, signal))) {
      throw new ActionableError(
        `Android Auto did not show "${this.labels.developerModeDialog}" after ${DEVELOPER_MODE_VERSION_TAPS} taps on ${describeScreenText(this.labels.version)}.`,
      );
    }
    await this.screen.tapText(this.labels.developerModeConfirm, signal);
  }

  async isUnknownSourcesEnabled(signal?: AbortSignal): Promise<boolean> {
    await this.openDeveloperSettings(signal);
    return this.screen.isSwitchOn(this.labels.unknownSources, signal);
  }

  async enableUnknownSources(signal?: AbortSignal): Promise<void> {
    await this.openDeveloperSettings(signal);
    if (!(await this.screen.isSwitchOn(this.labels.unknownSources, signal))) {
      await this.screen.tapText(this.labels.unknownSources, signal);
    }
  }

  async startHeadUnitServer(signal?: AbortSignal): Promise<void> {
    await this.openOverflow(signal);
    await this.screen.tapText(this.labels.startHeadUnitServer, signal);
  }

  isOnboardingPending(signal?: AbortSignal): Promise<boolean> {
    return this.screen.isTextVisible(this.labels.onboardingTitle, signal);
  }

  async acceptOnboarding(signal?: AbortSignal): Promise<void> {
    await this.screen.tapText(this.labels.onboardingContinue, signal);
  }

  private async openOverflow(signal?: AbortSignal): Promise<void> {
    await this.phone.openAndroidAutoSettings(signal);
    await this.screen.openOverflowMenu(signal);
  }

  private async openDeveloperSettings(signal?: AbortSignal): Promise<void> {
    await this.openOverflow(signal);
    await this.screen.tapText(this.labels.developerSettings, signal);
    await this.screen.scrollToText(this.labels.unknownSources, signal);
  }
}
