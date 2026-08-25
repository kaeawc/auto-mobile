import { describe, expect, test } from "bun:test";
import {
  DevicectlDeviceLister,
  parseDevicectlDeviceList,
} from "../../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";
import type { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

const PHYSICAL_UDID = "00008120-001C2D3E1234567A";
const LEGACY_UDID = "a".repeat(40);
const SIMULATOR_UDID = "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6";

function devicectlPayload(devices: unknown[]): unknown {
  return { info: { outcome: "success" }, result: { devices } };
}

function connectedIphone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identifier: "8FB0A5A4-0000-0000-0000-000000000000",
    deviceProperties: { name: "Jason's iPhone", osVersionNumber: "18.6" },
    hardwareProperties: {
      udid: PHYSICAL_UDID,
      platform: "iOS",
      productType: "iPhone16,1",
      marketingName: "iPhone 15 Pro",
    },
    connectionProperties: { tunnelState: "connected", pairingState: "paired" },
    ...overrides,
  };
}

const okExec: ExecResult = { stdout: "", stderr: "", toString: () => "" } as ExecResult;

function makeLister(overrides: Record<string, unknown>): DevicectlDeviceLister {
  return new DevicectlDeviceLister({
    platform: () => "darwin",
    tmpdir: () => "/tmp",
    mkdtemp: async (prefix) => `${prefix}abc123`,
    rm: async () => {},
    execute: async () => okExec,
    logger: { debug: () => {}, warn: () => {} },
    timer: new FakeTimer(),
    ...overrides,
  } as ConstructorParameters<typeof DevicectlDeviceLister>[0]);
}

describe("parseDevicectlDeviceList", () => {
  test("maps a connected physical device to a BootedDevice", () => {
    expect(parseDevicectlDeviceList(devicectlPayload([connectedIphone()]))).toEqual([
      {
        name: "Jason's iPhone",
        platform: "ios",
        deviceId: PHYSICAL_UDID,
        iosVersion: "18.6",
        osVersion: "18.6",
        formFactor: "phone",
      },
    ]);
  });

  test("infers the tablet form factor from an iPad product type", () => {
    const devices = parseDevicectlDeviceList(
      devicectlPayload([
        connectedIphone({
          deviceProperties: { name: "Test iPad" },
          hardwareProperties: { udid: LEGACY_UDID, productType: "iPad14,3" },
        }),
      ]),
    );

    expect(devices).toEqual([
      { name: "Test iPad", platform: "ios", deviceId: LEGACY_UDID, formFactor: "tablet" },
    ]);
  });

  test("drops devices devicectl reports as unreachable", () => {
    const devices = parseDevicectlDeviceList(
      devicectlPayload([
        connectedIphone({ connectionProperties: { tunnelState: "unavailable" } }),
        connectedIphone({
          hardwareProperties: { udid: LEGACY_UDID },
          connectionProperties: { tunnelState: "disconnected" },
        }),
      ]),
    );

    expect(devices).toEqual([]);
  });

  test("keeps devices whose tunnel state is missing or unrecognized", () => {
    const devices = parseDevicectlDeviceList(
      devicectlPayload([
        connectedIphone({ connectionProperties: {} }),
        connectedIphone({
          deviceProperties: { name: "Second" },
          hardwareProperties: { udid: LEGACY_UDID },
          connectionProperties: { tunnelState: "someFutureState" },
        }),
      ]),
    );

    expect(devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID, LEGACY_UDID].sort());
  });

  test("rejects records whose udid is not a physical iOS udid", () => {
    const devices = parseDevicectlDeviceList(
      devicectlPayload([
        connectedIphone({ hardwareProperties: { udid: SIMULATOR_UDID } }),
        connectedIphone({ hardwareProperties: { udid: "emulator-5554" } }),
        connectedIphone({ hardwareProperties: {} }),
        "not-an-object",
      ]),
    );

    expect(devices).toEqual([]);
  });

  test("falls back through name sources when deviceProperties has no name", () => {
    const devices = parseDevicectlDeviceList(
      devicectlPayload([
        connectedIphone({ deviceProperties: {} }),
        connectedIphone({
          deviceProperties: {},
          hardwareProperties: { udid: LEGACY_UDID },
        }),
      ]),
    );

    expect(devices.map((device) => device.name).sort()).toEqual(
      [LEGACY_UDID, "iPhone 15 Pro"].sort(),
    );
  });

  test("returns an empty list for payload shapes it does not understand", () => {
    expect(parseDevicectlDeviceList(null)).toEqual([]);
    expect(parseDevicectlDeviceList({ result: {} })).toEqual([]);
    expect(parseDevicectlDeviceList({ result: { devices: "nope" } })).toEqual([]);
    expect(parseDevicectlDeviceList([connectedIphone()])).toHaveLength(1);
  });
});

