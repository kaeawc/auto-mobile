import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice, ObserveResult } from "../../src/models";
import {
  hitTestHandler,
  resetHitTestDeviceReadFactory,
  resetHitTestObservationFactory,
  setHitTestDeviceReadFactory,
  setHitTestObservationFactory,
} from "../../src/server/interactionTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { getStructuredField } from "../../src/utils/toolUtils";
import { FakeNavigationGraphManager } from "../fakes/FakeNavigationGraphManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/**
 * hitTest and identifyInteractions are reads (#10965). On the read-only device path (a watcher of
 * a held device) they read through the observer capture, connect-only like `observe {deviceId}`,
 * and never through the holder's session observe pipeline or its cache (#10828).
 */
const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const watching = <T>(fn: () => Promise<T>) =>
  runWithToolSelectionContext({ explicitObserveDeviceRead: true }, fn);

describe("hitTest on the read-only device path (#10965)", () => {
  afterEach(() => {
    resetHitTestObservationFactory();
    resetHitTestDeviceReadFactory();
  });

  test("a watcher reads the observer capture, never the session pipeline", async () => {
    const observation = loadAndroidHomeObserve().observe;
    const deviceReads: unknown[] = [];
    setHitTestObservationFactory(() => ({
      execute: async () => {
        throw new Error("the session pipeline must not run for a watcher");
      },
    }));
    setHitTestDeviceReadFactory((_device, display) => ({
      executeDeviceRead: async (_signal, screenshot) => {
        deviceReads.push({ display, screenshot });
        return observation;
      },
    }));

    const response = await watching(() =>
      hitTestHandler(device, { x: 1, y: 2, display: "active" }),
    );

    expect(deviceReads).toEqual([{ display: "active", screenshot: "none" }]);
    expect(getStructuredField(response, "method")).toBe("hierarchy-bounds");
    expect(getStructuredField(response, "deviceId")).toBe(device.deviceId);
  });

  test("outside the read-only path it keeps the session pipeline", async () => {
    const observation = loadAndroidHomeObserve().observe;
    let sessionReads = 0;
    setHitTestObservationFactory(() => ({
      execute: async () => {
        sessionReads++;
        return observation;
      },
    }));
    setHitTestDeviceReadFactory(() => ({
      executeDeviceRead: async () => {
        throw new Error("the observer capture is only for watchers");
      },
    }));

    await hitTestHandler(device, { x: 1, y: 2 });

    expect(sessionReads).toBe(1);
  });
});

describe("identifyInteractions on the read-only device path (#10965)", () => {
  let previousDebugMode = false;
  beforeAll(() => {
    previousDebugMode = isDebugModeEnabled();
    setDebugModeEnabled(true);
  });
  afterAll(() => setDebugModeEnabled(previousDebugMode));

  async function identify(watcher: boolean) {
    const observation = loadAndroidHomeObserve().observe as ObserveResult;
    const calls: string[] = [];
    const navigation = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
      new FakeNavigationGraphManager() as unknown as NavigationGraphManager,
    );
    try {
      registerObserveTools({
        timer: new FakeTimer(),
        createScreen: () =>
          ({
            execute: async () => {
              calls.push("execute");
              return observation;
            },
            executeDeviceRead: async (_signal: unknown, screenshot: unknown) => {
              calls.push(`executeDeviceRead:${String(screenshot)}`);
              return observation;
            },
            getMostRecentCachedObserveResult: async () => {
              calls.push("cache");
              return observation;
            },
          }) as never,
      });
      const tool = ToolRegistry.getTool("identifyInteractions")!;
      const run = () =>
        tool.deviceAwareHandler!(device, { includeContext: { navigationGraph: false } });
      await (watcher ? watching(run) : run());
      return calls;
    } finally {
      navigation.mockRestore();
      ToolRegistry.clearTools();
    }
  }

  test("a watcher reads a fresh observer capture, never the session cache", async () => {
    expect(await identify(true)).toEqual(["executeDeviceRead:none"]);
  });

  test("outside the read-only path it reads the session cache", async () => {
    expect(await identify(false)).toContain("cache");
  });
});
