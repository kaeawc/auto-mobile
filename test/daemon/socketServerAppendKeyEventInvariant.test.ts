import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { harness, frame } from "../helpers/socketServerInputHoldHarness";
import { screenshotPathProtection } from "../../src/features/observe/ScreenshotPathProtection";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { buildAsciiKeyEventPlan } from "../../src/utils/android-cmdline-tools/asciiKeyEvents";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

beforeEach(() => {
  spyOn(screenshotPathProtection, "start").mockImplementation(() => {});
  spyOn(screenshotPathProtection, "sweepOnce").mockResolvedValue(undefined);
});
afterEach(() => {
  mock.restore();
  AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
});

const PRINTABLE_ASCII = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index));
const isKeyEventCommand = (command: string) =>
  command.startsWith("shell input keyevent ") || command.startsWith("shell input keycombination ");

/**
 * The daemon's socket input hold (`createSocketInputAdbFactory`) recognises a dispatch by
 * `args[0] === "shell" && args[1] === "input"`. Text typed through `executeAndroidInputText` is sent
 * as `["shell", "echo $$; exec [cmd ]input text ..."]`, which that check would let through unheld
 * and unfenced. That is safe only while append never plans `input text` commands, so a switch to
 * text chunks must fail here and extend the wrapper in the same change.
 */
test.each([true, false])(
  "every append key-event plan is a keyevent command (key combination support: %s)",
  (supportsKeyCombination) => {
    for (const char of PRINTABLE_ASCII) {
      const plan = buildAsciiKeyEventPlan(char, supportsKeyCombination);
      if (plan) {
        expect(plan.commands.every(isKeyEventCommand)).toBe(true);
      }
    }
  },
);

test("a socket append dispatches only `shell input keyevent` commands to adb", async () => {
  const { handler } = harness();
  const client = Object.create(AndroidCtrlProxyClient.prototype) as AndroidCtrlProxyClient;
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  const adb = new FakeAdbExecutor();
  spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
  const dispatched: string[][] = [];
  spyOn(adb, "execute").mockImplementation(async (args, options) => {
    await options?.beforeDispatch?.(options.timeoutMs);
    dispatched.push([...args]);
    return { stdout: "", stderr: "" };
  });
  const request = frame("android", "A", true);
  request.params = { ...request.params, text: "ab 1.," };

  await handler.handleInputTypeText(request);

  const typing = dispatched.filter((args) => args[0] === "shell" && args[1] === "input");
  expect(typing.length).toBeGreaterThan(0);
  // Nothing may reach adb as a tracked-guest script the hold would not recognise.
  expect(dispatched.filter((args) => args.some((part) => part.startsWith("echo $$")))).toEqual([]);
  expect(typing.every((args) => isKeyEventCommand(args.join(" ")))).toBe(true);
});
