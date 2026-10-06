import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  AndroidEmulatorClient,
  parseExtraEmulatorArguments,
} from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { DeviceInfo, ExecResult } from "../../../src/models";
import { EmulatorLaunchCancelledError } from "../../../src/models/EmulatorLaunchCancelledError";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { PortAvailabilityChecker } from "../../../src/utils/PortManager";

const execResult = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value) => stdout.includes(value),
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
  hostPortAvailabilityChecker: PortAvailabilityChecker = {
    isPortAvailable: () => true,
  },
  avdName: string = "Pixel 9",
  timer: FakeTimer = new FakeTimer(),
): AndroidEmulatorClient {
  const adbFactory: AdbClientFactory = {
    create: (): AdbExecutor => adb,
  };
  const client = new AndroidEmulatorClient(
    async () => execResult(),
    spawnFn as never,
    timer,
    adbFactory,
    undefined,
    undefined,
    undefined,
    hostPortAvailabilityChecker,
  );
  (client as unknown as { ensureEmulatorPath: () => Promise<string> }).ensureEmulatorPath =
    async () => "emulator";
  (client as unknown as { listAvds: () => Promise<DeviceInfo[]> }).listAvds = async () => [
    { name: avdName, platform: "android", isRunning: false },
  ];
  (client as unknown as { isAvdRunning: () => Promise<boolean> }).isAvdRunning = async () => false;
  (client as unknown as { isAvdStarting: () => Promise<boolean> }).isAvdStarting = async () =>
    false;
  (
    client as unknown as { checkArchitectureCompatibility: () => Promise<{ compatible: boolean }> }
  ).checkArchitectureCompatibility = async () => ({ compatible: true });
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
      expect(
        spawnedArgs.filter((argument) => argument === "-port" || argument === "-ports"),
      ).toEqual([extraArgs[0]]);
      child.emit("exit", 0, null);
      AndroidEmulatorClient.resetLaunchReservationsForTesting();
    }
  });

  test("rejects caller-supplied console ports outside the supported range", async () => {
    let spawns = 0;
    const client = createClient(() => {
      spawns += 1;
      return createChild();
    });

    await expect(
      client.launchEmulator({ avdName: "Pixel 9", extraArgs: ["-port", "5684"] }),
    ).rejects.toThrow("5554 through 5682");
    expect(spawns).toBe(0);
  });

  test("reserves the ADB endpoint supplied by -ports for concurrent launches", async () => {
    const adb = new FakeAdbExecutor();
    const firstChild = createChild();
    const secondChild = createChild();
    let firstSpawnedArgs: string[] = [];
    let secondSpawnedArgs: string[] = [];
    const firstClient = createClient((_command, args) => {
      firstSpawnedArgs = args;
      queueMicrotask(() =>
        firstChild.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")),
      );
      return firstChild;
    }, adb);
    // A DIFFERENT AVD: a second launch of an AVD this process is already
    // launching is adopted, never spawned (#6407). What is under test here is
    // the port reservation, so the two launches must be for distinct AVDs.
    const secondClient = createClient(
      (_command, args) => {
        secondSpawnedArgs = args;
        queueMicrotask(() =>
          secondChild.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")),
        );
        return secondChild;
      },
      adb,
      undefined,
      "Pixel 9a",
    );

    const firstLaunch = await firstClient.launchEmulator({
      avdName: "Pixel 9",
      extraArgs: ["-ports", "5562,5555"],
    });
    const secondLaunch = await secondClient.startEmulator("Pixel 9a");

    expect(firstLaunch.targetDeviceId).toBe("emulator-5562");
    expect(firstSpawnedArgs).toEqual(expect.arrayContaining(["-ports", "5562,5555"]));
    expect(secondSpawnedArgs).toEqual(expect.arrayContaining(["-port", "5556"]));
    firstChild.emit("exit", 0, null);
    secondLaunch!.emit("exit", 0, null);
  });

  test("skips an automatic port pair whose ADB endpoint is occupied outside ADB", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([{ name: "Unknown", platform: "android", deviceId: "emulator-5562" }]);
    const child = createChild();
    const checkedPorts: number[] = [];
    let spawnedArgs: string[] = [];
    const client = createClient(
      (_command, args) => {
        spawnedArgs = args;
        queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
        return child;
      },
      adb,
      {
        isPortAvailable: (port) => {
          checkedPorts.push(port);
          return port !== 5555;
        },
      },
    );

    await client.startEmulator("Pixel 9");

    expect(checkedPorts).toEqual(expect.arrayContaining([5554, 5555, 5556, 5557]));
    expect(spawnedArgs).toEqual(expect.arrayContaining(["-port", "5556"]));
    child.emit("exit", 0, null);
  });

  test("rechecks reservations after concurrent host-port probes", async () => {
    const adb = new FakeAdbExecutor();
    const firstChild = createChild();
    const secondChild = createChild();
    const children = [firstChild, secondChild];
    const spawnedArgs: string[][] = [];
    const hostPortAvailabilityChecker: PortAvailabilityChecker = {
      isPortAvailable: () => true,
    };
    const createSharedClient = (avdName: string) =>
      createClient(
        (_command, args) => {
          spawnedArgs.push(args);
          const child = children.shift()!;
          queueMicrotask(() =>
            child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")),
          );
          return child;
        },
        adb,
        hostPortAvailabilityChecker,
        avdName,
      );

    // Distinct AVDs: two CONCURRENT launches of the SAME AVD are the duplicate
    // this process now refuses outright (#6407), and the port-reservation race
    // under test is about the ports, not the AVD label.
    const launches = await Promise.all([
      createSharedClient("Pixel 9").startEmulator("Pixel 9"),
      createSharedClient("Pixel 9a").startEmulator("Pixel 9a"),
    ]);

    expect(launches).toHaveLength(2);
    expect(spawnedArgs).toEqual([
      expect.arrayContaining(["-port", "5554"]),
      expect.arrayContaining(["-port", "5556"]),
    ]);
    firstChild.emit("exit", 0, null);
    secondChild.emit("exit", 0, null);
  });

  test("tolerates odd and malformed emulator serials observed through ADB", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([
      { name: "Odd", platform: "android", deviceId: "emulator-5555" },
      { name: "Malformed", platform: "android", deviceId: "emulator-not-a-port" },
    ]);
    const child = createChild();
    let spawnedArgs: string[] = [];
    const client = createClient((_command, args) => {
      spawnedArgs = args;
      queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
      return child;
    }, adb);

    await client.startEmulator("Pixel 9");

    expect(spawnedArgs).toEqual(expect.arrayContaining(["-port", "5558"]));
    child.emit("exit", 0, null);
  });

  test("globally reserves an explicit emulator serial against a concurrent unlabelled launch", async () => {
    const adb = new FakeAdbExecutor();
    const firstChild = createChild();
    const secondChild = createChild();
    let firstSpawnedArgs: string[] = [];
    let secondSpawnedArgs: string[] = [];
    const firstClient = createClient((_command, args) => {
      firstSpawnedArgs = args;
      queueMicrotask(() =>
        firstChild.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")),
      );
      return firstChild;
    }, adb);
    // A DIFFERENT AVD, for the same reason as above: the serial reservation is
    // what must hold across clients, not the AVD label (#6407).
    const secondClient = createClient(
      (_command, args) => {
        secondSpawnedArgs = args;
        queueMicrotask(() =>
          secondChild.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")),
        );
        return secondChild;
      },
      adb,
      undefined,
      "Pixel 9a",
    );

    const firstLaunch = await firstClient.launchEmulator({
      avdName: "Pixel 9",
      deviceId: "emulator-5554",
    });
    const secondLaunch = await secondClient.startEmulator("Pixel 9a");

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

  test("does not clear a terminal reservation created during an older snapshot", async () => {
    const adb = new FakeAdbExecutor();
    const firstChild = createChild();
    const secondChild = createChild();
    const spawnedArgs: string[][] = [];
    const children = [firstChild, secondChild];
    let releaseSecondStateScan: (states: []) => void = () => {};
    const secondStateScan = new Promise<[]>((resolve) => {
      releaseSecondStateScan = resolve;
    });
    let stateScans = 0;
    let secondStateScanStarted = false;
    adb.getDeviceStates = async () => {
      stateScans += 1;
      if (stateScans === 2) {
        secondStateScanStarted = true;
        return secondStateScan;
      }
      return [];
    };
    const createSharedClient = (avdName: string) =>
      createClient(
        (_command, args) => {
          spawnedArgs.push(args);
          const child = children.shift()!;
          queueMicrotask(() =>
            child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")),
          );
          return child;
        },
        adb,
        undefined,
        avdName,
      );
    // Distinct AVDs: the terminal reservation under test is about the PORT, and
    // a second launch of an AVD this process is already running is adopted
    // rather than spawned (#6407).
    const firstClient = createSharedClient("Pixel 9");
    const secondClient = createSharedClient("Pixel 9a");

    await firstClient.startEmulator("Pixel 9");
    const secondLaunch = secondClient.startEmulator("Pixel 9a");
    while (!secondStateScanStarted) {
      await Promise.resolve();
    }
    firstChild.emit("exit", 0, null);
    releaseSecondStateScan([]);
    await secondLaunch;

    expect(spawnedArgs).toEqual([
      expect.arrayContaining(["-port", "5554"]),
      expect.arrayContaining(["-port", "5556"]),
    ]);
    secondChild.emit("exit", 0, null);
  });

  test("expires a failed launch reservation after the TTL with an incomplete snapshot", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const failedChild = createChild();
    const nextChild = createChild();
    let spawns = 0;
    const client = createClient(
      () => {
        spawns += 1;
        const child = spawns === 1 ? failedChild : nextChild;
        queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
        return child;
      },
      adb,
      undefined,
      "Pixel 9",
      timer,
    );

    const failedLaunch = client.launchEmulator({ avdName: "Pixel 9", deviceId: "emulator-5554" });
    while (spawns === 0) {
      await Promise.resolve();
    }
    failedChild.emit("error", new Error("spawn failed"));
    await expect(failedLaunch).rejects.toThrow("Emulator failed to start: spawn failed");
    failedChild.emit("close", -2, null);

    adb.getDeviceStates = async () => {
      throw new Error("raw device-state scan failed");
    };
    await expect(
      client.launchEmulator({ avdName: "Pixel 9", deviceId: "emulator-5554" }),
    ).rejects.toThrow("console port 5554 is already in use");
    timer.advanceTime(30_001);
    const retry = await client.launchEmulator({ avdName: "Pixel 9", deviceId: "emulator-5554" });

    expect(retry.targetDeviceId).toBe("emulator-5554");
    expect(spawns).toBe(2);
    nextChild.emit("exit", 0, null);
  });

  test("keeps a successful launch reservation bound to its live device", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const child = createChild();
    let secondSpawns = 0;
    const firstClient = createClient(
      () => {
        queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
        return child;
      },
      adb,
      undefined,
      "Pixel 9",
      timer,
    );
    const secondClient = createClient(
      () => {
        secondSpawns += 1;
        return createChild();
      },
      adb,
      undefined,
      "Pixel 9a",
      timer,
    );

    await firstClient.launchEmulator({ avdName: "Pixel 9", deviceId: "emulator-5554" });

    await expect(
      secondClient.launchEmulator({ avdName: "Pixel 9a", deviceId: "emulator-5554" }),
    ).rejects.toThrow("console port 5554 is already in use");
    expect(secondSpawns).toBe(0);
    child.emit("exit", 0, null);
    timer.advanceTime(30_001);
    adb.setDevices([{ name: "Pixel 9", platform: "android", deviceId: "emulator-5554" }]);
    await expect(
      secondClient.launchEmulator({ avdName: "Pixel 9a", deviceId: "emulator-5554" }),
    ).rejects.toThrow("console port 5554 is already in use");
    expect(secondSpawns).toBe(0);
  });

  test("aborting a launch keeps its reservation until the TTL expires", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    const firstChild = createChild();
    const secondChild = createChild();
    let spawns = 0;
    const client = createClient(
      () => {
        spawns += 1;
        const child = spawns === 1 ? firstChild : secondChild;
        queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
        return child;
      },
      adb,
      undefined,
      "Pixel 9",
      timer,
    );

    await client.launchEmulator({
      avdName: "Pixel 9",
      deviceId: "emulator-5554",
      signal: controller.signal,
    });
    controller.abort();
    firstChild.emit("exit", null, "SIGTERM");
    firstChild.emit("close", null, "SIGTERM");
    adb.getDeviceStates = async () => {
      throw new Error("raw device-state scan failed");
    };

    await expect(
      client.launchEmulator({ avdName: "Pixel 9", deviceId: "emulator-5554" }),
    ).rejects.toThrow("console port 5554 is already in use");
    timer.advanceTime(30_001);
    const retry = await client.launchEmulator({ avdName: "Pixel 9", deviceId: "emulator-5554" });

    expect(retry.targetDeviceId).toBe("emulator-5554");
    expect(spawns).toBe(2);
    secondChild.emit("exit", 0, null);
  });

  test("terminating one launch does not release another launch reservation", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const firstChild = createChild();
    const secondChild = createChild();
    let firstSpawns = 0;
    let secondSpawns = 0;
    const firstClient = createClient(
      () => {
        firstSpawns += 1;
        queueMicrotask(() =>
          firstChild.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")),
        );
        return firstChild;
      },
      adb,
      undefined,
      "Pixel 9",
      timer,
    );
    const secondClient = createClient(
      () => {
        secondSpawns += 1;
        queueMicrotask(() =>
          secondChild.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")),
        );
        return secondChild;
      },
      adb,
      undefined,
      "Pixel 9a",
      timer,
    );
    const thirdClient = createClient(
      () => {
        secondSpawns += 1;
        return createChild();
      },
      adb,
      undefined,
      "Pixel 10",
      timer,
    );

    await firstClient.launchEmulator({ avdName: "Pixel 9", deviceId: "emulator-5554" });
    await secondClient.launchEmulator({ avdName: "Pixel 9a", deviceId: "emulator-5556" });
    firstChild.emit("exit", 0, null);
    timer.advanceTime(30_001);
    adb.getDeviceStates = async () => {
      throw new Error("raw device-state scan failed");
    };

    await expect(
      thirdClient.launchEmulator({ avdName: "Pixel 10", deviceId: "emulator-5556" }),
    ).rejects.toThrow("console port 5556 is already in use");
    expect(firstSpawns).toBe(1);
    expect(secondSpawns).toBe(1);
    secondChild.emit("exit", 0, null);
  });

  test("expired terminal reservation frees an explicit port with an incomplete snapshot", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const firstChild = createChild();
    const secondChild = createChild();
    let spawns = 0;
    const client = createClient(
      () => {
        spawns += 1;
        const child = spawns === 1 ? firstChild : secondChild;
        queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
        return child;
      },
      adb,
      undefined,
      "Pixel 9",
      timer,
    );

    await client.launchEmulator({ avdName: "Pixel 9", deviceId: "emulator-5554" });
    firstChild.emit("exit", 0, null);
    adb.getDeviceStates = async () => {
      throw new Error("raw device-state scan failed");
    };

    await expect(
      client.launchEmulator({ avdName: "Pixel 9", deviceId: "emulator-5554" }),
    ).rejects.toThrow("console port 5554 is already in use");
    timer.advanceTime(30_001);
    const retry = await client.launchEmulator({ avdName: "Pixel 9", deviceId: "emulator-5554" });

    expect(retry.targetDeviceId).toBe("emulator-5554");
    expect(spawns).toBe(2);
    secondChild.emit("exit", 0, null);
  });

  test("rejects an occupied selected port when the raw-state scan fails", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([{ name: "Unknown", platform: "android", deviceId: "emulator-5554" }]);
    adb.getDeviceStates = async () => {
      throw new Error("raw device-state scan failed");
    };
    let spawns = 0;
    const client = createClient(() => {
      spawns += 1;
      return createChild();
    }, adb);

    await expect(
      client.launchEmulator({ avdName: "Pixel 9", deviceId: "emulator-5554" }),
    ).rejects.toThrow("console port 5554 is already in use");
    expect(spawns).toBe(0);
  });

  test("does not allocate a console port when the raw-state scan fails", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([{ name: "Unknown", platform: "android", deviceId: "emulator-5554" }]);
    adb.getDeviceStates = async () => {
      throw new Error("raw device-state scan failed");
    };
    const child = createChild();
    let spawnedArgs: string[] = [];
    const client = createClient((_command, args) => {
      spawnedArgs = args;
      queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
      return child;
    }, adb);

    await client.startEmulator("Pixel 9");

    expect(spawnedArgs).not.toContain("-port");
    child.emit("exit", 0, null);
  });

  test("does not spawn when launch has already been cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawns = 0;
    const client = createClient(() => {
      spawns += 1;
      return createChild();
    });

    await expect(
      client.launchEmulator({ avdName: "Pixel 9", signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(spawns).toBe(0);
  });

  test("does not spawn when cancellation happens during startup validation", async () => {
    const controller = new AbortController();
    let releaseAvdLookup: (devices: DeviceInfo[]) => void = () => {};
    const availableAvds = new Promise<DeviceInfo[]>((resolve) => {
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

  test("cancels host-port reservation before spawning", async () => {
    const controller = new AbortController();
    let hostProbeStarted = false;
    let spawns = 0;
    const client = createClient(
      () => {
        spawns += 1;
        return createChild();
      },
      new FakeAdbExecutor(),
      {
        isPortAvailable: () => {
          hostProbeStarted = true;
          controller.abort();
          return true;
        },
      },
    );

    const launch = client.launchEmulator({ avdName: "Pixel 9", signal: controller.signal });

    await expect(launch).rejects.toThrow("cancelled");
    expect(spawns).toBe(0);
    expect(hostProbeStarted).toBe(true);
  });

  test("cancels the reservation snapshot before starting the raw-state scan", async () => {
    const controller = new AbortController();
    const adb = new FakeAdbExecutor();
    let releaseBootedDevices: (devices: DeviceInfo[]) => void = () => {};
    const bootedDevices = new Promise<DeviceInfo[]>((resolve) => {
      releaseBootedDevices = resolve;
    });
    let bootedDeviceSignal: AbortSignal | undefined;
    let rawStateScanStarted = false;
    let spawns = 0;
    adb.getBootedAndroidDevices = async (options) => {
      bootedDeviceSignal = options?.signal;
      return bootedDevices;
    };
    adb.getDeviceStates = async () => {
      rawStateScanStarted = true;
      return [];
    };
    const client = createClient(() => {
      spawns += 1;
      return createChild();
    }, adb);

    const launch = client.launchEmulator({ avdName: "Pixel 9", signal: controller.signal });
    while (!bootedDeviceSignal) {
      await Promise.resolve();
    }
    controller.abort();
    releaseBootedDevices([]);

    await expect(launch).rejects.toThrow("cancelled");
    expect(bootedDeviceSignal).toBe(controller.signal);
    expect(rawStateScanStarted).toBe(false);
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

  test("hands the spawned child to the owner when cancelled during startup validation (#10075)", async () => {
    const controller = new AbortController();
    const child = createChild();
    const signals: string[] = [];
    // An emulator that ignores SIGTERM: kill() is only recorded, `exit` never fires.
    child.kill = ((signal?: NodeJS.Signals) => {
      signals.push(String(signal ?? "SIGTERM"));
      child.killed = true;
      return true;
    }) as ChildProcess["kill"];
    const timer = new FakeTimer();
    let spawned = false;
    const client = createClient(
      () => {
        spawned = true;
        return child;
      },
      undefined,
      undefined,
      "Pixel 9",
      timer,
    );

    const launch = client.launchEmulator({ avdName: "Pixel 9", signal: controller.signal });
    const rejection = launch.then(
      () => undefined,
      (error: unknown) => error,
    );
    while (!spawned) {
      await Promise.resolve();
    }
    controller.abort();
    // No timer advance: the owner gets the child inside its abort grace, not after the 5 s fallback.
    const error = await rejection;

    expect(error).toBeInstanceOf(EmulatorLaunchCancelledError);
    expect((error as EmulatorLaunchCancelledError).process).toBe(child);
    expect(signals).toEqual(["SIGTERM"]);

    // The abandoned validation settling later must not signal again or surface an error.
    timer.advanceTime(5000);
    await Promise.resolve();
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("carries the child on the cancellation when the emulator exits on SIGTERM (#10075)", async () => {
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
    const rejection = launch.then(
      () => undefined,
      (error: unknown) => error,
    );
    while (!spawned) {
      await Promise.resolve();
    }
    controller.abort();

    const error = await rejection;
    expect(error).toBeInstanceOf(EmulatorLaunchCancelledError);
    expect((error as EmulatorLaunchCancelledError).process).toBe(child);
  });

  test("a launch cancelled before the spawn carries no child (#10075)", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawns = 0;
    const client = createClient(() => {
      spawns++;
      return createChild();
    });

    const error = await client
      .launchEmulator({ avdName: "Pixel 9", signal: controller.signal })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(EmulatorLaunchCancelledError);
    expect((error as EmulatorLaunchCancelledError).process).toBeNull();
    expect(spawns).toBe(0);
  });

  test("bounds the AVD-existence check with the launch's abort signal (#10075)", async () => {
    const controller = new AbortController();
    const child = createChild();
    const client = createClient(() => {
      queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
      return child;
    });
    let listSignal: AbortSignal | undefined;
    spyOn(client, "listAvds").mockImplementation(async (options) => {
      listSignal = options?.signal;
      return [{ name: "Pixel 9", platform: "android", isRunning: false }];
    });

    await client.launchEmulator({ avdName: "Pixel 9", signal: controller.signal });

    expect(listSignal).toBe(controller.signal);
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
