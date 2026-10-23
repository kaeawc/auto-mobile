import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import type { DeviceLockState } from "../../src/models";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import { InteractionMutationPriorReader } from "../../src/server/deviceMutationInteractionPriorReader";
import { interactionToolMutations } from "../../src/server/deviceMutationInteractionAdapters";
import { pressButtonInput } from "../../src/server/interactionTools/deviceSchemas";
import { DefaultMutationPriorReader } from "../../src/server/deviceMutationPriorReader";
import { FamilyMutationPriorReader } from "../../src/server/deviceMutationFamilyPriorReader";
import { SessionDeviceMutationRecording } from "../../src/server/deviceMutationRecording";
import { SessionMutationRecorder } from "../../src/daemon/sessionBroker/mutations/recorder";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceMutationJournal } from "../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

const ANDROID: BootedDevice = { deviceId: "phone", platform: "android", name: "Phone" };
const IOS: BootedDevice = { deviceId: "sim", platform: "ios", name: "Sim" };
const SCREEN_STATE = { kind: "device-setting", key: "screen-state" };
const VOLUME = { kind: "opaque", key: "tool:pressButton:volume" };

/** Every tool the Interaction family owns whose calls never change persistent device state. */
const PURE_INPUT_TOOLS = [
  "accessibilityFocus",
  "dragAndDrop",
  "dragPath",
  "highlight",
  "homeScreen",
  "multiTouch",
  "pinchOn",
  "recentApps",
  "selectAllText",
  "shake",
  "swipeAt",
  "swipeOn",
  "systemTray",
  "tapAny",
  "tapAt",
  "tapOn",
  "wakeAndUnlock",
];

describe("Interaction journal intents (#14359)", () => {
  test.each(PURE_INPUT_TOOLS)("%s is an owned tool that records nothing", (tool) => {
    expect(interactionToolMutations(tool, {}, "android")).toEqual([]);
    expect(interactionToolMutations(tool, {}, "ios")).toEqual([]);
    expect(deviceToolMutations(tool, {}, "android")).toEqual([]);
  });

  test("tools of other families are not claimed", () => {
    expect(interactionToolMutations("displayConfig", {}, "android")).toBeUndefined();
  });

  const pressRows: [string, "android" | "ios", { kind: string; key: string }[]][] = [
    ["power", "android", [SCREEN_STATE]],
    ["lock", "android", [SCREEN_STATE]],
    ["volume_up", "android", [VOLUME]],
    ["volume_down", "android", [VOLUME]],
    ["volume_up", "ios", [VOLUME]],
    ["volume_down", "ios", [VOLUME]],
    ["power", "ios", [{ kind: "opaque", key: "tool:pressButton:power" }]],
    ["action", "ios", [{ kind: "opaque", key: "tool:pressButton:action" }]],
  ];
  test.each(pressRows)(
    "pressButton %s on %s records its persistent effect",
    (button, platform, rows) => {
      expect(deviceToolMutations("pressButton", { button }, platform)).toEqual(rows);
    },
  );

  test("pressButton classifies every button the schema accepts", () => {
    const transient = [
      "home",
      "back",
      "menu",
      "recent",
      "camera",
      "power_dialog",
      "quick_settings",
      "screenshot",
      "split_screen",
      "dismiss_notification_shade",
    ];
    const persistent = ["power", "lock", "volume_up", "volume_down", "action"];
    const buttons = pressButtonInput.shape.button.options;
    expect([...transient, ...persistent].sort()).toEqual([...buttons].sort());
    for (const button of transient) {
      expect(deviceToolMutations("pressButton", { button }, "android")).toEqual([]);
      expect(deviceToolMutations("pressButton", { button }, "ios")).toEqual([]);
    }
    for (const button of persistent) {
      const recorded = (["android", "ios"] as const).flatMap((platform) =>
        deviceToolMutations("pressButton", { button }, platform),
      );
      expect(recorded).not.toEqual([]);
    }
  });

  test("pressButton reads the button case-insensitively and tolerates a missing one", () => {
    expect(deviceToolMutations("pressButton", { button: "POWER" }, "android")).toEqual([
      SCREEN_STATE,
    ]);
    expect(deviceToolMutations("pressButton", {}, "android")).toEqual([]);
  });

  test("sendKeys records the keyboard profile row only when a type command switches it", () => {
    const type = { action: "type", text: "hello", mode: "ime" };
    expect(deviceToolMutations("sendKeys", { commands: [type] }, "android")).toEqual([]);
    expect(
      deviceToolMutations(
        "sendKeys",
        {
          commands: [
            { action: "key", key: "enter" },
            { ...type, keyboardProfile: "gboard" },
            { ...type, keyboardProfile: "samsung" },
          ],
        },
        "android",
      ),
    ).toEqual([{ kind: "keyboard", key: "profile" }]);
    expect(
      deviceToolMutations(
        "sendKeys",
        { commands: [{ ...type, keyboardProfile: "gboard" }] },
        "ios",
      ),
    ).toEqual([]);
    expect(deviceToolMutations("sendKeys", {}, "android")).toEqual([]);
  });
});

