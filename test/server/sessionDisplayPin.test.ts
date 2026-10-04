import { afterEach, beforeEach, expect, test } from "bun:test";
import { spyOn } from "bun:test";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { registerObserveTools } from "../../src/server/observeTools";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import {
  registerInteractionTools,
  setTapAnyElementFactory,
  resetTapAnyElementFactory,
  setTapOnElementFactory,
  resetTapOnElementFactory,
  setSwipeOnFactory,
  resetSwipeOnFactory,
} from "../../src/server/interactionTools";
import { withStaleDisplay } from "../../src/models/StaleDisplayError";
import { displayTransitions } from "../../src/features/observe/DisplayTransition";
import { z } from "zod/v4";
import { ToolRegistryClass, ToolRegistry } from "../../src/server/toolRegistry";
import { withPostFlattenJsonSchemaOverride } from "../../src/server/toolSchemaHelpers";
import { registerUtilityTools, setActiveDeviceSchema } from "../../src/server/utilityTools";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { DevicePoolRefresh } from "../../src/daemon/devicePoolRefresh";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeLogger } from "../fakes/FakeLogger";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import {
  createJSONToolResponse,
  createStructuredToolResponse,
  getStructuredPayload,
} from "../../src/utils/toolUtils";
import {
  resolveTargetDisplay,
  DisplaySelectionError,
} from "../../src/features/observe/DisplaySelection";
import { runSessionDisplayPin } from "../../src/server/sessionDisplayPin";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import {
  runWithSelectedDisplayPin,
  displayPinFailure,
} from "../../src/features/observe/SessionDisplayContext";
import { DeviceLostError } from "../../src/models/DeviceLostError";
import { ActionableError } from "../../src/models/ActionableError";
import { displayInventoryOutcome } from "../../src/models/DeviceInfo";
import { getToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { CachingDisplayInventoryProvider } from "../../src/devices/DisplayInventoryProvider";
import { FakeDisplayInventorySource } from "../fakes/FakeDisplayInventoryProvider";
import type { BootedDevice } from "../../src/models";

const device: BootedDevice = {
  deviceId: "pin-device",
  name: "Pin device",
  platform: "android",
  displays: {
    panels: [
      { key: "inside", role: "inner", sizePx: { width: 200, height: 200 } },
      { key: "outside", role: "cover", sizePx: { width: 100, height: 100 } },
    ],
    postures: ["opened", "closed"],
  },
};
let timer: FakeTimer;
let sessions: SessionManager;
let pool: DevicePool;
let provider: FakeDisplayInventoryProvider;
let previousFactory: ReturnType<typeof PlatformDeviceManagerFactory.getInstance>;

beforeEach(async () => {
  timer = new FakeTimer();
  sessions = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  const utils = new FakeDeviceUtils();
  previousFactory = PlatformDeviceManagerFactory.getInstance();
  PlatformDeviceManagerFactory.setInstance(utils);
  pool = new DevicePool(
    createDevicePoolDependencies(sessions, "test-pin-daemon", { timer, deviceManager: utils }),
  );
  await pool.initializeWithDevices([device]);
  await sessions.createSession("one", device.deviceId, "android");
  DaemonState.getInstance().initialize(sessions, pool);
  provider = new FakeDisplayInventoryProvider(device.displays);
  ToolRegistry.clearTools();
  registerUtilityTools({ displayInventory: provider });
});
afterEach(() => {
  resetTapAnyElementFactory();
  resetTapOnElementFactory();
  resetSwipeOnFactory();
  sessions.stopCleanupTimer();
  DaemonState.getInstance().reset();
  ToolRegistry.clearTools();
  PlatformDeviceManagerFactory.setInstance(previousFactory);
});

async function select(display?: unknown) {
  return ToolRegistry.getTool("setActiveDevice")!.handler({
    deviceId: device.deviceId,
    sessionUuid: "one",
    ...(display === undefined ? {} : { display }),
  });
}

test.each(["missing-device", device.deviceId])(
  "setActiveDevice rechecks %s after a failed refresh partially updates the pool",
  async (deviceId) => {
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", [device]);
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "failed-refresh", {
        timer,
        deviceManager: utils,
        devicePoolRefreshFactory: (port) =>
          new DevicePoolRefresh({
            ...port,
            setDeviceSessionTracking: async () => {
              throw new Error("tracking persistence unavailable");
            },
          }),
      }),
    );
    DaemonState.getInstance().initialize(sessions, pool);
    const handler = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });
    if (deviceId === device.deviceId) {
      expect(getStructuredPayload(await handler({ deviceId, sessionUuid: "one" }))).toMatchObject({
        deviceId,
        sessionUuid: "one",
      });
      expect(pool.getDevice(deviceId)).toBeDefined();
    } else {
      await expect(handler({ deviceId, sessionUuid: "one" })).rejects.toThrow(
        "Could not refresh device list: tracking persistence unavailable",
      );
    }
  },
);

test("setActiveDevice caps a multi-line refresh failure at its first line", async () => {
  const failure = `${"x".repeat(300)}\nsecond line must stay in logs`;
  const refresh = spyOn(pool, "refreshDevicesWithOutcome").mockResolvedValue({
    addedCount: 0,
    failure,
  });
  try {
    const handler = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });
    await expect(handler({ deviceId: "missing-device", sessionUuid: "one" })).rejects.toMatchObject(
      {
        message: `Could not refresh device list: ${"x".repeat(256)}. Resolve the cause and retry.`,
      },
    );
  } finally {
    refresh.mockRestore();
  }
});