describe("DevicectlDeviceLister", () => {
  test("does not invoke devicectl off macOS", async () => {
    let executed = 0;
    const lister = makeLister({
      platform: () => "linux",
      execute: async () => {
        executed++;
        return okExec;
      },
    });

    expect(await lister.listConnectedDevices()).toEqual([]);
    expect(executed).toBe(0);
  });

  test("reads the devicectl JSON output it asked for", async () => {
    let args: string[] = [];
    const lister = makeLister({
      execute: async (_file: string, execArgs: string[]) => {
        args = execArgs;
        return okExec;
      },
      readFile: async (path: string) => {
        expect(path).toBe("/tmp/automobile-devicectl-devices-abc123/devices.json");
        return JSON.stringify(devicectlPayload([connectedIphone()]));
      },
    });

    const devices = await lister.listConnectedDevices();

    expect(devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
    expect(args.slice(0, 3)).toEqual(["devicectl", "list", "devices"]);
    expect(args).toContain("/tmp/automobile-devicectl-devices-abc123/devices.json");
  });

  test("degrades to an empty list when devicectl is unavailable", async () => {
    const lister = makeLister({
      execute: async () => {
        throw new Error('xcrun: error: unable to find utility "devicectl"');
      },
    });

    expect(await lister.listConnectedDevices()).toEqual([]);
  });

  test("degrades to an empty list when the JSON output is unreadable", async () => {
    const lister = makeLister({ readFile: async () => "{not json" });

    expect(await lister.listConnectedDevices()).toEqual([]);
  });

  test("removes its temp directory on both success and failure", async () => {
    const removed: string[] = [];
    const succeeding = makeLister({
      rm: async (path: string) => {
        removed.push(path);
      },
      readFile: async () => JSON.stringify(devicectlPayload([])),
    });
    const failing = makeLister({
      rm: async (path: string) => {
        removed.push(path);
      },
      execute: async () => {
        throw new Error("boom");
      },
    });

    await succeeding.listConnectedDevices();
    await failing.listConnectedDevices();

    expect(removed).toEqual([
      "/tmp/automobile-devicectl-devices-abc123",
      "/tmp/automobile-devicectl-devices-abc123",
    ]);
  });

  test("reuses a listing within the cache window and re-shells out after it", async () => {
    const timer = new FakeTimer();
    let executions = 0;
    const lister = makeLister({
      timer,
      execute: async () => {
        executions++;
        return okExec;
      },
      readFile: async () => JSON.stringify(devicectlPayload([connectedIphone()])),
    });

    await lister.listConnectedDevices();
    await lister.listConnectedDevices();
    expect(executions).toBe(1);

    timer.advanceTime(2_999);
    await lister.listConnectedDevices();
    expect(executions).toBe(1);

    timer.advanceTime(2);
    expect((await lister.listConnectedDevices()).map((device) => device.deviceId)).toEqual([
      PHYSICAL_UDID,
    ]);
    expect(executions).toBe(2);
  });

  test("caches an unavailable host so every sweep does not respawn devicectl", async () => {
    let executions = 0;
    const lister = makeLister({
      execute: async () => {
        executions++;
        throw new Error("devicectl missing");
      },
    });

    expect(await lister.listConnectedDevices()).toEqual([]);
    expect(await lister.listConnectedDevices()).toEqual([]);
    expect(executions).toBe(1);
  });

  test("concurrent sweeps share a single devicectl invocation", async () => {
    let executions = 0;
    const lister = makeLister({
      execute: async () => {
        executions++;
        return okExec;
      },
      readFile: async () => JSON.stringify(devicectlPayload([connectedIphone()])),
    });

    const [first, second] = await Promise.all([
      lister.listConnectedDevices(),
      lister.listConnectedDevices(),
    ]);

    expect(executions).toBe(1);
    expect(first).toEqual(second);
  });

  test("a cleanup failure does not turn a good listing into an empty one", async () => {
    const lister = makeLister({
      rm: async () => {
        throw new Error("EBUSY");
      },
      readFile: async () => JSON.stringify(devicectlPayload([connectedIphone()])),
    });

    expect((await lister.listConnectedDevices()).map((device) => device.deviceId)).toEqual([
      PHYSICAL_UDID,
    ]);
  });
});
