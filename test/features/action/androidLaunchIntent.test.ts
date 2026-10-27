import { describe, expect, test } from "bun:test";
import {
  AndroidLaunchIntentError,
  type AndroidLaunchIntentErrorCode,
  buildAmStartIntentArgs,
  classifyAmStartFailure,
  resolveIntentComponent,
} from "../../../src/features/action/androidLaunchIntent";

const APP = "com.example.app";

function refusal(run: () => unknown): AndroidLaunchIntentError {
  try {
    run();
  } catch (error) {
    if (error instanceof AndroidLaunchIntentError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an AndroidLaunchIntentError");
}

describe("resolveIntentComponent (#14080)", () => {
  test.each([
    [".DebugActivity", `${APP}/.DebugActivity`],
    ["DebugActivity", `${APP}/.DebugActivity`],
    [`${APP}.debug.DebugActivity`, `${APP}/${APP}.debug.DebugActivity`],
    [`${APP}/.DebugActivity`, `${APP}/.DebugActivity`],
    [`${APP}/com.example.shared.Screen$Inner`, `${APP}/com.example.shared.Screen$Inner`],
  ])("%s resolves to %s", (component, expected) => {
    expect(resolveIntentComponent(APP, component)).toBe(expected);
  });

  test("refuses a component in another package", () => {
    const error = refusal(() => resolveIntentComponent(APP, "com.android.settings/.Settings"));
    expect(error.code).toBe("invalid_intent");
    expect(error.message).toContain("com.android.settings");
  });

  test.each([".Bad Name", "1Activity", "a/b/c", ".; reboot"])(
    "refuses the malformed class %s",
    (component) => {
      expect(refusal(() => resolveIntentComponent(APP, component)).code).toBe("invalid_intent");
    },
  );
});

describe("buildAmStartIntentArgs (#14080)", () => {
  test("builds a component launch with typed extras and flags", () => {
    expect(
      buildAmStartIntentArgs(APP, {
        component: ".DebugActivity",
        action: "android.intent.action.VIEW",
        data: "example://screen/42",
        categories: ["android.intent.category.DEFAULT"],
        extras: [
          { key: "user", type: "string", value: "alice" },
          { key: "count", type: "int", value: 3 },
          { key: "big", type: "long", value: 9_000_000_000 },
          { key: "ratio", type: "float", value: 0.5 },
          { key: "debug", type: "boolean", value: true },
          { key: "tags", type: "stringArray", value: ["a,b", "c"] },
          { key: "link", type: "uri", value: "https://example.com/x" },
        ],
        flags: ["clearTask", "newTask", "clearTask"],
      }),
    ).toBe(
      [
        "-a 'android.intent.action.VIEW'",
        "-d 'example://screen/42'",
        "-c 'android.intent.category.DEFAULT'",
        "--es 'user' 'alice'",
        "--ei 'count' '3'",
        "--el 'big' '9000000000'",
        "--ef 'ratio' '0.5'",
        "--ez 'debug' 'true'",
        "--esa 'tags' 'a\\,b,c'",
        "--eu 'link' 'https://example.com/x'",
        "--activity-clear-task",
        "-f 0x10000000",
        `-n '${APP}/.DebugActivity'`,
      ].join(" "),
    );
  });

  test("passes shell metacharacters in extras literally", () => {
    const hostile = `x'; rm -rf / #$(id)\`whoami\`"&|<>`;
    const args = buildAmStartIntentArgs(APP, {
      component: ".Main",
      extras: [{ key: "k;ey", type: "string", value: hostile }],
    });
    expect(args).toBe(`--es 'k;ey' 'x'\\''; rm -rf / #$(id)\`whoami\`"&|<>' -n '${APP}/.Main'`);
  });

  test("an intent without a component is pinned to the app with -p", () => {
    expect(buildAmStartIntentArgs(APP, { action: "android.intent.action.VIEW" })).toBe(
      `-a 'android.intent.action.VIEW' -p '${APP}'`,
    );
  });

  test("an intent with nothing to resolve is refused", () => {
    expect(refusal(() => buildAmStartIntentArgs(APP, { categories: ["x"] })).code).toBe(
      "invalid_intent",
    );
  });

  test.each([
    { key: "n", type: "int" as const, value: 2 ** 31 },
    { key: "n", type: "int" as const, value: 1.5 },
    { key: "n", type: "long" as const, value: 2 ** 60 },
    { key: "n", type: "float" as const, value: Number.NaN },
    { key: "", type: "string" as const, value: "x" },
  ])("refuses the extra %o", (extra) => {
    expect(
      refusal(() => buildAmStartIntentArgs(APP, { component: ".Main", extras: [extra] })).code,
    ).toBe("invalid_intent");
  });
});

describe("classifyAmStartFailure (#14080)", () => {
  test("a clean start is not a failure", () => {
    expect(
      classifyAmStartFailure(
        "Starting: Intent { cmp=com.example.app/.DebugActivity (has extras) }\n",
      ),
    ).toBeUndefined();
  });

  test.each<[string, AndroidLaunchIntentErrorCode]>([
    [
      "Starting: Intent { cmp=com.example.app/.Secret }\nException occurred while executing 'start':\njava.lang.SecurityException: Permission Denial: starting Intent { cmp=com.example.app/.Secret } from null (pid=1, uid=2000) not exported from uid 10123",
      "activity_not_exported",
    ],
    [
      "Starting: Intent { cmp=com.example.app/.Missing }\nError type 3\nError: Activity class {com.example.app/com.example.app.Missing} does not exist.",
      "activity_not_found",
    ],
    [
      "Starting: Intent { act=android.intent.action.VIEW pkg=com.example.app }\nError: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW flg=0x10000000 pkg=com.example.app }",
      "intent_unresolved",
    ],
    ["Error: Unknown option: --bogus", "am_start_failed"],
  ])("classifies %#", (output, code) => {
    expect(classifyAmStartFailure(output)?.code).toBe(code);
  });
});
