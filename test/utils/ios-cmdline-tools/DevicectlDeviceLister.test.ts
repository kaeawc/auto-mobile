import { describe, expect, test } from "bun:test";
import {
  DevicectlDeviceLister,
  classifyDevicectlInvocationError,
  parseDevicectlDeviceList,
} from "../../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";
import type { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDiscoveryObservationSequence } from "../../fakes/FakeDiscoveryObservationSequence";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { join } from "path";
import { DefaultHostCommandExecutor } from "../../../src/utils/HostCommandExecutor";
import {
  loadDerivedDevicectlListing,
  derivePhysicalDevicectlRecord,
} from "../../helpers/devicectlListFixtures";

const PHYSICAL_UDID = "00008120-001C2D3E1234567A";
const LEGACY_UDID = "a".repeat(40);
const SIMULATOR_UDID = "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6";

function devicectlPayload(devices: unknown[]): unknown {
  return { info: { outcome: "success" }, result: { devices } };
}

// Constructed legacy physical records; these are not captured payloads.
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

// Built with `join` rather than literal "/" so the assertions hold on Windows,
// where the production code's `join(tmpdir(), ...)` yields backslashes.
const TEMP_DIR = join("/tmp", "automobile-devicectl-devices-abc123");
const JSON_PATH = join(TEMP_DIR, "devices.json");

const DEVICE_LIST_CACHE_TTL_MS = 3_000;

const okExec: ExecResult = { stdout: "", stderr: "", toString: () => "" } as ExecResult;

function makeLister(
  overrides: ConstructorParameters<typeof DevicectlDeviceLister>[0],
): DevicectlDeviceLister {
  return new DevicectlDeviceLister({
    platform: () => "darwin",
    tmpdir: () => "/tmp",
    mkdtemp: async (prefix) => `${prefix}abc123`,
    rm: async () => {},
    execute: async () => okExec,
    logger: { debug: () => {}, warn: () => {} },
    timer: new FakeTimer(),
    observationSequence: new FakeDiscoveryObservationSequence(),
    ...overrides,
  });
}

function parseListing(data: unknown) {
  const parsed = parseDevicectlDeviceList(data);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return parsed;
}

