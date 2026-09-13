import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { BootedDevice, DeviceInfo, ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { FakeRunningAvdAdvertisementReader } from "../../fakes/FakeRunningAvdAdvertisementReader";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { logger } from "../../../src/utils/logger";

const AVD = "am-api36-ga-arm64";

const execResult = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

/**
 * ADB seam whose device scan is scripted per call, including a scan that
 * THROWS — the "adb discovery failed" case #6407 requires be distinguishable
 * from "no emulator runs this AVD".
 */
class ScriptedAdbExecutor extends FakeAdbExecutor {
  constructor(private readonly owner: ScriptedAdbClientFactory) {
    super();
  }

  async getBootedAndroidDevices(): Promise<BootedDevice[]> {
    return this.owner.currentDevices();
  }

  async getDeviceStates(): Promise<Array<{ deviceId: string; state: string }>> {
    if (this.owner.deviceStatesError) {
      throw this.owner.deviceStatesError;
    }
    return this.owner
      .currentDevices()
      .map((device) => ({ deviceId: device.deviceId, state: "device" }));
  }

  async executeCommand(command: string): Promise<ExecResult> {
    // No emulator answers `avd name` here: every listed emulator resolves to the
    // `Unknown (<serial>)` placeholder, which is the mid-boot window itself.
    return execResult(command === "get-state" ? "device\n" : "");
  }
}

class ScriptedAdbClientFactory implements AdbClientFactory {
  devices: BootedDevice[] = [];
  scanError: Error | undefined;
  deviceStatesError: Error | undefined;

  create(): AdbExecutor {
    return new ScriptedAdbExecutor(this);
  }

  currentDevices(): BootedDevice[] {
    if (this.scanError) {
      throw this.scanError;
    }
    return this.devices;
  }
}

function unknownEmulator(deviceId: string): BootedDevice {
  return { name: `Unknown (${deviceId})`, platform: "android", deviceId, source: "local" };
}

function createChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.stdout = new Readable({ read() {} }) as never;
  child.stderr = new Readable({ read() {} }) as never;
  child.killed = false;
  child.kill = (() => {
    child.killed = true;
    return true;
  }) as ChildProcess["kill"];
  return child;
}

interface Harness {
  client: AndroidEmulatorClient;
  adbFactory: ScriptedAdbClientFactory;
  advertisements: FakeRunningAvdAdvertisementReader;
  spawnedArgs: string[][];
  children: Array<ChildProcess & EventEmitter>;
  /** Resolves once the emulator binary has been spawned `count` times. */
  spawnedAtLeast(count: number): Promise<void>;
}

function createHarness(): Harness {
  const adbFactory = new ScriptedAdbClientFactory();
  const advertisements = new FakeRunningAvdAdvertisementReader();
  const spawnedArgs: string[][] = [];
  const children: Array<ChildProcess & EventEmitter> = [];
  const spawnWaiters: Array<{ count: number; resolve: () => void }> = [];

  const spawnFn = ((_command: string, args: string[]) => {
    spawnedArgs.push(args);
    const child = createChild();
    children.push(child);
    for (const waiter of spawnWaiters.splice(0)) {
      if (spawnedArgs.length >= waiter.count) {
        waiter.resolve();
      } else {
        spawnWaiters.push(waiter);
      }
    }
    return child;
  }) as never;

  const client = new AndroidEmulatorClient(
    async () => execResult(),
    spawnFn,
    new FakeTimer(),
    adbFactory,
    new FakeAvdConfigReader(),
    undefined,
    undefined,
    { isAvailable: async () => true },
    advertisements,
  );
  (client as unknown as { ensureEmulatorPath: () => Promise<string> }).ensureEmulatorPath =
    async () => "emulator";
  (client as unknown as { listAvds: () => Promise<DeviceInfo[]> }).listAvds = async () => [
    { name: AVD, platform: "android", isRunning: false } as DeviceInfo,
  ];
  (
    client as unknown as { checkArchitectureCompatibility: () => Promise<{ compatible: boolean }> }
  ).checkArchitectureCompatibility = async () => ({ compatible: true });

  return {
    client,
    adbFactory,
    advertisements,
    spawnedArgs,
    children,
    spawnedAtLeast: (count: number) =>
      spawnedArgs.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => spawnWaiters.push({ count, resolve })),
  };
}

