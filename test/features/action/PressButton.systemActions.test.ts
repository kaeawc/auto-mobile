import { describe, expect, test } from "bun:test";
import { PressButton } from "../../../src/features/action/PressButton";
import {
  ANDROID_SYSTEM_ACTIONS,
  androidSystemActionRefusal,
  resolveAndroidSystemAction,
} from "../../../src/features/action/androidSystemActions";
import { ANDROID_CAPABILITY_FLAGS } from "../../../src/features/observe/android/ctrlProxyProtocol/capabilities";
import { pressButtonInput } from "../../../src/server/interactionTools/deviceSchemas";
import type { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const SYSTEM_BUTTONS = [
  ["lock", "lock_screen", "global_action_lock_screen_v1", 28],
  ["power_dialog", "power_dialog", "global_action_power_dialog_v1", 21],
  ["quick_settings", "quick_settings", "global_action_quick_settings_v1", 21],
  ["screenshot", "screenshot", "global_action_screenshot_v1", 28],
  ["split_screen", "split_screen", "global_action_split_screen_v1", 24],
  [
    "dismiss_notification_shade",
    "dismiss_notification_shade",
    "global_action_dismiss_notification_shade_v1",
    31,
  ],
] as const;

type SystemClient = Pick<AndroidCtrlProxyClient, "requestGlobalAction" | "supportsCommand">;
type GlobalActionResult = Awaited<ReturnType<SystemClient["requestGlobalAction"]>>;

const androidDevice: BootedDevice = {
  deviceId: "android-device",
  platform: "android",
  name: "Pixel",
};
const iosDevice: BootedDevice = { deviceId: "ios-device", platform: "ios", name: "iPhone" };

class FakeSystemClient implements SystemClient {
  readonly sentActions: string[] = [];
  readonly capabilityChecks: string[] = [];

  constructor(
    private readonly advertised: ReadonlySet<string>,
    private readonly reply: (action: string) => GlobalActionResult = (action) => ({
      success: true,
      action,
      totalTimeMs: 1,
      acknowledged: true,
    }),
  ) {}

  async supportsCommand(name: string): Promise<boolean> {
    this.capabilityChecks.push(name);
    return this.advertised.has(name);
  }

  async requestGlobalAction(
    ...args: Parameters<SystemClient["requestGlobalAction"]>
  ): Promise<GlobalActionResult> {
    this.sentActions.push(args[0]);
    args[3]?.onDispatch?.();
    return this.reply(args[0]);
  }
}

function pressButton(device: BootedDevice, client: SystemClient, adb = new FakeAdbExecutor()) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const press = new PressButton(device, adb, timer, { systemActionClient: client });
  return { press, adb };
}