// Passes on main too; guards the existing pooled-device fast path.
test("pin: setActiveDevice does not refresh when the requested device is already pooled", async () => {
  const refresh = spyOn(pool, "refreshDevicesWithOutcome");
  try {
    const handler = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });
    await handler({ deviceId: device.deviceId, sessionUuid: "one" });
    expect(refresh).not.toHaveBeenCalled();
  } finally {
    refresh.mockRestore();
  }
});

test("setActiveDevice reports device not found after a successful empty refresh", async () => {
  const utils = new FakeDeviceUtils();
  pool = new DevicePool(
    createDevicePoolDependencies(sessions, "empty-refresh", { timer, deviceManager: utils }),
  );
  DaemonState.getInstance().initialize(sessions, pool);
  const handler = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });
  await expect(handler({ deviceId: "missing-device", sessionUuid: "one" })).rejects.toThrow(
    "Device 'missing-device' not found in device pool",
  );
});

for (const inventoryKind of ["single", "empty", "one panel"] as const) {
  for (const selector of ["0", "active"] as const) {
    test(`${inventoryKind} inventory accepts ${selector} and honours the sole display pin`, async () => {
      const source = new FakeDisplayInventorySource({
        degraded: false,
        ...(inventoryKind === "single"
          ? {}
          : {
              displays: {
                panels:
                  inventoryKind === "empty"
                    ? []
                    : [{ key: "0", role: "unknown" as const, sizePx: { width: 100, height: 200 } }],
                postures: [],
              },
            }),
      });
      const inventory = new CachingDisplayInventoryProvider(source, source, timer);
      const single = { ...device, displays: undefined };
      await pool.initializeWithDevices([single]);
      const handler = createSetActiveDeviceHandler({
        displayInventory: inventory,
        resumeCtrlProxy: async () => {},
      });
      expect(
        getStructuredPayload(
          await handler({ deviceId: device.deviceId, sessionUuid: "one", display: selector }),
        ),
      ).toMatchObject({ displayPin: "0" });
      const target = await inventory.hydrate(single, "single-test");
      for (const name of ["observe", "tapOn", "tapAny"]) {
        const calls: unknown[] = [];
        const invoke = async (args: Record<string, unknown>) => {
          calls.push(args.display);
          const panel = resolveTargetDisplay(
            target.displays,
            args.display as string | undefined,
            {},
          );
          const display = { key: panel.key, role: panel.role, posture: "unknown", generation: 0 };
          return createStructuredToolResponse(
            name === "observe" ? { display } : { success: true, observation: { display } },
          );
        };
        const pinned = getStructuredPayload(
          (await runSessionDisplayPin({
            name,
            acceptsDisplay: true,
            device: target,
            args: {},
            sessionUuid: "one",
            store: sessions,
            invoke,
          })) as Parameters<typeof getStructuredPayload>[0],
        )!;
        const output = name === "observe" ? pinned : (pinned.observation as { display: unknown });
        expect(output.display).toMatchObject({ key: "0", pinned: true, generation: 0 });
        await runSessionDisplayPin({
          name,
          acceptsDisplay: true,
          device: target,
          args: { display: "active" },
          sessionUuid: "one",
          store: sessions,
          invoke,
        });
        expect(calls).toEqual(["0", "active"]);
      }
      await expect(
        handler({ deviceId: device.deviceId, sessionUuid: "one", display: "missing" }),
      ).rejects.toMatchObject({
        name: "InvalidDisplayPinError",
        message: expect.stringContaining("Available panels: 0 (unknown)"),
        details: { availablePanels: [{ key: "0", role: "unknown" }] },
      });
      expect(sessions.getDisplayPin("one")).toBe("0");
    });
  }
}

test("strict display schema adds nullable string without weakening other fields", () => {
  expect(
    setActiveDeviceSchema.safeParse({ deviceId: device.deviceId, display: "inner" }).success,
  ).toBe(true);
  expect(
    setActiveDeviceSchema.safeParse({ deviceId: device.deviceId, display: null }).success,
  ).toBe(true);
  for (const display of [12, {}, false]) {
    expect(setActiveDeviceSchema.safeParse({ deviceId: device.deviceId, display }).success).toBe(
      false,
    );
  }
  expect(setActiveDeviceSchema.safeParse({ deviceId: device.deviceId, extra: true }).success).toBe(
    false,
  );
});

test("set, replace, omit, and clear report the current session pin", async () => {
  const selected = await select("inner");
  expect(getStructuredPayload(selected)).toMatchObject({ displayPin: "inner" });
  expect(getStructuredPayload(selected)).toMatchObject({ displayPin: "inner" });
  expect(getStructuredPayload(await select("outside"))).toMatchObject({ displayPin: "outside" });
  expect(getStructuredPayload(await select())).toMatchObject({ displayPin: "outside" });
  expect(getStructuredPayload(await select(null))).toMatchObject({ displayPin: null });
  expect(sessions.getDisplayPin("one")).toBeUndefined();
});

