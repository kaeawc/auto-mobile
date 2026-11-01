import type {
  ObservedActionResult,
  ObservedEnvelope,
} from "../../src/features/action/observedInteractionTypes";
import {
  cancellationHandlers,
  cancellationTests,
  pausedSleep,
} from "../helpers/interactionCancellation";
import { expect, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import type { BootedDevice, ObserveResult } from "../../src/models";
import { Keyboard } from "../../src/features/action/Keyboard";
import { OpenURL } from "../../src/features/action/OpenURL";
import { HandleIntentChooser } from "../../src/features/action/HandleIntentChooser";
import { FakeKeyboardHierarchyProvider } from "../fakes/FakeKeyboardHierarchyProvider";
import { FakeDeviceUrlLauncher } from "../fakes/FakeDeviceUrlLauncher";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { DeepLinkManager } from "../../src/features/utility/DeepLinkManager";
import { type InteractionToolDependencies } from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
} from "../../src/features/systemTray/systemTrayHelpers";
import { throwIfAborted } from "../../src/utils/toolUtils";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { ActionCall } from "../../src/features/action/ActionCall";
import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import { AdbDeviceTransportUnavailableError } from "../../src/utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { shapeToolCallError } from "../../src/daemon/shapeToolCallError";
import { toolExecutionError } from "../../src/server/toolExecutionError";