describe("PressButton Android system actions (#14095)", () => {
  test.each(SYSTEM_BUTTONS)(
    "%s sends %s when %s is advertised and never touches ADB",
    async (button, wire, capability) => {
      const client = new FakeSystemClient(new Set([capability]));
      const { press, adb } = pressButton(androidDevice, client);
      const result = await press.press(button);
      expect(result.success).toBe(true);
      expect(result.keyCode).toBe(-1);
      expect(client.capabilityChecks).toEqual([capability]);
      expect(client.sentActions).toEqual([wire]);
      expect(adb.getExecutedArgv()).toEqual([]);
    },
  );

  test.each(SYSTEM_BUTTONS)(
    "%s is refused with a typed error and nothing is sent when %s is not advertised",
    async (button, _wire, capability, minApi) => {
      const client = new FakeSystemClient(new Set());
      const { press, adb } = pressButton(androidDevice, client);
      const result = await press.press(button);
      expect(result.success).toBe(false);
      expect(result.code).toBe("unsupported_system_action");
      expect(result.retryable).toBe(false);
      expect(result.error).toContain(capability);
      expect(result.error).toContain(`API ${minApi}+`);
      expect(client.sentActions).toEqual([]);
      expect(adb.getExecutedArgv()).toEqual([]);
    },
  );

  test("an old APK that advertises other flags only is refused for every system action", async () => {
    const client = new FakeSystemClient(
      new Set(["semantic_node_actions_v1", "full_command_set_v1"]),
    );
    const { press } = pressButton(androidDevice, client);
    for (const [button] of SYSTEM_BUTTONS) {
      expect((await press.press(button)).code).toBe("unsupported_system_action");
    }
  });

  test("forwards the frame context into the system-action request", async () => {
    const frameContexts: Array<string | undefined> = [];
    class FrameRecordingClient extends FakeSystemClient {
      override async requestGlobalAction(
        ...args: Parameters<SystemClient["requestGlobalAction"]>
      ): Promise<GlobalActionResult> {
        frameContexts.push(args[3]?.frameContext);
        return super.requestGlobalAction(...args);
      }
    }
    const client = new FrameRecordingClient(new Set(["global_action_lock_screen_v1"]));
    const { press } = pressButton(androidDevice, client);
    await press.press("lock", { frameContext: "frame-3" });
    expect(frameContexts).toEqual(["frame-3"]);
  });

  test("button matching is case-insensitive", async () => {
    const client = new FakeSystemClient(new Set(["global_action_lock_screen_v1"]));
    const { press } = pressButton(androidDevice, client);
    expect((await press.press("LOCK")).success).toBe(true);
    expect(client.sentActions).toEqual(["lock_screen"]);
  });

  test("lock, power_dialog and quick_settings return a note about what stays changed", async () => {
    const all = new Set(SYSTEM_BUTTONS.map(([, , capability]) => capability));
    const client = new FakeSystemClient(all);
    const { press } = pressButton(androidDevice, client);
    expect((await press.press("lock")).warnings?.[0]).toContain("wakeAndUnlock");
    expect((await press.press("power_dialog")).warnings?.[0]).toContain("back or home");
    expect((await press.press("quick_settings")).warnings?.[0]).toContain(
      "dismiss_notification_shade",
    );
    expect((await press.press("split_screen")).warnings?.[0]).toContain("windowMode");
    expect((await press.press("screenshot")).warnings).toBeUndefined();
  });

  test("a device-side refusal is a typed failure, not a retryable press", async () => {
    const client = new FakeSystemClient(new Set(["global_action_screenshot_v1"]), (action) => ({
      success: false,
      action,
      totalTimeMs: 1,
      acknowledged: true,
      error: "Global action failed: screenshot",
    }));
    const { press } = pressButton(androidDevice, client);
    const result = await press.press("screenshot");
    expect(result.success).toBe(false);
    expect(result.code).toBe("system_action_failed");
    expect(result.retryable).toBe(false);
    expect(result.error).toContain("Global action failed: screenshot");
  });

  test("a dispatched but unacknowledged press is reported as indeterminate", async () => {
    const client = new FakeSystemClient(new Set(["global_action_lock_screen_v1"]), (action) => ({
      success: false,
      action,
      totalTimeMs: 1,
      acknowledged: false,
      error: "Global action timeout after 3000ms",
    }));
    const { press } = pressButton(androidDevice, client);
    const result = await press.press("lock");
    expect(result.success).toBe(false);
    expect(result.code).toBe("indeterminate_outcome");
    expect(result.error).toContain("indeterminate");
    expect(result.error).toContain("Do not retry automatically");
  });

  test("iOS refuses Android system actions as unsupported_button", async () => {
    const client = new FakeSystemClient(
      new Set(SYSTEM_BUTTONS.map(([, , capability]) => capability)),
    );
    const { press } = pressButton(iosDevice, client);
    const result = await press.press("lock");
    expect(result.success).toBe(false);
    expect(result.code).toBe("unsupported_button");
    expect(result.error).toContain("Android-only");
    expect(client.sentActions).toEqual([]);
  });
});

describe("Android system action table (#14095)", () => {
  test("every system action capability is a gated handshake flag", () => {
    for (const action of Object.values(ANDROID_SYSTEM_ACTIONS)) {
      expect((ANDROID_CAPABILITY_FLAGS as readonly string[]).includes(action.capability)).toBe(
        true,
      );
    }
  });

  test("prototype-named buttons do not resolve", () => {
    expect(resolveAndroidSystemAction("constructor")).toBeUndefined();
    expect(resolveAndroidSystemAction("__proto__")).toBeUndefined();
    expect(resolveAndroidSystemAction("home")).toBeUndefined();
  });

  test("the refusal names the API level and the capability", () => {
    const action = ANDROID_SYSTEM_ACTIONS.dismiss_notification_shade;
    expect(androidSystemActionRefusal("dismiss_notification_shade", action)).toContain("API 31+");
  });

  test("pressButton schema accepts the system actions and still rejects unknown buttons", () => {
    for (const [button] of SYSTEM_BUTTONS) {
      expect(pressButtonInput.safeParse({ button }).success).toBe(true);
    }
    expect(pressButtonInput.safeParse({ button: "reboot" }).success).toBe(false);
  });
});
