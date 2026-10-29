import { readFileSync } from "node:fs";
import { ROTARY_BUTTONS } from "../../src/features/action/RotaryInput";
import {
  opaqueIntentKey,
  opaqueForcesFallback,
} from "../../src/daemon/sessionBroker/mutations/types";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import type { DeviceLockState } from "../../src/models";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import { DEVICE_MUTATION_TOOL_COVERAGE } from "../../src/daemon/sessionBroker/mutations/toolCoverage";
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
import { createExecResult } from "../../src/utils/execResult";

const ANDROID: BootedDevice = { deviceId: "phone", platform: "android", name: "Phone" };
const IOS: BootedDevice = { deviceId: "sim", platform: "ios", name: "Sim" };
const SCREEN_STATE = { kind: "device-setting", key: "screen-state" };
const VOLUME = { kind: "opaque", key: opaqueIntentKey("pressButton", "volume") };
const VOLUME_KEY_PRESS = { kind: "device-setting", key: "volume:key-press" };
const KEY_PRESS_STREAMS: [string, number, number][] = [
  ["bluetooth_sco", 6, 3],
  ["notification", 5, 0],
  ["system", 1, 0],
  ["assistant", 11, 11],
  ["tts", 9, 11],
  ["accessibility", 10, 11],
  ["voice_call", 0, 3],
  ["ring", 2, 0],
  ["alarm", 4, 5],
  ["music", 3, 11],
];

// Read-only API 37 captures; see test/fixtures/android-volume/README.md.
const VOLUME_OUTPUTS = new Map(
  KEY_PRESS_STREAMS.map(([, code]) => [
    code,
    readFileSync(
      new URL(`../fixtures/android-volume/api37-stream-${code}.stdout.txt`, import.meta.url),
      "utf8",
    ),
  ]),
);

/** The journal reader labels each raw per-stream capture in its single shell response. */
function volumeReadOutput(streams: readonly [string, number, number][]): string {
  return streams.map(([name, code]) => `${name}\n${VOLUME_OUTPUTS.get(code)}`).join("\n");
}

/** Every tool the coverage table says changes no persistent device state. */
const NOT_JOURNALED_TOOLS = Object.entries(DEVICE_MUTATION_TOOL_COVERAGE)
  .filter(([, coverage]) => coverage.status === "notJournaled")
  .map(([tool]) => tool);