describe("parseDevicectlDeviceList (constructed records)", () => {
  test("maps a connected physical device to a BootedDevice", () => {
    expect(parseListing(devicectlPayload([connectedIphone()])).physical).toEqual([
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
    const { physical: devices } = parseListing(
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
    const { physical: devices } = parseListing(
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
    const { physical: devices } = parseListing(
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

  test("rejects connected non-iOS CoreDevices (Watch, TV, Vision)", () => {
    const { physical: devices } = parseListing(
      devicectlPayload([
        connectedIphone({
          hardwareProperties: { udid: LEGACY_UDID, platform: "watchOS", productType: "Watch7,1" },
        }),
        connectedIphone({
          hardwareProperties: { udid: PHYSICAL_UDID, platform: "xrOS" },
        }),
      ]),
    );

    expect(devices).toEqual([]);
  });

  test("keeps iPadOS records and records that omit the platform field", () => {
    const { physical: devices } = parseListing(
      devicectlPayload([
        connectedIphone({
          hardwareProperties: { udid: LEGACY_UDID, platform: "iPadOS", productType: "iPad14,3" },
        }),
        connectedIphone({ hardwareProperties: { udid: PHYSICAL_UDID } }),
      ]),
    );

    expect(devices.map((device) => device.deviceId).sort()).toEqual(
      [LEGACY_UDID, PHYSICAL_UDID].sort(),
    );
  });

  test("UDID shape alone is insufficient simulator evidence", () => {
    const discovery = parseListing(
      devicectlPayload([
        { hardwareProperties: { udid: SIMULATOR_UDID } },
        { hardwareProperties: { udid: "emulator-5554" } },
        { hardwareProperties: {} },
        "not-an-object",
      ]),
    );
    expect(discovery.physical).toEqual([]);
    expect(discovery.notAvailable).toEqual([]);
    expect(discovery.unidentified).toHaveLength(4);
  });

  test("falls back through name sources when deviceProperties has no name", () => {
    const { physical: devices } = parseListing(
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

  test("unreadable envelopes return a reason", () => {
    for (const envelope of [
      null,
      { result: {} },
      { info: { outcome: "success" } },
      { result: { devices: "nope" } },
      { info: { outcome: "failure" }, result: { devices: [] } },
    ]) {
      const parsed = parseDevicectlDeviceList(envelope);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toContain("devicectl");
      }
    }
  });

  test("unidentifiable records are reported separately from parsed devices", () => {
    for (const entry of [
      { hardwareProperties: { platform: "iOS" } },
      { hardwareProperties: { udid: 42 } },
      "not-an-object",
    ]) {
      const parsed = parseListing(devicectlPayload([entry]));
      expect(parsed.physical).toEqual([]);
      expect(parsed.unidentified).toHaveLength(1);
    }
  });

  test("a healthy device alongside an unidentifiable one is still reported", () => {
    const discovery = parseListing(
      devicectlPayload([connectedIphone(), { hardwareProperties: { platform: "iOS" } }]),
    );

    expect(discovery.physical.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
    expect(discovery.ok).toBe(true);
    expect(discovery.unidentified).toHaveLength(1);
  });

  test("records it deliberately filters keep the listing authoritative", () => {
    // A paired Watch and an unreachable phone are understood, not drifted: the
    // sweep still knows exactly which physical iOS devices are attached.
    expect(
      parseListing(
        devicectlPayload([
          connectedIphone({ hardwareProperties: { udid: PHYSICAL_UDID, platform: "watchOS" } }),
          connectedIphone({ connectionProperties: { tunnelState: "unavailable" } }),
        ]),
      ),
    ).toMatchObject({ ok: true, physical: [] });
  });

  test("a recognized empty listing is authoritative", () => {
    expect(parseListing(devicectlPayload([]))).toMatchObject({ ok: true, physical: [] });
    expect(parseListing([connectedIphone()]).physical).toHaveLength(1);
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

    expect(await lister.listConnectedDevices()).toEqual({ devices: [], complete: true });
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
        expect(path).toBe(JSON_PATH);
        return JSON.stringify(devicectlPayload([connectedIphone()]));
      },
    });

    const discovery = await lister.listConnectedDevices();

    expect(discovery.devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
    expect(discovery.complete).toBe(true);
    expect(args.slice(0, 3)).toEqual(["devicectl", "list", "devices"]);
    expect(args).toContain(JSON_PATH);
  });

  test("degrades to an incomplete empty list when devicectl is unavailable", async () => {
    const lister = makeLister({
      execute: async () => {
        throw new Error('xcrun: error: unable to find utility "devicectl"');
      },
    });

    // `complete: false` is what stops the daemon reading this as "the iPhone
    // disconnected" and pruning a device that is still plugged in.
    expect(await lister.listConnectedDevices()).toMatchObject({
      devices: [],
      complete: false,
      error: { code: "unavailable" },
    });
  });

  test("degrades to an incomplete empty list when the JSON output is unreadable", async () => {
    const lister = makeLister({ readFile: async () => "{not json" });

    expect(await lister.listConnectedDevices()).toMatchObject({
      devices: [],
      complete: false,
      error: { code: "failed" },
    });
  });

  test("bounds the devicectl invocation without binding it to one caller's abort", async () => {
    let options: { timeoutMs?: number; signal?: AbortSignal } | undefined;
    const controller = new AbortController();
    const lister = makeLister({
      execute: async (_file: string, _args: string[], execOptions: typeof options) => {
        options = execOptions;
        return okExec;
      },
      readFile: async () => JSON.stringify(devicectlPayload([])),
    });

    await runWithAbortSignal(controller.signal, () => lister.listConnectedDevices());

    // The listing is shared between concurrent callers, so it must not inherit
    // the first caller's cancellation; the timeout is what bounds it.
    expect(options?.timeoutMs).toBe(15_000);
    expect(options?.signal).toBeUndefined();
  });

  test("a sweep with an unidentifiable record is incomplete and includes recognized devices", async () => {
    const lister = makeLister({
      readFile: async () =>
        JSON.stringify(
          devicectlPayload([connectedIphone(), { hardwareProperties: { platform: "iOS" } }]),
        ),
    });

    const discovery = await lister.listConnectedDevices();

    expect(discovery.devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
    expect(discovery.complete).toBe(false);
  });

  test("retains the last good listing across a failing sweep, then lets it go stale", async () => {
    const timer = new FakeTimer();
    let shouldFail = false;
    const lister = makeLister({
      timer,
      execute: async () => {
        if (shouldFail) {
          throw new Error("devicectl blipped");
        }
        return okExec;
      },
      readFile: async () => JSON.stringify(devicectlPayload([connectedIphone()])),
    });

    expect((await lister.listConnectedDevices()).devices).toHaveLength(1);

    shouldFail = true;
    timer.advanceTime(DEVICE_LIST_CACHE_TTL_MS);
    const blipped = await lister.listConnectedDevices();

    // The iPhone did not go anywhere, so it stays in the discovered list; the
    // sweep is still flagged non-authoritative.
    expect(blipped.devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
    expect(blipped.complete).toBe(false);
    // It is a replay, not an observation: liveness decisions must not read it
    // as proof the phone is still plugged in (#5683).
    if (!blipped.complete) {
      expect(blipped.error.code).toBe("failed");
    }

    timer.advanceTime(60_000);
    const stale = await lister.listConnectedDevices();

    // A permanently broken devicectl must eventually stop asserting hardware
    // that may well have been unplugged.
    expect(stale).toMatchObject({ devices: [], complete: false, error: { code: "failed" } });
  });

  test("retains a physical device through a failed sweep after a clock rollback", async () => {
    const timer = new FakeTimer();
    let shouldFail = false;
    const lister = makeLister({
      timer,
      execute: async () => {
        if (shouldFail) {
          throw new Error("devicectl blipped");
        }
        return okExec;
      },
      readFile: async () => JSON.stringify(devicectlPayload([connectedIphone()])),
    });

    timer.setCurrentTime(1_000);
    expect((await lister.listConnectedDevices()).devices.map((device) => device.deviceId)).toEqual([
      PHYSICAL_UDID,
    ]);

    // A clock rollback invalidates cache freshness, but not the last known
    // presence of hardware when the next devicectl sweep cannot complete.
    timer.setCurrentTime(999);
    shouldFail = true;
    const discovery = await lister.listConnectedDevices();

    expect(discovery.devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
    expect(discovery.complete).toBe(false);
    if (!discovery.complete) {
      expect(discovery.error.code).toBe("failed");
    }
  });

  test("bounds retained devices to one window after a large clock rollback", async () => {
    const timer = new FakeTimer();
    let shouldFail = false;
    const lister = makeLister({
      timer,
      execute: async () => {
        if (shouldFail) {
          throw new Error("devicectl blipped");
        }
        return okExec;
      },
      readFile: async () => JSON.stringify(devicectlPayload([connectedIphone()])),
    });

    timer.setCurrentTime(1_000_000);
    await lister.listConnectedDevices();

    timer.setCurrentTime(0);
    shouldFail = true;
    expect((await lister.listConnectedDevices()).devices.map((device) => device.deviceId)).toEqual([
      PHYSICAL_UDID,
    ]);

    timer.advanceTime(60_001);
    expect(await lister.listConnectedDevices()).toMatchObject({
      devices: [],
      complete: false,
      error: { code: "failed" },
    });
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

    expect(removed).toEqual([TEMP_DIR, TEMP_DIR]);
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
    expect((await lister.listConnectedDevices()).devices.map((device) => device.deviceId)).toEqual([
      PHYSICAL_UDID,
    ]);
    expect(executions).toBe(2);
  });

  test("preserves an observation stamp for cached and retained physical devices", async () => {
    const timer = new FakeTimer();
    let shouldFail = false;
    const lister = makeLister({
      timer,
      execute: async () => {
        if (shouldFail) {
          throw new Error("devicectl blipped");
        }
        return okExec;
      },
      readFile: async () => JSON.stringify(devicectlPayload([connectedIphone()])),
    });

    const initial = await lister.listConnectedDevices();
    expect(initial.devices[0]?.observedAt).toBe(1);

    timer.advanceTime(1_000);
    expect((await lister.listConnectedDevices()).devices[0]?.observedAt).toBe(1);

    shouldFail = true;
    timer.advanceTime(DEVICE_LIST_CACHE_TTL_MS);
    expect((await lister.listConnectedDevices()).devices[0]?.observedAt).toBe(1);
  });

  test("caches an unavailable host so every sweep does not respawn devicectl", async () => {
    let executions = 0;
    const lister = makeLister({
      execute: async () => {
        executions++;
        throw new Error("devicectl missing");
      },
    });

    expect(await lister.listConnectedDevices()).toMatchObject({
      devices: [],
      complete: false,
      error: { code: "failed" },
    });
    expect(await lister.listConnectedDevices()).toMatchObject({
      devices: [],
      complete: false,
      error: { code: "failed" },
    });
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

    expect((await lister.listConnectedDevices()).devices.map((device) => device.deviceId)).toEqual([
      PHYSICAL_UDID,
    ]);
  });
});

// Constructed shapes cover cases for which no hardware capture exists.
describe("constructed modern and legacy field combinations", () => {
  test("modern physical fields override each deprecated field", () => {
    const parsed = parseListing([
      {
        ...connectedIphone(),
        properties: {
          hardware: {
            udid: LEGACY_UDID,
            platform: "iPadOS",
            reality: "physical",
            productType: "iPad14,3",
            marketingName: "Modern iPad",
          },
          state: { name: "Modern", bootState: "booted" },
          connection: { state: "connected" },
          software: { osVersionNumber: { stringValue: "26.5" } },
        },
      },
    ]);
    expect(parsed.physical).toEqual([
      {
        name: "Modern",
        platform: "ios",
        deviceId: LEGACY_UDID,
        formFactor: "tablet",
        iosVersion: "26.5",
        osVersion: "26.5",
      },
    ]);
  });

  test("modern bare version and per-field legacy fallbacks share the reader", () => {
    const parsed = parseListing([
      {
        ...connectedIphone(),
        properties: { hardware: { reality: "physical" }, software: { osVersionNumber: "26.6" } },
      },
    ]);
    expect(parsed.physical[0]).toMatchObject({
      deviceId: PHYSICAL_UDID,
      name: "Jason's iPhone",
      iosVersion: "26.6",
      formFactor: "phone",
    });
  });

  test("reality must agree with a routable UDID", () => {
    const parsed = parseListing([
      { hardwareProperties: { reality: "physical", udid: SIMULATOR_UDID } },
      {
        hardwareProperties: { reality: "simulated", udid: PHYSICAL_UDID },
        deviceProperties: { bootState: "booted" },
        connectionProperties: { tunnelState: "connected" },
      },
      { hardwareProperties: { reality: "physical", udid: "unknown" } },
      { hardwareProperties: { reality: "future", udid: PHYSICAL_UDID } },
      { identifier: SIMULATOR_UDID, hardwareProperties: { reality: "physical" } },
    ]);
    expect(parsed.physical).toEqual([]);
    expect(parsed.simulators).toEqual([]);
    expect(parsed.unidentified).toHaveLength(5);
  });

  test("availability is lenient for physical records and strict for simulators", () => {
    const parsed = parseListing([
      connectedIphone(),
      connectedIphone({ deviceProperties: { bootState: "shutdown" } }),
      connectedIphone({ deviceProperties: { bootState: "unknown" } }),
      {
        hardwareProperties: { udid: SIMULATOR_UDID },
        deviceProperties: { bootState: "booted" },
        connectionProperties: {},
      },
      {
        hardwareProperties: { udid: SIMULATOR_UDID },
        deviceProperties: { bootState: "booted" },
        connectionProperties: { tunnelState: "connected" },
      },
    ]);
    expect(parsed.physical).toHaveLength(3);
    expect(parsed.simulators).toHaveLength(0);
    expect(parsed.notAvailable).toEqual([]);
    expect(parsed.unidentified).toHaveLength(2);
  });

  test("availability alone does not identify constructed records without UDIDs", () => {
    const parsed = parseListing([
      { connectionProperties: { tunnelState: "disconnected" } },
      { properties: { connection: { state: "unavailable" } } },
      { properties: { hardware: { reality: "simulated" }, state: { bootState: "shutdown" } } },
      {
        properties: {
          hardware: { reality: "simulated" },
          state: { bootState: "booted" },
          connection: { state: "disconnected" },
        },
      },
      { properties: { hardware: { reality: "physical" }, state: { bootState: "shutdown" } } },
    ]);
    expect(parsed.notAvailable).toEqual([]);
    expect(parsed.unidentified).toHaveLength(5);
    expect(parsed.unidentified.every((reason) => reason.includes("udid-shape=missing"))).toBe(true);
  });
});

describe("devicectl invocation failures (constructed errors)", () => {
  const errors = [
    {
      code: "timeout",
      error: new Error("Command failed", {
        cause: Object.assign(new Error("x"), { killed: true, signal: "SIGTERM", code: null }),
      }),
    },
    { code: "timeout", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) },
    {
      code: "unavailable",
      error: new Error("Command failed", {
        cause: Object.assign(new Error("missing xcrun"), { code: "ENOENT" }),
      }),
    },
    { code: "unavailable", error: new Error('xcrun: error: unable to find utility "devicectl"') },
    { code: "unavailable", error: new Error("xcode-select: error: no developer directory") },
    { code: "unavailable", error: new Error("active developer path /missing does not exist") },
    {
      code: "failed",
      error: new Error("Command failed", {
        cause: Object.assign(new Error("exit 1"), { code: 1 }),
      }),
    },
  ] as const;
  for (const { code, error } of errors) {
    test(`${error.message} reports ${code}`, async () => {
      expect(classifyDevicectlInvocationError(error)).toBe(code);
      const result = await makeLister({
        execute: async () => {
          throw error;
        },
      }).listConnectedDevices();
      expect(result.complete).toBe(false);
      if (!result.complete) {
        expect(result.error.code).toBe(code);
        expect(result.error.message).toContain("devicectl");
        if (code === "timeout") {
          expect(result.error.message).toContain("15000 ms");
        } else if (code === "unavailable") {
          expect(result.error.message).toContain("xcrun/devicectl not found");
        }
      }
    });
  }

  test.each(["string", "buffer"])(
    "real executor wrapper summarizes exit code and %s stderr without the temp path",
    async (stderrType) => {
      const stderr = `\n  \nCoreDevice service failed for ${JSON_PATH}\nsecond line`;
      const executor = new DefaultHostCommandExecutor(async () => {
        throw Object.assign(new Error(`Command failed: xcrun devicectl ${JSON_PATH}`), {
          code: 7,
          stderr: stderrType === "buffer" ? Buffer.from(stderr) : stderr,
          signal: null,
          killed: false,
        });
      });
      const result = await makeLister({
        execute: (file, args, options) => executor.executeCommand(file, args, options),
      }).listConnectedDevices();
      expect(result.complete).toBe(false);
      if (!result.complete) {
        expect(result.error.code).toBe("failed");
        expect(result.error.message).toContain("exit code 7");
        expect(result.error.message).toContain("CoreDevice service failed");
        expect(result.error.message).toContain("devicectl");
        expect(result.error.message).not.toContain(TEMP_DIR);
        expect(result.error.message).not.toContain(JSON_PATH);
        expect(result.error.message).not.toContain("second line");
      }
    },
  );

  test("temp-directory and output-read failures report failed", async () => {
    for (const overrides of [
      {
        mkdtemp: async () => {
          throw Object.assign(new Error("missing temp parent"), { code: "ENOENT" });
        },
      },
      {
        readFile: async () => {
          throw Object.assign(new Error("missing output file"), { code: "ENOENT" });
        },
      },
    ]) {
      expect(await makeLister(overrides).listConnectedDevices()).toMatchObject({
        complete: false,
        error: { code: "failed" },
      });
    }
  });

  test("non-success envelopes retain last-good devices, while a successful empty sweep clears them", async () => {
    const timer = new FakeTimer();
    let payload: unknown = devicectlPayload([connectedIphone()]);
    const lister = makeLister({ timer, readFile: async () => JSON.stringify(payload) });
    await lister.listConnectedDevices();
    payload = { info: { outcome: "failed" } };
    timer.advanceTime(3_000);
    const failed = await lister.listConnectedDevices();
    expect(failed.devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
    expect(failed).toMatchObject({ complete: false, error: { code: "failed" } });
    payload = [];
    timer.advanceTime(3_000);
    expect(await lister.listConnectedDevices()).toEqual({ devices: [], complete: true });
    payload = { info: { outcome: "success" } };
    timer.advanceTime(3_000);
    expect(await lister.listConnectedDevices()).toMatchObject({
      devices: [],
      complete: false,
      error: { code: "failed" },
    });
  });

  test("unidentified sets warn once per change and mark the listing incomplete", async () => {
    const timer = new FakeTimer();
    const warnings: string[] = [];
    const debug: string[] = [];
    // DERIVED from the captured listing: remove reality and visibility from one connected simulator.
    const listing = loadDerivedDevicectlListing();
    const record = listing.result.devices[0];
    const phone = derivePhysicalDevicectlRecord(record, PHYSICAL_UDID);
    listing.result.devices = [record, phone];
    delete record.properties.hardware.reality;
    delete record.visibilityClass;
    delete record.properties.state.visibilityClass;
    const lister = makeLister({
      timer,
      readFile: async () => JSON.stringify(listing),
      logger: {
        warn: (message) => {
          warnings.push(message);
        },
        debug: (message) => {
          debug.push(message);
        },
      },
    });
    expect(await lister.listConnectedDevices()).toMatchObject({
      devices: [{ deviceId: PHYSICAL_UDID }],
      complete: false,
    });
    const unidentifiedDebug = () =>
      warnings.filter((message) => message.includes("could not be identified"));
    expect(unidentifiedDebug()).toHaveLength(1);
    expect(unidentifiedDebug()[0]).toContain("platform=ios, reality=missing, udid-shape=simulator");
    expect(unidentifiedDebug()[0]).toContain("connection-state=connected");
    timer.advanceTime(3_000);
    await lister.listConnectedDevices();
    timer.advanceTime(3_000);
    await lister.listConnectedDevices();
    expect(unidentifiedDebug()).toHaveLength(1);
    // DERIVED unknown values may contain identifiers; diagnostics must only report fixed labels.
    record.properties.hardware.reality = record.identifier;
    record.properties.hardware.platform = record.identifier;
    timer.advanceTime(3_000);
    await lister.listConnectedDevices();
    expect(unidentifiedDebug()).toHaveLength(2);
    expect(unidentifiedDebug()[1]).toContain("platform=unknown, reality=unknown");
    for (const message of [...warnings, ...debug]) {
      expect(message).not.toContain(record.identifier);
      expect(message).not.toContain(String(record.properties.hardware.udid));
      expect(message).not.toContain("iPhone 17");
    }
    listing.result.devices = [];
    timer.advanceTime(3_000);
    await lister.listConnectedDevices();
    listing.result.devices = [record];
    timer.advanceTime(3_000);
    await lister.listConnectedDevices();
    expect(unidentifiedDebug()).toHaveLength(3);
  });

  test("a drifted record keeps the omitted phone from accruing misses by replaying last-good", async () => {
    const timer = new FakeTimer();
    let payload: unknown = devicectlPayload([connectedIphone()]);
    const lister = makeLister({ timer, readFile: async () => JSON.stringify(payload) });
    expect(await lister.listConnectedDevices()).toMatchObject({ complete: true });
    payload = devicectlPayload([{ hardwareProperties: { platform: "iOS" } }]);
    timer.advanceTime(3_000);
    const drifted = await lister.listConnectedDevices();
    expect(drifted.complete).toBe(false);
    expect(drifted).toMatchObject({
      error: { message: expect.stringContaining("could not identify") },
    });
    expect(drifted.devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
    payload = devicectlPayload([]);
    timer.advanceTime(3_000);
    expect(await lister.listConnectedDevices()).toEqual({ devices: [], complete: true });
  });

  test("failure transitions warn, repeats debug, and recovery resets suppression", async () => {
    const timer = new FakeTimer();
    const warnings: string[] = [];
    const debug: string[] = [];
    let fail = true;
    const lister = makeLister({
      timer,
      execute: async () => {
        if (fail) {
          throw new Error("failed\nsecond line");
        }
        return okExec;
      },
      readFile: async () => "[]",
      logger: {
        warn: (message) => {
          warnings.push(message);
        },
        debug: (message) => {
          debug.push(message);
        },
      },
    });
    for (let i = 0; i < 3; i++) {
      await lister.listConnectedDevices();
      timer.advanceTime(3_000);
    }
    expect(warnings).toHaveLength(1);
    expect(debug).toHaveLength(2);
    expect(warnings[0]).not.toContain("second line");
    fail = false;
    await lister.listConnectedDevices();
    timer.advanceTime(3_000);
    fail = true;
    await lister.listConnectedDevices();
    await lister.listConnectedDevices();
    expect(warnings).toHaveLength(2);
  });
});

// Constructed minimal objects only; real CoreDeviceError 1000 and 1001 captures are still owed.
describe("constructed failure envelopes at the lister boundary", () => {
  for (const throws of [false, true]) {
    for (const [code, kind, label] of [
      [1000, "device-not-found", "device not found"],
      [1001, "capability-unsupported", "capability unsupported"],
      [1002, "other", "other"],
    ] as const) {
      test(`constructed ${code} envelope on ${throws ? "non-zero" : "zero"} exit retains a typed outcome`, async () => {
        const removed: string[] = [];
        let reads = 0;
        const lister = makeLister({
          execute: async () => {
            if (throws) {
              throw Object.assign(new Error("could not run"), { code: 1 });
            }
            return okExec;
          },
          readFile: async () => {
            reads++;
            return JSON.stringify({
              info: { outcome: "failed" },
              error: { domain: "constructed.CoreDevice", code },
            });
          },
          rm: async (path) => {
            removed.push(path);
          },
        });
        const discovery = await lister.listConnectedDevices();
        expect(discovery).toMatchObject({
          complete: false,
          error: {
            code: "failed",
            coreDeviceError: { code, kind, domain: "constructed.CoreDevice" },
          },
        });
        if (!discovery.complete) {
          expect(discovery.error.message).toContain(`CoreDeviceError ${code} (${label})`);
          expect(discovery.error.message).not.toContain("could not run");
        }
        expect(reads).toBe(1);
        expect(removed).toEqual([TEMP_DIR]);
      });
    }
  }

  test("constructed plain invocation failure has no CoreDevice error; optional read failures debug and scrub paths", async () => {
    for (const raw of [
      undefined,
      "{invalid",
      "[]",
      JSON.stringify({ info: { outcome: "failed" }, error: { code: "1000" } }),
    ]) {
      const debug: string[] = [];
      const removed: string[] = [];
      const lister = makeLister({
        execute: async () => {
          throw Object.assign(new Error("could not run"), {
            code: 1,
            stderr: `${TEMP_DIR}: could not run`,
          });
        },
        readFile: async () => {
          if (raw === undefined) {
            throw new Error("no file");
          }
          return raw;
        },
        logger: {
          warn: () => {},
          debug: (message) => {
            debug.push(message);
          },
        },
        rm: async (path) => {
          removed.push(path);
        },
      });
      const discovery = await lister.listConnectedDevices();
      if (discovery.complete) {
        throw new Error("expected failure");
      }
      expect(discovery.error.coreDeviceError).toBeUndefined();
      expect(discovery.error.message).toContain("exit code 1");
      expect(discovery.error.message).toContain("could not run");
      expect(discovery.error.message).not.toContain(TEMP_DIR);
      if (raw === undefined || raw === "{invalid") {
        expect(debug).toHaveLength(1);
      }
      expect(removed).toEqual([TEMP_DIR]);
    }
  });

  test("constructed timeout and unavailable failures do not read optional JSON", async () => {
    for (const code of ["ETIMEDOUT", "ENOENT"]) {
      let reads = 0;
      const lister = makeLister({
        execute: async () => {
          throw Object.assign(new Error("could not run"), { code });
        },
        readFile: async () => {
          reads++;
          return "[]";
        },
      });
      const discovery = await lister.listConnectedDevices();
      expect(discovery.complete).toBe(false);
      expect(reads).toBe(0);
    }
  });

  test("constructed failure dedupe warns on CoreDevice kind changes and resets after recovery", async () => {
    const timer = new FakeTimer();
    const warnings: string[] = [];
    const debug: string[] = [];
    let raw = JSON.stringify({
      info: { outcome: "failed" },
      error: { domain: "CoreDevice", code: 1000 },
    });
    const lister = makeLister({
      timer,
      readFile: async () => raw,
      logger: {
        warn: (message) => {
          warnings.push(message);
        },
        debug: (message) => {
          debug.push(message);
        },
      },
    });
    await lister.listConnectedDevices();
    timer.advanceTime(3_000);
    await lister.listConnectedDevices();
    expect(warnings).toHaveLength(1);
    expect(debug).toHaveLength(1);
    raw = JSON.stringify({
      info: { outcome: "failed" },
      error: { domain: "CoreDevice", code: 1001 },
    });
    timer.advanceTime(3_000);
    await lister.listConnectedDevices();
    expect(warnings).toHaveLength(2);
    raw = "[]";
    timer.advanceTime(3_000);
    await lister.listConnectedDevices();
    raw = JSON.stringify({
      info: { outcome: "failed" },
      error: { domain: "CoreDevice", code: 1001 },
    });
    timer.advanceTime(3_000);
    await lister.listConnectedDevices();
    expect(warnings).toHaveLength(3);
  });
});