describe("InteractionMutationPriorReader screen state", () => {
  let adb: FakeAdbExecutor;
  let reader: InteractionMutationPriorReader;
  let warn: ReturnType<typeof spyOn>;
  const unlocked: DeviceLockState = { locked: false, keyguardShowing: false, secure: false };

  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    adb = new FakeAdbExecutor();
    reader = new InteractionMutationPriorReader(() => adb);
  });
  afterEach(() => warn.mockRestore());

  test("captures wakefulness and keyguard before the press", async () => {
    adb.setScreenState(true);
    adb.setDeviceLock(unlocked);
    expect(await reader.read(ANDROID, [SCREEN_STATE])).toEqual([
      { state: "present", value: { awake: true, keyguardShowing: false, secure: false } },
    ]);
  });

  test("records a sleeping, locked, secure device as such", async () => {
    adb.setScreenState(false, "Dozing");
    adb.setDeviceLock({ locked: true, keyguardShowing: true, secure: true });
    expect(await reader.read(ANDROID, [SCREEN_STATE])).toEqual([
      { state: "present", value: { awake: false, keyguardShowing: true, secure: true } },
    ]);
  });

  test("an unknown credential state is recorded as null, never guessed", async () => {
    adb.setScreenState(true);
    adb.setDeviceLock({ locked: false, keyguardShowing: false });
    expect(await reader.read(ANDROID, [SCREEN_STATE])).toEqual([
      { state: "present", value: { awake: true, keyguardShowing: false, secure: null } },
    ]);
  });

  test("an unreadable half is unobservable", async () => {
    adb.setScreenState(true);
    adb.setDeviceLock(null);
    expect(await reader.read(ANDROID, [SCREEN_STATE])).toEqual([{ state: "unobservable" }]);
    adb.setDeviceLock(unlocked);
    adb.setWakefulnessUnknown();
    expect(await reader.read(ANDROID, [SCREEN_STATE])).toEqual([{ state: "unobservable" }]);
  });

  test("a failed read warns and is unobservable", async () => {
    const failing = {
      getWakefulness: () => Promise.reject(new Error("adb offline")),
      getDeviceLock: () => Promise.resolve(unlocked),
    };
    const failed = new InteractionMutationPriorReader(() => failing);
    expect(await failed.read(ANDROID, [SCREEN_STATE])).toEqual([{ state: "unobservable" }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("other intents and other platforms stay unobservable and read nothing", async () => {
    let created = 0;
    const counting = new InteractionMutationPriorReader(() => {
      created++;
      return adb;
    });
    expect(await counting.read(ANDROID, [VOLUME, { kind: "keyboard", key: "profile" }])).toEqual([
      { state: "unobservable" },
      { state: "unobservable" },
    ]);
    expect(await counting.read(IOS, [SCREEN_STATE])).toEqual([{ state: "unobservable" }]);
    expect(created).toBe(0);
  });
});

describe("Interaction rows are recorded before the tool acts", () => {
  const scope = { sessionUuid: "session", deviceId: "phone", incarnation: "boot-1" };

  test("a power press journals the screen state the device had, a volume press an opaque row", async () => {
    const adb = new FakeAdbExecutor();
    adb.setScreenState(true);
    adb.setDeviceLock({ locked: false, keyguardShowing: false, secure: false });
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    const family = new FamilyMutationPriorReader([new InteractionMutationPriorReader(() => adb)]);
    const recording = new SessionDeviceMutationRecording(
      () => new SessionMutationRecorder(journal, scope),
      new DefaultMutationPriorReader(undefined, undefined, undefined, undefined, undefined, {
        dataReader: family,
      }),
      { appId: async () => undefined },
    );
    await recording.beforeToolCall("pressButton", { button: "power" }, ANDROID, "session");
    await recording.beforeToolCall("pressButton", { button: "volume_up" }, ANDROID, "session");
    await recording.beforeToolCall("pressButton", { button: "back" }, ANDROID, "session");
    expect(await journal.list(scope)).toMatchObject([
      {
        kind: "device-setting",
        key: "screen-state",
        priorValue: {
          state: "present",
          value: { awake: true, keyguardShowing: false, secure: false },
        },
        toolName: "pressButton",
      },
      {
        kind: "opaque",
        key: "tool:pressButton:volume",
        priorValue: { state: "unobservable" },
        toolName: "pressButton",
      },
    ]);
  });
});
