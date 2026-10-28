import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod/v4";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import {
  getObserveCacheStore,
  setObserveCacheStore,
} from "../../src/features/observe/cache/ObserveCacheRegistry";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { registerObserveTools } from "../../src/server/observeTools";
import { registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { AvdConfigReader } from "../../src/utils/android-cmdline-tools/AvdConfigReader";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAvdConfigReader } from "../fakes/FakeAvdConfigReader";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeObserveCacheStore } from "../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeViewHierarchy } from "../fakes/FakeViewHierarchy";
import { FakeWindow } from "../fakes/FakeWindow";
import { noopObserveAudits } from "../fakes/noopObserveAudits";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { readToolResponse } from "../helpers/toolResponse";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const emulator: BootedDevice = {
  deviceId: "emulator-5620",
  name: "arbitrary-avd-name",
  platform: "android",
};
const sessionUuid = "held-form-factor";
const roundDisplay = readFileSync(
  new URL("../fixtures/wear-os/dumpsys-display-captured-round.txt", import.meta.url),
  "utf8",
);
const restorers: Array<() => void> = [];

afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) {
    restore();
  }
});

async function arrange(reader: AvdConfigReader, image?: Partial<DeviceInfo>) {
  restorers.push(preserveToolRegistry());
  const previousCache = getObserveCacheStore();
  restorers.push(() => setObserveCacheStore(previousCache));
  ToolRegistry.clearTools();
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  sessions.stopCleanupTimer();
  const devices = new FakeDeviceUtils();
  devices.setBootedDevices("android", [emulator]);
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "form-factor-daemon", { timer, deviceManager: devices }),
  );
  await pool.initializeWithDevices([emulator]);
  if (image) {
    await pool.addDevice(emulator, { ...emulator, source: "local", isRunning: true, ...image });
  }
  DaemonState.getInstance().initialize(sessions, pool);
  restorers.push(() => DaemonState.getInstance().reset());
  await sessions.createSession(sessionUuid, emulator.deviceId, "android");
  sessions.setDeviceReadiness(sessionUuid, "automationReady");
  sessions.setKeepScreenAwake(sessionUuid, { applied: false, skipReason: "failed" });

  const client = new FakeCtrlProxy(timer);
  const proxy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  restorers.push(() => proxy.mockRestore());
  const previous = ToolRegistry.getCollaboratorsForTesting();
  const readiness = new FakeDeviceReadiness();
  readiness.setConnectedDevices([emulator]);
  ToolRegistry.setCollaboratorsForTesting({
    timer,
    deviceReadiness: readiness,
    toolCallRepository: { recordToolCall: async () => {} },
    navigationToolCallRecorder: { record: () => undefined },
  });
  restorers.push(() => ToolRegistry.setCollaboratorsForTesting(previous));
  restorers.push(
    ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      deviceReadAccess: {
        avdConfigReader: reader,
        listBooted: async () => {
          throw new Error("Held-session calls must not take the sessionless read path");
        },
        isAuthorized: () => true,
      },
      auditRunner: {
        run: ({ device, args, handler, progress, signal }) =>
          handler(device, args, progress, signal),
      },
      afterToolCall: {
        handle: async ({ response }) => ({ durationMs: 0, finalizedResponse: response }),
      },
    }),
  );
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("shell dumpsys display", createExecResult(roundDisplay, ""));
  const adbFactory = new FakeAdbClientFactory(adb);
  const hierarchy = new FakeViewHierarchy();
  hierarchy.configureHierarchy(loadAndroidHomeObserve().observe.viewHierarchy!);
  registerObserveTools({
    timer,
    audioInputDiagnostic: async () => undefined,
    snapshotReferences: { capture: () => ({ status: "unavailable", missing: ["fixture"] }) },
    createScreen: (device) =>
      new RealObserveScreen(
        device,
        adbFactory,
        {
          ...noopObserveAudits(),
          viewHierarchy: hierarchy,
          window: new FakeWindow(),
          cacheStore: new FakeObserveCacheStore(timer),
        },
        timer,
      ),
  });
  restorers.push(
    registerPrototypeTools({
      clientFactory: () => client,
      clock: timer,
      timer,
      adbFactory,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    }),
  );
  ToolRegistry.registerDeviceAware(
    "formFactorProbe",
    "Inspect the session device",
    z.object({ sessionUuid: z.string() }),
    async (device) => device,
  );
  const probe = async () =>
    (await ToolRegistry.getTool("formFactorProbe")!.handler({ sessionUuid })) as BootedDevice;
  const observe = async () =>
    readToolResponse(
      await ToolRegistry.getTool("observe")!.handler({ sessionUuid, screenshot: "none" }),
    ).structuredContent as Record<string, unknown>;
  const show = async () =>
    readToolResponse(
      await ToolRegistry.getTool("prototype")!.handler({
        sessionUuid,
        action: "show",
        spec: {
          id: "card",
          window: { placement: { type: "fullscreen" }, opacity: 1 },
          root: { type: "text", text: "Hello" },
        },
      }),
    ).structuredContent as Record<string, unknown>;
  return { pool, probe, observe, show, adb };
}

