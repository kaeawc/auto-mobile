import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ANDROID_AUTO_UI_LABELS as L,
  DEVELOPER_MODE_VERSION_TAPS,
  ScriptedAndroidAutoSettingsUi,
  screenTextVariants,
  type AndroidAutoScreenDriver,
  type ScreenText,
} from "../../../src/features/androidAuto/AndroidAutoSettingsUi";

/**
 * Records each screen action; visible text and switch states are set by the test. A tap or
 * scroll must name a label that is visible, so a relabelled row fails like it does on a device.
 * `relabel` swaps one visible label for another after its first tap, as Android Auto 18.1 does.
 */
class FakeScreen implements AndroidAutoScreenDriver {
  readonly actions: string[] = [];
  visible = new Set<string>();
  switches = new Map<string, boolean>();
  strict = false;
  relabel = new Map<string, string>();

  async isTextVisible(text: string) {
    this.actions.push(`visible?${text}`);
    return this.visible.has(text);
  }
  async tapText(text: ScreenText) {
    const label = this.match(text);
    this.actions.push(`tap:${label}`);
    const next = this.relabel.get(label);
    if (next !== undefined) {
      this.relabel.delete(label);
      this.visible.delete(label);
      this.visible.add(next);
    }
  }
  async scrollToText(text: ScreenText) {
    this.actions.push(`scroll:${this.match(text)}`);
  }
  /** The visible variant of `text`, or its first variant when the screen is not strict. */
  private match(text: ScreenText): string {
    const variants = screenTextVariants(text);
    const shown = variants.find((variant) => this.visible.has(variant));
    if (shown !== undefined) {
      return shown;
    }
    if (this.strict) {
      throw new Error(`${variants.join(" | ")} is not on the screen`);
    }
    return variants[0]!;
  }
  async isSwitchOn(label: string) {
    this.actions.push(`switch?${label}`);
    return this.switches.get(label) ?? false;
  }
  async openOverflowMenu() {
    this.actions.push("overflow");
  }
  async pressBack() {
    this.actions.push("back");
  }
}

function setup() {
  const screen = new FakeScreen();
  const phone = {
    openAndroidAutoSettings: async () => {
      screen.actions.push("open-settings");
    },
  };
  return { screen, ui: new ScriptedAndroidAutoSettingsUi(phone, screen) };
}

describe("ScriptedAndroidAutoSettingsUi", () => {
  test("developer mode reads as on only when the overflow lists Developer settings", async () => {
    const { screen, ui } = setup();
    expect(await ui.isDeveloperModeEnabled()).toBe(false);
    screen.visible.add(L.developerSettings);
    expect(await ui.isDeveloperModeEnabled()).toBe(true);
    expect(screen.actions.slice(0, 4)).toEqual([
      "open-settings",
      "overflow",
      `visible?${L.developerSettings}`,
      "back",
    ]);
  });

  test("taps Version ten times and accepts the development-settings prompt", async () => {
    const { screen, ui } = setup();
    screen.visible.add(L.developerModeDialog);
    await ui.enableDeveloperMode();
    const versionTaps = screen.actions.filter((action) => action === "tap:Version");
    expect(versionTaps).toHaveLength(DEVELOPER_MODE_VERSION_TAPS);
    expect(screen.actions.at(-1)).toBe(`tap:${L.developerModeConfirm}`);
  });

  test("keeps counting taps on the Version row after it relabels (Android Auto 18.1.664404, #17884)", async () => {
    const { screen, ui } = setup();
    screen.strict = true;
    screen.visible = new Set(["Version", L.developerModeDialog, L.developerModeConfirm]);
    screen.relabel.set("Version", "Version and permission info");
    await ui.enableDeveloperMode();
    expect(screen.actions.filter((action) => action.startsWith("tap:Version"))).toEqual([
      "tap:Version",
      ...Array.from(
        { length: DEVELOPER_MODE_VERSION_TAPS - 1 },
        () => "tap:Version and permission info",
      ),
    ]);
    expect(screen.actions.at(-1)).toBe(`tap:${L.developerModeConfirm}`);
  });

  test("finds the Version row when settings reopen already relabelled", async () => {
    const { screen, ui } = setup();
    screen.strict = true;
    screen.visible = new Set([
      "Version and permission info",
      L.developerModeDialog,
      L.developerModeConfirm,
    ]);
    await ui.enableDeveloperMode();
    expect(screen.actions).toContain("scroll:Version and permission info");
    expect(
      screen.actions.filter((action) => action === "tap:Version and permission info"),
    ).toHaveLength(DEVELOPER_MODE_VERSION_TAPS);
  });

  test("a missing development-settings prompt fails instead of tapping blindly", async () => {
    const { screen, ui } = setup();
    await expect(ui.enableDeveloperMode()).rejects.toThrow(L.developerModeDialog);
    expect(screen.actions).not.toContain(`tap:${L.developerModeConfirm}`);
  });

  test("turns Unknown sources on only when it is off", async () => {
    const { screen, ui } = setup();
    await ui.enableUnknownSources();
    expect(screen.actions).toContain(`tap:${L.unknownSources}`);

    const on = setup();
    on.screen.switches.set(L.unknownSources, true);
    await on.ui.enableUnknownSources();
    expect(on.screen.actions).not.toContain(`tap:${L.unknownSources}`);
    expect(await on.ui.isUnknownSourcesEnabled()).toBe(true);
  });

  test("starts the head unit server from the overflow menu", async () => {
    const { screen, ui } = setup();
    await ui.startHeadUnitServer();
    expect(screen.actions).toEqual(["open-settings", "overflow", `tap:${L.startHeadUnitServer}`]);
  });

  test("onboarding is pending while the welcome screen shows, and Continue accepts it", async () => {
    const { screen, ui } = setup();
    expect(await ui.isOnboardingPending()).toBe(false);
    screen.visible.add(L.onboardingTitle);
    expect(await ui.isOnboardingPending()).toBe(true);
    await ui.acceptOnboarding();
    expect(screen.actions.at(-1)).toBe(`tap:${L.onboardingContinue}`);
  });
});
