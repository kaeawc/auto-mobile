import {
  beforeEach as beforeOutputSchema,
  afterEach as afterOutputSchema,
  spyOn as spyOnOutputSchema,
} from "bun:test";
import {
  setDeviceStateResultSchema,
  getDeviceStateResultSchema,
} from "../../../src/server/toolOutputSchemas";
import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../../fakes/FakeArtifactWriter";
import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import { setDeviceStateSchema } from "../../../src/server/utilityTools";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeEmulatorConsoleClient } from "../../fakes/FakeEmulatorConsoleClient";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  LocationRouteRegistry,
  registerLocationRouteSessionCleanup,
  stopLocationRouteForRemovedDevice,
} from "../../../src/features/utility/LocationRoutePlayer";
import { ActionableError } from "../../../src/models/ActionableError";
import type { SessionManager, SessionReleaseSnapshot } from "../../../src/daemon/sessionManager";

const android: BootedDevice = { platform: "android", deviceId: "emulator-5554", name: "Pixel" };
const ios: BootedDevice = {
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
  name: "iPhone",
};
const point = { mode: "static" as const, latitude: 37.7749, longitude: -122.4194 };
const route = {
  mode: "route" as const,
  waypoints: [
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 0.001 },
  ],
  durationMs: 1000,
  updateIntervalMs: 500,
};
const flush = async (): Promise<void> => {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve();
  }
};

