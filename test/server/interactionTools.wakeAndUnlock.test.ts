import { cancellationHandlers, warmedTests } from "../helpers/interactionCancellation";
import { expect, spyOn } from "bun:test";
import { INTERNAL_MCP_REQUEST_DEADLINE_PARAM } from "../../src/daemon/constants";
import { WakeAndUnlock } from "../../src/features/action/WakeAndUnlock";
import type { BootedDevice } from "../../src/models";
import {
  type InteractionToolDependencies,
  registerInteractionTools,
} from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { IosLockScreenUnlocker } from "../../src/features/action/IosLockScreenUnlocker";
import { getStructuredPayload } from "../../src/utils/toolUtils";
import { readToolResponse } from "../helpers/toolResponse";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const interactionDeps: InteractionToolDependencies = {};
const handler = cancellationHandlers(["wakeAndUnlock"], interactionDeps);
const test = warmedTests(() => {
  delete interactionDeps.wakeAndUnlockFactory;
  ToolRegistry.clearTools();
});

test("wakeAndUnlock renders the no-swipe-needed message after a post-wake unlocked read", async () => {
  const timer = new FakeTimer();
  const calls: string[] = [];
  let reads = 0;
  const device: BootedDevice = {
    deviceId: "12345678-1234-1234-1234-123456789ABC",
    platform: "ios",
    name: "Fake",
  };
  interactionDeps.wakeAndUnlockFactory = () =>
    new WakeAndUnlock(device, new FakeAdbExecutor(), {
      timer,
      iosLockStateProbe: {
        async read() {
          calls.push("read");
          const locked = ++reads === 1;
          return { kind: "known", lock: { locked, keyguardShowing: locked } };
        },
      },
      iosUnlocker: new IosLockScreenUnlocker(
        device,
        {
          async pressHome() {
            calls.push("home");
            return { success: true };
          },
          async swipeUp() {
            calls.push("swipe");
            return { success: false };
          },
        },
        timer,
      ),
    });
  const response = readToolResponse(await handler("wakeAndUnlock")(device, {}));
  expect(calls).toEqual(["read", "home", "read"]);
  expect(getStructuredPayload(response)).toMatchObject({
    success: true,
    unlocked: true,
    wasLocked: true,
    message: "Device unlocked. Warning: device unlocked after wake; no swipe was needed",
  });
  expect(response.content).toContainEqual({
    type: "text",
    text: expect.stringContaining("no swipe was needed"),
  });
});

test("wakeAndUnlock handler forwards the daemon's absolute transport deadline", async () => {
  const registration = spyOn(ToolRegistry, "registerDeviceAware").mockImplementation(() => {});
  const adb = spyOn(defaultAdbClientFactory, "create").mockReturnValue(new FakeAdbExecutor());
  const calls: unknown[][] = [];
  const execute = spyOn(WakeAndUnlock.prototype, "execute").mockImplementation(async (...args) => {
    calls.push(args);
    return {
      success: true,
      platform: "android",
      wasAsleep: false,
      wasLocked: false,
      unlocked: true,
    };
  });
  try {
    registerInteractionTools(interactionDeps);
    const handler = registration.mock.calls.find(([name]) => name === "wakeAndUnlock")?.[3];
    expect(handler).toBeDefined();
    const device: BootedDevice = { deviceId: "fake-unlock", platform: "android", name: "Fake" };
    await handler!(device, { pin: "1234", [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: 123_000 });
    await handler!(device, {});
    expect(calls).toEqual([
      ["1234", { deadlineMs: 123_000, signal: undefined }],
      [undefined, { deadlineMs: undefined, signal: undefined }],
    ]);
  } finally {
    registration.mockRestore();
    adb.mockRestore();
    execute.mockRestore();
  }
});