for (const invalid of ["missing", "unknown", "active", "all", "", 12, false, {}]) {
  test(`invalid pin ${JSON.stringify(invalid)} is typed and does not replace`, async () => {
    sessions.updateSessionCache("one", { ...{ displayPin: "inner" } });
    let caught: unknown;
    try {
      await select(invalid);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: "InvalidDisplayPinError", details: { pin: invalid } });
    expect((caught as Error).message).toContain(
      "Available panels: inside (inner), outside (cover)",
    );
    expect(sessions.getSessionCache("one")?.displayPin).toBe("inner");
  });
}

test("invalid pin on a different target leaves original binding intact", async () => {
  await pool.initializeWithDevices([device, { ...device, deviceId: "other" }]);
  sessions.updateSessionCache("one", { ...{ displayPin: "inner" } });
  await expect(
    ToolRegistry.getTool("setActiveDevice")!.handler({
      deviceId: "other",
      sessionUuid: "one",
      display: "missing",
    }),
  ).rejects.toMatchObject({ name: "InvalidDisplayPinError" });
  expect(sessions.getDeviceForSession("one")).toBe(device.deviceId);
  expect(sessions.getSessionCache("one")?.displayPin).toBe("inner");
});

test("direct mode display refuses before device selection; omitted is unchanged", async () => {
  DaemonState.getInstance().reset();
  const manager = DeviceSessionManager.getInstance();
  const ready = spyOn(manager, "ensureDeviceReady").mockResolvedValue(device);
  const pin = spyOn(manager, "setExplicitDevicePin").mockImplementation(() => {});
  try {
    for (const display of ["inner", null]) {
      await expect(
        ToolRegistry.getTool("setActiveDevice")!.handler({ deviceId: device.deviceId, display }),
      ).rejects.toMatchObject({ name: "DisplayPinNeedsSessionError" });
    }
    expect(ready).not.toHaveBeenCalled();
    const response = await ToolRegistry.getTool("setActiveDevice")!.handler({
      deviceId: device.deviceId,
    });
    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            message: "Active device set to 'pin-device'",
            deviceId: device.deviceId,
          }),
        },
      ],
    });
    expect(pin).toHaveBeenCalledWith(device);
  } finally {
    ready.mockRestore();
    pin.mockRestore();
  }
});

function registry() {
  const registry = new ToolRegistryClass(new FakeTimer(), new FakeLogger());
  registry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
  registry.setPipelineOverridesForTesting({
    executionTargetResolver: {
      resolveExecutionTarget: async (input) => ({
        args: input.args,
        baseSessionUuid: "one",
        device,
        sessionUuid: "one",
        internalCall: false,
        shouldResolveDevice: true,
      }),
    },
    auditRunner: {
      run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
    },
    afterToolCall: {
      handle: async (input) => ({ durationMs: 0, finalizedResponse: input.response }),
    },
    planLifecycleManager: { afterExecution: async () => {} },
  });
  return registry;
}

for (const acceptsDisplay of [true, false]) {
  test(`display capability converts a shared schema once across registration and dispatch (display=${acceptsDisplay})`, async () => {
    let conversions = 0;
    const schema = withPostFlattenJsonSchemaOverride(
      acceptsDisplay ? z.object({ display: z.string().optional() }) : z.object({}),
      () => {
        conversions++;
      },
    );
    sessions.setDisplayPin("one", "inner");
    const tools = registry();
    const response = createStructuredToolResponse({ success: true });
    const handler = async (_target: BootedDevice, args: Record<string, unknown>) => {
      expect(args.display).toBe(acceptsDisplay ? "inside" : undefined);
      return response;
    };
    for (const name of ["first", "second", "first"]) {
      tools.registerDeviceAware(name, "shared schema probe", schema, handler);
      expect(tools.getTool(name)!.deviceAwareHandler).toBe(handler);
      expect(await tools.getTool(name)!.handler({})).toBe(response);
      for (let dispatch = 0; dispatch < 2; dispatch++) {
        expect(
          await tools.callInternal(name, {}, undefined, undefined, {
            targetDevice: device,
            sessionUuid: "one",
          }),
        ).toBe(response);
      }
    }
    expect(conversions).toBe(1);
  });
}

for (const schema of [
  {},
  { properties: { display: { type: "string" } } },
  { parse: (value: unknown) => value },
]) {
  test(`non-zod schema ${JSON.stringify(schema)} registers and dispatches without display injection`, async () => {
    sessions.setDisplayPin("one", "unplugged");
    const tools = registry();
    const response = createStructuredToolResponse({ success: true });
    const handler = async (_target: BootedDevice, args: Record<string, unknown>) => {
      expect(args).not.toHaveProperty("display");
      return response;
    };
    tools.registerDeviceAware("plain", "plain schema probe", schema, handler);
    expect(tools.getTool("plain")!.deviceAwareHandler).toBe(handler);
    expect(await tools.getTool("plain")!.handler({})).toBe(response);
    expect(
      await tools.callInternal("plain", {}, undefined, undefined, {
        targetDevice: device,
        sessionUuid: "one",
      }),
    ).toBe(response);
  });
}

