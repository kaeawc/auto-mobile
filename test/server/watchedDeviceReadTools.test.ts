import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice, ObserveResult } from "../../src/models";
import {
  type InteractionToolDependencies,
  hitTestHandler,
} from "../../src/server/interactionTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { getStructuredField } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { installInMemoryNavManager } from "../helpers/navigationTestHarness";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

const interactionDeps: InteractionToolDependencies = {};
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
    delete interactionDeps.hitTestObservationFactory;
    delete interactionDeps.hitTestDeviceReadFactory;
  });

  test("a watcher reads the observer capture, never the session pipeline", async () => {
    const observation = loadAndroidHomeObserve().observe;
    const deviceReads: unknown[] = [];
    interactionDeps.hitTestObservationFactory = () => ({
      execute: async () => {
        throw new Error("the session pipeline must not run for a watcher");
      },
    });
    interactionDeps.hitTestDeviceReadFactory = (_device, display) => ({
      executeDeviceRead: async (_signal, screenshot) => {
        deviceReads.push({ display, screenshot });
        return observation;
      },
    });

    const response = await watching(() =>
      hitTestHandler(device, { x: 1, y: 2, display: "active" }, { deps: interactionDeps }),
    );

    expect(deviceReads).toEqual([{ display: "active", screenshot: "none" }]);
    expect(getStructuredField(response, "method")).toBe("hierarchy-bounds");
    expect(getStructuredField(response, "deviceId")).toBe(device.deviceId);
  });

  test("outside the read-only path it keeps the session pipeline", async () => {
    const observation = loadAndroidHomeObserve().observe;
    let sessionReads = 0;
    interactionDeps.hitTestObservationFactory = () => ({
      execute: async () => {
        sessionReads++;
        return observation;
      },
    });
    interactionDeps.hitTestDeviceReadFactory = () => ({
      executeDeviceRead: async () => {
        throw new Error("the observer capture is only for watchers");
      },
    });

    await hitTestHandler(device, { x: 1, y: 2 }, { deps: interactionDeps });

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
    const navigation = await installInMemoryNavManager();
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
      await navigation.dispose();
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
