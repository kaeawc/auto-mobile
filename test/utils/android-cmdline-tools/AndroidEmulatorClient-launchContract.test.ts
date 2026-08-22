import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  AndroidEmulatorClient,
  parseExtraEmulatorArguments,
} from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { DeviceInfo, ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

const execResult = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: value => stdout.includes(value),
});

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

function createClient(
  spawnFn: (command: string, args: string[]) => ChildProcess,
  adb: FakeAdbExecutor = new FakeAdbExecutor(),
): AndroidEmulatorClient {
  const adbFactory: AdbClientFactory = {
    create: (): AdbExecutor => adb,
  };
  const client = new AndroidEmulatorClient(
    async () => execResult(),
    spawnFn as never,
    new FakeTimer(),
    adbFactory,
  );
  (client as unknown as { ensureEmulatorPath: () => Promise<string> }).ensureEmulatorPath = async () => "emulator";
  (client as unknown as { listAvds: () => Promise<DeviceInfo[]> }).listAvds = async () => [
    { name: "Pixel 9", platform: "android", isRunning: false },
  ];
  (client as unknown as { isAvdRunning: () => Promise<boolean> }).isAvdRunning = async () => false;
  (client as unknown as { isAvdStarting: () => Promise<boolean> }).isAvdStarting = async () => false;
  (client as unknown as { checkArchitectureCompatibility: () => Promise<{ compatible: boolean }> }).checkArchitectureCompatibility = async () => ({ compatible: true });
  return client;
}

afterEach(() => {
  AndroidEmulatorClient.resetLaunchReservationsForTesting();
});

