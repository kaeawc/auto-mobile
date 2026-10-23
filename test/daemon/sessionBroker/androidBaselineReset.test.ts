import { BOOT_ID_TIMEOUT } from "./fixtures/androidResetLoadTimeouts";
import { describe, expect, test } from "bun:test";
import {
  AndroidBaselineReset,
  watchAndroidResetSession,
} from "../../../src/daemon/sessionBroker/androidBaselineReset";
import { boundAndroidResetInventory } from "../../../src/daemon/sessionBroker/service";
import { ExecutionTracker } from "../../../src/daemon/executionTracker";
import { FakeTimer } from "../../fakes/FakeTimer";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { drainUntil } from "../../helpers/fakeTimerStepping";
import {
  ANDROID_RESET_DEVICE,
  ANDROID_RESET_PROFILE,
  FakeAndroidResetHost,
} from "./fixtures/androidReset";
describe("AndroidBaselineReset", () => {
  test("reset target inventory can take 3000ms within a 600000ms reset budget", async () => {
    const host = new FakeAndroidResetHost();
    const timer = new FakeTimer();
    host.timer = timer;
    host.strategy = {
      reset: async (_device, _packages, owned, context) => {
        await owned();
        await context.rebindIncarnation?.();
        await context.healthCheck?.({
          scope: {
            deviceId: ANDROID_RESET_DEVICE.deviceId,
            incarnation: "resource-a",
            sessionUuid: "session-a",
          },
          signal: context.signal!,
          assertOwned: owned,
        });
      },
    };
    const baseline = new AndroidBaselineReset(host);
    await baseline.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a", {
      timer,
    });
    const inventory = host.inventory.bind(host);
    const budgets: number[] = [];
    const bounded = boundAndroidResetInventory(async (options) => {
      budgets.push(options.timeoutMs);
      await timer.sleep(3000);
      return [ANDROID_RESET_DEVICE];
    }, timer);
    host.inventory = async (options) => {
      await bounded(options);
      return inventory(options);
    };
    timer.enableAutoAdvance();
    await expect(
      baseline.reset("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).resolves.toBe("clean");
    expect(budgets.length).toBeGreaterThan(3);
    expect(budgets.every((budget) => budget > 2000 && budget <= 600000)).toBe(true);
  });

  test("capture shares target inventory budget across retries and ownership checks", async () => {
    const host = new FakeAndroidResetHost();
    const timer = new FakeTimer();
    const inventory = host.inventory.bind(host);
    const budgets: number[] = [];
    const targets: Array<string | undefined> = [];
    host.inventory = async (options) => {
      targets.push(options.targetDeviceId);
      budgets.push(options.timeoutMs);
      if (budgets.length === 1) {
        timer.advanceTime(options.timeoutMs);
        throw new Error(`Android baseline reset inventory timed out after ${options.timeoutMs}ms`);
      }
      return inventory(options);
    };
    host.strategy = {
      capture: async (_device, context) => {
        await context.assertOwned();
      },
      reset: async () => {},
    };
    await new AndroidBaselineReset(host).capture(
      "resource-a",
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      "session-a",
      { timer, timeoutMs: 30000 },
    );
    expect(budgets).toEqual([10000, 10000, 20000]);
    expect(targets).toEqual(Array(3).fill(ANDROID_RESET_DEVICE.deviceId));
    expect(host.closed).toBe(0);
    expect(host.commandOptions.every((options) => options!.timeoutMs === 2000)).toBe(true);
  });

  test("reset ownership, incarnation rebinding and health accept a pending inventory name", async () => {
    const host = new FakeAndroidResetHost();
    host.strategy = {
      handlesSessionMutations: true,
      reset: async (_device, _packages, assertOwned, context) => {
        await assertOwned();
        host.bootId = "87654321-4321-4321-4321-cba987654321";
        await context.rebindIncarnation?.();
      },
    };
    const baseline = new AndroidBaselineReset(host);
    await baseline.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a", {
      timer: new FakeTimer(),
    });
    host.devices = [
      {
        ...ANDROID_RESET_DEVICE,
        name: `Unknown (${ANDROID_RESET_DEVICE.deviceId})`,
        isRunning: true,
      },
    ];
    await expect(
      baseline.reset("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).resolves.toBe("clean");
  });

  test("capture accepts a pending inventory name only inside the strategy ownership check", async () => {
    const host = new FakeAndroidResetHost();
    host.strategy = {
      handlesSessionMutations: true,
      capture: async (_device, context) => {
        host.devices = [
          {
            ...ANDROID_RESET_DEVICE,
            name: `Unknown (${ANDROID_RESET_DEVICE.deviceId})`,
            isRunning: true,
          },
        ];
        await context.assertOwned();
      },
      reset: async () => {},
    };
    const baseline = new AndroidBaselineReset(host);
    await baseline.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a", {
      timer: new FakeTimer(),
    });
    expect(host.closed).toBe(0);
    expect(
      host.commands.filter((command) => command === "shell cat /proc/sys/kernel/random/boot_id"),
    ).toHaveLength(2);
  });

  test.each([
    "foreign serial",
    "foreign placeholder",
    "real name",
    "offline",
    "unknown running state",
    "duplicate",
    "boot",
    "boot identity",
  ])("capture rejects %s during the strategy ownership check", async (failure) => {
    const host = new FakeAndroidResetHost();
    host.strategy = {
      handlesSessionMutations: true,
      capture: async (_device, context) => {
        host.devices = [
          {
            ...ANDROID_RESET_DEVICE,
            name: `Unknown (${ANDROID_RESET_DEVICE.deviceId})`,
            isRunning: true,
          },
        ];
        const target = host.devices[0]!;
        if (failure === "foreign serial") {
          target.deviceId = "emulator-5556";
        }
        if (failure === "foreign placeholder") {
          target.name = "Unknown (emulator-5556)";
        }
        if (failure === "real name") {
          target.name = "different-avd";
        }
        if (failure === "offline") {
          target.isRunning = false;
        }
        if (failure === "unknown running state") {
          target.isRunningStateKnown = false;
        }
        if (failure === "duplicate") {
          host.devices.push({ ...target });
        }
        if (failure === "boot") {
          host.booted = false;
        }
        if (failure === "boot identity") {
          host.bootId = "87654321-4321-4321-4321-cba987654321";
        }
        await context.assertOwned();
      },
      reset: async () => {},
    };
    const message =
      failure === "boot"
        ? "has not completed boot"
        : failure === "boot identity"
          ? "changed emulator boot identity"
          : "exact online reset target";
    await expect(
      new AndroidBaselineReset(host).capture(
        "resource-a",
        ANDROID_RESET_DEVICE,
        ANDROID_RESET_PROFILE,
        "session-a",
        { timer: new FakeTimer() },
      ),
    ).rejects.toThrow(message);
    expect(host.closed).toBe(1);
  });

  test("pre-capture inventory requires the full profile even for the same serial placeholder", async () => {
    const host = new FakeAndroidResetHost();
    host.devices = [
      {
        ...ANDROID_RESET_DEVICE,
        name: `Unknown (${ANDROID_RESET_DEVICE.deviceId})`,
        isRunning: true,
      },
    ];
    let captured = false;
    host.strategy = {
      capture: async () => {
        captured = true;
      },
      reset: async () => {},
    };
    await expect(
      new AndroidBaselineReset(host).capture(
        "resource-a",
        ANDROID_RESET_DEVICE,
        ANDROID_RESET_PROFILE,
        "session-a",
        { timer: new FakeTimer() },
      ),
    ).rejects.toThrow("exact online reset target");
    expect(captured).toBe(false);
  });

  test("default reset budget accommodates a cold boot beyond the old two-minute cutoff", async () => {
    const timer = new FakeTimer();
    const host = new FakeAndroidResetHost();
    host.timer = timer;
    host.strategy = {
      reset: async (_device, _packages, _owned, context) => {
        expect(context.timeoutMs).toBe(600_000);
        timer.advanceTime(150_000);
        return { outcome: "clean", mode: "snapshot", phases: { load: 150_000 } };
      },
    };
    const baseline = new AndroidBaselineReset(host);
    await baseline.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a", {
      timer,
    });
    await expect(
      baseline.reset("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).resolves.toMatchObject({ outcome: "clean", mode: "snapshot", phases: { load: 150_000 } });
  });

  test("configured reset budget aborts in-flight strategy work and closes its baseline", async () => {
    const timer = new FakeTimer();
    const host = new FakeAndroidResetHost();
    host.timer = timer;
    host.resetTimeoutMs = 1000;
    let signal: AbortSignal | undefined;
    host.strategy = {
      reset: async (_device, _packages, _owned, context) => {
        signal = context.signal;
        return new Promise<never>(() => {});
      },
    };
    const baseline = new AndroidBaselineReset(host);
    await baseline.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a", {
      timer,
    });
    const result = baseline.reset(
      "resource-a",
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      async () => {},
    );
    await drainUntil(() => signal !== undefined, { description: "bounded reset strategy" });
    timer.advanceTime(1000);
    await expect(result).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
    expect(host.closed).toBe(1);
  });

  test.each(["deviceSnapshot", "network", "setDeviceResources"])(
    "admitted %s activity vetoes even a full snapshot baseline",
    async (toolName) => {
      const tracker = new ExecutionTracker(new FakeTimer(), new CountingIdGenerator("execution"));
      const activity = watchAndroidResetSession(tracker, "session-a");
      const mutation = tracker.startExecution(toolName, undefined, "session-a");
      tracker.markSessionAdmitted(mutation.id);
      tracker.endExecution(mutation.id);
      expect(activity.canReset()).toBe(false);
      activity.close();
    },
  );
  test("other strategies receive the remaining capture deadline without a journal cap", async () => {
    const host = new FakeAndroidResetHost();
    const timer = new FakeTimer();
    let captureBudget: number | undefined;
    host.onInventory = () => timer.advanceTime(100);
    host.strategy = {
      capture: async (_device, context) => {
        captureBudget = context.timeoutMs;
        timer.advanceTime(3000);
        context.signal.throwIfAborted();
        await context.assertOwned();
      },
      reset: async () => {},
    };
    const reset = new AndroidBaselineReset(host);
    await reset.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a", {
      timer,
      timeoutMs: 10_000,
    });
    expect(captureBudget).toBe(9900);
  });

  test("pruning failure neither retains activity nor hides the original capture error", async () => {
    const host = new FakeAndroidResetHost();
    let failCapture = false;
    host.strategy = {
      capture: async () => {
        if (failCapture) {
          throw new Error("original capture failure");
        }
      },
      forget: async () => {
        throw new Error("SQLite unavailable");
      },
      reset: async () => {},
    };
    const reset = new AndroidBaselineReset(host);
    await reset.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a");
    await reset.forget("resource-a");
    expect(host.closed).toBe(1);
    await expect(
      reset.reset("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).rejects.toThrow("original session baseline");
    failCapture = true;
    await expect(
      reset.capture("resource-b", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-b"),
    ).rejects.toThrow("original capture failure");
    expect(host.closed).toBe(2);
  });

  test("activity guard marks only a user snapshot capture as opaque persistent", () => {
    const tracker = new ExecutionTracker(new FakeTimer(), new CountingIdGenerator("execution"));
    const activity = watchAndroidResetSession(tracker, "session-a");
    const run = (toolName: string) => {
      const execution = tracker.startExecution(toolName, undefined, "session-a");
      tracker.markSessionAdmitted(execution.id);
      tracker.endExecution(execution.id);
    };
    run("displayConfig");
    run("installApp");
    expect(activity.canReset()).toBe(false);
    expect(activity.madeOpaquePersistentChanges()).toBe(false);
    expect(activity.madeHostSideChanges()).toBe(false);
    run("setDeviceResources");
    expect(activity.madeHostSideChanges()).toBe(true);
    run("deviceSnapshot");
    expect(activity.madeOpaquePersistentChanges()).toBe(true);
    activity.close();
  });

  test("a capture step that times out is retried inside the preparation deadline (#14956)", async () => {
    const host = new FakeAndroidResetHost();
    host.strategy = { reset: async () => {} };
    let calls = 0;
    host.onInventory = () => {
      if (++calls === 1) {
        throw new Error("Android baseline reset inventory timed out after 2000ms");
      }
    };
    await new AndroidBaselineReset(host).capture(
      "resource-a",
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      "session-a",
      { timer: new FakeTimer(), timeoutMs: 30_000 },
    );
    expect(host.inventoryCalls).toBeGreaterThan(1);
    expect(host.closed).toBe(0);
  });

  test("a capture step that keeps timing out fails after bounded attempts, other errors are not retried", async () => {
    const timedOut = new FakeAndroidResetHost();
    timedOut.strategy = { reset: async () => {} };
    timedOut.onInventory = () => {
      throw new Error("Android baseline reset inventory timed out after 2000ms");
    };
    await expect(
      new AndroidBaselineReset(timedOut).capture(
        "resource-a",
        ANDROID_RESET_DEVICE,
        ANDROID_RESET_PROFILE,
        "session-a",
        { timer: new FakeTimer(), timeoutMs: 30_000 },
      ),
    ).rejects.toThrow("timed out after 2000ms");
    expect(timedOut.inventoryCalls).toBe(3);
    const broken = new FakeAndroidResetHost();
    broken.strategy = { reset: async () => {} };
    broken.onInventory = () => {
      throw new Error("adb exploded");
    };
    await expect(
      new AndroidBaselineReset(broken).capture(
        "resource-a",
        ANDROID_RESET_DEVICE,
        ANDROID_RESET_PROFILE,
        "session-a",
        { timer: new FakeTimer(), timeoutMs: 30_000 },
      ),
    ).rejects.toThrow("adb exploded");
    expect(broken.inventoryCalls).toBe(1);
  });

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
    host.timer = new FakeTimer();
    host.timer.enableAutoAdvance();
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
      inventory: (options) => host.inventory(options),
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
    await reset.forget("resource-a");
    expect(host.closed).toBe(1);
    expect(
      await reset.reset("resource-b", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).toBe("clean");
    expect(host.closed).toBe(2);
  });
});