for (const targetDevice of [undefined, device]) {
  test(`nested display-aware dispatch inherits the routing session with supplied device=${!!targetDevice}`, async () => {
    sessions.setDisplayPin("one", "inner");
    const tools = registry();
    tools.registerDeviceAware(
      "inner",
      "nested display probe",
      z.object({ display: z.string().optional() }),
      async (_target, args) => {
        expect(args.display).toBe("inside");
        expect(args.sessionUuid).toBe("one");
        expect(getToolSelectionContext()?.routingSessionUuid).toBe("one");
        return createStructuredToolResponse({
          display: { key: args.display, role: "inner", posture: "opened", generation: 0 },
        });
      },
    );
    tools.registerDeviceAware("outer", "nested caller", z.object({}), async () =>
      tools.callInternal("inner", {}, undefined, undefined, { targetDevice }),
    );
    expect(getStructuredPayload(await tools.getTool("outer")!.handler({}))?.display).toMatchObject({
      key: "inside",
      pinned: true,
    });
  });
}

for (const name of [
  "observe",
  "tapOn",
  "swipeOn",
  "tapAt",
  "pinchOn",
  "dragAndDrop",
  "sendKeys",
  "captureScreenshot",
  "hitTest",
  "videoRecording",
]) {
  test(`${name} shared seam routes omitted display to pin and explicit active bypasses it`, async () => {
    sessions.updateSessionCache("one", { ...{ displayPin: "inner" } });
    const calls: string[] = [];
    const tools = registry();
    tools.registerDeviceAware(
      name,
      "probe",
      z.object({ display: z.string().optional() }),
      async (target, args) => {
        const selected = resolveTargetDisplay(target.displays, args.display, {
          focusedPanelKey: "outside",
          posture: "closed",
        });
        calls.push(selected.key);
        const display = {
          key: selected.key,
          role: selected.role,
          posture: "closed",
          generation: 0,
        };
        return createStructuredToolResponse(
          name === "observe" ? { display } : { success: true, observation: { display } },
        );
      },
    );
    const first = getStructuredPayload(await tools.getTool(name)!.handler({}));
    const stamp =
      name === "observe" ? first?.display : (first?.observation as { display: unknown }).display;
    expect(stamp).toMatchObject({ key: "inside", pinned: true });
    const explicit = getStructuredPayload(
      await tools.getTool(name)!.handler({ display: "active" }),
    );
    const explicitStamp =
      name === "observe"
        ? explicit?.display
        : (explicit?.observation as { display: unknown }).display;
    expect(explicitStamp).toMatchObject({ key: "outside" });
    expect(explicitStamp).not.toHaveProperty("pinned");
    expect(calls).toEqual(["inside", "outside"]);
  });

  test(`${name} missing panel refuses before any handler or dispatch`, async () => {
    sessions.updateSessionCache("one", { ...{ displayPin: "unplugged" } });
    const tools = registry();
    let dispatches = 0;
    const executor = new FakeAdbExecutor();
    tools.registerDeviceAware(
      name,
      "probe",
      z.object({ display: z.string().optional() }),
      async () => {
        await executor.executeCommand("unexpected input or capture");
        dispatches++;
        return createStructuredToolResponse({ success: true });
      },
    );
    let response: unknown;
    let failure: unknown;
    try {
      response = await tools.getTool(name)!.handler({});
    } catch (error) {
      failure = error;
    }
    const details =
      failure ?? getStructuredPayload(response as Parameters<typeof getStructuredPayload>[0]);
    expect(details).toMatchObject(
      name === "observe" || name === "captureScreenshot"
        ? { name: "PinnedDisplayUnavailableError", details: { pin: "unplugged" } }
        : { success: false, pinnedDisplay: { pin: "unplugged" } },
    );
    expect(dispatches).toBe(0);
    expect(executor.getExecutedCommands()).toEqual([]);
  });
}

test("live-panel rejection is typed as pin error", async () => {
  sessions.updateSessionCache("one", { ...{ displayPin: "inner" } });
  const tools = registry();
  tools.registerDeviceAware(
    "observe",
    "probe",
    z.object({ display: z.string().optional() }),
    async () => {
      throw new DisplaySelectionError(
        'Display "inside" is not the active panel on iOS. Active panel: outside',
      );
    },
  );
  await expect(tools.getTool("observe")!.handler({})).rejects.toMatchObject({
    name: "PinnedDisplayUnavailableError",
    details: { pin: "inner" },
  });
});