describe("Interaction journal intents (#14359)", () => {
  test("pure input tools are covered as notJournaled", () => {
    expect(NOT_JOURNALED_TOOLS).toEqual(
      expect.arrayContaining(["tapOn", "swipeOn", "dragAndDrop", "systemTray", "wakeAndUnlock"]),
    );
  });

  test.each(NOT_JOURNALED_TOOLS)("%s records nothing on either platform", (tool) => {
    expect(deviceToolMutations(tool, {}, "android")).toEqual([]);
    expect(deviceToolMutations(tool, {}, "ios")).toEqual([]);
  });

  test("tools of other families are not claimed", () => {
    expect(interactionToolMutations("displayConfig", {}, "android")).toBeUndefined();
  });

  const pressRows: [string, "android" | "ios", { kind: string; key: string }[]][] = [
    ["power", "android", [SCREEN_STATE]],
    ["lock", "android", [SCREEN_STATE]],
    ["volume_up", "android", [VOLUME_KEY_PRESS]],
    ["volume_down", "android", [VOLUME_KEY_PRESS]],
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

  test("mediaSession volume journals its Android stream; dispatch keeps a breadcrumb", () => {
    for (const stream of ["music", "ring", "alarm"]) {
      expect(
        deviceToolMutations(
          "mediaSession",
          { action: { volume: { stream, level: 3 } } },
          "android",
        ),
      ).toEqual([{ kind: "device-setting", key: `volume:${stream}` }]);
    }
    const fallback = [{ kind: "opaque", key: opaqueIntentKey("mediaSession", "volume") }];
    expect(
      deviceToolMutations("mediaSession", { action: { volume: { stream: "music" } } }, "ios"),
    ).toEqual(fallback);
    expect(
      deviceToolMutations("mediaSession", { action: { volume: { stream: "dtmf" } } }, "android"),
    ).toEqual(fallback);
    expect(fallback.every((row) => opaqueForcesFallback(row))).toBe(true);
    const dispatch = deviceToolMutations(
      "mediaSession",
      { action: { dispatch: "play" } },
      "android",
    );
    expect(dispatch).toEqual([{ kind: "opaque", key: "tool:mediaSession:dispatch" }]);
    expect(dispatch.some((row) => opaqueForcesFallback(row))).toBe(false);
    expect(deviceToolMutations("mediaSession", { action: "get" }, "android")).toEqual([]);
  });

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
      // Rotary input moves focus only (#14920).
      ...ROTARY_BUTTONS,
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
      executeCommand: () => Promise.reject(new Error("not read")),
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

describe("InteractionMutationPriorReader volume levels", () => {
  let adb: FakeAdbExecutor;
  let reader: InteractionMutationPriorReader;
  let warn: ReturnType<typeof spyOn>;
  const MUSIC = { kind: "device-setting", key: "volume:music" };

  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    adb = new FakeAdbExecutor();
    reader = new InteractionMutationPriorReader(() => adb);
  });
  afterEach(() => warn.mockRestore());

  test("a key press reads every stream a volume key can change in one device shell", async () => {
    adb.setCommandResponse(
      "volume --stream",
      createExecResult(volumeReadOutput(KEY_PRESS_STREAMS), ""),
    );
    expect(await reader.read(ANDROID, [VOLUME_KEY_PRESS])).toEqual([
      {
        state: "present",
        value: Object.fromEntries(KEY_PRESS_STREAMS.map(([name, , level]) => [name, level])),
      },
    ]);
    const commands = adb.getExecutedCommands();
    expect(commands).toHaveLength(1);
    for (const [name, code] of KEY_PRESS_STREAMS) {
      expect(commands[0]).toContain(
        `echo ${name}; cmd media_session volume --stream ${code} --get`,
      );
    }
  });

  test("a mediaSession row reads its one stream", async () => {
    adb.setCommandResponse(
      "volume --stream 3",
      createExecResult(volumeReadOutput([["music", 3, 11]]), ""),
    );
    expect(await reader.read(ANDROID, [MUSIC])).toEqual([{ state: "present", value: 11 }]);
  });

  test.each([
    ["one stream is missing", volumeReadOutput(KEY_PRESS_STREAMS.slice(1))],
    ["the media shell is unavailable", "No shell command implementation."],
    ["the output is empty", ""],
  ])("is unobservable when %s", async (_label, stdout) => {
    adb.setCommandResponse("volume --stream", createExecResult(stdout, ""));
    expect(await reader.read(ANDROID, [VOLUME_KEY_PRESS])).toEqual([{ state: "unobservable" }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a failed read warns and is unobservable", async () => {
    adb.setCommandError("volume --stream", new Error("adb offline"));
    expect(await reader.read(ANDROID, [MUSIC])).toEqual([{ state: "unobservable" }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("iOS reads nothing", async () => {
    expect(await reader.read(IOS, [MUSIC])).toEqual([{ state: "unobservable" }]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});

describe("Interaction rows are recorded before the tool acts", () => {
  const scope = { sessionUuid: "session", deviceId: "phone", incarnation: "boot-1" };

  test("a power press journals the screen state the device had, a volume press its stream levels", async () => {
    const adb = new FakeAdbExecutor();
    adb.setScreenState(true);
    adb.setDeviceLock({ locked: false, keyguardShowing: false, secure: false });
    adb.setCommandResponse(
      "volume --stream",
      createExecResult(volumeReadOutput(KEY_PRESS_STREAMS), ""),
    );
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
    // The first press's levels win: a second press neither re-reads nor re-journals them.
    await recording.beforeToolCall("pressButton", { button: "volume_down" }, ANDROID, "session");
    await recording.beforeToolCall("pressButton", { button: "back" }, ANDROID, "session");
    expect(
      adb.getExecutedCommands().filter((command) => command.includes("volume --stream")),
    ).toHaveLength(1);
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
        kind: "device-setting",
        key: "volume:key-press",
        priorValue: {
          state: "present",
          value: Object.fromEntries(KEY_PRESS_STREAMS.map(([name, , level]) => [name, level])),
        },
        toolName: "pressButton",
      },
    ]);
    expect(await journal.list(scope)).toHaveLength(2);
  });
});

test("iOS volume presses force fallback; Android presses do not", () => {
  for (const button of ["volume_up", "volume_down"]) {
    expect(deviceToolMutations("pressButton", { button }, "ios").every(opaqueForcesFallback)).toBe(
      true,
    );
    expect(
      deviceToolMutations("pressButton", { button }, "android").some(opaqueForcesFallback),
    ).toBe(false);
  }
});
