import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { settleByFakeEvents } from "../../helpers/fakeTimerStepping";
import { FakeTimer } from "../../fakes/FakeTimer";
import { AdbAndroidFoldPostureRestore } from "../../../src/daemon/sessionBroker/androidFoldPostureRestore";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { ANDROID_RESET_DEVICE } from "./fixtures/androidReset";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");
const FOLD_STATES = fixture("foldpf-print-states.txt");
const OPENED_STATE = fixture("foldpf-1-default-state.txt");
const CLOSED_STATE = fixture("foldpf-5-after-reset-state.txt");

function foldAdb(committedState: string): FakeAdbClient {
  const adb = new FakeAdbClient();
  adb.setCommandResult("emu unfold", "OK");
  adb.setCommandResult("emu sensor set hinge-angle0 180", "OK");
  adb.setCommandResult("emu sensor get hinge-angle0", "hinge-angle0 = 180\nOK");
  adb.setCommandResult("shell cmd device_state print-states", FOLD_STATES);
  adb.setCommandResult("shell cmd device_state state", committedState);
  return adb;
}

test("real posture adapter restores opened and verifies 180 using existing commands", async () => {
  const adb = foldAdb(OPENED_STATE);
  await new AdbAndroidFoldPostureRestore(new FakeAdbClientFactory(adb)).restore(
    ANDROID_RESET_DEVICE,
    new AbortController().signal,
  );
  expect(adb.getCommandCalls().map((call) => call.command)).toEqual([
    "shell cmd device_state state reset",
    "emu unfold",
    "emu sensor set hinge-angle0 180",
    "emu sensor get hinge-angle0",
    "shell cmd device_state print-states",
    "shell cmd device_state state",
  ]);
});

test("adapter fails when the committed device state is still not opened", async () => {
  const timer = new FakeTimer();
  const restore = new AdbAndroidFoldPostureRestore(
    new FakeAdbClientFactory(foldAdb(CLOSED_STATE)),
    undefined,
    timer,
  );
  const pending = restore.restore(ANDROID_RESET_DEVICE, new AbortController().signal);
  await expect(settleByFakeEvents(timer, pending, { description: "fold restore" })).rejects.toThrow(
    "did not change to 'opened'",
  );
});
test("adapter refuses unsupported hinge and already aborted work with device context", async () => {
  const adb = new FakeAdbClient();
  adb.setCommandResult("emu sensor set hinge-angle0 180", "KO: unsupported");
  const restore = new AdbAndroidFoldPostureRestore(new FakeAdbClientFactory(adb));
  await expect(restore.restore(ANDROID_RESET_DEVICE, new AbortController().signal)).rejects.toThrow(
    "emulator-5554",
  );
  const count = adb.getCommandCalls().length;
  await expect(restore.restore(ANDROID_RESET_DEVICE, AbortSignal.abort())).rejects.toThrow(
    "opened",
  );
  expect(adb.getCommandCalls()).toHaveLength(count);
});
