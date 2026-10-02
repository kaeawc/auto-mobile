import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type WebSocket from "ws";
import type { BootedDevice, ObserveResult } from "../../src/models";
import { Keyboard } from "../../src/features/action/Keyboard";
import { HomeScreen } from "../../src/features/action/HomeScreen";
import { OpenURL } from "../../src/features/action/OpenURL";
import { withAndroidImeLock } from "../../src/features/action/androidImeLock";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { CtrlProxyKeyboard } from "../../src/features/observe/ios/CtrlProxyKeyboard";
import { CtrlProxyGestures } from "../../src/features/observe/ios/CtrlProxyGestures";
import type { DelegateContext } from "../../src/features/observe/ios/types";
import {
  registerInteractionTools,
  setKeyboardFactory,
  resetKeyboardFactory,
  setOpenUrlFactory,
  resetOpenUrlFactory,
} from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  setSystemTrayDependencies,
  resetSystemTrayDependencies,
} from "../../src/server/systemTrayHelpers";
import { RequestManager } from "../../src/utils/RequestManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeKeyboardHierarchyProvider } from "../fakes/FakeKeyboardHierarchyProvider";
import { FakeDeviceUrlLauncher } from "../fakes/FakeDeviceUrlLauncher";
import { FakeWebSocket } from "../fakes/FakeWebSocket";

const android: BootedDevice = { platform: "android", deviceId: "slice4-android", name: "Test" };
const ios: BootedDevice = {
  platform: "ios",
  deviceId: "00008110-000A4D8E1234567E",
  name: "Test iPhone",
};
const captured = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/observe/ctrlproxy-headerless-two-notification-group-expanded.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Pick<ObserveResult, "viewHierarchy">;
// Keep the captured notification rows; adapt only the platform's tray identity.
const observation: ObserveResult = {
  updatedAt: 0,
  screenSize: { width: 1080, height: 2316 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy: {
    ...captured.viewHierarchy!,
    packageName: "com.apple.springboard",
    hierarchy: {
      node: { ...captured.viewHierarchy!.hierarchy!.node, class: "NotificationCenter" },
    },
  },
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
  resetSystemTrayDependencies();
  ToolRegistry.clearTools();
});

function profileClient() {
  const client = AndroidCtrlProxyClient.createForTesting(
    android,
    new FakeAdbExecutor(),
    () => {
      throw new Error("Unexpected socket connection");
    },
    new FakeTimer(),
  );
  const supports = spyOn(client, "supportsCommand").mockResolvedValue(true);
  const set = spyOn(client, "setKeyboardProfile").mockResolvedValue({
    success: true,
    activeProfileId: "direct",
  });
  const list = spyOn(client, "listKeyboardProfiles").mockResolvedValue({
    success: true,
    catalogId: "automobile_behavior_profiles",
    catalogVersion: 1,
    profiles: [],
  });
  const instance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  restores.push(
    () => supports.mockRestore(),
    () => set.mockRestore(),
    () => list.mockRestore(),
    () => instance.mockRestore(),
  );
  return { supports, set, list };
}

test.each(["setProfile", "listProfiles"])(
  "pre-aborted keyboard %s never calls the client",
  async (action) => {
    const client = profileClient();
    const controller = new AbortController();
    controller.abort();
    await expect(
      handler("keyboard")(android, { action, profile: "direct" }, undefined, controller.signal),
    ).rejects.toThrow("Operation cancelled");
    expect(client.supports).not.toHaveBeenCalled();
    expect(client.set).not.toHaveBeenCalled();
    expect(client.list).not.toHaveBeenCalled();
  },
  100,
);

test("keyboard setProfile cancelled behind the IME lock never flips the profile", async () => {
  const client = profileClient();
  const held = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<void>();
  const supported = Promise.withResolvers<void>();
  client.supports.mockImplementation(async () => {
    supported.resolve();
    return true;
  });
  const lock = withAndroidImeLock(android.deviceId, async () => {
    acquired.resolve();
    await held.promise;
  });
  await acquired.promise;
  const controller = new AbortController();
  const pending = handler("keyboard")(
    android,
    { action: "setProfile", profile: "direct" },
    undefined,
    controller.signal,
  );
  await supported.promise;
  await Promise.resolve();
  controller.abort();
  held.resolve();
  await lock;
  await expect(pending).rejects.toThrow("Operation cancelled");
  expect(client.set).not.toHaveBeenCalled();
}, 100);

