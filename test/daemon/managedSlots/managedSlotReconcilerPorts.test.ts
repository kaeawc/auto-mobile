import { describe, expect, test } from "bun:test";
import {
  DeviceManagerSlotInventory,
  GateManagedSlotBootCapacity,
  PoolManagedSlotDeviceClaims,
  ToolManagedSlotProvisioner,
  type ManagedSlotToolInvoker,
} from "../../../src/daemon/managedSlots/managedSlotReconcilerPorts";
import type { PooledDevice } from "../../../src/daemon/devicePool";
import { ProvisionDeviceError } from "../../../src/devices/exactDeviceProvisioning";
import type { BootedDevice, DeviceInfo } from "../../../src/models";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { BootedDeviceDiscoveryIncompleteError } from "../../../src/models/BootedDeviceDiscoveryIncompleteError";
import {
  createProvisionDeviceResponse,
  createToolErrorResponse,
} from "../../../src/server/deviceTools";
import { MultiPlatformDeviceManager } from "../../../src/devices/deviceUtils";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { createFakeAndroidEmulator } from "../../fakes/FakeAndroidEmulator";
import { FakeTimer } from "../../fakes/FakeTimer";

const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";

function recordingInvoker(response: unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const invoke: ManagedSlotToolInvoker = async (name, args) => {
    calls.push({ name, args });
    return response;
  };
  return { calls, invoke };
}

function provisionerWith(invoke: ManagedSlotToolInvoker, images: DeviceInfo[] = []) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000);
  return new ToolManagedSlotProvisioner({
    invokeTool: invoke,
    deviceManager: { listDeviceImages: async () => images },
    androidConfigReader: {
      readConfig: async () => ({ deviceName: "pixel_8" }) as never,
    },
    timer,
    releaseSession: async () => {},
  });
}

