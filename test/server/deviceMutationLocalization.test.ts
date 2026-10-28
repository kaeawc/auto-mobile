import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { appLocaleJournalKey } from "../../src/daemon/sessionBroker/appLocaleJournalKey";
import {
  AdbLocalizationPriorSource,
  type LocalizationPriorSource,
  type RawSettingRead,
} from "../../src/features/utility/system-configuration/AndroidLocalizationPriorSource";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import { LocalizationMutationPriorReader } from "../../src/server/deviceMutationLocalizationPriorReader";
import { DefaultMutationPriorReader } from "../../src/server/deviceMutationPriorReader";
import type { MutationValue } from "../../src/daemon/sessionBroker/mutations/types";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

const ANDROID: BootedDevice = { deviceId: "phone", platform: "android", name: "Phone" };
const IOS: BootedDevice = { deviceId: "sim", platform: "ios", name: "Sim" };
const APP = "com.example.app";
const APP_LOCALE = { kind: "device-setting", key: appLocaleJournalKey(APP) };
const UNOBSERVED: MutationValue = { state: "unobservable" };

function source(
  rows: Record<string, RawSettingRead>,
  locales: Awaited<ReturnType<LocalizationPriorSource["readAppLocales"]>> = null,
): LocalizationPriorSource {
  return {
    readAppLocales: async () => locales,
    readSettingRow: async (namespace, key) => rows[`${namespace}:${key}`] ?? { readable: false },
  };
}

describe("changeLocalization journal priors on Android", () => {
  test("the journal rows are the app locale, the time zone and the settings-backed fields", () => {
    expect(
      deviceToolMutations(
        "changeLocalization",
        { locale: "he", appId: APP, textDirection: "rtl", calendarSystem: "islamic" },
        "android",
      ),
    ).toEqual([
      APP_LOCALE,
      { kind: "device-setting", key: "textDirection" },
      { kind: "device-setting", key: "calendarSystem" },
    ]);
  });

  test("records the app's locales for its user and both raw RTL rows", async () => {
    const reader = new LocalizationMutationPriorReader(() =>
      source(
        {
          "global:debug.force_rtl": { readable: true, value: null },
          "global:force_rtl": { readable: true, value: "0" },
        },
        { userId: 10, locales: "fr-FR,en-US" },
      ),
    );
    expect(
      await reader.read(ANDROID, [APP_LOCALE, { kind: "device-setting", key: "textDirection" }]),
    ).toEqual([
      { state: "present", value: { userId: 10, locales: "fr-FR,en-US" } },
      { state: "present", value: "null,0" },
    ]);
  });

  test("an unreadable row, an unread app locale or a failed read is unobservable", async () => {
    const unreadable = new LocalizationMutationPriorReader(() =>
      source({ "global:debug.force_rtl": { readable: true, value: "1" } }),
    );
    expect(
      await unreadable.read(ANDROID, [
        APP_LOCALE,
        { kind: "device-setting", key: "textDirection" },
      ]),
    ).toEqual([{ state: "unobservable" }, { state: "unobservable" }]);
    const throwing = new LocalizationMutationPriorReader(() => ({
      readAppLocales: async () => {
        throw new Error("adb offline");
      },
      readSettingRow: async () => {
        throw new Error("adb offline");
      },
    }));
    expect(await throwing.read(ANDROID, [APP_LOCALE])).toEqual([{ state: "unobservable" }]);
  });

  test("the journal prior reader takes the app-locale prior and keeps calendarSystem's", async () => {
    const reader = new DefaultMutationPriorReader(
      { read: async () => ({ calendarSystem: "gregory" }) },
      undefined,
      undefined,
      undefined,
      undefined,
      {
        dataReader: new LocalizationMutationPriorReader(() =>
          source({}, { userId: 0, locales: "" }),
        ),
        deviceStateReader: { read: async (_device, mutations) => mutations.map(() => UNOBSERVED) },
      },
    );
    expect(
      await reader.read(ANDROID, [APP_LOCALE, { kind: "device-setting", key: "calendarSystem" }]),
    ).toEqual([
      { state: "present", value: { userId: 0, locales: "" } },
      { state: "present", value: "gregory" },
    ]);
  });

  test("other intents and iOS read nothing", async () => {
    const reader = new LocalizationMutationPriorReader(() => {
      throw new Error("must not read");
    });
    expect(
      await reader.read(ANDROID, [
        { kind: "device-setting", key: "fontScale" },
        { kind: "clock", key: "timezone" },
      ]),
    ).toEqual([{ state: "unobservable" }, { state: "unobservable" }]);
    expect(await reader.read(IOS, [{ kind: "device-setting", key: "calendarSystem" }])).toEqual([
      { state: "unobservable" },
    ]);
  });
});

describe("AdbLocalizationPriorSource", () => {
  function adb(apiLevel: number | null) {
    const fake = new FakeAdbExecutor();
    fake.setAndroidApiLevel(apiLevel);
    fake.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    return fake;
  }

  test("reads the app's locale list for the resolved user on Android 13+", async () => {
    const fake = adb(34);
    fake.setCommandResponse(
      `shell cmd locale get-app-locales '${APP}' --user 0`,
      createExecResult(`Locales for ${APP} for user 0 are [fr-FR,en-US]\n`, ""),
    );
    expect(await new AdbLocalizationPriorSource(fake).readAppLocales(APP)).toEqual({
      userId: 0,
      locales: "fr-FR,en-US",
    });
  });

  test("below Android 13, an unknown API level or an unknown package has no prior", async () => {
    expect(await new AdbLocalizationPriorSource(adb(32)).readAppLocales(APP)).toBeNull();
    expect(await new AdbLocalizationPriorSource(adb(null)).readAppLocales(APP)).toBeNull();
    const missing = adb(34);
    missing.setCommandResponse(
      "get-app-locales",
      createExecResult(`Unknown package ${APP} for userId 0`, ""),
    );
    expect(await new AdbLocalizationPriorSource(missing).readAppLocales(APP)).toBeNull();
  });

  test("a settings row reads as its raw value, null when unset, unreadable on stderr", async () => {
    const fake = adb(34);
    fake.setCommandResponse(
      "shell settings get system calendar_type",
      createExecResult("islamic\n", ""),
    );
    fake.setCommandResponse("shell settings get global force_rtl", createExecResult("null\n", ""));
    fake.setCommandResponse(
      "shell settings get global debug.force_rtl",
      createExecResult("", "Security exception"),
    );
    const reader = new AdbLocalizationPriorSource(fake);
    expect(await reader.readSettingRow("system", "calendar_type")).toEqual({
      readable: true,
      value: "islamic",
    });
    expect(await reader.readSettingRow("global", "force_rtl")).toEqual({
      readable: true,
      value: null,
    });
    expect(await reader.readSettingRow("global", "debug.force_rtl")).toEqual({ readable: false });
  });
});
