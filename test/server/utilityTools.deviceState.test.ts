import { createJSONToolResponse } from "../../src/utils/toolUtils";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { compileAjv } from "../helpers/jsonSchemaCompile";
import fs from "node:fs";
import path from "node:path";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { ActionableError } from "../../src/models/ActionableError";
import { DeviceState } from "../../src/features/utility/DeviceState";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { BootedDevice, Platform } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";
import { FakeNetworkFilterBridge } from "../fakes/FakeNetworkFilterBridge";
import { LocationRouteRegistry } from "../../src/features/utility/LocationRoutePlayer";

// No test in this file may run the installed network-filter-controller.
const networkFilterBridge = new FakeNetworkFilterBridge();

const createBootedDevice = (
  deviceId: string,
  platform: Platform = "android",
  name?: string,
): BootedDevice => ({
  name: name ?? deviceId,
  platform,
  deviceId,
});

describe("device state tools", () => {
  for (const location of [
    { mode: "static" as const, latitude: 1, longitude: 2 },
    {
      mode: "route" as const,
      waypoints: [
        { latitude: 0, longitude: 0 },
        { latitude: 1, longitude: 1 },
      ],
      durationMs: 1000,
    },
  ]) {
    test(`tracks a location-only ${location.mode} request through session setup`, async () => {
      const timer = new FakeTimer();
      const manager = new SessionManager(
        timer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
      );
      const pool = new DevicePool(
        createDevicePoolDependencies(manager, "test-daemon", {
          timer,
          deviceManager: new FakeDeviceManager([], []),
          installedAppsRepository: new FakeInstalledAppsRepository(),
        }),
      );
      DaemonState.getInstance().initialize(manager, pool);
      await manager.createSession("location-session", "emulator-5554", "android");
      const tracking = spyOn(manager, "trackSessionSetup");
      const setState = spyOn(DeviceState.prototype, "setState").mockResolvedValue({
        success: true,
        deviceId: "emulator-5554",
        platform: "android",
      });
      try {
        await ToolRegistry.getTool("setDeviceState")!.deviceAwareHandler!(
          createBootedDevice("emulator-5554"),
          {
            sessionUuid: "location-session",
            location,
          },
        );
        expect(tracking).toHaveBeenCalledTimes(1);
        expect(setState).toHaveBeenCalledTimes(1);
        await manager.rebindSession("location-session", "emulator-5556", "android");
        await expect(
          ToolRegistry.getTool("setDeviceState")!.deviceAwareHandler!(
            createBootedDevice("emulator-5554"),
            {
              sessionUuid: "location-session",
              location,
            },
          ),
        ).rejects.toBeInstanceOf(ActionableError);
        expect(setState).toHaveBeenCalledTimes(1);
      } finally {
        tracking.mockRestore();
        setState.mockRestore();
        manager.stopCleanupTimer();
      }
    });
  }

  test("combined biometric/location request is tracked once when capture succeeds", async () => {
    const timer = new FakeTimer();
    const manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "test-daemon", {
        timer,
        deviceManager: new FakeDeviceManager([], []),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    DaemonState.getInstance().initialize(manager, pool);
    await manager.createSession("location-session", "sim-1", "ios");
    const tracking = spyOn(manager, "trackSessionSetup");
    const capture = spyOn(DeviceState.prototype, "getBiometricEnrollmentState").mockResolvedValue({
      supported: true,
      enrollment: "not_enrolled",
    });
    const setState = spyOn(DeviceState.prototype, "setState").mockResolvedValue({
      success: true,
      deviceId: "sim-1",
      platform: "ios",
      location: { supported: true, mode: "static" },
    });
    try {
      const location = { mode: "static" as const, latitude: 1, longitude: 2 };
      const response = await ToolRegistry.getTool("setDeviceState")!.deviceAwareHandler!(
        createBootedDevice("sim-1", "ios"),
        {
          sessionUuid: "location-session",
          location,
          biometrics: { enrollment: "enrolled" },
        },
      );
      expect(setState).toHaveBeenCalledTimes(1);
      expect(setState.mock.calls[0][0].location).toEqual(location);
      expect(setState.mock.calls[0][0].biometrics).toEqual({ enrollment: "enrolled" });
      expect(tracking).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(
        (response as { content: Array<{ text: string }> }).content[0].text,
      );
      expect(payload.success).toBe(true);
    } finally {
      tracking.mockRestore();
      capture.mockRestore();
      setState.mockRestore();
      manager.stopCleanupTimer();
    }
  });

  for (const mode of ["static", "route"] as const) {
    for (const releaseDuringCapture of [false, true]) {
      test(`biometric capture failure skips ${mode} location and preserves failure${releaseDuringCapture ? " after release" : ""}`, async () => {
        const timer = new FakeTimer();
        const manager = new SessionManager(
          timer,
          new FakeDeviceSessionPersistence(),
          () => new FakeDbWriteBarrier(),
        );
        const pool = new DevicePool(
          createDevicePoolDependencies(manager, "test-daemon", {
            timer,
            deviceManager: new FakeDeviceManager([], []),
            installedAppsRepository: new FakeInstalledAppsRepository(),
          }),
        );
        DaemonState.getInstance().initialize(manager, pool);
        const device = createBootedDevice("12345678-1234-1234-1234-123456789ABC", "ios");
        await manager.createSession("location-session", device.deviceId, "ios");
        const simctl = new FakeSimCtlClient();
        const registry = new LocationRouteRegistry(timer);
        const state = new DeviceState(device, { timer, simctl, routeRegistry: registry });
        const originalSetState = DeviceState.prototype.setState;
        const setState = spyOn(DeviceState.prototype, "setState").mockImplementation((input) =>
          originalSetState.call(state, input),
        );
        const biometrics = { supported: false, error: "capture failed" };
        const capture = spyOn(
          DeviceState.prototype,
          "getBiometricEnrollmentState",
        ).mockImplementation(async () => {
          if (releaseDuringCapture) {
            await manager.releaseSession("location-session");
          }
          return biometrics;
        });
        const start = spyOn(registry, "start");
        const tracking = spyOn(manager, "trackSessionSetup");
        try {
          const location =
            mode === "static"
              ? { mode, latitude: 1, longitude: 2 }
              : {
                  mode,
                  waypoints: [
                    { latitude: 0, longitude: 0 },
                    { latitude: 1, longitude: 1 },
                  ],
                  durationMs: 1000,
                };
          const response = await ToolRegistry.getTool("setDeviceState")!.deviceAwareHandler!(
            device,
            {
              sessionUuid: "location-session",
              location,
              biometrics: { enrollment: "enrolled" },
            },
          );
          const payload = JSON.parse(
            (response as { content: Array<{ text: string }> }).content[0].text,
          );
          expect(payload.success).toBe(false);
          expect(payload.error).toBe("capture failed");
          expect(payload.message).toBe("capture failed");
          expect(payload.biometrics).toEqual(biometrics);
          expect(payload.location).toBeUndefined();
          expect(setState).not.toHaveBeenCalled();
          expect(start).not.toHaveBeenCalled();
          expect(tracking).not.toHaveBeenCalled();
          timer.advanceTime(0);
          expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
        } finally {
          capture.mockRestore();
          setState.mockRestore();
          start.mockRestore();
          tracking.mockRestore();
          registry.stopAll();
          manager.stopCleanupTimer();
        }
      });
    }
  }

  beforeEach(() => {
    ToolRegistry.clearTools();
    networkFilterBridge.setState("not_installed");
    registerUtilityTools({ networkFilterBridge });
    for (const name of ["getDeviceState", "setDeviceState"]) {
      const tool = ToolRegistry.getTool(name)!;
      const handler = tool.deviceAwareHandler!;
      tool.deviceAwareHandler = async (...args) => {
        const response = await handler(...args);
        expect(tool.outputSchema!.parse(response.structuredContent)).toBeDefined();
        expect(response.content).toEqual(
          createJSONToolResponse(response.structuredContent).content,
        );
        return response;
      };
    }
  });

  afterEach(() => {
    AndroidCtrlProxyClient.resetInstances();
    IOSCtrlProxyClient.resetInstances();
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    PlatformDeviceManagerFactory.reset();
  });

  test("registers getDeviceState and setDeviceState schemas", () => {
    const getTool = ToolRegistry.getTool("getDeviceState");
    const setTool = ToolRegistry.getTool("setDeviceState");

    expect(getTool).toBeDefined();
    expect(getTool?.requiresDevice).toBe(true);
    expect(() => getTool!.schema.parse({ include: ["doNotDisturb"] })).not.toThrow();
    expect(() => getTool!.schema.parse({ include: ["biometrics"] })).not.toThrow();
    expect(() => getTool!.schema.parse({ include: ["location"] })).toThrow();

    expect(setTool).toBeDefined();
    expect(setTool?.requiresDevice).toBe(true);
    expect(() =>
      setTool!.schema.parse({
        doNotDisturb: { enabled: true },
      }),
    ).not.toThrow();
    expect(() =>
      setTool!.schema.parse({
        doNotDisturb: { mode: "priority" },
      }),
    ).not.toThrow();
    expect(() =>
      setTool!.schema.parse({
        biometrics: { enrollment: "not_enrolled" },
      }),
    ).not.toThrow();
    expect(() => setTool!.schema.parse({})).toThrow();

    expect(() => setTool!.schema.parse({ connectivity: { wifiEnabled: false } })).not.toThrow();
    expect(() => setTool!.schema.parse({ connectivity: {} })).toThrow();

    // #6012: networkCondition is a first-class device-state field.
    expect(() => getTool!.schema.parse({ include: ["networkCondition"] })).not.toThrow();
    expect(() => setTool!.schema.parse({ networkCondition: { profile: "3g" } })).not.toThrow();
    expect(() => setTool!.schema.parse({ networkCondition: { cancel: true } })).not.toThrow();
    expect(() => setTool!.schema.parse({ networkCondition: { profile: "offline" } })).not.toThrow();
    // An empty networkCondition sub-object is not a request.
    expect(() => setTool!.schema.parse({ networkCondition: {} })).toThrow();
    // #6012 audit: falsey-only cancel/reset and TTL-only are NOT requests.
    expect(() => setTool!.schema.parse({ networkCondition: { cancel: false } })).toThrow();
    expect(() => setTool!.schema.parse({ networkCondition: { reset: false } })).toThrow();
    expect(() => setTool!.schema.parse({ networkCondition: { expiresInSeconds: 30 } })).toThrow();
    // packetLossPercent is a (backend-unsupported) request, so the schema accepts
    // it — the setter reports it unsupported rather than the schema rejecting it.
    expect(() =>
      setTool!.schema.parse({ networkCondition: { packetLossPercent: 20 } }),
    ).not.toThrow();
    expect(() =>
      setTool!.schema.parse({ networkCondition: { delayMs: 400, expiresInSeconds: 5 } }),
    ).not.toThrow();
    // #6085 item 4: an expiresInSeconds above the 32-bit setTimeout ceiling is
    // rejected by the schema so the ms product cannot overflow.
    expect(() =>
      setTool!.schema.parse({ networkCondition: { profile: "3g", expiresInSeconds: 2_147_484 } }),
    ).toThrow();
    expect(() =>
      setTool!.schema.parse({ networkCondition: { profile: "offline", delayMs: 500 } }),
    ).toThrow();
    // offline + packetLossPercent is redundant, not contradictory → accepted.
    expect(() =>
      setTool!.schema.parse({ networkCondition: { profile: "offline", packetLossPercent: 50 } }),
    ).not.toThrow();
    // 5g was dropped (identical to none) → no longer a valid enum value.
    expect(() => setTool!.schema.parse({ networkCondition: { profile: "5g" } })).toThrow();
  });

  test("reports supported device-state outcomes in the getDeviceState message", async () => {
    const getState = spyOn(DeviceState.prototype, "getState").mockResolvedValue({
      success: true,
      deviceId: "fake",
      platform: "android",
      doNotDisturb: { supported: true, enabled: false },
      connectivity: {
        supported: true,
        wifiEnabled: true,
        bluetoothEnabled: true,
        locationEnabled: true,
        airplaneMode: false,
      },
    });
    try {
      const getTool = ToolRegistry.getTool("getDeviceState");
      const response = await getTool!.deviceAwareHandler!(createBootedDevice("fake"), {
        include: ["doNotDisturb", "connectivity"],
      });
      const payload = JSON.parse(
        (response as { content: Array<{ text: string }> }).content[0].text,
      );

      expect(payload.message).toContain("DND off");
      expect(payload.message).toContain("Wi-Fi on");
    } finally {
      getState.mockRestore();
    }
  });

  test("advertised networkCondition JSON schema leaves conditional edges to runtime", () => {
    const toolDefsPath = path.join(process.cwd(), "schemas/tool-definitions.json");
    const toolDefs = JSON.parse(fs.readFileSync(toolDefsPath, "utf8")) as Array<{
      name: string;
      inputSchema: { properties?: Record<string, unknown> };
    }>;
    const setDeviceState = toolDefs.find((t) => t.name === "setDeviceState");
    expect(setDeviceState).toBeDefined();
    const ncSchema = setDeviceState!.inputSchema.properties?.networkCondition;
    expect(ncSchema).toBeDefined();

    const validate = compileAjv(ncSchema, { allErrors: true, strict: false });

    // Unsupported conditional keywords are stripped from the advertised schema.
    expect(validate({ profile: "offline", delayMs: 500 })).toBe(true);
    // offline + override + cancel:true is a valid cancel-reset — must NOT be
    // false-rejected (the #6090 issue-3 fix; runtime classifies it `reset`).
    expect(validate({ profile: "offline", delayMs: 500, cancel: true })).toBe(true);
    expect(validate({ profile: "offline", delayMs: 500, reset: true })).toBe(true);
    // offline alone stays valid; offline + packetLossPercent is redundant, not
    // contradictory (packet loss is not a shaping override).
    expect(validate({ profile: "offline" })).toBe(true);
    expect(validate({ profile: "offline", packetLossPercent: 50 })).toBe(true);

    // A neutral override may be accepted by the advertised schema; runtime
    // retains the no-op classification.
    expect(validate({ profile: "none", delayMs: 0 })).toBe(true);
    expect(validate({ profile: "none", downloadKbps: 0, uploadKbps: 0 })).toBe(true);
    expect(validate({ delayMs: 0 })).toBe(true);
    expect(validate({ downloadKbps: 0 })).toBe(true);
    expect(validate({ packetLossPercent: 0 })).toBe(true);
    // A real (non-zero) override remains a valid request.
    expect(validate({ delayMs: 500 })).toBe(true);
  });

  test("threads networkCondition through the setDeviceState handler", async () => {
    // A physical Android device short-circuits to an unsupported result before
    // any adb call, so this proves the handler forwards networkCondition into
    // DeviceState.setState without needing a real device.
    const setTool = ToolRegistry.getTool("setDeviceState");
    const physicalAndroid = createBootedDevice("38290DLJG000XY", "android", "Pixel 8");

    const response = await setTool!.deviceAwareHandler!(physicalAndroid, {
      networkCondition: { profile: "3g" },
    });

    const payload = JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.networkCondition).toMatchObject({
      supported: false,
      capability: "unsupported",
      requestedProfile: "3g",
    });
  });

  test("rejects invalid clock input before the handler can capture or mutate state", async () => {
    const getSpy = spyOn(DeviceState.prototype, "getBiometricEnrollmentState");
    const setSpy = spyOn(DeviceState.prototype, "setState");
    try {
      await expect(
        ToolRegistry.getTool("setDeviceState")!.deviceAwareHandler!(
          createBootedDevice("emulator-5554"),
          {
            clock: { mode: "set", instant: "2026-10-01T00:00:00" },
            biometrics: { enrollment: "enrolled" },
          },
        ),
      ).rejects.toBeInstanceOf(ActionableError);
      expect(getSpy).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  test("threads clock through the setter and advertises its strict input union", async () => {
    const setTool = ToolRegistry.getTool("setDeviceState");
    const response = await setTool!.deviceAwareHandler!(createBootedDevice("physical-android"), {
      clock: { mode: "reset" },
    });
    const payload = JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.clock).toMatchObject({ supported: false, capability: "unsupported" });
    const definitions = JSON.parse(
      fs.readFileSync("schemas/tool-definitions.json", "utf8"),
    ) as Array<{
      name: string;
      description: string;
      inputSchema: { properties: Record<string, unknown> };
    }>;
    const definition = definitions.find((value) => value.name === "setDeviceState")!;
    const validate = compileAjv(definition.inputSchema.properties.clock, {
      strict: false,
      validateFormats: false,
    });
    expect(validate({ mode: "set", instant: "2026-10-01T00:00:00Z" })).toBe(true);
    expect(validate({ mode: "set", instant: "2026-10-01T00:00:00" })).toBe(false);
    expect(validate({ mode: "advance", byMs: 315360000000 })).toBe(true);
    expect(validate({ mode: "advance", byMs: 315360000001 })).toBe(false);
    expect(validate({ mode: "advance", byMs: 1.5 })).toBe(false);
    expect(validate({ mode: "reset", instant: "2026-10-01T00:00:00Z" })).toBe(false);
    for (const warning of [
      "TLS/certificate validation",
      "token expiry",
      "freshness checks",
      "rootable Android emulators",
      "Play Store images",
      "session release",
    ]) {
      expect(definition.description).toContain(warning);
    }
    expect(() =>
      ToolRegistry.getTool("getDeviceState")!.schema.parse({ include: ["clock"] }),
    ).not.toThrow();
  });

  test("threads location through the setDeviceState handler", async () => {
    const setTool = ToolRegistry.getTool("setDeviceState");
    const physicalAndroid = createBootedDevice("38290DLJG000XY", "android", "Pixel 8");
    const response = await setTool!.deviceAwareHandler!(physicalAndroid, {
      location: { mode: "static", latitude: 37.7749, longitude: -122.4194 },
    });
    const payload = JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.location.supported).toBe(false);
    expect(payload.location.error).toContain("Use an Android emulator");
  });

  test("advertises a strict static location schema in generated tool definitions", () => {
    const definitions = JSON.parse(
      fs.readFileSync("schemas/tool-definitions.json", "utf8"),
    ) as Array<{
      name: string;
      inputSchema: { properties: Record<string, unknown> };
    }>;
    const schema = definitions.find((definition) => definition.name === "setDeviceState")
      ?.inputSchema.properties.location;
    expect(schema).toBeDefined();
    const validate = compileAjv(schema, { strict: false });
    expect(validate({ mode: "static", latitude: 90, longitude: -180 })).toBe(true);
    expect(validate({ mode: "static", latitude: 91, longitude: 0 })).toBe(false);
    expect(validate({ mode: "static", latitude: 0, longitude: 181 })).toBe(false);
    expect(validate({ mode: "static", latitude: 0, longitude: 0, extra: true })).toBe(false);
    expect(validate({ mode: "route", latitude: 0, longitude: 0 })).toBe(false);
    const waypoints = [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 1 },
    ];
    expect(validate({ mode: "route", waypoints, durationMs: 1000 })).toBe(true);
    expect(
      validate({
        mode: "route",
        waypoints,
        speedMetersPerSecond: 2,
        loop: true,
        updateIntervalMs: 200,
      }),
    ).toBe(true);
    expect(validate({ mode: "route", waypoints, durationMs: 1000, speedMetersPerSecond: 2 })).toBe(
      false,
    );
    expect(validate({ mode: "route", waypoints })).toBe(false);
    expect(validate({ mode: "stop" })).toBe(true);
  });

  test("threads connectivity through the setDeviceState handler", async () => {
    // iOS exits through the static unsupported path without creating an adb or
    // simctl client, so the returned connectivity result proves the handler
    // passed the field through to DeviceState.setState.
    const setTool = ToolRegistry.getTool("setDeviceState");
    const iosSimulator = createBootedDevice(
      "12345678-1234-1234-1234-123456789ABC",
      "ios",
      "iPhone 16",
    );

    const response = await setTool!.deviceAwareHandler!(iosSimulator, {
      connectivity: { wifiEnabled: false },
    });

    const payload = JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.connectivity).toMatchObject({ supported: false, verified: false });
    expect(payload.connectivity.error).toContain("cannot be set on iOS");
  });

  test("rejects networkCondition.expiresInSeconds in sessionless mode where no lifecycle owner can enforce it (#6085)", async () => {
    // Direct/sessionless mode: DaemonState is uninitialized, so the handler has no
    // SessionManager to schedule a TTL. A degrade that WOULD shape an emulator with
    // a TTL must be rejected rather than shape the device indefinitely while falsely
    // echoing the TTL.
    DaemonState.getInstance().reset();
    const setTool = ToolRegistry.getTool("setDeviceState");
    const emulator = createBootedDevice("emulator-5554", "android", "Pixel");

    const response = await setTool!.deviceAwareHandler!(emulator, {
      networkCondition: { profile: "3g", expiresInSeconds: 30 },
    });

    const payload = JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("cannot be honored in direct/sessionless mode");
  });

  test.each([false, true])(
    "biometric capture failure retains structured output with combined fields (%s)",
    async (combined) => {
      const timer = new FakeTimer();
      const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const pool = new DevicePool(
        createDevicePoolDependencies(sessions, "fake-daemon", {
          timer,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          deviceManager: new FakeDeviceManager([], []),
          retryExecutor: new DefaultRetryExecutor(timer),
        }),
      );
      DaemonState.getInstance().initialize(sessions, pool);
      const device = createBootedDevice("fake-ios", "ios");
      await sessions.createSession("fake-session", device.deviceId, "ios");
      const capture = spyOn(DeviceState.prototype, "getBiometricEnrollmentState").mockResolvedValue(
        { supported: true, error: "capture failed" },
      );
      const mutation = spyOn(DeviceState.prototype, "setState").mockResolvedValue({
        success: true,
        deviceId: device.deviceId,
        platform: "ios",
        doNotDisturb: { supported: true, enabled: false },
      });
      try {
        const response = await ToolRegistry.getTool("setDeviceState")!.deviceAwareHandler!(device, {
          sessionUuid: "fake-session",
          biometrics: { enrollment: "enrolled" },
          ...(combined ? { doNotDisturb: { enabled: false } } : {}),
        });
        const payload = {
          message: "capture failed",
          success: false,
          deviceId: device.deviceId,
          platform: "ios",
          ...(combined ? { doNotDisturb: { supported: true, enabled: false } } : {}),
          biometrics: { supported: true, error: "capture failed" },
          error: "capture failed",
        };
        expect(response.structuredContent).toEqual(payload);
        expect(response.content).toEqual(createJSONToolResponse(payload).content);
        expect(response.isError).toBeUndefined();
        expect(mutation).toHaveBeenCalledTimes(combined ? 1 : 0);
      } finally {
        capture.mockRestore();
        mutation.mockRestore();
        sessions.stopCleanupTimer();
      }
    },
  );

  test("does not register a network restore slot for an unsupported (iOS) platform", async () => {
    // #6012 (review #2): the slot's presence is authoritative evidence a device
    // was shaped, so an unsupported platform — where setState applies nothing —
    // must not register one.
    const fakeTimer = new FakeTimer();
    const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    const devicePool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
        timer: fakeTimer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: new FakeDeviceManager([], []),
        retryExecutor: new DefaultRetryExecutor(fakeTimer),
      }),
    );
    DaemonState.getInstance().initialize(sessionManager, devicePool);
    await sessionManager.createSession("ios-session", "sim-ios-1", "ios");

    const setTool = ToolRegistry.getTool("setDeviceState");
    await setTool!.deviceAwareHandler!(createBootedDevice("sim-ios-1", "ios", "iPhone 16"), {
      networkCondition: { profile: "3g" },
      sessionUuid: "ios-session",
    });

    expect(sessionManager.getNetworkCondition("ios-session")).toBeUndefined();
    sessionManager.stopCleanupTimer();
  });

  test("reads networkCondition through the getDeviceState handler on iOS", async () => {
    const getTool = ToolRegistry.getTool("getDeviceState");
    const iosSim = createBootedDevice("12345678-1234-1234-1234-123456789ABC", "ios", "iPhone 16");
    iosSim.displays = {
      panels: [
        { key: "primary", role: "cover", sizePx: { width: 1398, height: 2034 } },
        { key: "primary-1", role: "inner", sizePx: { width: 2007, height: 2853 } },
      ],
      postures: ["unknown"],
    };

    const response = await getTool!.deviceAwareHandler!(iosSim, {
      include: ["networkCondition"],
    });

    const payload = JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.displays).toEqual(iosSim.displays);
    expect(payload.networkCondition).toMatchObject({
      supported: false,
      capability: "unsupported",
      backend: "network-extension",
      controller: { state: "not_installed" },
    });
    expect(networkFilterBridge.statusCalls).toBeGreaterThan(0);
  });

  test("setDeviceState refuses a device-wide networkCondition on an iOS simulator (#10264)", async () => {
    networkFilterBridge.setState("ready");
    const setTool = ToolRegistry.getTool("setDeviceState");
    const iosSim = createBootedDevice("12345678-1234-1234-1234-123456789ABC", "ios", "iPhone 16");

    const response = await setTool!.deviceAwareHandler!(iosSim, {
      networkCondition: { profile: "offline" },
    });

    const payload = JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.networkCondition).toMatchObject({
      supported: false,
      capability: "unsupported",
      backend: "network-extension",
      scope: "device",
      requestedProfile: "offline",
      verified: false,
    });
    expect(payload.networkCondition.error).toContain("networkCondition.appId");
    expect(payload.networkCondition.error).not.toContain("host-side proxy");
    expect(networkFilterBridge.ruleCalls).toEqual([]);
  });

  test("setActiveDevice binds a refreshed session device in the pool", async () => {
    const fakeTimer = new FakeTimer();
    const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    const fakeDeviceManager = new FakeDeviceManager(
      [],
      [createBootedDevice("sim-new", "ios", "iPhone 16")],
    );
    PlatformDeviceManagerFactory.setInstance(fakeDeviceManager);
    const devicePool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
        timer: fakeTimer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: fakeDeviceManager,
        retryExecutor: new DefaultRetryExecutor(fakeTimer),
      }),
    );
    DaemonState.getInstance().initialize(sessionManager, devicePool);
    const device = createBootedDevice("sim-new", "ios", "iPhone 16");
    await IOSCtrlProxyClient.retireInstance(device.deviceId);
    const retired = IOSCtrlProxyClient.getInstance(device);

    const setActiveDevice = ToolRegistry.getTool("setActiveDevice");
    await setActiveDevice!.handler({
      deviceId: "sim-new",
      platform: "ios",
      sessionUuid: "session-1",
    });

    expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("sim-new");
    expect(devicePool.getDevice("sim-new")?.sessionId).toBe("session-1");
    expect(devicePool.getDevice("sim-new")?.status).toBe("busy");
    expect(sessionManager.getDeviceReadiness("session-1")).toBe("booted");
    sessionManager.setDeviceReadiness("session-1", "automationReady");
    await setActiveDevice!.handler({
      deviceId: "sim-new",
      platform: "ios",
      sessionUuid: "session-1",
    });
    expect(sessionManager.getDeviceReadiness("session-1")).toBe("automationReady");
    expect(IOSCtrlProxyClient.getInstance(device)).not.toBe(retired);

    sessionManager.stopCleanupTimer();
  });

  test("setActiveDevice resumes a re-admitted Android device", async () => {
    const fakeTimer = new FakeTimer();
    const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
    const fakeDeviceManager = new FakeDeviceManager([], [device]);
    PlatformDeviceManagerFactory.setInstance(fakeDeviceManager);
    const devicePool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
        timer: fakeTimer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: fakeDeviceManager,
        retryExecutor: new DefaultRetryExecutor(fakeTimer),
      }),
    );
    DaemonState.getInstance().initialize(sessionManager, devicePool);
    AndroidCtrlProxyClient.retireForShutdown(device.deviceId);
    const retired = AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory());

    await ToolRegistry.getTool("setActiveDevice")!.handler({
      deviceId: device.deviceId,
      platform: "android",
      sessionUuid: "session-1",
    });

    expect(AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory())).not.toBe(
      retired,
    );
    sessionManager.stopCleanupTimer();
  });

  test("A3 setActiveDevice preserves a tombstone installed during discovery", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const device = createBootedDevice("sim-racing", "ios", "iPhone 16");
    const manager = new FakeDeviceManager([], [device]);
    const entered = Promise.withResolvers<void>();
    const releaseDiscovery = Promise.withResolvers<void>();
    manager.getBootedDevices = async () => {
      entered.resolve();
      await releaseDiscovery.promise;
      return [device];
    };
    PlatformDeviceManagerFactory.setInstance(manager);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
    );
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    const selection = ToolRegistry.getTool("setActiveDevice")!.handler({
      deviceId: device.deviceId,
      platform: "ios",
      sessionUuid: "session-1",
    });
    await entered.promise;
    const shutdown = await pool.reserveDeviceForShutdown(device.deviceId);
    await IOSCtrlProxyClient.retireInstance(device.deviceId);
    const retired = IOSCtrlProxyClient.getInstance(device);
    releaseDiscovery.resolve();
    await expect(selection).rejects.toThrow(/shutting down/);
    expect(await pool.isShutdownReserved(device.deviceId)).toBe(true);
    expect(IOSCtrlProxyClient.getInstance(device)).toBe(retired);
    await shutdown?.release();
    sessionManager.stopCleanupTimer();
  });

  test("setActiveDevice keeps a cached but no longer booted device retired", async () => {
    const fakeTimer = new FakeTimer();
    const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    const device = createBootedDevice("sim-stopped", "ios", "iPhone 16");
    const devicePool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
        timer: fakeTimer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: new FakeDeviceManager([], [device]),
        retryExecutor: new DefaultRetryExecutor(fakeTimer),
      }),
    );
    await devicePool.initializeWithDevices([device]);
    const freshDiscovery = new FakeDeviceManager([], []);
    PlatformDeviceManagerFactory.setInstance(freshDiscovery);
    DaemonState.getInstance().initialize(sessionManager, devicePool);
    await IOSCtrlProxyClient.retireInstance(device.deviceId);
    const retired = IOSCtrlProxyClient.getInstance(device);

    await ToolRegistry.getTool("setActiveDevice")!.handler({
      deviceId: device.deviceId,
      platform: "ios",
      sessionUuid: "session-1",
    });

    expect(devicePool.getDevice(device.deviceId)).not.toBeNull();
    expect(IOSCtrlProxyClient.getInstance(device)).toBe(retired);
    expect(await retired.ensureConnected()).toBe(false);
    sessionManager.stopCleanupTimer();
  });

  test("setActiveDevice rejects devices owned by another live session", async () => {
    const fakeTimer = new FakeTimer();
    const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    const fakeDeviceManager = new FakeDeviceManager(
      [],
      [
        createBootedDevice("sim-a", "ios", "iPhone 15"),
        createBootedDevice("sim-b", "ios", "iPhone 16"),
      ],
    );
    PlatformDeviceManagerFactory.setInstance(fakeDeviceManager);
    const devicePool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
        timer: fakeTimer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: fakeDeviceManager,
        retryExecutor: new DefaultRetryExecutor(fakeTimer),
      }),
    );
    await devicePool.initializeWithDevices([
      createBootedDevice("sim-a", "ios", "iPhone 15"),
      createBootedDevice("sim-b", "ios", "iPhone 16"),
    ]);
    await devicePool.bindOrReuseDeviceSession("session-a", "sim-a", "ios");
    await devicePool.bindOrReuseDeviceSession("session-b", "sim-b", "ios");
    DaemonState.getInstance().initialize(sessionManager, devicePool);

    const setActiveDevice = ToolRegistry.getTool("setActiveDevice");
    await expect(
      setActiveDevice!.handler({
        deviceId: "sim-b",
        platform: "ios",
        sessionUuid: "session-a",
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/already assigned to session session-b/),
      // Typed like the input/* and tools/call refusals (#10832); clients match the code.
      code: "device_owned_by_other_session",
      deviceId: "sim-b",
    });

    expect(sessionManager.getSession("session-a")?.assignedDevice).toBe("sim-a");
    expect(devicePool.getDevice("sim-a")?.sessionId).toBe("session-a");
    expect(devicePool.getDevice("sim-b")?.sessionId).toBe("session-b");

    sessionManager.stopCleanupTimer();
  });
});
