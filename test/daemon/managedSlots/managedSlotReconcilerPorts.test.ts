import { describe, expect, test } from "bun:test";
import {
  DeviceManagerSlotInventory,
  PoolManagedSlotDeviceClaims,
  ToolManagedSlotProvisioner,
  type ManagedSlotToolInvoker,
} from "../../../src/daemon/managedSlots/managedSlotReconcilerPorts";
import type { PooledDevice } from "../../../src/daemon/devicePool";
import { ProvisionDeviceError } from "../../../src/devices/exactDeviceProvisioning";
import type { DeviceInfo } from "../../../src/models";
import {
  createProvisionDeviceResponse,
  createToolErrorResponse,
} from "../../../src/server/deviceTools";
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

  test("another daemon's claim holds the device", async () => {
    const claims = new PoolManagedSlotDeviceClaims({
      getAllDevices: () => [pooled(null)],
      assertNotClaimedByForeignDaemon: async () => {
        throw new Error("owned by daemon 99");
      },
    });
    expect(await claims.describe(avd)).toEqual({ kind: "held", reason: "owned by daemon 99" });
  });

  test("an unidentified running device is unknown; an idle one is free", async () => {
    const pool = { getAllDevices: () => [], assertNotClaimedByForeignDaemon: async () => {} };
    const claims = new PoolManagedSlotDeviceClaims(pool);
    expect((await claims.describe({ ...avd, isRunningStateKnown: false })).kind).toBe("unknown");
    expect((await claims.describe({ ...avd, isRunning: false })).kind).toBe("free");
  });
});
