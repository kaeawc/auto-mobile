import { describe, expect, test } from "bun:test";
import {
  applyLauncherPackages,
  catalogFromPackageRecords,
  launcherActivitiesCommand,
  needsLauncherProbe,
  parseLauncherPackages,
  type AndroidAppCatalog,
} from "../../../src/features/observe/androidAppCatalog";

describe("androidAppCatalog (#6798)", () => {
  test("the launcher probe is one batched per-user MAIN/LAUNCHER query", () => {
    expect(launcherActivitiesCommand(0)).toBe(
      "shell cmd package query-activities --brief --user 0 " +
        "-a android.intent.action.MAIN -c android.intent.category.LAUNCHER",
    );
    expect(launcherActivitiesCommand(10)).toContain("--user 10");
  });

  test("parses the flattened components out of --brief output, chrome and all", () => {
    const stdout = [
      "3 activities found:",
      "  Activity #0:",
      "    com.android.contacts/.activities.PeopleActivity",
      "  Activity #1:",
      "    com.google.android.deskclock/com.android.deskclock.DeskClock",
      "  Activity #2:",
      "    com.android.settings/.homepage.SettingsHomepageActivity",
      "",
    ].join("\n");

    expect(parseLauncherPackages(stdout)).toEqual(
      new Set(["com.android.contacts", "com.google.android.deskclock", "com.android.settings"]),
    );
  });

  test("an empty / 'No activities found' listing yields no launcher packages", () => {
    expect(parseLauncherPackages("No activities found\n")).toEqual(new Set());
    expect(parseLauncherPackages("")).toEqual(new Set());
  });

  test("CtrlProxy records supply labels and launchability without an adb probe", () => {
    const catalog = catalogFromPackageRecords([
      { packageName: "com.android.contacts", isSystem: true, label: "Contacts", launchable: true },
      {
        packageName: "com.android.providers.contacts",
        isSystem: true,
        label: "Contacts Storage",
        launchable: false,
      },
    ]);

    expect(catalog.get("com.android.contacts")).toEqual({ label: "Contacts", launchable: true });
    expect(catalog.get("com.android.providers.contacts")).toEqual({
      label: "Contacts Storage",
      launchable: false,
    });
    expect(needsLauncherProbe(catalog)).toBe(false);
  });

  test("an older on-device SDK reports neither field; launchability stays unknown, not false", () => {
    const catalog = catalogFromPackageRecords([
      { packageName: "com.example.app", isSystem: false },
      { packageName: "com.example.blank", isSystem: false, label: "   " },
    ]);

    expect(catalog.get("com.example.app")).toEqual({});
    expect(catalog.get("com.example.blank")).toEqual({});
    expect(needsLauncherProbe(catalog)).toBe(true);
  });

  test("the launcher probe fills in a definite launchable for every known package", () => {
    const catalog: AndroidAppCatalog = new Map([["com.android.contacts", { label: "Contacts" }]]);

    applyLauncherPackages(
      catalog,
      ["com.android.contacts", "com.android.providers.contacts"],
      new Set(["com.android.contacts"]),
    );

    expect(catalog.get("com.android.contacts")).toEqual({ label: "Contacts", launchable: true });
    expect(catalog.get("com.android.providers.contacts")).toEqual({ launchable: false });
  });
});