for (const name of ["observe", "tapOn", "tapAny", "swipeOn"] as const) {
  test(`${name} registered handler receives the effective panel and dispatches through its fake`, async () => {
    sessions.updateSessionCache("one", { ...{ displayPin: "inner" } });
    const executor = new FakeAdbExecutor();
    const selectedPanels: string[] = [];
    const capture = (display: string | undefined) => {
      const panel = resolveTargetDisplay(device.displays, display, {
        focusedPanelKey: "outside",
        posture: "closed",
      });
      selectedPanels.push(panel.key);
      const observation = structuredClone(loadAndroidHomeObserve().observe);
      observation.backStack = undefined;
      observation.display = { key: panel.key, role: panel.role, posture: "closed", generation: 0 };
      return observation;
    };
    const notify = spyOn(ResourceRegistry, "notifyResourcesUpdated").mockResolvedValue();
    const observe = new FakeObserveScreen();
    registerObserveTools({
      timer: new FakeTimer(),
      createScreen: (_device, display) => ({
        execute: async () => {
          const observation = capture(display);
          await executor.executeCommand(`capture panel ${observation.display.key}`);
          return observation;
        },
        executeDeviceRead: async () => capture(display),
        appendRawViewHierarchy: observe.appendRawViewHierarchy.bind(observe),
        getMostRecentCachedObserveResult: observe.getMostRecentCachedObserveResult.bind(observe),
      }),
    });
    setTapOnElementFactory(() => ({
      execute: async (options) => {
        const observation = capture(options.display);
        await executor.executeCommand(`tap panel ${observation.display.key}`);
        return { success: true, action: "tap", element: {}, observation };
      },
    }));
    setTapAnyElementFactory(() => ({
      execute: async (options) => {
        const observation = capture(options.display);
        await executor.executeCommand(`tap panel ${observation.display.key}`);
        return { success: true, action: "tap", element: {}, observation };
      },
    }));
    setSwipeOnFactory(() => ({
      execute: async (options) => {
        const observation = capture(options.display);
        await executor.executeCommand(`swipe panel ${observation.display.key}`);
        return {
          success: true,
          targetType: "screen",
          x1: 1,
          y1: 1,
          x2: 2,
          y2: 2,
          duration: 0,
          observation,
        };
      },
    }));
    registerInteractionTools();
    const args =
      name === "tapOn"
        ? { selector: { text: "Settings" } }
        : name === "swipeOn"
          ? { direction: "up" }
          : {};
    try {
      for (const [display, key, pinned] of [
        [undefined, "inside", true],
        ["cover", "outside", false],
        ["active", "outside", false],
      ] as const) {
        const response = await ToolRegistry.callInternal(
          name,
          {
            ...args,
            ...(display === undefined ? {} : { display }),
          },
          undefined,
          undefined,
          { targetDevice: device, sessionUuid: "one" },
        );
        const payload = getStructuredPayload(response)!;
        const output = name === "observe" ? payload : (payload.observation as { display: unknown });
        expect(output.display).toMatchObject({ key });
        expect((output.display as { pinned?: true }).pinned).toBe(pinned ? true : undefined);
      }
      expect(selectedPanels).toEqual(["inside", "outside", "outside"]);
      expect(executor.getExecutedCommands()).toEqual([
        `${name === "observe" ? "capture" : name === "tapOn" || name === "tapAny" ? "tap" : "swipe"} panel inside`,
        `${name === "observe" ? "capture" : name === "tapOn" || name === "tapAny" ? "tap" : "swipe"} panel outside`,
        `${name === "observe" ? "capture" : name === "tapOn" || name === "tapAny" ? "tap" : "swipe"} panel outside`,
      ]);
    } finally {
      notify.mockRestore();
    }
  });
}

for (const name of ["tapOn", "swipeOn", "sendKeys"]) {
  test(`${name} swallowed live-display refusal preserves typed pin details in failure channel`, async () => {
    sessions.updateSessionCache("one", { ...{ displayPin: "inner" } });
    const tools = registry();
    tools.registerDeviceAware(
      name,
      "probe",
      z.object({ display: z.string().optional() }),
      async () => {
        const error = new DisplaySelectionError(
          'Display panel "inside" is not currently connected.',
        );
        return {
          ...createStructuredToolResponse(
            withStaleDisplay({ success: false, error: error.message }, error),
          ),
          isError: true,
        };
      },
    );
    const response = await tools.getTool(name)!.handler({});
    expect(getStructuredPayload(response)).toMatchObject({
      success: false,
      pinnedDisplay: {
        pin: "inner",
        availablePanels: [
          { key: "inside", role: "inner" },
          { key: "outside", role: "cover" },
        ],
      },
    });
    expect(getStructuredPayload(response)?.error).toContain("setActiveDevice {display: null}");
    expect(response.isError).toBe(true);
  });
}

test("pin marker does not mutate cached stamps or advance display identity generation", async () => {
  sessions.updateSessionCache("one", { ...{ displayPin: "inner" } });
  const tools = registry();
  const stamp = {
    key: "inside",
    role: "inner" as const,
    posture: "opened" as const,
    generation: 0,
  };
  tools.registerDeviceAware(
    "observe",
    "probe",
    z.object({ display: z.string().optional() }),
    async () => createStructuredToolResponse({ display: stamp }),
  );
  const pinned = getStructuredPayload(await tools.getTool("observe")!.handler({}))!;
  expect(pinned.display).toMatchObject({ pinned: true });
  expect(stamp).not.toHaveProperty("pinned");
  sessions.setDisplayPin("one", null);
  const unpinned = getStructuredPayload(await tools.getTool("observe")!.handler({}))!;
  expect(unpinned.display).toBe(stamp);
  expect(unpinned.display).not.toHaveProperty("pinned");
  const observation = structuredClone(loadAndroidHomeObserve().observe);
  observation.display = stamp;
  displayTransitions.reset(device.deviceId);
  displayTransitions.record(device.deviceId, observation);
  const generation = displayTransitions.identityRevision(device.deviceId);
  observation.display = { ...stamp, pinned: true };
  displayTransitions.record(device.deviceId, observation);
  expect(displayTransitions.identityRevision(device.deviceId)).toBe(generation);
  displayTransitions.reset(device.deviceId);
});

test("video stop and tools with no display schema remain callable with a missing pin", async () => {
  sessions.updateSessionCache("one", { ...{ displayPin: "unplugged" } });
  const tools = registry();
  let calls = 0;
  for (const name of ["videoRecording", "plain"]) {
    tools.registerDeviceAware(
      name,
      "probe",
      name === "plain" ? z.object({}) : z.object({ display: z.string().optional() }),
      async (_device, args) => {
        expect(args).not.toHaveProperty("display");
        calls++;
        return createStructuredToolResponse({ success: true });
      },
    );
    expect(
      getStructuredPayload(await tools.getTool(name)!.handler({ action: "stop" }))?.success,
    ).toBe(true);
  }
  expect(calls).toBe(2);
});

