import { beforeEach, describe, expect, test } from "bun:test";
import { AndroidDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/androidDeviceMutationResetPort";
import { androidBaselineCleanCovers } from "../../../src/daemon/sessionBroker/androidKeepBootedCleanup";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type {
  DeviceMutationInput,
  MutationValue,
} from "../../../src/daemon/sessionBroker/mutations/types";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const KEY_PRESS_LEVELS: Record<string, number> = {
  bluetooth_sco: 7,
  notification: 5,
  system: 7,
  assistant: 5,
  voice_call: 4,
  ring: 5,
  alarm: 6,
  music: 9,
  accessibility: 6,
};

const WITHOUT_MUSIC = Object.fromEntries(
  Object.entries(KEY_PRESS_LEVELS).filter(([stream]) => stream !== "music"),
);

const row = (key: string, prior: number | Record<string, number>): DeviceMutationInput => ({
  kind: "device-setting",
  key,
  priorValue: { state: "present", value: prior },
  toolName: "pressButton",
});

describe("AndroidDeviceMutationResetPort volume (#14364)", () => {
  let adb: FakeAdbExecutor;
  let port: AndroidDeviceMutationResetPort;
  let context: DeviceMutationResetContext;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    port = new AndroidDeviceMutationResetPort(adb);
    context = {
      scope: { deviceId: "emulator-5554", incarnation: "resource", sessionUuid: "session" },
      signal: new AbortController().signal,
      assertOwned: async () => {},
    };
  });

  test("sets a mediaSession stream back and confirms it reads its level back", async () => {
    adb.setCommandResponse("volume --stream 2", createExecResult("volume-restored\n", ""));
    const mutation = row("volume:ring", 5);
    expect(port.canRevert(mutation)).toBe(true);
    expect(androidBaselineCleanCovers(mutation)).toBe(false);
    await port.revert(mutation, context);
    expect(adb.getExecutedCommands()).toEqual([
      `shell sh -c 'cmd media_session volume --stream 2 --set 5 >/dev/null 2>&1; cmd media_session volume --stream 2 --get 2>/dev/null | grep -q "volume is 5 in range" && echo volume-restored'`,
    ]);
  });

  test("a level that does not read back fails the revert", async () => {
    adb.setCommandResponse("volume --stream 3", createExecResult("", ""));
    await expect(port.revert(row("volume:music", 4), context)).rejects.toThrow(
      "Android reset command failed to confirm success",
    );
  });

  test("a key press sets every stream, aliases before music, and only verifies accessibility", async () => {
    adb.setCommandResponse("volume --stream", createExecResult("volume-restored", ""));
    const mutation = row("volume:key-press", KEY_PRESS_LEVELS);
    expect(port.canRevert(mutation)).toBe(true);
    await port.revert(mutation, context);
    const [command] = adb.getExecutedCommands();
    const sets = [...command!.matchAll(/--stream (\d+) --set (\d+)/g)].map((m) => [m[1], m[2]]);
    expect(sets).toEqual([
      ["6", "7"],
      ["5", "5"],
      ["1", "7"],
      ["11", "5"],
      ["0", "4"],
      ["2", "5"],
      ["4", "6"],
      ["3", "9"],
    ]);
    const checks = [...command!.matchAll(/--stream (\d+) --get[^|]*\| grep -q "volume is (\d+) /g)];
    expect(checks.map((m) => [m[1], m[2]])).toEqual([...sets, ["10", "6"]]);
  });

  test.each<[string, string, MutationValue]>([
    ["unobservable", "volume:music", { state: "unobservable" }],
    ["absent", "volume:music", { state: "absent" }],
    ["zero (muted or ringer-changing)", "volume:ring", { state: "present", value: 0 }],
    ["fractional", "volume:alarm", { state: "present", value: 2.5 }],
    ["a string", "volume:music", { state: "present", value: "5" }],
    [
      "a key press with a zero stream",
      "volume:key-press",
      { state: "present", value: { ...KEY_PRESS_LEVELS, ring: 0 } },
    ],
    [
      "a key press missing a stream",
      "volume:key-press",
      { state: "present", value: WITHOUT_MUSIC },
    ],
    [
      "a key press with an extra stream",
      "volume:key-press",
      { state: "present", value: { ...KEY_PRESS_LEVELS, dtmf: 3 } },
    ],
    ["an unknown stream", "volume:dtmf", { state: "present", value: 5 }],
  ])("cannot restore a prior that is %s", async (_label, key, priorValue) => {
    const mutation = { ...row(key, 1), priorValue };
    expect(port.canRevert(mutation)).toBe(false);
    await expect(port.revert(mutation, context)).rejects.toThrow("Android cannot restore");
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});
