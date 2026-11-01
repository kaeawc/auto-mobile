import { describe, expect, test } from "bun:test";
import { AndroidDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/androidDeviceMutationResetPort";
import { AndroidKeepBootedReset } from "../../../src/daemon/sessionBroker/androidKeepBootedReset";
import { appLocaleJournalKey } from "../../../src/daemon/sessionBroker/appLocaleJournalKey";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type { MutationValue } from "../../../src/daemon/sessionBroker/mutations/types";
import { deviceToolMutations } from "../../../src/server/deviceMutationAdapters";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ANDROID_RESET_DEVICE } from "./fixtures/androidReset";
import { androidBaselineRig } from "./fixtures/androidMutationBaseline";

const APP = "com.example.probe";
const SET = `shell cmd locale set-app-locales '${APP}' --user 0 --locales`;
const GET = `shell cmd locale get-app-locales '${APP}' --user 0`;

const appLocale = (priorValue: MutationValue, appId = APP) => ({
  kind: "device-setting",
  key: appLocaleJournalKey(appId),
  priorValue,
  toolName: "changeLocalization",
});

function rig() {
  const adb = new FakeAdbExecutor();
  const port = new AndroidDeviceMutationResetPort(adb);
  const context: DeviceMutationResetContext = {
    scope: { deviceId: "emulator-5554", incarnation: "resource", sessionUuid: "session" },
    signal: new AbortController().signal,
    assertOwned: async () => {},
  };
  return { adb, port, context };
}

describe("AndroidDeviceMutationResetPort per-app locale", () => {
  test.each([
    ["an app with no override", "", `${SET} ''`],
    ["an app's locale list", "fr-FR,en-US", `${SET} 'fr-FR,en-US'`],
  ])("restores %s and reads it back", async (_label, locales, setCommand) => {
    const { adb, port, context } = rig();
    adb.setCommandResponse(
      GET,
      createExecResult(`Locales for ${APP} for user 0 are [${locales}]\n`, ""),
    );
    const mutation = appLocale({ state: "present", value: { userId: 0, locales } });
    expect(port.canRevert(mutation)).toBe(true);
    await port.revert(mutation, context);
    expect(adb.getExecutedCommands()).toEqual([setCommand, GET]);
  });

  test("a read-back that does not show the prior list fails the revert", async () => {
    const { adb, port, context } = rig();
    adb.setCommandResponse(GET, createExecResult(`Locales for ${APP} for user 0 are [he]`, ""));
    await expect(
      port.revert(appLocale({ state: "present", value: { userId: 0, locales: "" } }), context),
    ).rejects.toThrow();
  });

  test("an unknown package fails the revert", async () => {
    const { adb, port, context } = rig();
    adb.setCommandResponse(SET, createExecResult("", `Unknown package ${APP} for userId 0`));
    await expect(
      port.revert(appLocale({ state: "present", value: { userId: 0, locales: "" } }), context),
    ).rejects.toThrow();
  });

  test.each([
    ["unobservable", appLocale({ state: "unobservable" })],
    ["absent", appLocale({ state: "absent" })],
    ["a bare locale string", appLocale({ state: "present", value: "fr-FR" })],
    ["no user", appLocale({ state: "present", value: { locales: "" } })],
    ["a negative user", appLocale({ state: "present", value: { userId: -1, locales: "" } })],
    [
      "shell text in the list",
      appLocale({ state: "present", value: { userId: 0, locales: "fr;reboot" } }),
    ],
    ["an unsafe app id", appLocale({ state: "present", value: { userId: 0, locales: "" } }, "a;b")],
    [
      "the device-wide locale",
      { ...appLocale({ state: "present", value: { userId: 0, locales: "" } }), key: "locale" },
    ],
  ])("cannot restore %s", (_label, mutation) => {
    expect(rig().port.canRevert(mutation)).toBe(false);
  });
});

describe("Android keep-booted changeLocalization", () => {
  async function keepBootedRig() {
    const { adb, reply } = androidBaselineRig();
    const timer = new FakeTimer();
    const journal = new FakeDeviceMutationJournal(timer);
    const port = new AndroidDeviceMutationResetPort(adb, timer);
    let fallbacks = 0;
    const strategy = new AndroidKeepBootedReset({
      journal,
      port: () => port,
      timer,
      fallback: {
        reset: async () => {
          fallbacks++;
          return { outcome: "clean", mode: "snapshot", phases: {} };
        },
      },
    });
    const session = { resourceId: "resource-a", sessionId: "session-a" };
    const assertOwned = async () => {};
    await strategy.capture(ANDROID_RESET_DEVICE, {
      ...session,
      timeoutMs: 50,
      signal: new AbortController().signal,
      assertOwned,
    });
    adb.clearHistory();
    const scope = {
      deviceId: ANDROID_RESET_DEVICE.deviceId,
      incarnation: session.resourceId,
      sessionUuid: session.sessionId,
    };
    const record = async (args: Record<string, unknown>, priors: MutationValue[]) => {
      const rows = deviceToolMutations("changeLocalization", args, "android");
      expect(rows).toHaveLength(priors.length);
      for (const [index, row] of rows.entries()) {
        await journal.record(scope, {
          ...row,
          toolName: "changeLocalization",
          priorValue: priors[index]!,
        });
      }
    };
    const reset = () => strategy.reset(ANDROID_RESET_DEVICE, new Set([APP]), assertOwned, session);
    return { adb, reply, record, reset, fallbacks: () => fallbacks };
  }

  test("an app locale and text direction with readable priors revert in place", async () => {
    const { adb, reply, record, reset, fallbacks } = await keepBootedRig();
    reply(GET, `Locales for ${APP} for user 0 are []`);
    await record({ locale: "he", appId: APP, textDirection: "rtl" }, [
      { state: "present", value: { userId: 0, locales: "" } },
      { state: "present", value: "null,0" },
    ]);
    expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(fallbacks()).toBe(0);
    expect(adb.getExecutedCommands()).toEqual(
      expect.arrayContaining([
        `${SET} ''`,
        GET,
        "shell settings --user 0 delete global debug.force_rtl",
        "shell settings --user 0 put global force_rtl '0'",
      ]),
    );
  });

  test("a calendarSystem row still escalates", async () => {
    const { adb, record, reset, fallbacks } = await keepBootedRig();
    await record({ calendarSystem: "islamic" }, [{ state: "present", value: "gregory" }]);
    expect(await reset()).toMatchObject({ outcome: "fallback:snapshot" });
    expect(fallbacks()).toBe(1);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("an unreadable app-locale prior still escalates without touching the device", async () => {
    const { adb, record, reset, fallbacks } = await keepBootedRig();
    await record({ locale: "he", appId: APP }, [{ state: "unobservable" }]);
    expect(await reset()).toMatchObject({ outcome: "fallback:snapshot" });
    expect(fallbacks()).toBe(1);
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});