describe("setDeviceState location", () => {
  test("static fix waits for a cancelled route fix before writing", async () => {
    const timer = new FakeTimer();
    const routeRegistry = new LocationRouteRegistry(timer);
    const commands: string[] = [];
    let resolveRoute!: () => void;
    const routeFix = new Promise<void>((resolve) => {
      resolveRoute = resolve;
    });
    class DelayedSimCtl extends FakeSimCtlClient {
      override async executeCommandArgs(args: string[], timeoutMs?: number) {
        commands.push(args[3]);
        if (commands.length === 1) {
          await routeFix;
        }
        return super.executeCommandArgs(args, timeoutMs);
      }
    }
    const simctl = new DelayedSimCtl();
    const state = new DeviceState(ios, { timer, routeRegistry, simctl });
    await state.setState({ location: route });
    timer.advanceTime(0);
    await flush();
    const staticFix = state.setState({ location: point });
    await flush();
    expect(commands).toEqual(["0,0"]);
    resolveRoute();
    const result = await staticFix;
    expect(result.location?.previousRoute).toMatchObject({ endedReason: "replaced" });
    expect(commands).toEqual(["0,0", "37.7749,-122.4194"]);
    timer.advanceTime(2000);
    await flush();
    expect(commands).toHaveLength(2);
  });

  test("rejected route replacement leaves the current route active", async () => {
    const timer = new FakeTimer();
    const routeRegistry = new LocationRouteRegistry(timer);
    const adbFactory = new FakeAdbClientFactory();
    adbFactory.getFakeClient().setCommandResult("shell getprop ro.kernel.qemu", "1\n");
    const state = new DeviceState(android, {
      timer,
      routeRegistry,
      adbFactory,
      consoleFactory: () => new FakeEmulatorConsoleClient(),
    });
    await state.setState({ location: route });
    expect(routeRegistry.isActive(android.deviceId)).toBe(true);
    adbFactory.getFakeClient().setCommandResult("shell getprop ro.kernel.qemu", "0\n");
    const rejected = await state.setState({ location: route });
    expect(rejected.location?.supported).toBe(false);
    expect(routeRegistry.isActive(android.deviceId)).toBe(true);
    routeRegistry.stop(android.deviceId);
  });

  test("stop reports a failed route once", async () => {
    const timer = new FakeTimer();
    const routeRegistry = new LocationRouteRegistry(timer);
    routeRegistry.start(ios.deviceId, route.waypoints, 2000, 500, false, async () => {
      throw new Error("offline");
    });
    for (const delta of [0, 500, 500]) {
      timer.advanceTime(delta);
      await flush();
    }
    const state = new DeviceState(ios, { timer, routeRegistry });
    expect((await state.setState({ location: { mode: "stop" } })).location).toMatchObject({
      stopped: false,
      previousRoute: { endedReason: "failed", lastError: "offline" },
    });
    expect(
      (await state.setState({ location: { mode: "stop" } })).location?.previousRoute,
    ).toBeUndefined();
  });
  test("uses Android emulator console with longitude first", async () => {
    const adbFactory = new FakeAdbClientFactory();
    adbFactory.getFakeClient().setCommandResult("shell getprop ro.kernel.qemu", "1\n");
    const consoleClient = new FakeEmulatorConsoleClient();
    const ports: number[] = [];
    const result = await new DeviceState(android, {
      adbFactory,
      consoleFactory: (port) => {
        ports.push(port);
        return consoleClient;
      },
    }).setState({ location: point });
    expect(result.success).toBe(true);
    expect(result.location).toMatchObject({
      supported: true,
      ...point,
      method: "android_emulator_console",
    });
    expect(ports).toEqual([5554]);
    expect(consoleClient.calls).toEqual([{ method: "geoFix", args: ["-122.4194", "37.7749"] }]);
  });

  test("uses iOS simctl argv with latitude first", async () => {
    const simctl = new FakeSimCtlClient();
    const args = ["location", ios.deviceId, "set", "37.7749,-122.4194"];
    simctl.setCommandArgsResult(args, "");
    const result = await new DeviceState(ios, { simctl }).setState({ location: point });
    expect(result.success).toBe(true);
    expect(result.location).toMatchObject({ supported: true, ...point, method: "ios_simctl" });
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([{ args, timeoutMs: undefined }]);
  });

  test("rejects invalid coordinates before any command", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const consoleClient = new FakeEmulatorConsoleClient();
    for (const location of [
      { ...point, latitude: NaN },
      { ...point, latitude: Infinity },
      { ...point, latitude: -91 },
      { ...point, longitude: -181 },
      { ...point, longitude: Infinity },
    ]) {
      const result = await new DeviceState(android, {
        adbFactory,
        consoleFactory: () => consoleClient,
      }).setState({ location });
      expect(result.success).toBe(false);
      expect(result.error).toContain("location.");
    }
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
    expect(consoleClient.calls).toEqual([]);
  });

  test("returns actionable unsupported failures for physical devices", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const physicalAndroid = { ...android, deviceId: "R123456" };
    const simctl = new FakeSimCtlClient();
    const physicalIos = { ...ios, deviceId: "00008110-001234567890801E" };
    const androidResult = await new DeviceState(physicalAndroid, { adbFactory }).setState({
      location: point,
    });
    const iosResult = await new DeviceState(physicalIos, { simctl }).setState({ location: point });
    expect(androidResult.location?.supported).toBe(false);
    expect(androidResult.error).toContain("Use an Android emulator");
    expect(iosResult.location?.supported).toBe(false);
    expect(iosResult.error).toContain("Use an iOS Simulator");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("maps a generic console or simctl command failure", async () => {
    const adbFactory = new FakeAdbClientFactory();
    adbFactory.getFakeClient().setCommandResult("shell getprop ro.kernel.qemu", "1\n");
    const consoleClient = new FakeEmulatorConsoleClient();
    consoleClient.failNext("geoFix", new Error("Command exited with code 1"));
    const androidResult = await new DeviceState(android, {
      adbFactory,
      consoleFactory: () => consoleClient,
    }).setState({ location: point });
    expect(androidResult.success).toBe(false);
    expect(androidResult.error).toContain("Command exited with code 1");

    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsError(
      ["location", ios.deviceId, "set", "37.7749,-122.4194"],
      new Error("Command exited with code 1"),
    );
    const iosResult = await new DeviceState(ios, { simctl }).setState({ location: point });
    expect(iosResult.success).toBe(false);
    expect(iosResult.error).toContain("Command exited with code 1");
  });

  test("advertises a strict, bounded, extensible location mode", () => {
    expect(setDeviceStateSchema.safeParse({ location: point }).success).toBe(true);
    expect(setDeviceStateSchema.safeParse({ location: { ...point, extra: true } }).success).toBe(
      false,
    );
    expect(setDeviceStateSchema.safeParse({ location: { ...point, mode: "route" } }).success).toBe(
      false,
    );
    expect(setDeviceStateSchema.safeParse({ location: { ...point, latitude: 91 } }).success).toBe(
      false,
    );
    expect(setDeviceStateSchema.safeParse({ location: { ...point, longitude: NaN } }).success).toBe(
      false,
    );
  });

  test("route starts without a timer tick, emits iOS simctl argv, and static cancels", async () => {
    const timer = new FakeTimer();
    const routeRegistry = new LocationRouteRegistry(timer);
    const simctl = new FakeSimCtlClient();
    const state = new DeviceState(ios, { timer, routeRegistry, simctl });
    const result = await state.setState({
      location: {
        mode: "route",
        waypoints: [
          { latitude: 0, longitude: 0 },
          { latitude: 0, longitude: 0.001 },
        ],
        durationMs: 1000,
        updateIntervalMs: 500,
      },
    });
    expect(result.location).toMatchObject({
      supported: true,
      mode: "route",
      waypointCount: 2,
      expectedDurationMs: 1000,
      loop: false,
      updateIntervalMs: 500,
      method: "ios_simctl",
    });
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
    timer.advanceTime(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(simctl.getMethodCalls("executeCommandArgs")[0]).toMatchObject({
      args: ["location", ios.deviceId, "set", "0,0"],
    });
    await state.setState({ location: point });
    expect(routeRegistry.isActive(ios.deviceId)).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    timer.advanceTime(3000);
    await Promise.resolve();
    await Promise.resolve();
    expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(2);
  });

  test("a second route replaces the first and continues emitting", async () => {
    const timer = new FakeTimer();
    const routeRegistry = new LocationRouteRegistry(timer);
    const simctl = new FakeSimCtlClient();
    const state = new DeviceState(ios, { timer, routeRegistry, simctl });
    await state.setState({ location: route });
    timer.advanceTime(0);
    await flush();
    const firstCount = simctl.getMethodCalls("executeCommandArgs").length;
    expect(firstCount).toBe(1);
    await state.setState({
      location: { ...route, waypoints: [...route.waypoints].reverse() },
    });
    expect(timer.getPendingTimeoutCount()).toBe(1);
    timer.advanceTime(0);
    await flush();
    timer.advanceTime(500);
    await flush();
    const calls = simctl.getMethodCalls("executeCommandArgs");
    expect(calls).toHaveLength(firstCount + 2);
    expect(calls[firstCount].args).toEqual(["location", ios.deviceId, "set", "0,0.001"]);
    expect(Number(calls[firstCount + 1].args[3].split(",")[1])).toBeCloseTo(0.0005, 8);
    routeRegistry.stop(ios.deviceId);
    expect(routeRegistry.isActive(ios.deviceId)).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("session release, unbind, and device removal cancel active routes", async () => {
    const timer = new FakeTimer();
    const routeRegistry = new LocationRouteRegistry(timer);
    const simctl = new FakeSimCtlClient();
    const state = new DeviceState(ios, { timer, routeRegistry, simctl });
    let release: Parameters<SessionManager["onSessionRelease"]>[0] | undefined;
    let unbound: Parameters<SessionManager["onSessionDeviceUnbound"]>[0] | undefined;
    registerLocationRouteSessionCleanup(
      {
        onSessionRelease: (callback) => {
          release = callback;
        },
        onSessionDeviceUnbound: (callback) => {
          unbound = callback;
        },
      },
      routeRegistry,
    );
    const snapshot: SessionReleaseSnapshot = {
      sessionId: "session",
      deviceId: ios.deviceId,
      releaseReason: "test",
      releasedAtMs: 0,
      terminal: true,
      heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: true, timeoutMs: 1000, ageMs: 0 },
    };
    for (const teardown of [
      () => release!("session", ios.deviceId, "test", snapshot),
      () => unbound!("session", ios.deviceId),
      () => stopLocationRouteForRemovedDevice(ios.deviceId, routeRegistry),
    ]) {
      await state.setState({ location: route });
      timer.advanceTime(0);
      await flush();
      const count = simctl.getMethodCalls("executeCommandArgs").length;
      teardown();
      expect(routeRegistry.isActive(ios.deviceId)).toBe(false);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      timer.advanceTime(2000);
      await flush();
      expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(count);
    }
  });

  test("route rejects invalid inputs with ActionableError before platform access", async () => {
    const state = new DeviceState(android, {
      routeRegistry: new LocationRouteRegistry(new FakeTimer()),
    });
    const two = [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 1 },
    ];
    const invalid = [
      { waypoints: [two[0]], durationMs: 1000 },
      { waypoints: [{ latitude: 91, longitude: 0 }, two[1]], durationMs: 1000 },
      { waypoints: two, durationMs: 1000, speedMetersPerSecond: 1 },
      { waypoints: two },
      { waypoints: two, speedMetersPerSecond: 0 },
      { waypoints: two, durationMs: -1 },
      { waypoints: two, durationMs: 1000, updateIntervalMs: 100 },
    ];
    for (const value of invalid) {
      expect(state.setState({ location: { mode: "route", ...value } })).rejects.toBeInstanceOf(
        ActionableError,
      );
    }
  });

  test("unsupported physical targets start no route", async () => {
    const timer = new FakeTimer();
    const routeRegistry = new LocationRouteRegistry(timer);
    const route = {
      mode: "route" as const,
      waypoints: [
        { latitude: 0, longitude: 0 },
        { latitude: 0, longitude: 1 },
      ],
      durationMs: 1000,
    };
    for (const device of [
      { ...android, deviceId: "physical" },
      { ...ios, deviceId: "physical" },
    ]) {
      const result = await new DeviceState(device, { timer, routeRegistry }).setState({
        location: route,
      });
      expect(result.location?.supported).toBe(false);
      expect(routeRegistry.stop(device.deviceId)).toBe(false);
    }
    const adbFactory = new FakeAdbClientFactory();
    adbFactory.getFakeClient().setCommandResult("shell getprop ro.kernel.qemu", "0\n");
    const nonEmulator = await new DeviceState(android, {
      timer,
      routeRegistry,
      adbFactory,
    }).setState({ location: route });
    expect(nonEmulator.location).toMatchObject({ supported: false });
    expect(routeRegistry.stop(android.deviceId)).toBe(false);
  });

  test("Android route emits geo fixes and stop is idempotent", async () => {
    const timer = new FakeTimer();
    const routeRegistry = new LocationRouteRegistry(timer);
    const adbFactory = new FakeAdbClientFactory();
    adbFactory.getFakeClient().setCommandResult("shell getprop ro.kernel.qemu", "1\n");
    const consoleClient = new FakeEmulatorConsoleClient();
    const state = new DeviceState(android, {
      timer,
      routeRegistry,
      adbFactory,
      consoleFactory: () => consoleClient,
    });
    const route = {
      mode: "route" as const,
      waypoints: [
        { latitude: 0, longitude: 0, altitude: 10 },
        { latitude: 0, longitude: 0.001, altitude: 20 },
      ],
      durationMs: 1000,
      updateIntervalMs: 500,
    };
    await state.setState({ location: route });
    timer.advanceTime(0);
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(consoleClient.calls[0]).toEqual({ method: "geoFix", args: ["0", "0", "10"] });
    expect(Number(consoleClient.calls[1].args[2])).toBeCloseTo(15, 6);
    expect((await state.setState({ location: { mode: "stop" } })).location?.stopped).toBe(true);
    expect((await state.setState({ location: { mode: "stop" } })).location?.stopped).toBe(false);
    expect(routeRegistry.isActive(android.deviceId)).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    timer.advanceTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(consoleClient.calls).toHaveLength(2);
  });
});

// Validate the actual fake-backed branch results before and after finalization.
const getStateForOutputSchema = DeviceState.prototype.getState;
let getStateOutputSchemaSpy: ReturnType<typeof spyOnOutputSchema>;
beforeOutputSchema(() => {
  getStateOutputSchemaSpy = spyOnOutputSchema(DeviceState.prototype, "getState").mockImplementation(
    async function (this: DeviceState, ...args: Parameters<DeviceState["getState"]>) {
      const result = await getStateForOutputSchema.apply(this, args);
      const payload = { message: "Result", ...result };
      expect(getDeviceStateResultSchema.parse(payload)).toBeDefined();
      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "getDeviceState",
        outputSchema: getDeviceStateResultSchema,
        artifactWriter: new FakeArtifactWriter(),
      });
      expect(getDeviceStateResultSchema.parse(finalized.structuredContent)).toBeDefined();
      return result;
    },
  );
});
afterOutputSchema(() => getStateOutputSchemaSpy.mockRestore());

// Validate the actual fake-backed branch results before and after finalization.
const setStateForOutputSchema = DeviceState.prototype.setState;
let setStateOutputSchemaSpy: ReturnType<typeof spyOnOutputSchema>;
beforeOutputSchema(() => {
  setStateOutputSchemaSpy = spyOnOutputSchema(DeviceState.prototype, "setState").mockImplementation(
    async function (this: DeviceState, ...args: Parameters<DeviceState["setState"]>) {
      const result = await setStateForOutputSchema.apply(this, args);
      const payload = { message: "Result", ...result };
      expect(setDeviceStateResultSchema.parse(payload)).toBeDefined();
      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "setDeviceState",
        outputSchema: setDeviceStateResultSchema,
        artifactWriter: new FakeArtifactWriter(),
      });
      expect(setDeviceStateResultSchema.parse(finalized.structuredContent)).toBeDefined();
      return result;
    },
  );
});
afterOutputSchema(() => setStateOutputSchemaSpy.mockRestore());
