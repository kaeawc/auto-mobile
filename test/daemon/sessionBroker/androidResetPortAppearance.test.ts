import { describe, expect, test } from "bun:test";
import { AndroidDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/androidDeviceMutationResetPort";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type { MutationValue } from "../../../src/daemon/sessionBroker/mutations/types";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const statusBar = (priorValue: MutationValue, key = "device") => ({
  kind: "status-bar",
  key,
  priorValue,
  toolName: "statusBar",
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

describe("AndroidDeviceMutationResetPort status bar (#14359)", () => {
  test("exits demo mode and deletes the setting that was unset before", async () => {
    const { adb, port, context } = rig();
    const mutation = statusBar({ state: "absent" });
    expect(port.canRevert(mutation)).toBe(true);
    await port.revert(mutation, context);
    expect(adb.getExecutedCommands()).toEqual([
      "shell am broadcast -a com.android.systemui.demo -e command exit",
      "shell settings delete global sysui_demo_allowed",
    ]);
  });

  test("exits demo mode and puts back the value the device held", async () => {
    const { adb, port, context } = rig();
    await port.revert(statusBar({ state: "present", value: "1" }), context);
    expect(adb.getExecutedCommands()).toEqual([
      "shell am broadcast -a com.android.systemui.demo -e command exit",
      "shell settings put global sysui_demo_allowed '1'",
    ]);
  });

  test.each([
    ["unobservable", statusBar({ state: "unobservable" })],
    ["non-string", statusBar({ state: "present", value: 1 })],
    ["wrong key", statusBar({ state: "absent" }, "other")],
  ])("cannot restore a %s prior", (_label, mutation) => {
    expect(rig().port.canRevert(mutation)).toBe(false);
  });
});