/**
 * A guard REGRESSION makes `startEmulator` spawn a second emulator whose launch
 * never completes, so an unguarded `await` would hang the suite instead of
 * failing it. Bound every "this call must take the adopt path" await.
 */
async function adoptPathWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = defaultTimer.setTimeout(() => reject(new Error(label)), 500);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      defaultTimer.clearTimeout(timeoutHandle);
    }
  }
}

/** Settle a launch that is deliberately left mid-flight by the test. */
function completeStartupValidation(child: ChildProcess & EventEmitter): void {
  child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n"));
}

afterEach(() => {
  AndroidEmulatorClient.resetLaunchReservationsForTesting();
});

describe("AndroidEmulatorClient duplicate-launch guard (#6407)", () => {
  test("a second startEmulator for an AVD whose launch is in flight does not spawn", async () => {
    const harness = createHarness();

    const firstLaunch = harness.client.startEmulator(AVD);
    await harness.spawnedAtLeast(1);

    // The first launch has spawned but not finished startup validation, so the
    // emulator is not yet in the device scan under any name.
    const second = await adoptPathWithin(
      harness.client.startEmulator(AVD),
      "the second startEmulator did not take the adopt path",
    );

    expect(second).toBeNull();
    expect(harness.spawnedArgs).toHaveLength(1);

    completeStartupValidation(harness.children[0]);
    await firstLaunch;
  });

  test("does not spawn when a listed Unknown serial matches this process's reservation for the AVD", async () => {
    const harness = createHarness();

    const firstLaunch = harness.client.startEmulator(AVD);
    await harness.spawnedAtLeast(1);
    completeStartupValidation(harness.children[0]);
    await firstLaunch;

    // Mid-boot reality: adb lists the emulator, but `emu avd name` has not
    // answered, so the scan can only label it `Unknown (emulator-5554)`.
    harness.adbFactory.devices = [unknownEmulator("emulator-5554")];

    const second = await adoptPathWithin(
      harness.client.startEmulator(AVD),
      "the second startEmulator did not take the adopt path",
    );

    expect(second).toBeNull();
    expect(harness.spawnedArgs).toHaveLength(1);
  });

  test("does not spawn while a reserved launch is live but ADB has not listed it yet", async () => {
    const harness = createHarness();

    const firstLaunch = harness.client.startEmulator(AVD);
    await harness.spawnedAtLeast(1);
    // Startup validation resolves off the first emulator output marker, which
    // arrives seconds before adb names (or even lists) the runtime. The
    // name-level in-flight claim is released here, so the live console-port
    // reservation is the only evidence left that this AVD is coming up.
    completeStartupValidation(harness.children[0]);
    await firstLaunch;

    // The scan is still EMPTY: the emulator has not reached adb at all.
    expect(harness.adbFactory.devices).toHaveLength(0);

    const second = await adoptPathWithin(
      harness.client.startEmulator(AVD),
      "the second startEmulator did not take the adopt path",
    );

    expect(second).toBeNull();
    expect(harness.spawnedArgs).toHaveLength(1);
  });

  test("does not spawn while a live launch that reserved no port has not reached ADB", async () => {
    const harness = createHarness();
    // The raw `getDeviceStates` probe fails after the device scan succeeded, so
    // the pre-launch snapshot is incomplete and the launch reserves no console
    // port at all. Child liveness is then the only evidence of this AVD.
    harness.adbFactory.deviceStatesError = new Error("adb: protocol fault");

    const firstLaunch = harness.client.startEmulator(AVD);
    await harness.spawnedAtLeast(1);
    completeStartupValidation(harness.children[0]);
    await firstLaunch;

    expect(harness.spawnedArgs[0]).not.toContain("-port");
    expect(harness.adbFactory.devices).toHaveLength(0);

    const second = await adoptPathWithin(
      harness.client.startEmulator(AVD),
      "the second startEmulator did not take the adopt path",
    );

    expect(second).toBeNull();
    expect(harness.spawnedArgs).toHaveLength(1);
  });

  test("an unreserved launch whose child has exited stops blocking later launches", async () => {
    const harness = createHarness();
    harness.adbFactory.deviceStatesError = new Error("adb: protocol fault");

    const firstLaunch = harness.client.startEmulator(AVD);
    await harness.spawnedAtLeast(1);
    completeStartupValidation(harness.children[0]);
    await firstLaunch;
    harness.children[0].emit("exit", 0, null);

    const second = harness.client.startEmulator(AVD);
    await harness.spawnedAtLeast(2);
    completeStartupValidation(harness.children[1]);

    expect(await second).toBe(harness.children[1]);
    expect(harness.spawnedArgs).toHaveLength(2);
  });

  test("a reservation whose child has exited stops blocking later launches", async () => {
    const harness = createHarness();

    const firstLaunch = harness.client.startEmulator(AVD);
    await harness.spawnedAtLeast(1);
    completeStartupValidation(harness.children[0]);
    await firstLaunch;
    harness.children[0].emit("exit", 0, null);

    const second = harness.client.startEmulator(AVD);
    await harness.spawnedAtLeast(2);
    completeStartupValidation(harness.children[1]);

    expect(await second).toBe(harness.children[1]);
    expect(harness.spawnedArgs).toHaveLength(2);
  });

  test("an Unknown serial this process did NOT reserve is not mistaken for the target AVD", async () => {
    const harness = createHarness();
    harness.adbFactory.devices = [unknownEmulator("emulator-5560")];

    const launch = harness.client.startEmulator(AVD);
    await harness.spawnedAtLeast(1);
    completeStartupValidation(harness.children[0]);

    expect(await launch).toBe(harness.children[0]);
  });

  test("surfaces an adb discovery failure instead of spawning a duplicate", async () => {
    const harness = createHarness();
    harness.adbFactory.scanError = new Error("adb: device offline");

    await expect(
      adoptPathWithin(
        harness.client.startEmulator(AVD),
        "the discovery failure was swallowed and the launch proceeded",
      ),
    ).rejects.toThrow("adb: device offline");
    expect(harness.spawnedArgs).toHaveLength(0);
  });

  test("an advertisement hit short-circuits the launch", async () => {
    const harness = createHarness();
    harness.advertisements.advertised.add(AVD);

    expect(
      await adoptPathWithin(
        harness.client.startEmulator(AVD),
        "an advertised AVD still reached the spawn",
      ),
    ).toBeNull();
    expect(harness.spawnedArgs).toHaveLength(0);
  });

  test("an advertisement miss falls through to the launch", async () => {
    const harness = createHarness();

    const launch = harness.client.startEmulator(AVD);
    await harness.spawnedAtLeast(1);
    completeStartupValidation(harness.children[0]);

    await launch;
    expect(harness.advertisements.queriedAvdNames).toContain(AVD);
    expect(harness.spawnedArgs).toHaveLength(1);
  });

  test("an unexpected advertisement read failure is warned, not swallowed at debug", async () => {
    const harness = createHarness();
    harness.advertisements.failWith = new Error("EACCES: permission denied");
    const warnSpy = spyOn(logger, "warn");

    try {
      const launch = harness.client.startEmulator(AVD);
      await harness.spawnedAtLeast(1);
      completeStartupValidation(harness.children[0]);
      await launch;

      expect(
        warnSpy.mock.calls.some(
          (call) =>
            String(call[0]).includes("EACCES: permission denied") && String(call[0]).includes(AVD),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
