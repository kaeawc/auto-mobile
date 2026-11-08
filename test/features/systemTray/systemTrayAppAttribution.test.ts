import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ViewHierarchyResult } from "../../../src/models";
import { findBestNotificationMatch } from "../../../src/features/systemTray/helpers/matching";
import { observeResultFromJsonText } from "../../helpers/observeFixture";

// The app filter attributes a row by its app-name element only, so another app's
// name in a notification's title or body never attributes the row to that app (#17401).

const fixturesDir = join(import.meta.dir, "../../fixtures");

// Real CtrlProxy shade: a collapsed "Shell" group (Delta, Gamma) above a
// headerless "Set a screen lock" row that carries no app-name element.
const androidShadeJson = JSON.stringify(
  (
    JSON.parse(
      readFileSync(
        join(fixturesDir, "observe/ctrlproxy-headerless-two-notification-group-collapsed.json"),
        "utf8",
      ),
    ) as { viewHierarchy: ViewHierarchyResult }
  ).viewHierarchy,
);
const androidShade = (replace: [string, string][] = []): ViewHierarchyResult =>
  JSON.parse(
    replace.reduce((json, [from, to]) => json.replaceAll(from, to), androidShadeJson),
  ) as ViewHierarchyResult;

// iOS 26.5 notification center whose only row reads "MESSAGES, Grouped, now,
// mt0091c, hello tray"; the leading "MESSAGES" is the row's app attribution.
const iosCaptureText = (
  JSON.parse(
    readFileSync(
      join(fixturesDir, "systemTray/ios-26.5/full-tray-open-messages-grouped.json"),
      "utf8",
    ),
  ) as { content: [{ text: string }] }
).content[0].text;
const iosTray = (replace: [string, string][] = []): ViewHierarchyResult => {
  const text = replace.reduce((json, [from, to]) => json.replaceAll(from, to), iosCaptureText);
  return observeResultFromJsonText(text, "full-tray-open-messages-grouped.json").viewHierarchy!;
};

const SETTINGS_ANDROID = ["Settings", "com.android.settings"];
const SHELL = ["Shell", "com.android.shell"];
const SETTINGS_IOS = ["Settings", "com.apple.Preferences"];
const MESSAGES_IOS = ["Messages", "com.apple.MobileSMS"];

describe("systemTray app filter on Android shade rows", () => {
  test("does not attribute a group child to an app named in its body", () => {
    const shade = androidShade([["delta body", "open Settings to reply"]]);
    expect(
      findBestNotificationMatch(
        shade,
        { title: "Delta", appId: "com.android.settings" },
        SETTINGS_ANDROID,
      ),
    ).toBeNull();
  });

  test("does not attribute a group child to an app named in its title", () => {
    const shade = androidShade([["Delta", "Settings changed"]]);
    expect(
      findBestNotificationMatch(
        shade,
        { body: "delta body", appId: "com.android.settings" },
        SETTINGS_ANDROID,
      ),
    ).toBeNull();
  });

  test("still attributes a group child by its group header's app label", () => {
    const shade = androidShade([["delta body", "open Settings to reply"]]);
    const match = findBestNotificationMatch(
      shade,
      { title: "Delta", appId: "com.android.shell" },
      SHELL,
    );
    expect(match?.match.matches.app).toEqual({ text: "Shell", matchType: "exact" });
  });

  test("falls back to the whole row when the row has no app-name element", () => {
    // The headerless row renders no app label, so its own text is the only evidence.
    const match = findBestNotificationMatch(
      androidShade(),
      { title: "Set a screen lock", appId: "com.android.settings" },
      ["security"],
    );
    expect(match?.match.matches.app).toEqual({ text: "security", matchType: "partial" });
  });
});

describe("systemTray app filter on iOS notification-center rows", () => {
  const settingsInBody = iosTray([["hello tray", "open Settings"]]);

  test("does not attribute a row to an app named in its body", () => {
    expect(
      findBestNotificationMatch(
        settingsInBody,
        { title: "mt0091c", appId: "com.apple.Preferences" },
        SETTINGS_IOS,
      ),
    ).toBeNull();
  });

  test("does not attribute a row to an app named in its title for an appId-only query", () => {
    const settingsInTitle = iosTray([["mt0091c", "Settings"]]);
    expect(
      findBestNotificationMatch(settingsInTitle, { appId: "com.apple.Preferences" }, SETTINGS_IOS),
    ).toBeNull();
  });

  test("attributes the row by its header app name", () => {
    const match = findBestNotificationMatch(
      settingsInBody,
      { title: "mt0091c", appId: "com.apple.MobileSMS" },
      MESSAGES_IOS,
    );
    expect(match?.match.matches.app).toEqual({ text: "Messages", matchType: "exact" });
  });

  test("attributes an appId-only query by the header app name", () => {
    const match = findBestNotificationMatch(
      settingsInBody,
      { appId: "com.apple.MobileSMS" },
      MESSAGES_IOS,
    );
    expect(match?.match.matches.app).toEqual({ text: "Messages", matchType: "exact" });
  });
});