test("held-session observe resolves watch form factor and reports the real display flag", async () => {
  const reader = new FakeAvdConfigReader({ deviceName: "wearos_small_round" });
  const { observe, probe, adb } = await arrange(reader);
  expect((await observe()).isScreenRound).toBe(true);
  expect((await probe()).formFactor).toBe("watch");
  expect(reader.readConfigCalls).toEqual([emulator.name]);
  expect(adb.getExecutedCommands()).toContain("shell dumpsys display");
});

test("prototype show resolves watch form factor through the held session", async () => {
  const reader = new FakeAvdConfigReader({ deviceName: "wearos_small_round" });
  const { show } = await arrange(reader);
  expect(await show()).toMatchObject({ success: true, screenRound: true });
  expect(reader.readConfigCalls).toEqual([emulator.name]);
});

test("a known phone pays no session-build config read or round-display read", async () => {
  const reader = new FakeAvdConfigReader({ deviceName: "wearos_small_round" });
  const { observe, show, adb } = await arrange(reader, { formFactor: "phone" });
  expect(await observe()).not.toHaveProperty("isScreenRound");
  expect(await show()).not.toHaveProperty("screenRound");
  expect(reader.readConfigCalls).toEqual([]);
  expect(adb.getExecutedCommands()).not.toContain("shell dumpsys display");
});

test("an already classified watch retains its metadata without a config read", async () => {
  const reader = new FakeAvdConfigReader(null);
  const { observe, show } = await arrange(reader, { formFactor: "watch" });
  expect((await observe()).isScreenRound).toBe(true);
  expect(await show()).toMatchObject({ success: true, screenRound: true });
  expect(reader.readConfigCalls).toEqual([]);
});

test("concurrent session consumers share one config lookup", async () => {
  const reader = new FakeAvdConfigReader({ deviceName: "wearos_small_round" });
  const { probe } = await arrange(reader);
  expect(
    (await Promise.all([probe(), probe(), probe()])).map((device) => device.formFactor),
  ).toEqual(["watch", "watch", "watch"]);
  expect(reader.readConfigCalls).toEqual([emulator.name]);
});

test.each(["missing", "throws", "unknown"] as const)(
  "%s optional config is cached absent without blocking either session consumer",
  async (mode) => {
    let reads = 0;
    const reader: AvdConfigReader = {
      readConfig: async () => {
        reads++;
        if (mode === "throws") {
          throw new Error("unreadable config");
        }
        return mode === "missing" ? null : {};
      },
    };
    const { observe, show } = await arrange(reader);
    expect(await observe()).not.toHaveProperty("isScreenRound");
    expect(await show()).toMatchObject({ success: true });
    expect(await show()).not.toHaveProperty("screenRound");
    expect(reads).toBe(1);
  },
);

test("a changed AVD identity on the pool entry gets fresh metadata", async () => {
  const reader = FakeAvdConfigReader.forAvds({
    [emulator.name]: { deviceName: "wearos_small_round" },
    replacement: {
      deviceName: "pixel_6",
      screenWidth: 1080,
      screenHeight: 2400,
      screenDensity: 420,
    },
  });
  const { pool, probe } = await arrange(reader);
  expect((await probe()).formFactor).toBe("watch");
  pool.getDevice(emulator.deviceId)!.avdName = "replacement";
  expect((await probe()).formFactor).toBe("phone");
  expect(reader.readConfigCalls).toEqual([emulator.name, "replacement"]);
});

test("a replacement pool incarnation cannot inherit the same serial's cached form factor", async () => {
  let reads = 0;
  const { pool, probe } = await arrange({
    readConfig: async () => (++reads === 1 ? { deviceName: "wearos_small_round" } : {}),
  });
  expect((await probe()).formFactor).toBe("watch");
  const pooled = pool.getDevice(emulator.deviceId)!;
  // The identity token must also fence a refreshed incarnation on the same entry object.
  pooled.incarnation++;
  expect(await probe()).not.toHaveProperty("formFactor");
  expect(reads).toBe(2);
});
