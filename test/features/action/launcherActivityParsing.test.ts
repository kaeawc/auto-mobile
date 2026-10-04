import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseLauncherActivities,
  parseLauncherActivitiesFromPackageDump,
  resolveComponentActivity,
} from "../../../src/features/action/launcherActivityParsing";

describe("launcher activity parsing characterization", () => {
  test("pattern 1 reads relative activity tokens from a real activity-activities capture", () => {
    const capture = readFileSync(
      new URL(
        "../observe/activityActivitiesDumps/api36-home-settings-secondapp.log",
        import.meta.url,
      ),
      "utf8",
    );
    // Slice the two captured ActivityRecord lines and the lines between them.
    const start = capture.indexOf("    mLastPausedActivity: ActivityRecord{74880956");
    const end = capture.indexOf("\n", capture.indexOf("    * Hist  #0: ActivityRecord{74880956"));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(parseLauncherActivities(capture.slice(start, end), "com.android.settings")).toEqual([
      ".Settings$WifiSettingsActivity",
    ]);
  });

  // These minimal strings probe regex input shapes, not captured device output.
  test("shape probe: pattern 1 keeps absolute activities and only the first slash segment", () => {
    expect(
      parseLauncherActivities(
        "com.foo.bar/com.other.Home com.foo.bar/.Relative/ignored com.foo.bar/",
        "com.foo.bar",
      ),
    ).toEqual(["com.other.Home", ".Relative"]);
  });

  test("shape probe: pattern 2 collects full Activity class tokens before pattern 3 tokens", () => {
    expect(
      parseLauncherActivities("com.foo.bar.Home com.foo.bar.HomeActivitySuffix", "com.foo.bar"),
    ).toEqual(["com.foo.bar.HomeActivitySuffix", "com.foo.bar.Home"]);
  });

  test("shape probe: pattern 3 collects full class names via the startsWith branch", () => {
    expect(parseLauncherActivities("com.foo.bar.Home com.foo.bar.Other", "com.foo.bar")).toEqual([
      "com.foo.bar.Home",
      "com.foo.bar.Other",
    ]);
  });

  test("shape probe: all patterns dedupe in pattern order and then first-seen order", () => {
    const stdout =
      "com.foo.bar.Home com.foo.bar.SecondActivity com.foo.bar/.First " +
      "com.foo.bar/.First com.foo.bar.FirstActivity com.foo.bar.SecondActivity com.foo.bar.Home";
    expect(parseLauncherActivities(stdout, "com.foo.bar")).toEqual([
      ".First",
      "com.foo.bar.SecondActivity",
      "com.foo.bar.FirstActivity",
      "com.foo.bar.Home",
    ]);
  });

  test("shape probe: patterns 2 and 3 use the slash branch and skip an empty segment", () => {
    expect(
      parseLauncherActivities(
        "com.foo.bar.ClassActivity/.FromPattern2/ignored " +
          "com.foo.bar.Class/.FromPattern3/ignored " +
          "com.foo.bar.EmptyActivity/ com.foo.bar.Empty/ com.foo.bar.Double//ignored",
        "com.foo.bar",
      ),
    ).toEqual([".FromPattern2", ".FromPattern3"]);
  });

  test("shape probe: package-prefix matches remain allowed without boundary anchors", () => {
    expect(parseLauncherActivities("com.foo.bar.baz/.X", "com.foo.bar")).toEqual([".X"]);
  });

  test.each(["", " \n\t", "unrelated/token"])("shape probe: no activities in %j", (stdout) => {
    expect(parseLauncherActivities(stdout, "com.foo.bar")).toEqual([]);
  });

  test.each([
    ["com.foo.bar/.Main", "com.foo.bar.Main"],
    ["com.foo.bar/com.other.Main", "com.other.Main"],
    ["com.foo.bar/.Main/extra", "com.foo.bar.Main/extra"],
    ["com.foo.bar/", ""],
    ["com.foo.bar.Main", undefined],
    ["", undefined],
  ])("shape probe: resolves component %j to %j", (component, expected) => {
    expect(resolveComponentActivity(component, "com.foo.bar")).toBe(expected);
  });
});