describe("ToolManagedSlotProvisioner", () => {
  test("provisions with automation readiness and reads the provisionDevice result", async () => {
    const { calls, invoke } = recordingInvoker(
      createProvisionDeviceResponse({
        device: {
          name: "amslot-abc-0-g1-x",
          platform: "ios",
          identity: { stableId: "UDID-1" },
          runtime: { deviceId: "UDID-1" },
        },
        created: true,
        adopted: false,
        lifecycleState: "ready",
        readiness: { mode: "automation", status: "automation_ready" },
        sessionId: "session-9",
      }),
    );

    const provisioned = await provisionerWith(invoke).provision({
      platform: "ios",
      name: "amslot-abc-0-g1-x",
      spec: { runtime: IOS_18, deviceType: IPHONE_16 },
      mode: "create",
      deadlineMs: 61_000,
    });

    expect(calls[0]).toEqual({
      name: "provisionDevice",
      args: {
        device: {
          platform: "ios",
          name: "amslot-abc-0-g1-x",
          spec: { runtime: IOS_18, deviceType: IPHONE_16 },
        },
        boot: true,
        readiness: "automation",
        timeoutMs: 60_000,
      },
    });
    expect(provisioned).toMatchObject({
      device: { stableId: "UDID-1", transportId: "UDID-1", name: "amslot-abc-0-g1-x" },
      created: true,
      sessionUuid: "session-9",
      readiness: { mode: "automation", status: "automation_ready" },
    });
  });

  test("an error response is rethrown as the typed provision failure", async () => {
    const { invoke } = recordingInvoker(
      createToolErrorResponse("capacity_exhausted", "3 devices booted", {
        error: {
          code: "capacity_exhausted",
          message: "3 devices booted",
          retryable: true,
          retryAfterMs: 5_000,
          limit: 3,
          booted: 3,
        },
      }),
    );

    const error = await provisionerWith(invoke)
      .provision({
        platform: "ios",
        name: "n",
        spec: { runtime: IOS_18, deviceType: IPHONE_16 },
        mode: "create",
        deadlineMs: 61_000,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProvisionDeviceError);
    expect(error).toMatchObject({
      code: "capacity_exhausted",
      retryable: true,
      diagnostics: { retryAfterMs: 5_000, capacity: { limit: 3, booted: 3 } },
    });
  });

  test("adopting with an omitted model passes the existing device's own model", async () => {
    const { calls, invoke } = recordingInvoker(
      createProvisionDeviceResponse({
        device: { name: "sim", platform: "ios", identity: { stableId: "UDID-2" } },
        created: false,
        lifecycleState: "ready",
        readiness: { mode: "automation", status: "automation_ready" },
        sessionId: "s",
      }),
    );
    const images: DeviceInfo[] = [
      { name: "sim", platform: "ios", deviceId: "UDID-2", isRunning: false, deviceType: IPHONE_16 },
    ];

    await provisionerWith(invoke, images).provision({
      platform: "ios",
      name: "sim",
      deviceId: "UDID-2",
      spec: { runtime: IOS_18 },
      mode: "adopt",
      deadlineMs: 61_000,
    });

    expect((calls[0]!.args.device as { spec: unknown }).spec).toEqual({
      runtime: IOS_18,
      deviceType: IPHONE_16,
    });
  });
});

describe("DeviceManagerSlotInventory", () => {
  test("a failed listing is incomplete, never empty-and-complete", async () => {
    const inventory = new DeviceManagerSlotInventory({
      listDeviceImages: async () => {
        throw new Error("simctl list timed out");
      },
    });

    expect(await inventory.list("ios", {})).toEqual({ complete: false, devices: [] });
  });
});

describe("PoolManagedSlotDeviceClaims", () => {
  const avd: DeviceInfo = { name: "slot-avd", platform: "android", isRunning: true };

  function pooled(sessionId: string | null): PooledDevice {
    return {
      id: "emulator-5554",
      name: "slot-avd",
      avdName: "slot-avd",
      platform: "android",
      sessionId,
    } as PooledDevice;
  }

  test("a pooled runtime with a session holds the device", async () => {
    const claims = new PoolManagedSlotDeviceClaims({
      getAllDevices: () => [pooled("session-1")],
      assertNotClaimedByForeignDaemon: async () => {},
    });
    expect((await claims.describe(avd)).kind).toBe("held");
  });

  test("reports a session as a live execution only when the daemon holds it as one (#11275)", () => {
    const pool = {
      getAllDevices: () => [pooled("session-1")],
      assertNotClaimedByForeignDaemon: async () => {},
    };
    const claims = new PoolManagedSlotDeviceClaims(pool, {
      isLiveManagedExecutionSession: (sessionUuid) => sessionUuid === "session-1",
    });
    expect(claims.isLiveExecution("session-1")).toBe(true);
    expect(claims.isLiveExecution("session-2")).toBe(false);
    expect(new PoolManagedSlotDeviceClaims(pool).isLiveExecution("session-1")).toBe(false);
  });

  test("lists the sessions this daemon's pool holds on the device, and only on it", () => {
    const claims = new PoolManagedSlotDeviceClaims({
      getAllDevices: () => [
        pooled("session-1"),
        { ...pooled("other-session"), id: "emulator-5556", name: "other", avdName: "other" },
      ],
      assertNotClaimedByForeignDaemon: async () => {},
    });
    expect(claims.sessionsOn(avd)).toEqual(["session-1"]);
    expect(
      new PoolManagedSlotDeviceClaims({
        getAllDevices: () => [pooled(null)],
        assertNotClaimedByForeignDaemon: async () => {},
      }).sessionsOn(avd),
    ).toEqual([]);
  });

  test("another daemon's claim holds the device", async () => {
    const claims = new PoolManagedSlotDeviceClaims({
      getAllDevices: () => [pooled(null)],
      assertNotClaimedByForeignDaemon: async () => {
        throw new Error("owned by daemon 99");
      },
    });
    expect(await claims.describe(avd)).toEqual({ kind: "held", reason: "owned by daemon 99" });
  });

  test("an idle device with a known stopped state is free", async () => {
    const pool = { getAllDevices: () => [], assertNotClaimedByForeignDaemon: async () => {} };
    const claims = new PoolManagedSlotDeviceClaims(pool);
    expect((await claims.describe({ ...avd, isRunning: false })).kind).toBe("free");
  });

  describe("driven by the real Android listing shape", () => {
    async function listedAvd(booted: BootedDevice[] | Error): Promise<DeviceInfo> {
      const fakeEmulator = createFakeAndroidEmulator({
        listAvds: async () => [{ name: "amslot-a", platform: "android", isRunning: false }],
        getBootedDevicesChecked: async () => {
          if (booted instanceof Error) {
            throw booted;
          }
          return booted;
        },
      });
      const manager = new MultiPlatformDeviceManager(
        new FakeAdbClient() as unknown as AdbClient,
        undefined,
        fakeEmulator,
      );
      const inventory = await new DeviceManagerSlotInventory(manager).list("android", {});
      return inventory.devices[0];
    }

    const unresolved: BootedDevice = {
      name: "Unknown (emulator-5554)",
      platform: "android",
      deviceId: "emulator-5554",
      source: "local",
    };

    test("an AVD whose adb listing failed is unknown, not free", async () => {
      const device = await listedAvd(new Error("adb devices unavailable"));
      expect(device).toMatchObject({ isRunning: false, isRunningStateKnown: false });
      const pool = { getAllDevices: () => [], assertNotClaimedByForeignDaemon: async () => {} };
      expect((await new PoolManagedSlotDeviceClaims(pool).describe(device)).kind).toBe("unknown");
    });

    test("an unresolved emulator held by a session makes the AVD unknown, not free", async () => {
      const device = await listedAvd([unresolved]);
      expect(device.isRunningStateKnown).toBe(false);
      const heldPool = {
        getAllDevices: () =>
          [
            {
              id: "emulator-5554",
              name: "Unknown (emulator-5554)",
              platform: "android",
              sessionId: "s-1",
            },
          ] as PooledDevice[],
        assertNotClaimedByForeignDaemon: async () => {},
      };
      expect((await new PoolManagedSlotDeviceClaims(heldPool).describe(device)).kind).toBe(
        "unknown",
      );
    });

    test("a fully listed stopped AVD stays free", async () => {
      const device = await listedAvd([]);
      const pool = { getAllDevices: () => [], assertNotClaimedByForeignDaemon: async () => {} };
      expect((await new PoolManagedSlotDeviceClaims(pool).describe(device)).kind).toBe("free");
    });
  });
});

describe("GateManagedSlotBootCapacity", () => {
  test("a passing gate check is available capacity", async () => {
    const platforms: string[] = [];
    const capacity = new GateManagedSlotBootCapacity(new FakeTimer(), async (platform) => {
      platforms.push(platform);
    });

    expect(await capacity.check("ios", {})).toEqual({ kind: "available" });
    expect(platforms).toEqual(["ios"]);
  });

  test("the gate's refusal keeps its limit, count, wait hint and external devices", async () => {
    const capacity = new GateManagedSlotBootCapacity(new FakeTimer(), async () => {
      throw new BootCapacityExhaustedError(
        { platform: "ios", limit: 2, booted: 3, retryAfterMs: 5_000, externalDevices: ["UDID-1"] },
        "full",
      );
    });

    expect(await capacity.check("ios", {})).toEqual({
      kind: "exhausted",
      limit: 2,
      booted: 3,
      retryAfterMs: 5_000,
      externalDevices: ["UDID-1"],
    });
  });

  test("the gate's unknown booted count is unknown, never available", async () => {
    const capacity = new GateManagedSlotBootCapacity(new FakeTimer(), async () => {
      throw new BootedDeviceDiscoveryIncompleteError("ios", {
        code: "failed",
        message: "simulator count unknown",
        retryable: true,
      });
    });

    expect(await capacity.check("ios", {})).toMatchObject({
      kind: "unknown",
      message: expect.stringContaining("simulator count unknown"),
    });
  });

  test("a check that never answers is unknown after 5 s, with no real wait", async () => {
    const timer = new FakeTimer();
    const capacity = new GateManagedSlotBootCapacity(timer, () => new Promise<void>(() => {}));

    const check = capacity.check("ios", {});
    await timer.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void check.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await timer.advanceTimersByTimeAsync(1);

    expect(await check).toEqual({
      kind: "unknown",
      message: "Timed out after 5000ms checking ios boot capacity.",
    });
  });

  test("a defect in the gate propagates instead of becoming a retryable refusal", async () => {
    const capacity = new GateManagedSlotBootCapacity(new FakeTimer(), async () => {
      throw new TypeError("gate.decide is not a function");
    });

    await expect(capacity.check("android", {})).rejects.toThrow("gate.decide is not a function");
  });

  test("a cancelled check rethrows the cancellation instead of reporting a count", async () => {
    const controller = new AbortController();
    const capacity = new GateManagedSlotBootCapacity(new FakeTimer(), async () => {
      controller.abort(new Error("cancelled"));
      await new Promise<void>(() => {});
    });

    await expect(capacity.check("android", { signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
  });
});
