import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BootedDevice } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { createExecResult } from "../../../src/utils/execResult";
import {
  parseAndroidPreferencesXml,
  serializeAndroidPreferencesXml,
  type AndroidPreferencesXmlDocument,
} from "../../../src/features/preferences/AndroidPreferencesXmlFile";
import {
  AppPreferences,
  readAndroidStorageEntries,
} from "../../../src/features/preferences/AppPreferences";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const CAPTURED_PREFERENCES_XML = readFileSync(
  new URL("../../fixtures/android-shared-preferences.xml", import.meta.url),
  "utf8",
);

const androidDevice: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5554",
};

/** Values whose text is whitespace-only, has leading/trailing whitespace, or is empty (#9916). */
const STRING_VALUES: Record<string, string> = {
  single_space: " ",
  many_spaces: "   ",
  newline: "\n",
  tab_and_newline: "\t\n",
  leading: "  x",
  trailing: "x  ",
  padded: "  x  ",
  empty: "",
  plain: "hello",
};

/** Built by the serializer under test so the XML is exactly what this code path emits. */
function documentWithStrings(values: Record<string, string>): AndroidPreferencesXmlDocument {
  return {
    map: {
      string: Object.entries(values).map(([name, value]) =>
        value === "" ? { $: { name } } : { _: value, $: { name } },
      ),
    },
  };
}

function valuesByKey(entries: { key: string; value: string | null }[]): Record<string, unknown> {
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

function writtenXml(adb: FakeAdbExecutor): string {
  const command = adb.getExecutedCommands().find((entry) => entry.includes("base64 -d >"));
  expect(command).toBeDefined();
  const match = command!.match(/([A-Za-z0-9+/=]{24,})/);
  expect(match).toBeTruthy();
  return Buffer.from(match![1], "base64").toString("utf8");
}

function factoryFor(adb: FakeAdbExecutor): AdbClientFactory {
  return { create: () => adb };
}

describe("Android preferences XML whitespace round trip (#9916)", () => {
  test("reads whitespace-only, padded and empty string values back exactly", async () => {
    const xml = serializeAndroidPreferencesXml(documentWithStrings(STRING_VALUES));

    const entries = await readAndroidStorageEntries(xml);

    expect(valuesByKey(entries)).toEqual(STRING_VALUES);
  });

  test("a parse then serialize pass leaves every string value unchanged", async () => {
    const xml = serializeAndroidPreferencesXml(documentWithStrings(STRING_VALUES));

    const roundTripped = serializeAndroidPreferencesXml(await parseAndroidPreferencesXml(xml));

    expect(roundTripped).toBe(xml);
  });

  test("keeps whitespace-only set members and ignores indentation between elements", async () => {
    const xml = serializeAndroidPreferencesXml({
      map: {
        set: [{ $: { name: "delims" }, string: [" ", "a", "\n", "  b  "] }],
        string: [{ _: " ", $: { name: "sep" } }],
      },
    });
    const indented = xml.replace(/></g, ">\n    <");

    const document = await parseAndroidPreferencesXml(indented);
    const entries = valuesByKey(await readAndroidStorageEntries(indented));

    expect(entries).toEqual({ sep: " ", delims: JSON.stringify([" ", "a", "\n", "  b  "]) });
    expect(Object.keys(document.map).sort()).toEqual(["set", "string"]);
    expect(serializeAndroidPreferencesXml(document)).toBe(xml);
  });

  test("parses the captured fixture to the same shape as before", async () => {
    const document = await parseAndroidPreferencesXml(CAPTURED_PREFERENCES_XML);

    expect(document).toEqual({
      map: {
        string: [{ _: 'hello "xml" & world', $: { name: "greeting" } }, { $: { name: "empty" } }],
        boolean: [{ $: { name: "enabled", value: "true" } }],
        int: [{ $: { name: "launch_count", value: "-7" } }],
        long: [{ $: { name: "max_long", value: "9223372036854775807" } }],
        float: [{ $: { name: "ratio", value: "0.1" } }],
        set: [{ $: { name: "flags" }, string: ["first", 'say "hi"'] }],
        null: [{ $: { name: "nullable" } }],
      },
    });
    expect(Object.keys(document)).toEqual(["map"]);
  });

  test("an empty or self-closing map still parses to an empty document", async () => {
    expect((await parseAndroidPreferencesXml("<map/>")).map).toEqual({});
    expect((await parseAndroidPreferencesXml("<map>\n</map>")).map).toEqual({});
  });
});

describe("setPreference keeps whitespace-only strings (#9916)", () => {
  test("rewriting another key preserves whitespace-only values in the same file", async () => {
    const original = serializeAndroidPreferencesXml(
      documentWithStrings({ sep: " ", newline: "\n", a: "x" }),
    );
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cat shared_prefs/app_preferences.xml", createExecResult(original, ""));
    const preferences = new AppPreferences(androidDevice, { adbFactory: factoryFor(adb) });

    const result = await preferences.setPreference({
      scope: "sharedPreferences",
      appId: "com.example.app",
      suite: "app_preferences",
      key: "a",
      value: "y",
      type: "string",
    });

    expect(result).toMatchObject({ success: true });
    const entries = valuesByKey(await readAndroidStorageEntries(writtenXml(adb)));
    expect(entries).toEqual({ sep: " ", newline: "\n", a: "y" });
  });

  test("a whitespace-only value written by setPreference reads back as the same value", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cat shared_prefs/app_preferences.xml", createExecResult("<map/>", ""));
    const preferences = new AppPreferences(androidDevice, { adbFactory: factoryFor(adb) });

    await preferences.setPreference({
      scope: "sharedPreferences",
      appId: "com.example.app",
      suite: "app_preferences",
      key: "sep",
      value: "  ",
      type: "string",
    });
    const written = writtenXml(adb);
    adb.setCommandResponse("cat shared_prefs/app_preferences.xml", createExecResult(written, ""));

    const read = await preferences.getPreference({
      scope: "sharedPreferences",
      appId: "com.example.app",
      suite: "app_preferences",
      key: "sep",
    });

    expect(read).toMatchObject({ success: true, found: true, type: "string", value: "  " });
  });
});