test.each(["setProfile", "listProfiles"])(
  "keyboard %s stops after capability negotiation cancels",
  async (action) => {
    const client = profileClient();
    const controller = new AbortController();
    client.supports.mockImplementation(async () => {
      controller.abort();
      return true;
    });
    await expect(
      handler("keyboard")(android, { action, profile: "direct" }, undefined, controller.signal),
    ).rejects.toThrow("Operation cancelled");
    expect(client.set).not.toHaveBeenCalled();
    expect(client.list).not.toHaveBeenCalled();
  },
  100,
);

function delayedConnection() {
  const timer = new FakeTimer();
  const connected = Promise.withResolvers<boolean>();
  const started = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const socket = new FakeWebSocket("ws://fake", "none", 0, timer);
  const sent = spyOn(socket, "send");
  const manager = new RequestManager(timer);
  const registered = spyOn(manager, "generateId");
  const context: DelegateContext = {
    timer,
    requestManager: manager,
    getWebSocket: () => socket as WebSocket,
    ensureConnected: () => {
      started.resolve();
      return connected.promise;
    },
    cancelScreenshotBackoff: () => {},
  };
  const client = IOSCtrlProxyClient.createForTesting(
    ios,
    8765,
    () => {
      throw new Error("Unexpected socket connection");
    },
    timer,
  );
  const instance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client);
  restores.push(
    () => instance.mockRestore(),
    () => sent.mockRestore(),
    () => registered.mockRestore(),
  );
  return { timer, context, client, connected, started, completed, sent, registered };
}

test.each(["open", "close", "detect", "close follow-up detect"] as const)(
  "iOS keyboard %s never dispatches after a cancelled connection wait",
  async (action) => {
    const h = delayedConnection();
    const proxy = new CtrlProxyKeyboard(h.context);
    const original = CtrlProxyKeyboard.prototype.requestKeyboard;
    let requests = 0;
    // Keep the real client forwarding method, but inject the delegate's connection context.
    const delegate = spyOn(CtrlProxyKeyboard.prototype, "requestKeyboard").mockImplementation(
      async (...args) => {
        requests++;
        if (action === "close follow-up detect" && requests === 1) {
          return {
            success: false,
            open: true,
            totalTimeMs: 8000,
            error: "Keyboard timed out after 8000ms",
          };
        }
        if (action === "close follow-up detect") {
          expect(args[0]).toBe("detect");
        }
        try {
          return await original.apply(proxy, args);
        } finally {
          h.completed.resolve();
        }
      },
    );
    restores.push(() => delegate.mockRestore());
    setKeyboardFactory(
      () =>
        new Keyboard(
          ios,
          { create: () => new FakeAdbExecutor() },
          new FakeKeyboardHierarchyProvider(),
          h.timer,
        ),
    );
    const controller = new AbortController();
    const pending = handler("keyboard")(
      ios,
      { action: action === "close follow-up detect" ? "close" : action },
      undefined,
      controller.signal,
    );
    await h.started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow("Operation cancelled");
    h.connected.resolve(true);
    // A pre-fix dispatch would otherwise await a fake response; drain it without real time.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    h.timer.advanceTime(10000);
    await h.completed.promise;
    expect(h.sent).not.toHaveBeenCalled();
    expect(h.registered).not.toHaveBeenCalled();
  },
  100,
);

class UnobservedOpenURL extends OpenURL {
  override async observedInteraction(
    block: Parameters<OpenURL["observedInteraction"]>[0],
  ): Promise<unknown> {
    return block(observation);
  }
}
test("physical iOS openLink forwards cancellation to devicectl", async () => {
  const timer = new FakeTimer();
  const launcher = new FakeDeviceUrlLauncher();
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const launch = spyOn(launcher, "launchWithPayloadUrl").mockImplementation(
    async (_device, _bundle, _url, signal?: AbortSignal) => {
      received = signal;
      controller.abort();
    },
  );
  restores.push(() => launch.mockRestore());
  setOpenUrlFactory(() => new UnobservedOpenURL(ios, new FakeAdbExecutor(), null, launcher, timer));
  await expect(
    handler("openLink")(ios, { url: "https://example.com" }, undefined, controller.signal),
  ).rejects.toThrow("Operation cancelled");
  expect(received).toBe(controller.signal);
}, 100);

