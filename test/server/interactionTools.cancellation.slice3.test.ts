import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BootedDevice, ObserveResult } from "../../src/models";
import { Keyboard } from "../../src/features/action/Keyboard";
import { OpenURL } from "../../src/features/action/OpenURL";
import { HandleIntentChooser } from "../../src/features/action/HandleIntentChooser";
import { FakeKeyboardHierarchyProvider } from "../fakes/FakeKeyboardHierarchyProvider";
import { FakeDeviceUrlLauncher } from "../fakes/FakeDeviceUrlLauncher";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";
import { DeepLinkManager } from "../../src/utils/DeepLinkManager";
import {
  resetKeyboardFactory,
  resetOpenUrlFactory,
  resetOpenLinkChooserFactory,
  setKeyboardFactory,
  setOpenUrlFactory,
  setOpenLinkChooserFactory,
  registerInteractionTools,
} from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
} from "../../src/server/systemTrayHelpers";
import { throwIfAborted } from "../../src/utils/toolUtils";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

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
  ...captured,
  updatedAt: 0,
  screenSize: { width: 1080, height: 2316 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
};
const restores: Array<() => void> = [];
function handler(name: string) {
  const registered = ToolRegistry.getTool(name)?.deviceAwareHandler;
  if (!registered) {
    throw new Error(`Missing handler ${name}`);
  }
  return registered;
}
beforeEach(() => registerInteractionTools());
afterEach(() => {
  for (const restore of restores.splice(0)) {
    restore();
  }
  resetKeyboardFactory();
  resetOpenUrlFactory();
  resetOpenLinkChooserFactory();
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
        throwIfAborted(signal);
        dispatches++;
        return { success: true, open: false, message: "closed" };
      },
    );
    const open = spyOn(OpenURL.prototype, "execute").mockImplementation(
      async (url, ...rest: [AbortSignal?]) => {
        throwIfAborted(rest[0]);
        dispatches++;
        return { success: true, url };
      },
    );
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
  100,
);

test.each(["tap", "dismiss"])(
  "systemTray %s cancels the group-expand wait without advancing time or acting on the notification",
  async (action) => {
    const timer = new FakeTimer();
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
    for (let i = 0; i < 100 && timer.getPendingSleepCount() === 0; i++) {
      await Promise.resolve();
    }
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
  100,
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
}, 100);

// Exercise command dispatch while keeping the separately tested observation pipeline fake.
class UnobservedOpenURL extends OpenURL {
  override async observedInteraction(
    block: Parameters<OpenURL["observedInteraction"]>[0],
  ): Promise<unknown> {
    return block(observation);
  }
}
class UnobservedChooser extends HandleIntentChooser {
  override async observedInteraction(
    block: Parameters<HandleIntentChooser["observedInteraction"]>[0],
  ): Promise<unknown> {
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
  const simctl = new FakeSimCtlClient();
  setKeyboardFactory(() => new Keyboard(target, { create: () => adb }, hierarchy, timer));
  setOpenUrlFactory(() => new UnobservedOpenURL(target, adb, simctl, launcher, timer));
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
  setKeyboardFactory(() => new Keyboard(device, { create: () => adb }, hierarchy, timer));
  const controller = new AbortController();
  const pending = handler("keyboard")(device, { action: "open" }, undefined, controller.signal);
  expect(timer.getPendingSleeps()).toEqual([100]);
  controller.abort();
  await expect(pending).rejects.toThrow("Operation cancelled");
  expect(timer.now()).toBe(0);
  expect(adb.getExecutedCommands()).toEqual([]);
  timer.resolveAll();
}, 100);

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
  setOpenUrlFactory(
    () => new UnobservedOpenURL(target, new FakeAdbExecutor(), null, launcher, timer),
  );
  await expect(
    handler("openLink")(target, { url: "https://example.com" }, undefined, controller.signal),
  ).rejects.toThrow("Operation cancelled");
  expect(launcher.launchCalls).toEqual([]);
}, 100);

test("openLink chooser cancels during handler metadata resolution before any chooser tap", async () => {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  const controller = new AbortController();
  let labels = 0;
  let reads = 0;
  let received: AbortSignal | undefined;
  setOpenUrlFactory(() => ({
    execute: async (url, signal) => {
      received = signal;
      return { success: true, url };
    },
  }));
  setOpenLinkChooserFactory(
    () =>
      new UnobservedChooser(
        device,
        null,
        (signal) => {
          expect(signal).toBe(controller.signal);
          const manager = new DeepLinkManager(
            device,
            adb,
            null,
            null,
            undefined,
            undefined,
            {
              getActivityLabel: async (_device, _package, _url, _adb, metadataSignal) => {
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
            signal,
          );
          // Detection is outside this test's metadata/dispatch boundary; use the captured hierarchy unchanged.
          const detected = spyOn(manager, "detectIntentChooser").mockReturnValue(true);
          restores.push(() => detected.mockRestore());
          return manager;
        },
        timer,
      ),
  );
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
}, 100);

test("keyboard forwards the exact request signal", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  setKeyboardFactory(() => ({
    execute: async (_action, signal) => {
      received = signal;
      throwIfAborted(signal);
      return { success: true, open: false, message: "closed" };
    },
  }));
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
  const simctl = new FakeSimCtlClient();
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation);
  const open = new UnobservedOpenURL(target, new FakeAdbExecutor(), simctl, null, timer);
  open.observeScreen = observe;
  setOpenUrlFactory(() => open);
  const controller = new AbortController();
  const pending = handler("openLink")(
    target,
    { url: "https://example.com" },
    undefined,
    controller.signal,
  );
  for (let i = 0; i < 100 && timer.getPendingSleepCount() === 0; i++) {
    await Promise.resolve();
  }
  expect(timer.getPendingSleeps()).toEqual([100]);
  controller.abort();
  await expect(pending).rejects.toThrow("Operation cancelled");
  expect(timer.now()).toBe(0);
  expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(1);
  timer.resolveAll();
}, 100);
