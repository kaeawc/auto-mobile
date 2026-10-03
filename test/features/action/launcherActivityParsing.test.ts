import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseFallbackMainActivities,
  parseLauncherActivities,
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

  test.each(["android.intent.action.MAIN", "MainActivity", ".Main"])(
    "shape probe: fallback collects every package token on a line triggered by %s",
    (trigger) => {
      expect(
        parseFallbackMainActivities(`${trigger} com.foo.bar/.One com.foo.bar/.Two`, "com.foo.bar"),
      ).toEqual(["com.foo.bar/.One", "com.foo.bar/.Two"]);
    },
  );

  test("shape probe: fallback dedupes across lines in first-seen order and ignores other lines", () => {
    expect(
      parseFallbackMainActivities(
        "com.foo.bar/.Ignored\nandroid.intent.action.MAIN com.foo.bar/.Two com.foo.bar/.One\n" +
          "MainActivity com.foo.bar/.One com.foo.bar/.Three\n.Main com.foo.bar/.Two",
        "com.foo.bar",
      ),
    ).toEqual(["com.foo.bar/.Two", "com.foo.bar/.One", "com.foo.bar/.Three"]);
  });

  test.each(["", "unrelated MainActivity", "com.foo.bar/.Ignored"])(
    "shape probe: fallback has no matches in %j",
    (stdout) => {
      expect(parseFallbackMainActivities(stdout, "com.foo.bar")).toEqual([]);
    },
  );

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
    "rejects dot-position look-alike %s in both parsers",
    (lookAlike) => {
      const stdout = `${lookAlike}/.Main ${lookAlike}.SomeActivity/.Two ${lookAlike}.Class/.Three`;
      expect(parseLauncherActivities(stdout, "com.foo.bar")).toEqual([]);
      expect(parseFallbackMainActivities(stdout, "com.foo.bar")).toEqual([]);
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
    expect(parseFallbackMainActivities(stdout, packageName)).toEqual([
      `${packageName}/.Main`,
      `${packageName}.HomeActivity`,
      `${packageName}.Home`,
    ]);
  });

  test("still matches a real package name literally in all three patterns and the fallback", () => {
    const stdout = "com.foo.bar/.Main com.foo.bar.HomeActivity com.foo.bar.Home";
    expect(parseLauncherActivities(stdout, "com.foo.bar")).toEqual([
      ".Main",
      "com.foo.bar.HomeActivity",
      "com.foo.bar.Home",
    ]);
    expect(parseFallbackMainActivities(stdout, "com.foo.bar")).toEqual([
      "com.foo.bar/.Main",
      "com.foo.bar.HomeActivity",
      "com.foo.bar.Home",
    ]);
  });
});
