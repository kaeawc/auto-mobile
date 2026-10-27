import { describe, expect, test } from "bun:test";
import {
  androidIntentArgs,
  androidIntentExtraSchema,
  resolveComponent,
} from "../../../src/features/intent/androidIntent";

const APP = "dev.jasonpearson.automobile.playground";

describe("androidIntentArgs (#14081)", () => {
  test("typed extras map to their am flags with every value quoted", () => {
    expect(
      androidIntentArgs(APP, {
        action: "dev.example.TOGGLE",
        extras: [
          { key: "name", type: "string", value: "Ada" },
          { key: "count", type: "int", value: 3 },
          { key: "big", type: "long", value: 9007199254740991 },
          { key: "ratio", type: "float", value: 0.5 },
          { key: "enabled", type: "boolean", value: true },
          { key: "tags", type: "stringArray", value: ["a", "b"] },
          { key: "link", type: "uri", value: "app://home" },
        ],
      }),
    ).toEqual([
      "-a",
      "'dev.example.TOGGLE'",
      "-p",
      `'${APP}'`,
      "--es",
      "'name'",
      "'Ada'",
      "--ei",
      "'count'",
      "'3'",
      "--el",
      "'big'",
      "'9007199254740991'",
      "--ef",
      "'ratio'",
      "'0.5'",
      "--ez",
      "'enabled'",
      "'true'",
      "--esa",
      "'tags'",
      "'a,b'",
      "--eu",
      "'link'",
      "'app://home'",
    ]);
  });

  test("shell metacharacters stay literal inside single quotes", () => {
    const [, , value] = androidIntentArgs(APP, {
      extras: [{ key: "q", type: "string", value: `$(reboot); echo 'hi' && rm -rf /` }],
    }).slice(2);
    expect(value).toBe(`'$(reboot); echo '\\''hi'\\'' && rm -rf /'`);
  });

  test("commas inside a string-array element are escaped for --esa", () => {
    const args = androidIntentArgs(APP, {
      extras: [{ key: "list", type: "stringArray", value: ["a,b", "c\\d"] }],
    });
    expect(args.at(-1)).toBe("'a\\,b,c\\\\d'");
  });

  test("data, mime type and categories precede the package", () => {
    expect(
      androidIntentArgs(APP, {
        action: "A",
        data: "https://x.test/p?q=1",
        mimeType: "text/plain",
        categories: ["android.intent.category.DEFAULT"],
      }),
    ).toEqual([
      "-a",
      "'A'",
      "-d",
      "'https://x.test/p?q=1'",
      "-t",
      "'text/plain'",
      "-c",
      "'android.intent.category.DEFAULT'",
      "-p",
      `'${APP}'`,
    ]);
  });
});

describe("resolveComponent", () => {
  test("relative, qualified and package-prefixed components inside the app", () => {
    expect(resolveComponent(APP, ".DebugReceiver")).toBe(`${APP}/.DebugReceiver`);
    expect(resolveComponent(APP, "dev.x.Receiver")).toBe(`${APP}/dev.x.Receiver`);
    expect(resolveComponent(APP, `${APP}/.DebugReceiver`)).toBe(`${APP}/.DebugReceiver`);
  });

  test("a component in another package is refused", () => {
    expect(() => resolveComponent(APP, "com.android.settings/.Receiver")).toThrow("is outside");
    expect(() => resolveComponent(APP, `${APP}/`)).toThrow("is outside");
  });
});

describe("androidIntentExtraSchema", () => {
  test("rejects a value of the wrong type for its declared type", () => {
    expect(androidIntentExtraSchema.safeParse({ key: "n", type: "int", value: 1.5 }).success).toBe(
      false,
    );
    expect(
      androidIntentExtraSchema.safeParse({ key: "b", type: "boolean", value: "true" }).success,
    ).toBe(false);
    expect(
      androidIntentExtraSchema.safeParse({ key: "s", type: "stringArray", value: ["x"] }).success,
    ).toBe(true);
  });
});