test.each(["tap", "dismiss"])(
  "iOS systemTray %s forwards the exact request signal",
  async (action) => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    let dispatches = 0;
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    setSystemTrayDependencies({
      timer: new FakeTimer(),
      observeScreenFactory: () => ({ execute: async () => observation }),
      iosClientFactory: () => ({
        requestTapCoordinates: async (
          _x,
          _y,
          _duration?: number,
          _timeout?: number,
          _perf?: unknown,
          _frame?: string,
          signal?: AbortSignal,
        ) => {
          received = signal;
          dispatches++;
          started.resolve();
          await finish.promise;
          return { success: true };
        },
        requestSwipe: async (
          _x1,
          _y1,
          _x2,
          _y2,
          _duration,
          _timeout?: number,
          _perf?: unknown,
          _frame?: string,
          signal?: AbortSignal,
        ) => {
          received = signal;
          dispatches++;
          started.resolve();
          await finish.promise;
          return { success: true };
        },
      }),
    });
    const pending = handler("systemTray")(
      ios,
      { action, notification: { title: "Gamma" }, awaitTimeout: 5000 },
      undefined,
      controller.signal,
    );
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow("Operation cancelled");
    finish.resolve();
    expect(dispatches).toBe(1);
    expect(received).toBe(controller.signal);
  },
  100,
);

test("iOS systemTray swipe never dispatches after a cancelled connection wait", async () => {
  const h = delayedConnection();
  const proxy = new CtrlProxyGestures(h.context);
  const original = CtrlProxyGestures.prototype.requestSwipe;
  const delegate = spyOn(CtrlProxyGestures.prototype, "requestSwipe").mockImplementation(
    async (...args) => {
      try {
        return await original.apply(proxy, args);
      } finally {
        h.completed.resolve();
      }
    },
  );
  restores.push(() => delegate.mockRestore());
  // Exercise the default systemTray adapter and the real client's forwarding method.
  setSystemTrayDependencies({
    timer: h.timer,
    observeScreenFactory: () => ({
      execute: async () => ({ ...observation, viewHierarchy: undefined }),
    }),
  });
  const controller = new AbortController();
  const pending = handler("systemTray")(
    ios,
    { action: "open", awaitTimeout: 5000 },
    undefined,
    controller.signal,
  );
  await h.started.promise;
  controller.abort();
  await expect(pending).rejects.toThrow("Operation cancelled");
  h.connected.resolve(true);
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  h.timer.advanceTime(10000);
  await h.completed.promise;
  expect(h.sent).not.toHaveBeenCalled();
  expect(h.registered).not.toHaveBeenCalled();
}, 100);

test("pre-aborted homeScreen dispatches nothing", async () => {
  let dispatches = 0;
  const execute = spyOn(HomeScreen.prototype, "execute").mockImplementation(async () => {
    dispatches++;
    return { success: true, navigationMethod: "hardware" };
  });
  restores.push(() => execute.mockRestore());
  const controller = new AbortController();
  controller.abort();
  await expect(handler("homeScreen")(ios, {}, undefined, controller.signal)).rejects.toThrow(
    "Operation cancelled",
  );
  expect(dispatches).toBe(0);
}, 100);

test("homeScreen cancels during iOS foreground verification", async () => {
  const h = delayedConnection();
  const read = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const press = spyOn(h.client, "requestPressHome").mockResolvedValue({
    success: true,
    totalTimeMs: 0,
  });
  const hierarchy = spyOn(h.client, "requestHierarchySync").mockImplementation(async () => {
    read.resolve();
    await finish.promise;
    return {
      hierarchy: {
        packageName: "com.apple.springboard",
        updatedAt: 1,
        hierarchy: { className: "XCUIApplication" },
      },
    };
  });
  const observe = spyOn(HomeScreen.prototype, "observedInteraction").mockImplementation(
    async (block) => block(observation),
  );
  restores.push(
    () => press.mockRestore(),
    () => hierarchy.mockRestore(),
    () => observe.mockRestore(),
  );
  const controller = new AbortController();
  const pending = handler("homeScreen")(ios, {}, undefined, controller.signal);
  await read.promise;
  controller.abort();
  finish.resolve();
  await expect(pending).rejects.toThrow("Operation cancelled");
  expect(press).toHaveBeenCalledTimes(1);
  expect(hierarchy).toHaveBeenCalledTimes(1);
}, 100);
