import { beforeEach, describe, expect, test } from "bun:test";
import { AndroidDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/androidDeviceMutationResetPort";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type {
  DeviceMutationInput,
  MutationValue,
} from "../../../src/daemon/sessionBroker/mutations/types";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const screen = (
  prior: { awake: boolean; keyguardShowing: boolean; secure: boolean | null } | MutationValue,
): DeviceMutationInput => ({
  kind: "device-setting",
  key: "screen-state",
  priorValue: "state" in prior ? prior : { state: "present", value: prior },
  toolName: "pressButton",
});

describe("AndroidDeviceMutationResetPort screen state (#14359)", () => {
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

  test("wakes the screen and dismisses the keyguard when it was awake with no credential", async () => {
    const mutation = screen({ awake: true, keyguardShowing: false, secure: false });
    expect(port.canRevert(mutation)).toBe(true);
    await port.revert(mutation, context);
    expect(adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_WAKEUP",
      "shell wm dismiss-keyguard",
    ]);
  });

  test.each([
    ["asleep", { awake: false, keyguardShowing: false, secure: false }],
    ["keyguard showing", { awake: true, keyguardShowing: true, secure: false }],
    ["secure", { awake: true, keyguardShowing: false, secure: true }],
    ["credential unknown", { awake: true, keyguardShowing: false, secure: null }],
  ])("cannot restore a prior that was %s", async (_label, prior) => {
    const mutation = screen(prior);
    expect(port.canRevert(mutation)).toBe(false);
    await expect(port.revert(mutation, context)).rejects.toThrow(
      "Android cannot restore device-setting:screen-state",
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test.each([
    ["unobservable", { state: "unobservable" } as const],
    ["absent", { state: "absent" } as const],
    ["malformed", { state: "present", value: { awake: "yes" } } as const],
  ])("cannot restore an %s prior", (_label, prior) => {
    expect(port.canRevert(screen(prior))).toBe(false);
  });
});