describe("AndroidEmulatorClient launch contract", () => {
  test("uses a JSON argv array so values containing spaces remain one argument", () => {
    expect(parseExtraEmulatorArguments('["-gpu", "swiftshader indirect"]')).toEqual([
      "-gpu",
      "swiftshader indirect",
    ]);
  });

  test("rejects the legacy whitespace-delimited extra-argument value", () => {
    expect(() => parseExtraEmulatorArguments("-gpu swiftshader_indirect")).toThrow(
      "AUTOMOBILE_EMULATOR_ARGS must be a JSON array",
    );
  });

  test("returns a typed launch handle correlated to the requested adb serial", async () => {
    const child = createChild();
    const client = createClient(() => {
      queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
      return child;
    });

    const handle = await client.launchEmulator({ avdName: "Pixel 9", deviceId: "emulator-5560" });

    expect(handle.avdName).toBe("Pixel 9");
    expect(handle.targetDeviceId).toBe("emulator-5560");
    expect(handle.process).toBe(child);
  });

  test("honors caller-supplied emulator console ports without adding another port flag", async () => {
    for (const [extraArgs, targetDeviceId] of [
      [["-port", "5560"], "emulator-5560"],
      [["-ports", "5562,5563"], "emulator-5562"],
    ] as const) {
      const child = createChild();
      let spawnedArgs: string[] = [];
      const client = createClient((_command, args) => {
        spawnedArgs = args;
        queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
        return child;
      });

      const handle = await client.launchEmulator({ avdName: "Pixel 9", extraArgs });

      expect(handle.targetDeviceId).toBe(targetDeviceId);
      expect(spawnedArgs.filter(argument => argument === "-port" || argument === "-ports")).toEqual([
        extraArgs[0],
      ]);
      child.emit("exit", 0, null);
      AndroidEmulatorClient.resetLaunchReservationsForTesting();
    }
  });

  test("globally reserves an explicit emulator serial against a concurrent unlabelled launch", async () => {
    const adb = new FakeAdbExecutor();
    const firstChild = createChild();
    const secondChild = createChild();
    let firstSpawnedArgs: string[] = [];
    let secondSpawnedArgs: string[] = [];
    const firstClient = createClient((_command, args) => {
      firstSpawnedArgs = args;
      queueMicrotask(() => firstChild.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
      return firstChild;
    }, adb);
    const secondClient = createClient((_command, args) => {
      secondSpawnedArgs = args;
      queueMicrotask(() => secondChild.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
      return secondChild;
    }, adb);

    const firstLaunch = await firstClient.launchEmulator({
      avdName: "Pixel 9",
      deviceId: "emulator-5554",
    });
    const secondLaunch = await secondClient.startEmulator("Pixel 9");

    expect(firstLaunch.targetDeviceId).toBe("emulator-5554");
    expect(firstSpawnedArgs).toEqual(expect.arrayContaining(["-port", "5554"]));
    expect(secondSpawnedArgs).toEqual(expect.arrayContaining(["-port", "5556"]));
    firstChild.emit("exit", 0, null);
    secondLaunch!.emit("exit", 0, null);
    AndroidEmulatorClient.resetLaunchReservationsForTesting();
  });

  test("reuses an explicit emulator serial after an all-state snapshot confirms it is absent", async () => {
    const adb = new FakeAdbExecutor();
    const firstChild = createChild();
    const secondChild = createChild();
    const children = [firstChild, secondChild];
    const spawnedArgs: string[][] = [];
    const client = createClient((_command, args) => {
      spawnedArgs.push(args);
      const child = children.shift()!;
      queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
      return child;
    }, adb);

    const firstLaunch = await client.launchEmulator({
      avdName: "Pixel 9",
      deviceId: "emulator-5554",
    });
    firstChild.emit("exit", 0, null);
    await client.launchEmulator({
      avdName: "Pixel 9",
      deviceId: "emulator-5554",
    });

    expect(firstLaunch.targetDeviceId).toBe("emulator-5554");
    expect(spawnedArgs).toEqual([
      expect.arrayContaining(["-port", "5554"]),
      expect.arrayContaining(["-port", "5554"]),
    ]);
    secondChild.emit("exit", 0, null);
  });

  test("does not spawn when launch has already been cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawns = 0;
    const client = createClient(() => {
      spawns += 1;
      return createChild();
    });

    await expect(client.launchEmulator({ avdName: "Pixel 9", signal: controller.signal })).rejects.toThrow("cancelled");
    expect(spawns).toBe(0);
  });

  test("does not spawn when cancellation happens during startup validation", async () => {
    const controller = new AbortController();
    let releaseAvdLookup: (devices: DeviceInfo[]) => void = () => {};
    const availableAvds = new Promise<DeviceInfo[]>(resolve => {
      releaseAvdLookup = resolve;
    });
    let validating = false;
    let spawns = 0;
    const client = createClient(() => {
      spawns += 1;
      return createChild();
    });
    (client as unknown as { listAvds: () => Promise<DeviceInfo[]> }).listAvds = async () => {
      validating = true;
      return availableAvds;
    };

    const launch = client.launchEmulator({ avdName: "Pixel 9", signal: controller.signal });
    while (!validating) {
      await Promise.resolve();
    }
    controller.abort();
    releaseAvdLookup([{ name: "Pixel 9", platform: "android", isRunning: false }]);

    await expect(launch).rejects.toThrow("cancelled");
    expect(spawns).toBe(0);
  });

  test("cancels and cleans up when aborted while startup validation is pending", async () => {
    const controller = new AbortController();
    const child = createChild();
    let spawned = false;
    const client = createClient(() => {
      spawned = true;
      return child;
    });

    const launch = client.launchEmulator({ avdName: "Pixel 9", signal: controller.signal });
    while (!spawned) {
      await Promise.resolve();
    }
    controller.abort();
    expect(child.killed).toBe(true);
    child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n"));

    await expect(launch).rejects.toThrow("cancelled");
  });

  test("reports cancellation when aborting causes the child to exit during startup validation", async () => {
    const controller = new AbortController();
    const child = createChild();
    child.kill = (() => {
      child.killed = true;
      child.emit("exit", null);
      child.emit("close", null);
      return true;
    }) as ChildProcess["kill"];
    let spawned = false;
    const client = createClient(() => {
      spawned = true;
      return child;
    });

    const launch = client.launchEmulator({ avdName: "Pixel 9", signal: controller.signal });
    while (!spawned) {
      await Promise.resolve();
    }
    controller.abort();

    await expect(launch).rejects.toThrow("cancelled");
  });

  test("disposal kills a process launched by this handle", async () => {
    const child = createChild();
    const client = createClient(() => {
      queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
      return child;
    });

    const handle = await client.launchEmulator({ avdName: "Pixel 9" });
    handle.dispose();

    expect(child.killed).toBe(true);
  });

  test("cancellation after launch disposes the owned process", async () => {
    const controller = new AbortController();
    const child = createChild();
    const client = createClient(() => {
      queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
      return child;
    });

    await client.launchEmulator({ avdName: "Pixel 9", signal: controller.signal });
    controller.abort();

    expect(child.killed).toBe(true);
  });
});