test("another session's pin cannot select this device", async () => {
  await sessions.createSession("two", "different-device", "android");
  sessions.setDisplayPin("two", "unplugged");
  const tools = registry();
  tools.registerDeviceAware(
    "observe",
    "probe",
    z.object({ display: z.string().optional() }),
    async (_target, args) => {
      expect(args.display).toBeUndefined();
      return createStructuredToolResponse({ success: true });
    },
  );
  expect(
    getStructuredPayload(
      await tools.callInternal("observe", {}, undefined, undefined, {
        targetDevice: device,
        sessionUuid: "two",
      }),
    )?.success,
  ).toBe(true);
});

test("daemon mode without a session refuses display and does not read inventory", async () => {
  await expect(
    ToolRegistry.getTool("setActiveDevice")!.handler({
      deviceId: device.deviceId,
      display: "inner",
    }),
  ).rejects.toMatchObject({ name: "DisplayPinNeedsSessionError" });
  expect(provider.calls).toBe(0);
});

test("null clears an unavailable pin without needing inventory; omitted does not read it", async () => {
  sessions.updateSessionCache("one", { ...{ displayPin: "unplugged" } });
  expect(getStructuredPayload(await select())).toMatchObject({ displayPin: "unplugged" });
  expect(provider.calls).toBe(0);
  expect(getStructuredPayload(await select(null))).toMatchObject({ displayPin: null });
  expect(provider.calls).toBe(0);
});

test("a successful device rebind with display omitted clears the old pin", async () => {
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", [device, { ...device, deviceId: "other" }]);
  Reflect.set(pool, "deviceManager", utils);
  await pool.initializeWithDevices([device, { ...device, deviceId: "other" }]);
  sessions.setDisplayPin("one", "inner");
  const response = await ToolRegistry.getTool("setActiveDevice")!.handler({
    deviceId: "other",
    sessionUuid: "one",
  });
  expect(sessions.getDeviceForSession("one")).toBe("other");
  expect(getStructuredPayload(response)).toMatchObject({ displayPin: null });
});

test("each string pin update refreshes inventory and a disappeared role leaves the pin unchanged", async () => {
  await select("inner");
  provider.displays = { panels: device.displays!.panels.slice(1), postures: ["closed"] };
  await expect(select("inner")).rejects.toMatchObject({
    name: "InvalidDisplayPinError",
    details: { pin: "inner", availablePanels: [{ key: "outside", role: "cover" }] },
  });
  expect(sessions.getDisplayPin("one")).toBe("inner");
  expect(provider.invalidations).toEqual([device.deviceId, device.deviceId]);
});

for (const name of ["observe", "tapOn", "tapAny", "swipeOn"]) {
  for (const scenario of ["no session", "no pin", "different device", "no display schema"]) {
    test(`${name} ${scenario} returns the identical frozen envelope without body reads or context changes`, async () => {
      sessions.setDisplayPin("one", scenario === "no pin" ? null : "inner");
      const tools = registry();
      let reads = 0;
      const response = Object.freeze(
        Object.defineProperties(
          {},
          Object.fromEntries(
            ["body", "content", "structuredContent"].map((key) => [
              key,
              {
                get: () => {
                  reads++;
                  throw new Error(`Unexpected ${key} read`);
                },
              },
            ]),
          ),
        ),
      );
      const routingFailure = new DisplaySelectionError("panel disconnected");
      let mappedFailure: unknown;
      const innerPromise = Promise.resolve(response);
      tools.registerDeviceAware(
        name,
        "identity probe",
        scenario === "no display schema"
          ? z.object({})
          : z.object({ display: z.string().optional() }),
        (_target, args) => {
          expect(args).not.toHaveProperty("display");
          mappedFailure = displayPinFailure(routingFailure);
          return innerPromise;
        },
      );
      const returned = runWithSelectedDisplayPin(
        { pin: "outside", inventory: device.displays },
        () =>
          runSessionDisplayPin({
            name,
            acceptsDisplay: scenario !== "no display schema",
            device: scenario === "different device" ? { ...device, deviceId: "other" } : device,
            args: scenario === "no session" ? {} : { sessionUuid: "one" },
            sessionUuid: scenario === "no session" ? undefined : "one",
            invoke: (args) => tools.getTool(name)!.deviceAwareHandler!(device, args),
          }),
      );
      expect(returned).toBe(innerPromise);
      expect(await returned).toBe(response);
      expect(
        await runWithSelectedDisplayPin({ pin: "outside", inventory: device.displays }, () =>
          tools.callInternal(
            name,
            scenario === "no session" ? {} : { sessionUuid: "one" },
            undefined,
            undefined,
            {
              targetDevice:
                scenario === "different device" ? { ...device, deviceId: "other" } : device,
            },
          ),
        ),
      ).toBe(response);
      expect(reads).toBe(0);
      expect(mappedFailure).toMatchObject({ name: "PinnedDisplayUnavailableError" });
    });
  }
  test(`${name} no pin preserves handler text bytes and payload identity`, async () => {
    const payload = {
      display: { key: "inside", generation: 0 },
      observation: { display: { key: "inside", generation: 0 } },
    };
    const response = createStructuredToolResponse(payload);
    response.content[0].text = JSON.stringify(payload, null, 2);
    const text = response.content[0].text;
    const result = await runSessionDisplayPin({
      name,
      acceptsDisplay: true,
      device,
      args: {},
      sessionUuid: "one",
      store: sessions,
      invoke: async () => response,
    });
    expect(result).toBe(response);
    expect(response.structuredContent).toBe(payload);
    expect(response.content[0].text).toBe(text);
  });
}