describe("baseline reset under load", () => {
  test("reset boot identity retries the captured timeout", async () => {
    const host = new FakeAndroidResetHost();
    const timer = new FakeTimer();
    host.timer = timer;
    host.strategy = { handlesSessionMutations: true, reset: async () => {} };
    const baseline = new AndroidBaselineReset(host);
    await baseline.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a", {
      timer,
    });
    timer.enableAutoAdvance();
    const adb = host.adb.bind(host);
    let reads = 0;
    host.adb = () => ({
      executeCommand: async (command, options) => {
        if (command.includes("boot_id") && ++reads === 1) {
          throw new Error(BOOT_ID_TIMEOUT);
        }
        return adb().executeCommand(command, options);
      },
    });
    await expect(
      baseline.reset("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).resolves.toBe("clean");
    expect(timer.getSleepHistory()).toEqual([250]);
  });
  test.each([true, false])(
    "CtrlProxy readiness recovers=%s within derived window",
    async (recovers) => {
      const host = new FakeAndroidResetHost();
      const timer = new FakeTimer();
      host.timer = timer;
      host.strategy = { reset: async () => {} };
      const baseline = new AndroidBaselineReset(host);
      await baseline.capture(
        "resource-a",
        ANDROID_RESET_DEVICE,
        ANDROID_RESET_PROFILE,
        "session-a",
        { timer },
      );
      timer.enableAutoAdvance();
      let calls = 0;
      host.ctrlProxyReady = async () => {
        calls++;
        return recovers && calls >= 3;
      };
      const pending = baseline.reset(
        "resource-a",
        ANDROID_RESET_DEVICE,
        ANDROID_RESET_PROFILE,
        async () => {},
      );
      if (recovers) {
        await expect(pending).resolves.toBe("clean");
        expect(calls).toBe(3);
      } else {
        await expect(pending).rejects.toThrow("Android reset CtrlProxy health check failed");
        expect(timer.now()).toBe(150_000);
        expect(calls).toBeGreaterThan(2);
      }
    },
  );
});