const interactionDeps: InteractionToolDependencies = {};
const device: BootedDevice = { platform: "android", deviceId: "test", name: "Test" };
const captured = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/observe/ctrlproxy-headerless-two-notification-group-collapsed.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Pick<ObserveResult, "viewHierarchy">;
const observation: ObserveResult = {
  observationId: "test-observation",
  display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
  ...captured,
  updatedAt: 0,
  screenSize: { width: 1080, height: 2316 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
};
const restores: Array<() => void> = [];
const handler = cancellationHandlers(["keyboard", "openLink", "systemTray"], interactionDeps);

const test = cancellationTests(() => {
  for (const restore of restores.splice(0)) {
    restore();
  }
  delete interactionDeps.keyboardFactory;
  delete interactionDeps.openUrlFactory;
  delete interactionDeps.openLinkChooserFactory;
  resetSystemTrayDependencies();
  ToolRegistry.clearTools();
});

test.each(["keyboard", "openLink", "systemTray"])(
  "pre-aborted %s dispatches nothing",
  async (name) => {
    const controller = new AbortController();
    controller.abort();
    let dispatches = 0;
    const keyboard = spyOn(Keyboard.prototype, "execute").mockImplementation(
      async (_action, signal) => {
        throwIfAborted(signal instanceof AbortSignal ? signal : signal?.signal);
        dispatches++;
        return { success: true, open: false, message: "closed" };
      },
    );
    const open = spyOn(OpenURL.prototype, "execute").mockImplementation(async (url, call) => {
      throwIfAborted((call as ActionCall | undefined)?.signal);
      dispatches++;
      return { success: true, url };
    });
    restores.push(
      () => keyboard.mockRestore(),
      () => open.mockRestore(),
    );
    setSystemTrayDependencies({
      timer: new FakeTimer(),
      adbFactory: () => ({
        executeCommand: async () => {
          dispatches++;
          return { stdout: "", stderr: "" };
        },
        getDeviceTimestampMs: async () => {
          dispatches++;
          return 0;
        },
      }),
      observeScreenFactory: () => ({ execute: async () => observation }),
    });
    await expect(
      handler(name)(
        device,
        name === "openLink"
          ? { url: "https://example.com" }
          : { action: name === "keyboard" ? "close" : "open" },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("Operation cancelled");
    expect(dispatches).toBe(0);
  },
);

test.each(["tap", "dismiss"])(
  "systemTray %s cancels the group-expand wait without advancing time or acting on the notification",
  async (action) => {
    const timer = new FakeTimer();
    const { started, sleep } = pausedSleep(timer);
    restores.push(() => sleep.mockRestore());
    const adb = new FakeAdbExecutor();
    let reads = 0;
    setSystemTrayDependencies({
      timer,
      adbFactory: () => adb,
      observeScreenFactory: () => ({
        execute: async () => {
          reads++;
          return observation;
        },
      }),
    });
    const controller = new AbortController();
    const pending = handler("systemTray")(
      device,
      { action, notification: { title: "Gamma" }, awaitTimeout: 5000 },
      undefined,
      controller.signal,
    );
    await started;
    expect(timer.getPendingSleeps()).toEqual([500]);
    controller.abort();
    await expect(pending).rejects.toThrow("Operation cancelled");
    expect(timer.now()).toBe(0);
    expect(reads).toBe(1);
    expect(
      adb.getExecutedCommands().filter((command) => command.includes("input tap")),
    ).toHaveLength(1);
    // No explicit shade close exists on successful notification taps either.
    expect(
      adb.getExecutedCommands().some((command) => command.includes("statusbar collapse")),
    ).toBe(false);
    timer.resolveAll();
  },
);

test("openLink stops before chooser launch if URL resolution cancels the request", async () => {
  const controller = new AbortController();
  const open = spyOn(OpenURL.prototype, "execute").mockImplementation(async (url) => {
    controller.abort();
    return { success: true, url };
  });
  let launches = 0;
  const chooser = spyOn(HandleIntentChooser.prototype, "execute").mockImplementation(async () => {
    launches++;
    return { success: true, detected: true };
  });
  restores.push(
    () => open.mockRestore(),
    () => chooser.mockRestore(),
  );
  await expect(
    handler("openLink")(
      device,
      { url: "https://example.com", chooserAppPackage: "com.example" },
      undefined,
      controller.signal,
    ),
  ).rejects.toThrow("Operation cancelled");
  expect(launches).toBe(0);
});

// Exercise command dispatch while keeping the separately tested observation pipeline fake.
class UnobservedOpenURL extends OpenURL {
  override observedInteraction<R extends ObservedActionResult>(
    block: (observation: ObserveResult) => Promise<R | ObservedActionResult>,
  ): Promise<R & ObservedEnvelope>;
  override async observedInteraction(
    block: (observation: ObserveResult) => Promise<ObservedActionResult>,
  ): Promise<ObservedActionResult & ObservedEnvelope> {
    return block(observation);
  }
}

test("single-use openLink dispatches once and preserves unknown dispatch in the tool error", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const dispatched: string[][] = [];
  const adb = new AdbClient(
    device,
    async (_file: string, args: string[], _maxBuffer?: number) => {
      dispatched.push(args);
      // Captured adb wording: https://github.com/kaeawc/auto-mobile/issues/13822.
      throw new Error("Command failed: adb shell am start", {
        cause: Object.assign(new Error("Command failed: adb"), {
          code: 1,
          stderr: "connection terminated: read failed",
        }),
      });
    },
    { timer, retryExecutor: new DefaultRetryExecutor(timer) },
  );
  interactionDeps.openUrlFactory = () =>
    new UnobservedOpenURL(device, { adb, simctl: null, devicectl: null, timer });
  const url = "myapp://sign-in?token=single-use";
  const error = await handler("openLink")(device, { url }).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(AdbDeviceTransportUnavailableError);
  expect(error).toMatchObject({ dispatched: "unknown", retryable: true });
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0].slice(-2)).toEqual([
    "shell",
    `am start -a android.intent.action.VIEW -d '${url}'`,
  ]);
  expect(timer.getSleepHistory()).toEqual([]);
  // The registry's contextual boundary must not flatten the typed error.
  expect(() => toolExecutionError(error, "openLink", device)).toThrow(
    AdbDeviceTransportUnavailableError,
  );
  const result = shapeToolCallError(error, { toolName: "openLink", source: "MCP" });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text)).toMatchObject({
    success: false,
    code: "device_transport_unavailable",
    retryable: true,
    dispatched: "unknown",
    deviceId: device.deviceId,
    error: expect.stringContaining("Observe before reissuing"),
  });
});
class UnobservedChooser extends HandleIntentChooser {
  override observedInteraction<R extends ObservedActionResult>(
    block: (observation: ObserveResult) => Promise<R | ObservedActionResult>,
  ): Promise<R & ObservedEnvelope>;
  override async observedInteraction(
    block: (observation: ObserveResult) => Promise<ObservedActionResult>,
  ): Promise<ObservedActionResult & ObservedEnvelope> {
    return block({
      ...observation,
      viewHierarchy: { ...observation.viewHierarchy!, updatedAt: 1000 },
    });
  }
}