test("session setActiveDevice without display matches main's entire JSON envelope", async () => {
  const expected = createJSONToolResponse({
    message: "Active device set to 'pin-device'",
    deviceId: device.deviceId,
    sessionUuid: "one",
  });
  const response = await select();
  expect(response).toEqual(expected);
  expect(response.content[0].text).toBe(expected.content[0].text);
  expect(response).not.toHaveProperty("structuredContent");
  expect(ToolRegistry.getTool("setActiveDevice")!.outputSchema).toBeUndefined();
});

test("legacy setActiveDevice without display matches main's entire JSON envelope and registration", async () => {
  DaemonState.getInstance().reset();
  const manager = DeviceSessionManager.getInstance();
  const ready = spyOn(manager, "ensureDeviceReady").mockResolvedValue(device);
  const pin = spyOn(manager, "setExplicitDevicePin").mockImplementation(() => {});
  try {
    const expected = createJSONToolResponse({
      message: "Active device set to 'pin-device'",
      deviceId: device.deviceId,
    });
    const response = await ToolRegistry.getTool("setActiveDevice")!.handler({
      deviceId: device.deviceId,
    });
    expect(response).toEqual(expected);
    expect(response.content[0].text).toBe(expected.content[0].text);
    expect(response).not.toHaveProperty("structuredContent");
    expect(ToolRegistry.getTool("setActiveDevice")!.outputSchema).toBeUndefined();
  } finally {
    ready.mockRestore();
    pin.mockRestore();
  }
});

test("setActiveDevice with display adds the resulting pin to main's JSON envelope", async () => {
  expect(await select("inner")).toEqual(
    createJSONToolResponse({
      message: "Active device set to 'pin-device'",
      deviceId: device.deviceId,
      sessionUuid: "one",
      displayPin: "inner",
    }),
  );
});

test("omitted display preserves main's routing order without accessing the inventory dependency", async () => {
  const steps: string[] = [];
  const poolDevice = pool.getDevice(device.deviceId)!;
  const getDevice = spyOn(pool, "getDevice").mockImplementation(() => {
    steps.push("lookup");
    return { ...poolDevice, id: "other", sessionId: "old" };
  });
  const cleanup = spyOn(pool, "assertDeviceCleanupComplete").mockImplementation(() => {
    steps.push("cleanup");
  });
  const originalGetSession = sessions.getSession.bind(sessions);
  const getSession = spyOn(sessions, "getSession");
  getSession.mockImplementation((id) => {
    if (id === "old") {
      steps.push("owner");
      return null;
    }
    if (id === "one") {
      steps.push("existing");
    }
    return originalGetSession(id);
  });
  const bind = spyOn(pool, "bindOrReuseDeviceSession").mockImplementation(async (...args) => {
    steps.push("bind");
    expect(args).toEqual(["one", "other", "android", undefined, undefined, undefined, true]);
    return "one";
  });
  const readiness = spyOn(sessions, "setDeviceReadiness").mockImplementation(() => {
    steps.push("readiness");
  });
  try {
    const handler = createSetActiveDeviceHandler({
      get displayInventory() {
        throw new Error("Omitted display must not access inventory");
      },
      resumeCtrlProxy: async (id, platform) => {
        expect([id, platform]).toEqual(["other", "android"]);
        steps.push("resume");
      },
    });
    await handler({ deviceId: "other", sessionUuid: "one" });
    expect(steps.slice(steps.indexOf("cleanup"), steps.indexOf("readiness") + 1)).toEqual([
      "cleanup",
      "resume",
      "owner",
      "existing",
      "bind",
      "readiness",
    ]);
    expect(steps[0]).toBe("lookup");
  } finally {
    getDevice.mockRestore();
    cleanup.mockRestore();
    getSession.mockRestore();
    bind.mockRestore();
    readiness.mockRestore();
  }
});

