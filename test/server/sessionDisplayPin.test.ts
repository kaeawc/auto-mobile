import { sessionDisplayPinnedHandler } from "../../src/server/pipeline/deviceCallDispatch";
import { readToolEnvelopePayload } from "../../src/utils/toolEnvelopePayload";
import { afterEach, expect, test } from "bun:test";
import { spyOn } from "bun:test";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { registerObserveTools } from "../../src/server/observeTools";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import {
  type InteractionToolDependencies,
  registerInteractionTools,
} from "../../src/server/interactionTools";
import { withStaleDisplay } from "../../src/features/observe/StaleDisplayError";
import { displayTransitions } from "../../src/features/observe/DisplayTransition";
import { z } from "zod/v4";
import { ToolRegistryClass, ToolRegistry } from "../../src/server/toolRegistry";
import { withPostFlattenJsonSchemaOverride } from "../../src/utils/schemaHelpers";
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
import { snapshotPlatformDeviceManagerFactory } from "../helpers/platformDeviceManagerSnapshot";
import { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import {
  resolveTargetDisplay,
  DisplaySelectionError,
} from "../../src/features/observe/DisplaySelection";
import { runSessionDisplayPin } from "../../src/server/sessionDisplayPin";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import {
  runWithSelectedDisplayPin,
  displayPinFailure,
  selectedDisplayPin,
} from "../../src/features/observe/SessionDisplayContext";
import { DeviceLostError } from "../../src/models/DeviceLostError";
import { ActionableError } from "../../src/models/ActionableError";
import { displayInventoryOutcome } from "../../src/models/DeviceInfo";
import { getToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { CachingDisplayInventoryProvider } from "../../src/devices/DisplayInventoryProvider";
import { FakeDisplayInventorySource } from "../fakes/FakeDisplayInventoryProvider";
import type { BootedDevice } from "../../src/models";
import { settleEmbeddedObservationInResponse } from "../../src/server/embeddedObservationSettle";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

const toolResponseSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});

isolateToolRegistry();

const interactionDeps: InteractionToolDependencies = {};
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
let restoreFactory: () => void;

async function arrangeHarness(): Promise<void> {
  timer = new FakeTimer();
  sessions = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  const utils = new FakeDeviceUtils();
  restoreFactory = snapshotPlatformDeviceManagerFactory();
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
}

// Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
  test(
    name,
    async () => {
      await arrangeHarness();
      await fn();
    },
    timeout,
  );
}

function arrangedEach<T>(table: readonly T[]) {
  return (name: string, fn: (row: T) => void | Promise<void>, timeout?: number): void => {
    for (const row of table) {
      arranged(name.replace("%s", String(row)), () => fn(row), timeout);
    }
  };
}

function arrangedEachRow<A, B>(table: readonly (readonly [A, B])[]) {
  return (
    name: string,
    fn: (first: A, second: B) => void | Promise<void>,
    timeout?: number,
  ): void => {
    for (const [first, second] of table) {
      arranged(name.replace("%s", String(first)), () => fn(first, second), timeout);
    }
  };
}
afterEach(() => {
  delete interactionDeps.tapAnyElementFactory;
  delete interactionDeps.tapOnElementFactory;
  delete interactionDeps.swipeOnFactory;
  sessions.stopCleanupTimer();
  DaemonState.getInstance().reset();
  ToolRegistry.clearTools();
  restoreFactory();
});

async function select(display?: unknown) {
  return ToolRegistry.getTool("setActiveDevice")!.handler({
    deviceId: device.deviceId,
    sessionUuid: "one",
    ...(display === undefined ? {} : { display }),
  });
}

