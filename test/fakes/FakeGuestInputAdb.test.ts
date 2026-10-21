import { expect, test } from "bun:test";
import { FakeGuestInputAdb } from "./FakeGuestInputAdb";
import { FakeTimer } from "./FakeTimer";

test.each([30, 34])(
  "API %s models whether typing survives client termination",
  async (apiLevel) => {
    const adb = new FakeGuestInputAdb();
    const timer = new FakeTimer();
    adb.setAndroidApiLevel(apiLevel);
    adb.setTypingDuration(timer, 150);
    // Intercepted fake argv only: no guest or host process is started or killed.
    await adb.execute(["shell", "if [ -r /proc/4242/cmdline ]; then kill 4242; fi"]);
    expect(adb.isTyping()).toBe(apiLevel >= 31);
    timer.advanceTime(149);
    expect(adb.isTyping()).toBe(apiLevel >= 31);
    timer.advanceTime(1);
    expect(adb.isTyping()).toBe(false);
  },
);