for (const failure of [
  new DeviceLostError("pin-device", "device dropped"),
  new DOMException("cancelled", "AbortError"),
  AbortSignal.abort(new Error("signal reason")).reason,
  new ActionableError("handler failure"),
]) {
  test(`pinned handler preserves original ${failure.name}: ${failure.message}`, async () => {
    sessions.setDisplayPin("one", "inner");
    await expect(
      runSessionDisplayPin({
        name: "observe",
        acceptsDisplay: true,
        device,
        args: {},
        sessionUuid: "one",
        store: sessions,
        invoke: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });
}

test("failed plain selection leaves session activity unchanged", async () => {
  await sessions.createSession("owner", "owned", "android");
  const original = pool.getDevice(device.deviceId)!;
  const lookup = spyOn(pool, "getDevice").mockReturnValue({ ...original, sessionId: "owner" });
  const session = sessions.getSession("one")!;
  const activity = () => ({
    lastHeartbeat: session.lastHeartbeat,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
    activityGeneration: session.activityGeneration,
  });
  const before = activity();
  timer.advanceTime(1000);
  try {
    await expect(select()).rejects.toThrow("already assigned");
    expect(activity()).toEqual(before);
  } finally {
    lookup.mockRestore();
  }
});

test("successful plain selection of the bound device adds no session activity", async () => {
  const before = structuredClone(sessions.getSession("one")!);
  timer.advanceTime(1000);
  await select();
  expect(sessions.getSession("one")).toEqual(before);
});

test("pin clear restores the complete main response envelope on the next plain call", async () => {
  const payload = {
    message: "Active device set to 'pin-device'",
    deviceId: device.deviceId,
    sessionUuid: "one",
  };
  expect(await select()).toEqual(createJSONToolResponse(payload));
  await select("inner");
  expect(await select()).toEqual(createJSONToolResponse({ ...payload, displayPin: "inner" }));
  expect(await select(null)).toEqual(createJSONToolResponse({ ...payload, displayPin: null }));
  expect(await select()).toEqual(createJSONToolResponse(payload));
});

for (const name of ["observe", "tapOn", "tapAny", "swipeOn"]) {
  for (const degraded of [false, true]) {
    test(`${name} unreadable inventory degraded=${degraded} is retryable and never dispatches`, async () => {
      sessions.setDisplayPin("one", "inner");
      let dispatches = 0;
      const target: BootedDevice = degraded
        ? { ...device, [displayInventoryOutcome]: { kind: "unreadable", reason: "probe failed" } }
        : { ...device, displays: undefined };
      const result = runSessionDisplayPin({
        name,
        acceptsDisplay: true,
        device: target,
        args: {},
        sessionUuid: "one",
        store: sessions,
        invoke: async () => {
          dispatches++;
          return {};
        },
      });
      if (name === "observe") {
        await expect(result).rejects.toMatchObject({
          name: "DisplayInventoryUnavailableError",
          details: { pin: "inner", retryable: true },
        });
      } else {
        const response = await result;
        expect(
          getStructuredPayload(response as Parameters<typeof getStructuredPayload>[0]),
        ).toMatchObject({
          success: false,
          error: expect.stringContaining("retry"),
          displayInventory: { pin: "inner", retryable: true },
        });
        expect(response).toMatchObject({ isError: true });
      }
      expect(dispatches).toBe(0);
      expect(sessions.getDisplayPin("one")).toBe("inner");
    });
  }
}

for (const outcome of ["throws", "no inventory", "degraded", "degraded panels"] as const) {
  test(`setting a pin with ${outcome} fails retryably and preserves the old pin`, async () => {
    sessions.setDisplayPin("one", "cover");
    const source = new FakeDisplayInventorySource({
      degraded: outcome.startsWith("degraded"),
      ...(outcome === "degraded panels"
        ? {
            displays: device.displays,
            outcome: { kind: "unreadable" as const, reason: "partial read" },
          }
        : {}),
    });
    if (outcome === "throws") {
      spyOn(source, "read").mockRejectedValue(new Error("probe failed"));
    }
    const inventory =
      outcome === "no inventory"
        ? new FakeDisplayInventoryProvider()
        : new CachingDisplayInventoryProvider(source, source, timer);
    const handler = createSetActiveDeviceHandler({
      displayInventory: inventory,
      resumeCtrlProxy: async () => {},
    });
    await expect(
      handler({ deviceId: device.deviceId, sessionUuid: "one", display: "inner" }),
    ).rejects.toMatchObject({
      name: "DisplayInventoryUnavailableError",
      details: { pin: "inner", retryable: true },
    });
    expect(sessions.getDisplayPin("one")).toBe("cover");
  });
}

test("readable single and zero-panel inventories still report an absent pin", async () => {
  sessions.setDisplayPin("one", "inner");
  for (const target of [
    { ...device, displays: { panels: [], postures: [] } },
    { ...device, displays: undefined, [displayInventoryOutcome]: { kind: "single" as const } },
  ]) {
    await expect(
      runSessionDisplayPin({
        name: "observe",
        acceptsDisplay: true,
        device: target,
        args: {},
        sessionUuid: "one",
        store: sessions,
        invoke: async () => ({}),
      }),
    ).rejects.toMatchObject({ name: "PinnedDisplayUnavailableError" });
  }
});

for (const name of ["observe", "tapOn", "tapAny", "swipeOn"]) {
  test(`${name} no pin returns synchronous handler values unchanged`, () => {
    const value = Object.freeze({ success: true });
    expect(
      runSessionDisplayPin({
        name,
        acceptsDisplay: true,
        device,
        args: {},
        sessionUuid: "one",
        store: sessions,
        invoke: () => value,
      }),
    ).toBe(value);
  });
}

test("registered tapAny missing pin reports typed details without dispatch", async () => {
  sessions.setDisplayPin("one", "unplugged");
  let dispatches = 0;
  setTapAnyElementFactory(() => ({
    execute: async () => {
      dispatches++;
      return { success: true, element: {} };
    },
  }));
  registerInteractionTools();
  const response = await ToolRegistry.callInternal("tapAny", {}, undefined, undefined, {
    targetDevice: device,
    sessionUuid: "one",
  });
  expect(response.isError).toBe(true);
  expect(getStructuredPayload(response)).toMatchObject({
    success: false,
    pinnedDisplay: { pin: "unplugged" },
  });
  expect(dispatches).toBe(0);
});