arrangedEach(["missing-device", device.deviceId])(
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
    const handler = createSetActiveDeviceHandler({
      resumeCtrlProxy: async () => {},
      transportWait: {
        timer: new FakeTimer(),
        probe: async () => new Map(),
        invalidateDeviceList: () => {},
      },
    });
    if (deviceId === device.deviceId) {
      expect(
        readToolEnvelopePayload(await handler({ deviceId, sessionUuid: "one" }))?.payload,
      ).toMatchObject({
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

arranged("setActiveDevice caps a multi-line refresh failure at its first line", async () => {
  const failure = `${"x".repeat(300)}\nsecond line must stay in logs`;
  const refresh = spyOn(pool, "refreshDevicesWithOutcome").mockResolvedValue({
    addedCount: 0,
    failure,
  });
  try {
    const handler = createSetActiveDeviceHandler({
      resumeCtrlProxy: async () => {},
      transportWait: {
        timer: new FakeTimer(),
        probe: async () => new Map(),
        invalidateDeviceList: () => {},
      },
    });
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
arranged(
  "pin: setActiveDevice does not refresh when the requested device is already pooled",
  async () => {
    const refresh = spyOn(pool, "refreshDevicesWithOutcome");
    try {
      const handler = createSetActiveDeviceHandler({
        resumeCtrlProxy: async () => {},
        transportWait: {
          timer: new FakeTimer(),
          probe: async () => new Map(),
          invalidateDeviceList: () => {},
        },
      });
      await handler({ deviceId: device.deviceId, sessionUuid: "one" });
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
    }
  },
);

arranged("setActiveDevice reports device not found after a successful empty refresh", async () => {
  const utils = new FakeDeviceUtils();
  pool = new DevicePool(
    createDevicePoolDependencies(sessions, "empty-refresh", { timer, deviceManager: utils }),
  );
  DaemonState.getInstance().initialize(sessions, pool);
  const handler = createSetActiveDeviceHandler({
    resumeCtrlProxy: async () => {},
    transportWait: {
      timer: new FakeTimer(),
      probe: async () => new Map(),
      invalidateDeviceList: () => {},
    },
  });
  await expect(handler({ deviceId: "missing-device", sessionUuid: "one" })).rejects.toThrow(
    "Device 'missing-device' not found in device pool",
  );
});

for (const inventoryKind of ["single", "empty", "one panel"] as const) {
  for (const selector of ["0", "active"] as const) {
    arranged(
      `${inventoryKind} inventory accepts ${selector} and honours the sole display pin`,
      async () => {
        const source = new FakeDisplayInventorySource({
          degraded: false,
          ...(inventoryKind === "single"
            ? {}
            : {
                displays: {
                  panels:
                    inventoryKind === "empty"
                      ? []
                      : [
                          {
                            key: "0",
                            role: "unknown" as const,
                            sizePx: { width: 100, height: 200 },
                          },
                        ],
                  postures: [],
                },
              }),
        });
        const inventory = new CachingDisplayInventoryProvider(source, source, { timer });
        const single = { ...device, displays: undefined };
        await pool.initializeWithDevices([single]);
        const handler = createSetActiveDeviceHandler({
          displayInventory: inventory,
          resumeCtrlProxy: async () => {},
        });
        expect(
          readToolEnvelopePayload(
            await handler({ deviceId: device.deviceId, sessionUuid: "one", display: selector }),
          )?.payload,
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
          const pinned = readToolEnvelopePayload(
            await runSessionDisplayPin({
              name,
              acceptsDisplay: true,
              device: target,
              args: {},
              sessionUuid: "one",
              store: sessions,
              invoke,
            }),
          )?.payload!;
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
          expect(calls).toEqual([name === "tapOn" ? undefined : "0", "active"]);
        }
        await expect(
          handler({ deviceId: device.deviceId, sessionUuid: "one", display: "missing" }),
        ).rejects.toMatchObject({
          name: "InvalidDisplayPinError",
          message: expect.stringContaining("Available panels: 0 (unknown)"),
          details: { availablePanels: [{ key: "0", role: "unknown" }] },
        });
        expect(sessions.getDisplayPin("one")).toBe("0");
      },
    );
  }
}

for (const option of [
  { focusFirst: true },
  { subtext: { text: "Terms" } },
  { accessibilityLink: "Terms" },
  { screenReaderNavigation: true },
]) {
  arranged(
    `sole-panel tapOn pin preserves ${Object.keys(option)[0]} and all response stamps`,
    async () => {
      sessions.setDisplayPin("one", "inner");
      const target = {
        ...device,
        displays: { panels: device.displays!.panels.slice(0, 1), postures: [] },
      };
      const stamp = { key: "inside", generation: 0 };
      const response = await runSessionDisplayPin({
        name: "tapOn",
        acceptsDisplay: true,
        device: target,
        args: option,
        sessionUuid: "one",
        store: sessions,
        invoke: (args) => {
          expect(args).toEqual(option);
          expect(selectedDisplayPin()).toBe("inner");
          return createStructuredToolResponse({
            display: stamp,
            observation: { display: stamp },
            commands: [{ display: stamp, observation: { display: stamp } }],
          });
        },
      });
      expect(response).toMatchObject({
        structuredContent: {
          display: { pinned: true },
          observation: { display: { pinned: true } },
          commands: [{ display: { pinned: true }, observation: { display: { pinned: true } } }],
        },
      });
      expect(stamp).not.toHaveProperty("pinned");
      expect(selectedDisplayPin()).toBeUndefined();
    },
  );
}

arranged(
  "registered sole-panel iOS swipeOn pin preserves lookFor and ordinary defaults",
  async () => {
    const target: BootedDevice = {
      ...device,
      platform: "ios",
      displays: { panels: device.displays!.panels.slice(0, 1), postures: [] },
    };
    sessions.setDisplayPin("one", "inner");
    const lookFor = { text: "Terms" };
    interactionDeps.swipeOnFactory = () => ({
      execute: async (options) => {
        expect(options).toMatchObject({ lookFor, autoTarget: true, includeSystemInsets: false });
        expect(options.display).toBeUndefined();
        expect(selectedDisplayPin()).toBe("inner");
        return { success: true, targetType: "screen", x1: 0, y1: 0, x2: 0, y2: 0, duration: 0 };
      },
    });
    registerInteractionTools(interactionDeps);
    const response = await ToolRegistry.callInternal(
      "swipeOn",
      { direction: "up", lookFor },
      { targetDevice: target, sessionUuid: "one" },
    );
    expect(readToolEnvelopePayload(response)?.payload?.success).toBe(true);
  },
);

arranged(
  "sole-panel ordinary action keeps settling bound to the pin and preserves its stamp",
  async () => {
    sessions.setDisplayPin("one", "inner");
    const target = {
      ...device,
      displays: { panels: device.displays!.panels.slice(0, 1), postures: [] },
    };
    const observation = structuredClone(loadAndroidHomeObserve().observe);
    observation.display = { key: "inside", role: "inner", posture: "unknown", generation: 0 };
    const response = createStructuredToolResponse({ success: true, observation });
    await runSessionDisplayPin({
      name: "tapOn",
      acceptsDisplay: true,
      device: target,
      args: { focusFirst: true },
      sessionUuid: "one",
      store: sessions,
      invoke: (args) => {
        expect(args.display).toBeUndefined();
        return response;
      },
    });
    const settled = { ...observation, freshness: { isFresh: true, verified: true } };
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: false,
      createSettleObserve: () => ({
        execute: async (options) => {
          expect(options?.display).toBe("inside");
          return {
            observation: settled,
            settled: true,
            polls: 2,
            waitMs: 150,
            terminalReason: "settled",
          };
        },
      }),
    });
    expect(readToolEnvelopePayload(response)?.payload?.observation).toMatchObject({
      settled: true,
      display: { key: "inside", pinned: true, generation: 0 },
    });
    expect(observation.display).not.toHaveProperty("pinned");
    expect(settled.display).not.toHaveProperty("pinned");
  },
);

arranged("strict display schema adds nullable string without weakening other fields", () => {
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

arranged("set, replace, omit, and clear report the current session pin", async () => {
  const selected = await select("inner");
  expect(readToolEnvelopePayload(selected)?.payload).toMatchObject({ displayPin: "inner" });
  expect(readToolEnvelopePayload(selected)?.payload).toMatchObject({ displayPin: "inner" });
  expect(readToolEnvelopePayload(await select("outside"))?.payload).toMatchObject({
    displayPin: "outside",
  });
  expect(readToolEnvelopePayload(await select())?.payload).toMatchObject({ displayPin: "outside" });
  expect(readToolEnvelopePayload(await select(null))?.payload).toMatchObject({ displayPin: null });
  expect(sessions.getDisplayPin("one")).toBeUndefined();
});

for (const invalid of ["missing", "unknown", "active", "all", "", 12, false, {}]) {
  arranged(`invalid pin ${JSON.stringify(invalid)} is typed and does not replace`, async () => {
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

arranged("invalid pin on a different target leaves original binding intact", async () => {
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

arranged("direct mode display refuses before device selection; omitted is unchanged", async () => {
  DaemonState.getInstance().reset();
  const manager = DeviceReadiness.createInstance(
    new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils()),
  );
  ToolRegistry.setDeviceReadiness(manager);
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
      structuredContent: {
        message: "Active device set to 'pin-device'",
        deviceId: device.deviceId,
      },
    });
    expect(pin).toHaveBeenCalledWith(device, undefined);
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
  arranged(
    `display capability converts a shared schema once across registration and dispatch (display=${acceptsDisplay})`,
    async () => {
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
            await tools.callInternal(name, {}, { targetDevice: device, sessionUuid: "one" }),
          ).toBe(response);
        }
      }
      expect(conversions).toBe(1);
    },
  );
}

for (const schema of [
  {},
  { properties: { display: { type: "string" } } },
  { parse: (value: unknown) => value },
]) {
  arranged(
    `non-zod schema ${JSON.stringify(schema)} dispatches without display injection`,
    async () => {
      sessions.setDisplayPin("one", "unplugged");
      const tools = registry();
      const response = createStructuredToolResponse({ success: true });
      const handler = async (_target: BootedDevice, args: Record<string, unknown>) => {
        expect(args).not.toHaveProperty("display");
        return response;
      };
      // Legacy schemas are accepted by the pinning seam; registration now requires Zod.
      const pinnedHandler = sessionDisplayPinnedHandler({ name: "plain", schema, handler });
      tools.registerDeviceAware("plain", "plain schema probe", z.object({}), pinnedHandler);
      expect(tools.getTool("plain")!.deviceAwareHandler).toBe(pinnedHandler);
      expect(await tools.getTool("plain")!.handler({})).toBe(response);
      expect(
        await tools.callInternal("plain", {}, { targetDevice: device, sessionUuid: "one" }),
      ).toBe(response);
    },
  );
}

for (const targetDevice of [undefined, device]) {
  arranged(
    `nested display-aware dispatch inherits the routing session with supplied device=${!!targetDevice}`,
    async () => {
      sessions.setDisplayPin("one", "inner");
      const tools = registry();
      tools.registerDeviceAware(
        "inner",
        "nested display probe",
        z.object({ display: z.string().optional(), sessionUuid: z.string().optional() }),
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
        tools.callInternal("inner", {}, { targetDevice }),
      );
      expect(
        readToolEnvelopePayload(await tools.getTool("outer")!.handler({}))?.payload?.display,
      ).toMatchObject({
        key: "inside",
        pinned: true,
      });
    },
  );
}

for (const name of [
  "observe",
  "tapOn",
  "swipeOn",
  "tapAt",
  "swipeAt",
  "pinchOn",
  "dragAndDrop",
  "sendKeys",
  "captureScreenshot",
  "hitTest",
  "videoRecording",
]) {
  arranged(
    `${name} shared seam routes omitted display to pin and explicit active bypasses it`,
    async () => {
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
      const first = readToolEnvelopePayload(await tools.getTool(name)!.handler({}))?.payload;
      const stamp =
        name === "observe" ? first?.display : (first?.observation as { display: unknown }).display;
      expect(stamp).toMatchObject({ key: "inside", pinned: true });
      const explicit = readToolEnvelopePayload(
        await tools.getTool(name)!.handler({ display: "active" }),
      )?.payload;
      const explicitStamp =
        name === "observe"
          ? explicit?.display
          : (explicit?.observation as { display: unknown }).display;
      expect(explicitStamp).toMatchObject({ key: "outside" });
      expect(explicitStamp).not.toHaveProperty("pinned");
      expect(calls).toEqual(["inside", "outside"]);
    },
  );

  arranged(`${name} missing panel refuses before any handler or dispatch`, async () => {
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
    const details = failure ?? readToolEnvelopePayload(response)?.payload;
    expect(details).toMatchObject(
      name === "observe" || name === "captureScreenshot"
        ? { name: "PinnedDisplayUnavailableError", details: { pin: "unplugged" } }
        : { success: false, pinnedDisplay: { pin: "unplugged" } },
    );
    expect(dispatches).toBe(0);
    expect(executor.getExecutedCommands()).toEqual([]);
  });
}

arranged("live-panel rejection is typed as pin error", async () => {
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
  arranged(
    `${name} registered handler receives the effective panel and dispatches through its fake`,
    async () => {
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
        observation.display = {
          key: panel.key,
          role: panel.role,
          posture: "closed",
          generation: 0,
        };
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
      interactionDeps.tapOnElementFactory = () => ({
        execute: async (options) => {
          const observation = capture(options.display);
          await executor.executeCommand(`tap panel ${observation.display.key}`);
          return {
            success: true,
            action: "tap",
            element: { bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
            observation,
          };
        },
      });
      interactionDeps.tapAnyElementFactory = () => ({
        execute: async (options) => {
          const observation = capture(options.display);
          await executor.executeCommand(`tap panel ${observation.display.key}`);
          return {
            success: true,
            action: "tap",
            element: { bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
            observation,
          };
        },
      });
      interactionDeps.swipeOnFactory = () => ({
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
      });
      registerInteractionTools(interactionDeps);
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
            { targetDevice: device, sessionUuid: "one" },
          );
          const payload = readToolEnvelopePayload(response)?.payload!;
          const output =
            name === "observe" ? payload : (payload.observation as { display: unknown });
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
    },
  );
}

for (const name of ["tapOn", "swipeOn", "sendKeys"]) {
  arranged(
    `${name} swallowed live-display refusal preserves typed pin details in failure channel`,
    async () => {
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
      expect(readToolEnvelopePayload(response)?.payload).toMatchObject({
        success: false,
        pinnedDisplay: {
          pin: "inner",
          availablePanels: [
            { key: "inside", role: "inner" },
            { key: "outside", role: "cover" },
          ],
        },
      });
      expect(readToolEnvelopePayload(response)?.payload?.error).toContain(
        "setActiveDevice {display: null}",
      );
      expect(toolResponseSchema.parse(response).isError).toBe(true);
    },
  );
}

arranged(
  "pin marker does not mutate cached stamps or advance display identity generation",
  async () => {
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
    const pinned = readToolEnvelopePayload(await tools.getTool("observe")!.handler({}))?.payload!;
    expect(pinned.display).toMatchObject({ pinned: true });
    expect(stamp).not.toHaveProperty("pinned");
    sessions.setDisplayPin("one", null);
    const unpinned = readToolEnvelopePayload(await tools.getTool("observe")!.handler({}))?.payload!;
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
  },
);

arranged(
  "video stop and tools with no display schema remain callable with a missing pin",
  async () => {
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
        readToolEnvelopePayload(await tools.getTool(name)!.handler({ action: "stop" }))?.payload
          ?.success,
      ).toBe(true);
    }
    expect(calls).toBe(2);
  },
);

arranged("another session's pin cannot select this device", async () => {
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
    readToolEnvelopePayload(
      await tools.callInternal("observe", {}, { targetDevice: device, sessionUuid: "two" }),
    )?.payload?.success,
  ).toBe(true);
});

arranged("daemon mode without a session refuses display and does not read inventory", async () => {
  await expect(
    ToolRegistry.getTool("setActiveDevice")!.handler({
      deviceId: device.deviceId,
      display: "inner",
    }),
  ).rejects.toMatchObject({ name: "DisplayPinNeedsSessionError" });
  expect(provider.calls).toBe(0);
});

arranged(
  "null clears an unavailable pin without needing inventory; omitted does not read it",
  async () => {
    sessions.updateSessionCache("one", { ...{ displayPin: "unplugged" } });
    expect(readToolEnvelopePayload(await select())?.payload).toMatchObject({
      displayPin: "unplugged",
    });
    expect(provider.calls).toBe(0);
    expect(readToolEnvelopePayload(await select(null))?.payload).toMatchObject({
      displayPin: null,
    });
    expect(provider.calls).toBe(0);
  },
);

arranged("a successful device rebind with display omitted clears the old pin", async () => {
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", [device, { ...device, deviceId: "other" }]);
  pool.testHooks.deviceManager = utils;
  await pool.initializeWithDevices([device, { ...device, deviceId: "other" }]);
  sessions.setDisplayPin("one", "inner");
  const response = await ToolRegistry.getTool("setActiveDevice")!.handler({
    deviceId: "other",
    sessionUuid: "one",
  });
  expect(sessions.getDeviceForSession("one")).toBe("other");
  expect(readToolEnvelopePayload(response)?.payload).toMatchObject({ displayPin: null });
});

arranged(
  "each string pin update refreshes inventory and a disappeared role leaves the pin unchanged",
  async () => {
    await select("inner");
    provider.displays = { panels: device.displays!.panels.slice(1), postures: ["closed"] };
    await expect(select("inner")).rejects.toMatchObject({
      name: "InvalidDisplayPinError",
      details: { pin: "inner", availablePanels: [{ key: "outside", role: "cover" }] },
    });
    expect(sessions.getDisplayPin("one")).toBe("inner");
    expect(provider.invalidations).toEqual([device.deviceId, device.deviceId]);
  },
);

for (const name of ["observe", "tapOn", "tapAny", "swipeOn"]) {
  for (const scenario of ["no session", "no pin", "different device", "no display schema"]) {
    arranged(
      `${name} ${scenario} returns the identical frozen envelope without body reads or context changes`,
      async () => {
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
            tools.callInternal(name, scenario === "no session" ? {} : { sessionUuid: "one" }, {
              targetDevice:
                scenario === "different device" ? { ...device, deviceId: "other" } : device,
            }),
          ),
        ).toBe(response);
        expect(reads).toBe(0);
        expect(mappedFailure).toMatchObject({ name: "PinnedDisplayUnavailableError" });
      },
    );
  }
  arranged(`${name} no pin preserves handler text bytes and payload identity`, async () => {
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

arranged(
  "session setActiveDevice without display matches main's entire JSON envelope",
  async () => {
    const expected = createStructuredToolResponse({
      message: "Active device set to 'pin-device'",
      deviceId: device.deviceId,
      sessionUuid: "one",
    });
    const response = await select();
    expect(response).toEqual(expected);
    expect(toolResponseSchema.parse(response).content[0].text).toBe(expected.content[0].text);
    expect(toolResponseSchema.parse(response).content[0].text).toBe(
      JSON.stringify({
        message: "Active device set to 'pin-device'",
        deviceId: device.deviceId,
        sessionUuid: "one",
      }),
    );
    expect(ToolRegistry.getTool("setActiveDevice")!.outputSchema).toBeDefined();
  },
);

arranged(
  "legacy setActiveDevice without display matches main's entire JSON envelope and registration",
  async () => {
    DaemonState.getInstance().reset();
    const manager = DeviceReadiness.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils()),
    );
    ToolRegistry.setDeviceReadiness(manager);
    const ready = spyOn(manager, "ensureDeviceReady").mockResolvedValue(device);
    const pin = spyOn(manager, "setExplicitDevicePin").mockImplementation(() => {});
    try {
      const expected = createStructuredToolResponse({
        message: "Active device set to 'pin-device'",
        deviceId: device.deviceId,
      });
      const response = await ToolRegistry.getTool("setActiveDevice")!.handler({
        deviceId: device.deviceId,
      });
      // The wire text is byte-identical to the pre-structured response (#11830).
      expect(toolResponseSchema.parse(response).content).toEqual(expected.content);
      expect(toolResponseSchema.parse(response).structuredContent).toEqual({
        message: "Active device set to 'pin-device'",
        deviceId: device.deviceId,
      });
      expect(ToolRegistry.getTool("setActiveDevice")!.outputSchema).toBeDefined();
    } finally {
      ready.mockRestore();
      pin.mockRestore();
    }
  },
);

arranged(
  "setActiveDevice with display adds the resulting pin to main's JSON envelope",
  async () => {
    expect(await select("inner")).toEqual(
      createStructuredToolResponse({
        message: "Active device set to 'pin-device'",
        deviceId: device.deviceId,
        sessionUuid: "one",
        displayPin: "inner",
      }),
    );
  },
);

arranged(
  "omitted display preserves main's routing order without accessing the inventory dependency",
  async () => {
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
    const bind = spyOn(pool, "bindOrReuseDeviceSession").mockImplementation(async (request) => {
      steps.push("bind");
      // The receipt records cancellation undo (#11593); the final flag refuses live preparation (#11651).
      expect(request).toEqual({
        sessionId: "one",
        deviceId: "other",
        platform: "android",
        allowSessionRebind: true,
        receipt: {},
        refusePreparedForOtherRequest: true,
      });
      return "one";
    });
    const readiness = spyOn(sessions, "setDeviceReadiness").mockImplementation(() => {
      steps.push("readiness");
    });
    try {
      const handler = createSetActiveDeviceHandler({
        get displayInventory(): FakeDisplayInventoryProvider {
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
        // Refused before the resume, and checked again once it returns (#11651).
        "owner",
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
  },
);

for (const failure of [
  new DeviceLostError("pin-device", "device dropped"),
  new DOMException("cancelled", "AbortError"),
  AbortSignal.abort(new Error("signal reason")).reason,
  new ActionableError("handler failure"),
]) {
  arranged(`pinned handler preserves original ${failure.name}: ${failure.message}`, async () => {
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

arranged("failed plain selection leaves session activity unchanged", async () => {
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

arranged("successful plain selection of the bound device adds no session activity", async () => {
  const before = structuredClone(sessions.getSession("one")!);
  timer.advanceTime(1000);
  await select();
  expect(sessions.getSession("one")).toEqual(before);
});

arranged(
  "pin clear restores the complete main response envelope on the next plain call",
  async () => {
    const payload = {
      message: "Active device set to 'pin-device'",
      deviceId: device.deviceId,
      sessionUuid: "one",
    };
    expect(await select()).toEqual(createStructuredToolResponse(payload));
    await select("inner");
    expect(await select()).toEqual(
      createStructuredToolResponse({ ...payload, displayPin: "inner" }),
    );
    expect(await select(null)).toEqual(
      createStructuredToolResponse({ ...payload, displayPin: null }),
    );
    expect(await select()).toEqual(createStructuredToolResponse(payload));
  },
);

for (const name of ["observe", "tapOn", "tapAny", "swipeOn"]) {
  for (const degraded of [false, true]) {
    arranged(
      `${name} unreadable inventory degraded=${degraded} is retryable and never dispatches`,
      async () => {
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
          expect(readToolEnvelopePayload(response)?.payload).toMatchObject({
            success: false,
            error: expect.stringContaining("retry"),
            displayInventory: { pin: "inner", retryable: true },
          });
          expect(response).toMatchObject({ isError: true });
        }
        expect(dispatches).toBe(0);
        expect(sessions.getDisplayPin("one")).toBe("inner");
      },
    );
  }
}

/** What the real provider reports when nothing could be read: no panels and an unreadable outcome. */
function unreadableInventoryProvider(): FakeDisplayInventoryProvider {
  const provider = new FakeDisplayInventoryProvider();
  provider.outcome = { kind: "unreadable", reason: "no inventory" };
  return provider;
}

for (const outcome of ["throws", "no inventory", "degraded", "degraded panels"] as const) {
  arranged(`setting a pin with ${outcome} fails retryably and preserves the old pin`, async () => {
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
        ? unreadableInventoryProvider()
        : new CachingDisplayInventoryProvider(source, source, { timer });
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

arranged("readable single and zero-panel inventories still report an absent pin", async () => {
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
  arranged(`${name} no pin returns synchronous handler values unchanged`, () => {
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

arranged("registered tapAny missing pin reports typed details without dispatch", async () => {
  sessions.setDisplayPin("one", "unplugged");
  let dispatches = 0;
  interactionDeps.tapAnyElementFactory = () => ({
    execute: async () => {
      dispatches++;
      return {
        success: true,
        action: "tap",
        element: { bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
      };
    },
  });
  registerInteractionTools(interactionDeps);
  const response = await ToolRegistry.callInternal(
    "tapAny",
    {},
    { targetDevice: device, sessionUuid: "one" },
  );
  expect(toolResponseSchema.parse(response).isError).toBe(true);
  expect(readToolEnvelopePayload(response)?.payload).toMatchObject({
    success: false,
    pinnedDisplay: { pin: "unplugged" },
  });
  expect(dispatches).toBe(0);
});

arrangedEachRow([
  ["show", "inside"],
  ["dismiss", undefined],
  ["awaitEvent", undefined],
  ["status", undefined],
])("prototype %s takes the session display pin only when it shows", async (action, expected) => {
  sessions.updateSessionCache("one", { displayPin: "inner" });
  const seen: unknown[] = [];
  await runSessionDisplayPin({
    name: "prototype",
    acceptsDisplay: true,
    device,
    args: { action },
    sessionUuid: "one",
    store: sessions,
    invoke: (args) => {
      seen.push(args.display);
      return createStructuredToolResponse({ success: true });
    },
  });
  expect(seen).toEqual([expected]);
});