const devices: BootedDevice[] = [
  device,
  { platform: "ios", deviceId: "00008110-000A4D8E1234567E", name: "Test iPhone" },
];
test.each(devices)("real commands receive pre-aborted requests on %s", async (target) => {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  const hierarchy = new FakeKeyboardHierarchyProvider();
  const launcher = new FakeDeviceUrlLauncher();
  const simctl = new FakeSimctl();
  interactionDeps.keyboardFactory = () =>
    new Keyboard(target, {
      adbFactory: { create: () => adb },
      hierarchyProvider: hierarchy,
      timer,
    });
  interactionDeps.openUrlFactory = () =>
    new UnobservedOpenURL(target, { adb, simctl, devicectl: launcher, timer });
  let gestures = 0;
  setSystemTrayDependencies({
    timer,
    adbFactory: () => adb,
    iosClientFactory: () => ({
      requestSwipe: async () => {
        gestures++;
        return { success: true };
      },
      requestTapCoordinates: async () => {
        gestures++;
        return { success: true };
      },
    }),
    observeScreenFactory: () => ({ execute: async () => observation }),
  });
  const controller = new AbortController();
  controller.abort();
  for (const action of ["detect", "open", "close"]) {
    await expect(
      handler("keyboard")(target, { action }, undefined, controller.signal),
    ).rejects.toThrow("Operation cancelled");
  }
  await expect(
    handler("openLink")(target, { url: "https://example.com" }, undefined, controller.signal),
  ).rejects.toThrow("Operation cancelled");
  for (const action of ["open", "close", "tap", "dismiss"]) {
    await expect(
      handler("systemTray")(
        target,
        { action, notification: { title: "Gamma" } },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("Operation cancelled");
  }
  expect(adb.getExecutedCommands()).toEqual([]);
  expect(hierarchy.getCallCount()).toBe(0);
  expect(launcher.availabilityChecks).toBe(0);
  expect(launcher.launchCalls).toEqual([]);
  expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  expect(gestures).toBe(0);
});

test("keyboard cancels a pending hierarchy read without dispatch or rollback", async () => {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  const hierarchy = new FakeKeyboardHierarchyProvider();
  const read = spyOn(hierarchy, "getViewHierarchy").mockImplementation(async () => {
    await timer.sleep(100);
    return observation.viewHierarchy ?? null;
  });
  restores.push(() => read.mockRestore());
  interactionDeps.keyboardFactory = () =>
    new Keyboard(device, {
      adbFactory: { create: () => adb },
      hierarchyProvider: hierarchy,
      timer,
    });
  const controller = new AbortController();
  const pending = handler("keyboard")(device, { action: "open" }, undefined, controller.signal);
  expect(timer.getPendingSleeps()).toEqual([100]);
  controller.abort();
  await expect(pending).rejects.toThrow("Operation cancelled");
  expect(timer.now()).toBe(0);
  expect(adb.getExecutedCommands()).toEqual([]);
  timer.resolveAll();
});

test("openLink does not launch after physical iOS URL availability resolution aborts", async () => {
  const target = devices[1]!;
  const timer = new FakeTimer();
  const controller = new AbortController();
  const launcher = new FakeDeviceUrlLauncher();
  const availability = spyOn(launcher, "isUrlLaunchAvailable").mockImplementation(async () => {
    controller.abort();
    return true;
  });
  restores.push(() => availability.mockRestore());
  interactionDeps.openUrlFactory = () =>
    new UnobservedOpenURL(target, {
      adb: new FakeAdbExecutor(),
      simctl: null,
      devicectl: launcher,
      timer,
    });
  await expect(
    handler("openLink")(target, { url: "https://example.com" }, undefined, controller.signal),
  ).rejects.toThrow("Operation cancelled");
  expect(launcher.launchCalls).toEqual([]);
});

test("openLink chooser cancels during handler metadata resolution before any chooser tap", async () => {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  const controller = new AbortController();
  let labels = 0;
  let reads = 0;
  let received: AbortSignal | undefined;
  interactionDeps.openUrlFactory = () => ({
    execute: async (url, call) => {
      received = (call as ActionCall | undefined)?.signal;
      return { success: true, url };
    },
  });
  interactionDeps.openLinkChooserFactory = () =>
    new UnobservedChooser(device, {
      adb: null,
      deepLinkManagerFactory: (signal) => {
        expect(signal).toBe(controller.signal);
        const manager = new DeepLinkManager(device, adb, {
          chooserMetadata: {
            getActivityLabel: async (
              _device,
              _package,
              _url,
              { adb: _adb, signal: metadataSignal },
            ) => {
              expect(metadataSignal).toBe(signal);
              controller.abort();
              return { kind: "none" };
            },
            getLabel: async () => {
              labels++;
              return "Example";
            },
            getFreshHierarchy: async () => {
              reads++;
              return observation.viewHierarchy!;
            },
          },
          timer,
          chooserSignal: signal,
        });
        // Detection is outside this test's metadata/dispatch boundary; use the captured hierarchy unchanged.
        const detected = spyOn(manager, "detectIntentChooser").mockReturnValue(true);
        restores.push(() => detected.mockRestore());
        return manager;
      },
      timer,
    });
  await expect(
    handler("openLink")(
      device,
      { url: "https://example.com", chooserAppPackage: "com.example" },
      undefined,
      controller.signal,
    ),
  ).rejects.toThrow("Operation cancelled");
  expect(received).toBe(controller.signal);
  expect(adb.getExecutedCommands()).toEqual([]);
  expect(labels).toBe(0);
  expect(reads).toBe(0);
});

test("keyboard forwards the exact request signal", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  interactionDeps.keyboardFactory = () => ({
    execute: async (_action, call) => {
      const signal = (call as ActionCall | undefined)?.signal;
      received = signal;
      throwIfAborted(signal);
      return { success: true, open: false, message: "closed" };
    },
  });
  await handler("keyboard")(device, { action: "detect" }, undefined, controller.signal);
  expect(received).toBe(controller.signal);
});

test("openLink cancels iOS foreground confirmation without waiting or rolling back the URL open", async () => {
  const target: BootedDevice = {
    platform: "ios",
    deviceId: "ABCDEF01-1234-1234-1234-1234567890AB",
    name: "Test simulator",
  };
  const timer = new FakeTimer();
  const { started, sleep } = pausedSleep(timer);
  restores.push(() => sleep.mockRestore());
  const simctl = new FakeSimctl();
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation);
  const open = new UnobservedOpenURL(target, {
    adb: new FakeAdbExecutor(),
    simctl,
    devicectl: null,
    timer,
  });
  open.observeScreen = observe;
  interactionDeps.openUrlFactory = () => open;
  const controller = new AbortController();
  const pending = handler("openLink")(
    target,
    { url: "https://example.com" },
    undefined,
    controller.signal,
  );
  await started;
  expect(timer.getPendingSleeps()).toEqual([100]);
  controller.abort();
  await expect(pending).rejects.toThrow("Operation cancelled");
  expect(timer.now()).toBe(0);
  expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(1);
  timer.resolveAll();
});