describe("literal package escaping (input-shape probes, not device captures)", () => {
  test.each(["comXfooXbar", "com-foo-bar", "com_foo_bar", "com/foo/bar"])(
    "rejects dot-position look-alike %s in the query parser",
    (lookAlike) => {
      const stdout = `${lookAlike}/.Main ${lookAlike}.SomeActivity/.Two ${lookAlike}.Class/.Three`;
      expect(parseLauncherActivities(stdout, "com.foo.bar")).toEqual([]);
    },
  );

  test.each([
    ["com.example.app$test", "com.example.apptest"],
    ["com.example+x", "com.exampleex"],
    ["a(b", "ab"],
    ["a[b", "ab"],
  ])("matches metacharacters in %s literally without throwing", (packageName, lookAlike) => {
    const stdout =
      `${lookAlike}/.Main ${lookAlike}.HomeActivity ${lookAlike}.Home\n` +
      `${packageName}/.Main ${packageName}.HomeActivity ${packageName}.Home`;
    expect(parseLauncherActivities(stdout, packageName)).toEqual([
      ".Main",
      `${packageName}.HomeActivity`,
      `${packageName}.Home`,
    ]);
  });

  test("still matches a real package name literally in all three patterns", () => {
    const stdout = "com.foo.bar/.Main com.foo.bar.HomeActivity com.foo.bar.Home";
    expect(parseLauncherActivities(stdout, "com.foo.bar")).toEqual([
      ".Main",
      "com.foo.bar.HomeActivity",
      "com.foo.bar.Home",
    ]);
  });
});

describe("package dump launcher filters", () => {
  const playgroundPackage = "dev.jasonpearson.automobile.playground";
  const playground = readFileSync(
    new URL(
      "../../fixtures/android-launcher/dumpsys-package-playground-launcher.txt",
      import.meta.url,
    ),
    "utf8",
  );
  const egg = readFileSync(
    new URL("../../fixtures/android-launcher/dumpsys-package-egg-no-launcher.txt", import.meta.url),
    "utf8",
  );

  test("real playground dump returns only its MAIN plus LAUNCHER activity", () => {
    expect(parseLauncherActivitiesFromPackageDump(playground, playgroundPackage)).toEqual([
      ".MainActivity",
    ]);
  });

  test("real egg dump rejects MAIN activities without LAUNCHER", () => {
    expect(parseLauncherActivities(egg, "com.android.egg")[0]).toBe(".landroid.MainActivity");
    expect(parseLauncherActivitiesFromPackageDump(egg, "com.android.egg")).toEqual([]);
  });

  test("real playground dump with CRLF still returns its launcher activity", () => {
    expect(
      parseLauncherActivitiesFromPackageDump(
        playground.replaceAll("\n", "\r\n"),
        playgroundPackage,
      ),
    ).toEqual([".MainActivity"]);
  });

  test("real egg dump with CRLF still rejects activities without LAUNCHER", () => {
    expect(
      parseLauncherActivitiesFromPackageDump(egg.replaceAll("\n", "\r\n"), "com.android.egg"),
    ).toEqual([]);
  });

  test("real playground dump with doubled indentation still returns its launcher activity", () => {
    const reindented = playground
      .split("\n")
      .map((line) => " ".repeat(line.length - line.trimStart().length) + line)
      .join("\n");
    expect(parseLauncherActivitiesFromPackageDump(reindented, playgroundPackage)).toEqual([
      ".MainActivity",
    ]);
  });

  test("real playground dump rejects a different package and package prefixes", () => {
    for (const packageName of [
      "com.android.egg",
      "dev.jasonpearson.automobile",
      playgroundPackage + "$test",
    ]) {
      expect(parseLauncherActivitiesFromPackageDump(playground, packageName)).toEqual([]);
    }
  });

  test("real filters repeated under actions are deduplicated in dump order", () => {
    const activityTable = playground.slice(0, playground.indexOf("Receiver Resolver Table:"));
    const entries = activityTable.slice(activityTable.indexOf("  Non-Data Actions:"));
    expect(
      parseLauncherActivitiesFromPackageDump(activityTable + entries, playgroundPackage),
    ).toEqual([".MainActivity"]);
  });

  test("activity filters placed after the real receiver table are ignored", () => {
    const activityTable = playground.slice(0, playground.indexOf("Receiver Resolver Table:"));
    const receiverTable = playground.slice(
      playground.indexOf("Receiver Resolver Table:"),
      playground.indexOf("Domain verification status:"),
    );
    expect(
      parseLauncherActivitiesFromPackageDump(
        egg.slice(0, egg.indexOf("Receiver Resolver Table:")) +
          receiverTable +
          activityTable.slice(activityTable.indexOf("  Non-Data Actions:")),
        playgroundPackage,
      ),
    ).toEqual([]);
  });

  test("another top-level section ends the activity resolver table", () => {
    const activityTable = playground.slice(0, playground.indexOf("Receiver Resolver Table:"));
    const otherSections = playground.slice(playground.indexOf("Domain verification status:"));
    const eggTable = egg.slice(0, egg.indexOf("Receiver Resolver Table:"));
    expect(
      parseLauncherActivitiesFromPackageDump(
        eggTable +
          otherSections +
          activityTable.slice(activityTable.indexOf("  Non-Data Actions:")),
        playgroundPackage,
      ),
    ).toEqual([]);
  });
});
