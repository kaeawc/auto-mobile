import { describe, expect, test } from "bun:test";
import { DefaultAccessibilityDetector } from "../../../src/features/accessibility/AccessibilityDetector";
import { TalkBackToggle } from "../../../src/features/accessibility/TalkBackToggle";
import { AndroidTapStrategy } from "../../../src/features/action/strategies/AndroidTapStrategy";
import type { ScreenReaderRestoreState } from "../../../src/features/accessibility/ScreenReaderRestore";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeSecureSettingsRpc } from "../../fakes/FakeSecureSettingsRpc";
import { FakeTalkBackDialogProbe } from "../../fakes/FakeTalkBackDialogProbe";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const TALKBACK =
  "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService";
const CTRL_PROXY = "dev.jasonpearson.automobile.ctrlproxy/.CtrlProxy";

/**
 * The `accessibility` tool reports `enabled = toggle.currentState`; `tapOn` decides its screen-reader
 * path from `AndroidTapStrategy.isAccessibilityServiceEnabled`. Both read the same device setting
 * through the same detector, so after a toggle that changes nothing they must not disagree (#10146,
 * #10147): a disagreement would tap with semantic actions on a device the tool just called off, or
 * the reverse.
 */
function harness(enabledServices: string) {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("enabled_accessibility_services", { stdout: enabledServices, stderr: "" });
  adb.setCommandResponse("pm list packages", {
    stdout: "package:com.google.android.marvin.talkback\n",
    stderr: "",
  });
  const timer = new FakeTimer();
  const detector = new DefaultAccessibilityDetector(timer);
  const probe = new FakeTalkBackDialogProbe();
  const toggle = new TalkBackToggle(
    device,
    adb,
    detector,
    timer,
    new FakeSecureSettingsRpc(),
    probe,
  );
  const strategy = new AndroidTapStrategy(device, adb, detector);
  return { adb, probe, toggle, strategy };
}

describe("a no-op TalkBack toggle and the tapOn screen-reader path", () => {
  test.each([
    ["TalkBack on, asked on", TALKBACK, true],
    ["TalkBack and CtrlProxy on, asked on", `${TALKBACK}:${CTRL_PROXY}`, true],
    ["nothing on, asked off", "null", false],
    ["only CtrlProxy on, asked off", CTRL_PROXY, false],
    ["another service on, asked off", "com.example.other/.Service", false],
  ])("%s: both report the state the device is in", async (_name, services, requested) => {
    const h = harness(services);
    const recorded: ScreenReaderRestoreState[] = [];

    const result = await h.toggle.toggle(requested, {
      beforeChange: (previousEnabled) => {
        recorded.push({ platform: "android", previousEnabled });
      },
    });

    expect(result).toEqual({ supported: true, applied: false, currentState: requested });
    const tapPathUsesScreenReader = await h.strategy.isAccessibilityServiceEnabled();
    expect(tapPathUsesScreenReader).toBe(result.currentState === true);
    // Nothing changed, so there is nothing to restore and no consent dialog to look for.
    expect(recorded).toEqual([]);
    expect(h.probe.probeCount).toBe(0);
    expect(h.adb.getExecutedCommands().some((command) => command.includes("uiautomator"))).toBe(
      false,
    );
  });

  test("an unreadable setting is a typed failure for the tool and an off screen-reader path for tapOn", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("enabled_accessibility_services", new Error("device offline"));
    const timer = new FakeTimer();
    const detector = new DefaultAccessibilityDetector(timer);
    const toggle = new TalkBackToggle(
      device,
      adb,
      detector,
      timer,
      new FakeSecureSettingsRpc(),
      new FakeTalkBackDialogProbe(),
    );
    const strategy = new AndroidTapStrategy(device, adb, detector);

    const result = await toggle.toggle(false);

    // The tool refuses to claim a state (currentState undefined throws in accessibilityTools) and
    // tapOn does not take the screen-reader path on an unknown state either.
    expect(result.currentState).toBeUndefined();
    expect(await strategy.isAccessibilityServiceEnabled()).toBe(false);
  });
});
