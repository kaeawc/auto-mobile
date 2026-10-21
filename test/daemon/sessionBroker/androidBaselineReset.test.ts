import { describe, expect, test } from "bun:test";
import {
  AndroidBaselineReset,
  watchAndroidResetSession,
} from "../../../src/daemon/sessionBroker/androidBaselineReset";
import { ExecutionTracker } from "../../../src/daemon/executionTracker";
import { FakeTimer } from "../../fakes/FakeTimer";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import {
  ANDROID_RESET_DEVICE,
  ANDROID_RESET_PROFILE,
  FakeAndroidResetHost,
} from "./fixtures/androidReset";
describe("AndroidBaselineReset", () => {
  test("native activity guard ignores reads and foreign sessions but rejects admitted session use", () => {
    const tracker = new ExecutionTracker(new FakeTimer(), new CountingIdGenerator("execution"));
    const activity = watchAndroidResetSession(tracker, "session-a");
    const read = tracker.startExecution("observe", undefined, "session-a");
    tracker.markSessionAdmitted(read.id);
    tracker.markReadOnlySessionAccess(read.id);
    tracker.endExecution(read.id);
    const foreign = tracker.startExecution("tap", undefined, "session-b");
    tracker.markSessionAdmitted(foreign.id);
    tracker.endExecution(foreign.id);
    expect(activity.canReset()).toBe(true);
    const mutation = tracker.startExecution("tap", undefined, "session-a");
    tracker.markSessionAdmitted(mutation.id);
    tracker.endExecution(mutation.id);
    expect(activity.canReset()).toBe(false);
    activity.close();
  });
  async function rig() {
    const host = new FakeAndroidResetHost();
    host.strategy = { reset: async (_device, _packages, assertOwned) => assertOwned() };
    const reset = new AndroidBaselineReset(host);
    await reset.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a");
    host.commands = [];
    return { host, reset: { reset: reset.reset.bind(reset, "resource-a") } };
  }

  test("package additions destroy rather than uninstall and pool", async () => {
    const { host, reset } = await rig();
    host.installed.add("com.example.session");
    await expect(
      reset.reset(ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).rejects.toThrow("untracked package inventory changes");
    expect(host.installed.has("com.example.session")).toBe(true);
    expect(host.commands.some((command) => command.startsWith("uninstall"))).toBe(false);
    expect(host.closed).toBe(1);
  });

  test.each([
    ["serial", "exact online reset target"],
    ["image", "exact online reset target"],
    ["name", "exact online reset target"],
    ["offline", "exact online reset target"],
    ["boot", "has not completed boot"],
    ["package-manager", "package manager is not responsive"],
    ["ctrlproxy", "CtrlProxy health check failed"],
    ["mutations", "session mutations cannot be restored"],
  ])("rejects %s failure instead of reporting a clean emulator", async (failure, message) => {
    const { host, reset } = await rig();
    const target = host.devices[0]!;
    if (failure === "serial") {
      target.deviceId = "emulator-5556";
    }
    if (failure === "image") {
      target.runtimeId = "system-images;android-36;google_apis;arm64-v8a";
    }
    if (failure === "name") {
      target.name = "different-avd";
    }
    if (failure === "offline") {
      target.isRunning = false;
    }
    if (failure === "boot") {
      host.booted = false;
    }
    if (failure === "package-manager") {
      host.packageManager = false;
    }
    if (failure === "ctrlproxy") {
      host.healthy = false;
    }
    if (failure === "mutations") {
      host.safe = false;
    }
    await expect(
      reset.reset(ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).rejects.toThrow(message);
    expect(host.closed).toBe(1);
  });

  test("ownership loss before strategy prevents mutation", async () => {
    const { host, reset } = await rig();
    let fences = 0;
    await expect(
      reset.reset(ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {
        if (++fences === 3) {
          throw new Error("ownership lost");
        }
      }),
    ).rejects.toThrow("ownership lost");
    expect(host.commands.some((command) => command.startsWith("uninstall"))).toBe(false);
  });

  test("post-health serial change prevents clean return", async () => {
    const { host, reset } = await rig();
    host.onHealth = () => {
      host.devices[0]!.deviceId = "emulator-5556";
    };
    await expect(
      reset.reset(ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).rejects.toThrow("exact online reset target");
  });

  test("post-health ownership loss prevents clean return", async () => {
    const { host, reset } = await rig();
    let owned = true;
    host.onHealth = () => {
      owned = false;
    };
    await expect(
      reset.reset(ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {
        if (!owned) {
          throw new Error("ownership lost");
        }
      }),
    ).rejects.toThrow("ownership lost");
  });

  test("missing baseline after restart is never considered clean", async () => {
    const host = new FakeAndroidResetHost();
    host.strategy = { reset: async () => {} };
    const reset = new AndroidBaselineReset(host);
    await expect(
      reset.reset("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).rejects.toThrow("original session baseline");
  });

  test("removal of a baseline package is not mistaken for a clean package diff", async () => {
    const { host, reset } = await rig();
    host.installed.clear();
    await expect(
      reset.reset(ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).rejects.toThrow("untracked package inventory changes");
  });

  test("duplicate fresh AVD identity prevents uninstall", async () => {
    const { host, reset } = await rig();
    host.installed.add("com.example.session");
    host.devices.push({ ...host.devices[0]!, deviceId: "emulator-5556" });
    await expect(
      reset.reset(ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).rejects.toThrow("exact online reset target");
    expect(host.commands.some((command) => command.startsWith("uninstall"))).toBe(false);
  });

  test("strategy hook receives the captured packages and guarded ownership seam", async () => {
    const host = new FakeAndroidResetHost();
    let called = false;
    const reset = new AndroidBaselineReset({
      inventory: () => host.inventory(),
      adb: () => host.adb(),
      watchSession: (sessionId) => host.watchSession(sessionId),
      ctrlProxyReady: () => host.ctrlProxyReady(),
      strategy: {
        reset: async (device, packages, assertOwned) => {
          await assertOwned();
          expect(device).toEqual(ANDROID_RESET_DEVICE);
          expect(packages).toEqual(host.installed);
          called = true;
        },
      },
    });
    await reset.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a");
    expect(
      await reset.reset("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).toBe("clean");
    expect(called).toBe(true);
  });

  test("without a strategy, capture skips native work and reset rejects unobservable state", async () => {
    const host = new FakeAndroidResetHost();
    const reset = new AndroidBaselineReset(host);
    await reset.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a");
    await expect(
      reset.reset("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).rejects.toThrow("cannot prove restoration of unobservable state");
    expect(host.inventoryCalls).toBe(0);
    expect(host.commands).toEqual([]);
    expect(host.closed).toBe(0);
  });

  test("forgetting an evicted resource does not remove a recycled serial's new baseline", async () => {
    const host = new FakeAndroidResetHost();
    host.strategy = { reset: async (_device, _packages, assertOwned) => assertOwned() };
    const reset = new AndroidBaselineReset(host);
    await reset.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a");
    await reset.capture("resource-b", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-b");
    reset.forget("resource-a");
    expect(host.closed).toBe(1);
    expect(
      await reset.reset("resource-b", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).toBe("clean");
    expect(host.closed).toBe(2);
  });
});
