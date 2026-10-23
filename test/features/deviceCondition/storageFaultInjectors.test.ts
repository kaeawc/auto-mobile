import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import { OwedResetError } from "../../../src/features/deviceCondition/OwedResetError";
import {
  STORAGE_BALLAST_PATH,
  STORAGE_FREE_BYTES_LEFT,
  createStorageFaultInjector,
  parseDfAvailableBytes,
  resolveStorageFaultInjector,
} from "../../../src/features/deviceCondition/storageFaultInjectors";

const MIB = 1024 * 1024;

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

const dfOutput = (freeBytes: number): string =>
  [
    "Filesystem       1K-blocks     Used Available Use% Mounted on",
    `/dev/block/dm-9  100000000 20000000 ${Math.floor(freeBytes / 1024)}  20% /data`,
  ].join("\n");

interface StorageDevice {
  adb: FakeAdbExecutor;
  freeBytes(): number;
  /** Change the free space the device has without any ballast (the app freed or filled storage). */
  setBaseFreeBytes(bytes: number): void;
  ballastBytes(): number | undefined;
  commands(): string[];
  /** Reject a later command containing `match`: the `nth` one from now (1 = the next). */
  failOn(match: string, nth: number): void;
  /** Make the next `rm -f` succeed without deleting anything. */
  ignoreNextRm(): void;
}

interface StorageDeviceOptions {
  /** Free bytes with no ballast. */
  baseFreeBytes: number;
  /** A ballast of this size already on the device (a crashed earlier session). */
  staleBallastBytes?: number;
  hasFallocate?: boolean;
  /** `fallocate` reports success but does not use any space. */
  fallocateNoEffect?: boolean;
}

/** A device whose `df`, `fallocate`, `rm` and `ls` agree about one ballast file. */
function storageDevice(options: StorageDeviceOptions): StorageDevice {
  const adb = new FakeAdbExecutor();
  const log: string[] = [];
  let ballast: number | undefined = options.staleBallastBytes;
  let ignoreRm = false;
  const scheduled: { match: string; skip: number }[] = [];
  let baseFree = options.baseFreeBytes;
  const free = (): number => baseFree - (ballast ?? 0);
  adb.execute = (args) => {
    const command = args.join(" ");
    log.push(command);
    for (const entry of [...scheduled]) {
      if (command.includes(entry.match)) {
        if (entry.skip > 0) {
          entry.skip -= 1;
        } else {
          scheduled.splice(scheduled.indexOf(entry), 1);
          return Promise.reject(new Error("adb offline"));
        }
      }
    }
    if (command === "shell df -k /data") {
      return Promise.resolve(execResult(dfOutput(free())));
    }
    if (command.startsWith("shell command -v fallocate")) {
      return Promise.resolve(
        execResult(options.hasFallocate === false ? "" : "/system/bin/fallocate"),
      );
    }
    if (command.startsWith("shell ls -d ")) {
      return Promise.resolve(execResult(ballast === undefined ? "" : STORAGE_BALLAST_PATH));
    }
    if (command.startsWith("shell fallocate -l ")) {
      if (options.fallocateNoEffect !== true) {
        ballast = Number(args[args.indexOf("-l") + 1]);
      }
    } else if (command === `shell rm -f ${STORAGE_BALLAST_PATH}`) {
      if (ignoreRm) {
        ignoreRm = false;
      } else {
        ballast = undefined;
      }
    }
    return Promise.resolve(execResult(""));
  };
  return {
    adb,
    freeBytes: free,
    setBaseFreeBytes: (bytes) => {
      baseFree = bytes;
    },
    ballastBytes: () => ballast,
    commands: () => [...log],
    failOn: (match, nth) => {
      scheduled.push({ match, skip: nth - 1 });
    },
    ignoreNextRm: () => {
      ignoreRm = true;
    },
  };
}

const BASE = 4096 * MIB;

describe("parseDfAvailableBytes (#14066)", () => {
  test("reads the Available column of the last row in bytes", () => {
    expect(parseDfAvailableBytes(dfOutput(300 * MIB))).toBe(300 * MIB);
  });

  test("reads columns from the right, so a filesystem name with spaces does not shift them", () => {
    const output =
      "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/some name 1000 400 600 40% /data";
    expect(parseDfAvailableBytes(output)).toBe(600 * 1024);
  });

  test("throws, naming the output, when no row parses", () => {
    expect(() => parseDfAvailableBytes("df: /data: No such file")).toThrow(
      /Could not read free space/,
    );
  });
});

describe("storage fault (#14066)", () => {
  test("low leaves the target free, and reset deletes the ballast and reads clean", async () => {
    const device = storageDevice({ baseFreeBytes: BASE });
    const injector = createStorageFaultInjector(device.adb);
    const outcome = await injector.apply("low");
    expect(outcome.status).toBe("applied");
    expect(device.freeBytes()).toBe(STORAGE_FREE_BYTES_LEFT.low);
    expect(await injector.isClean()).toBe(false);

    await outcome.reset?.();
    expect(device.ballastBytes()).toBeUndefined();
    expect(device.freeBytes()).toBe(BASE);
    expect(await injector.isClean()).toBe(true);
  });

  test("full leaves much less free than low", async () => {
    const device = storageDevice({ baseFreeBytes: BASE });
    await createStorageFaultInjector(device.adb).apply("full");
    expect(device.freeBytes()).toBe(STORAGE_FREE_BYTES_LEFT.full);
    expect(STORAGE_FREE_BYTES_LEFT.full).toBeLessThan(STORAGE_FREE_BYTES_LEFT.low);
  });

  test("a device already below the target gets no ballast and owes no reset", async () => {
    const device = storageDevice({ baseFreeBytes: 4 * MIB });
    const outcome = await createStorageFaultInjector(device.adb).apply("full");
    expect(outcome.status).toBe("unchanged");
    expect(outcome.reset).toBeUndefined();
    expect(device.commands().some((c) => c.includes("fallocate -l"))).toBe(false);
  });

  test("a no-op apply on a nearly full device does not leave ownership that hides a later reset", async () => {
    const device = storageDevice({ baseFreeBytes: 4 * MIB });
    const injector = createStorageFaultInjector(device.adb);
    expect((await injector.apply("full")).status).toBe("unchanged");

    device.setBaseFreeBytes(BASE);
    const outcome = await injector.apply("low");
    expect(outcome.status).toBe("applied");
    // Without its own reset the ballast would outlive the session.
    expect(outcome.reset).toBeDefined();
    await outcome.reset?.();
    expect(device.ballastBytes()).toBeUndefined();
  });

  test("changing low to full re-sizes the one ballast and keeps a single reset", async () => {
    const device = storageDevice({ baseFreeBytes: BASE });
    const injector = createStorageFaultInjector(device.adb);
    const first = await injector.apply("low");
    const second = await injector.apply("full");
    expect(second.reset).toBeUndefined();
    expect(device.freeBytes()).toBe(STORAGE_FREE_BYTES_LEFT.full);

    await first.reset?.();
    expect(device.freeBytes()).toBe(BASE);
  });

  test("replaces a stale ballast from a crashed session and sizes against the real free space", async () => {
    const device = storageDevice({ baseFreeBytes: BASE, staleBallastBytes: 3000 * MIB });
    const outcome = await createStorageFaultInjector(device.adb).apply("low");
    expect(outcome.status).toBe("applied");
    expect(device.freeBytes()).toBe(STORAGE_FREE_BYTES_LEFT.low);
    await outcome.reset?.();
    expect(device.freeBytes()).toBe(BASE);
  });

  test("an image without fallocate is reported unsupported and nothing is created", async () => {
    const device = storageDevice({ baseFreeBytes: BASE, hasFallocate: false });
    await expect(createStorageFaultInjector(device.adb).apply("low")).rejects.toThrow(
      /unsupported on this image/,
    );
    expect(device.ballastBytes()).toBeUndefined();
  });

  test("a fallocate that does not use the space is rolled back and reported unsupported", async () => {
    const device = storageDevice({ baseFreeBytes: BASE, fallocateNoEffect: true });
    const injector = createStorageFaultInjector(device.adb);
    await expect(injector.apply("low")).rejects.toThrow(/did not reduce free space/);
    expect(device.ballastBytes()).toBeUndefined();
    expect(await injector.isClean()).toBe(true);
  });

  test("a reset whose delete did not take effect throws and stays owed until a retry removes it", async () => {
    const device = storageDevice({ baseFreeBytes: BASE });
    const injector = createStorageFaultInjector(device.adb);
    const outcome = await injector.apply("low");
    device.ignoreNextRm();

    await expect(outcome.reset?.()).rejects.toThrow(/still present/);
    expect(await injector.isClean()).toBe(false);

    await outcome.reset?.();
    expect(device.ballastBytes()).toBeUndefined();
    expect(await injector.isClean()).toBe(true);
  });

  test("when apply and its rollback both fail, the owed reset still removes the ballast", async () => {
    const device = storageDevice({ baseFreeBytes: BASE });
    // df calls: 1 = free space before allocating, 2 = verification (fails). The rollback then also fails.
    device.failOn("df -k", 2);
    device.failOn("rm -f", 2);
    const injector = createStorageFaultInjector(device.adb);

    const error = await injector.apply("low").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OwedResetError);
    expect(device.ballastBytes()).toBeDefined();

    await (error as OwedResetError).owedReset();
    expect(device.ballastBytes()).toBeUndefined();
    expect(await injector.isClean()).toBe(true);
  });

  test("rejects an unknown value before touching the device", async () => {
    const device = storageDevice({ baseFreeBytes: BASE });
    await expect(createStorageFaultInjector(device.adb).apply("overflowing")).rejects.toThrow(
      /Invalid faults.storage/,
    );
    expect(device.commands()).toEqual([]);
  });

  test("works through the controller: apply, then restore verifies clean", async () => {
    const device = storageDevice({ baseFreeBytes: BASE });
    const controller = new DeviceConditionController((key) =>
      key === "faults.storage" ? createStorageFaultInjector(device.adb) : undefined,
    );
    const applied = await controller.apply({ faults: { storage: "full" } });
    expect(applied.success).toBe(true);
    expect(applied.active).toEqual(["faults.storage"]);

    const restored = await controller.restore();
    expect(restored.verifiedClean).toBe(true);
    expect(device.freeBytes()).toBe(BASE);
  });

  test("the resolver reuses one injector per device, so low then full registers a single reset", async () => {
    const device = storageDevice({ baseFreeBytes: BASE });
    const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
    const cache = new Map();
    const factory = { create: () => device.adb };
    // Like the registry: resolve again on every apply.
    const controller = new DeviceConditionController((key) =>
      resolveStorageFaultInjector(android, key, { adbFactory: factory, cache }),
    );

    await controller.apply({ faults: { storage: "low" } });
    await controller.apply({ faults: { storage: "full" } });
    expect(device.freeBytes()).toBe(STORAGE_FREE_BYTES_LEFT.full);

    const cleared = await controller.apply({ faults: { storage: "unset" } });
    expect(cleared.changes).toEqual([{ key: "faults.storage", status: "cleared" }]);
    expect(cleared.active).toEqual([]);
    expect(device.freeBytes()).toBe(BASE);
  });

  describe("resizing through a registry-style resolver", () => {
    const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
    const controllerFor = (device: StorageDevice): DeviceConditionController => {
      const cache = new Map();
      const factory = { create: () => device.adb };
      return new DeviceConditionController((key) =>
        resolveStorageFaultInjector(android, key, { adbFactory: factory, cache }),
      );
    };

    test("a failed resize that rolls back, then a successful retry, still clears with one unset", async () => {
      const device = storageDevice({ baseFreeBytes: BASE });
      const controller = controllerFor(device);
      await controller.apply({ faults: { storage: "low" } });

      device.failOn("fallocate -l", 1);
      const failed = await controller.apply({ faults: { storage: "full" } });
      expect(failed.success).toBe(false);
      expect(failed.active).toEqual(["faults.storage"]);

      await controller.apply({ faults: { storage: "full" } });
      expect(device.freeBytes()).toBe(STORAGE_FREE_BYTES_LEFT.full);

      const cleared = await controller.apply({ faults: { storage: "unset" } });
      expect(cleared.changes).toEqual([{ key: "faults.storage", status: "cleared" }]);
      expect(cleared.active).toEqual([]);
      expect(device.freeBytes()).toBe(BASE);
    });

    test("after an unset, a fresh apply registers its own reset again", async () => {
      const device = storageDevice({ baseFreeBytes: BASE });
      const controller = controllerFor(device);
      await controller.apply({ faults: { storage: "low" } });
      await controller.apply({ faults: { storage: "unset" } });
      expect(device.freeBytes()).toBe(BASE);

      await controller.apply({ faults: { storage: "full" } });
      expect(device.freeBytes()).toBe(STORAGE_FREE_BYTES_LEFT.full);
      // Without its own reset the second ballast would outlive the session.
      const restored = await controller.restore();
      expect(restored.verifiedClean).toBe(true);
      expect(device.freeBytes()).toBe(BASE);
    });

    test("a release the controller could not verify, then a fresh apply, still clears with one unset", async () => {
      const device = storageDevice({ baseFreeBytes: BASE });
      const controller = controllerFor(device);
      await controller.apply({ faults: { storage: "low" } });

      // The ballast is removed (ls 1 confirms it), then the controller's own clean read (ls 2) fails,
      // so the controller keeps the reset although the injector has already forgotten its registration.
      device.failOn("ls -d", 2);
      const restored = await controller.restore();
      expect(restored.verifiedClean).toBe(false);
      expect(device.freeBytes()).toBe(BASE);

      await controller.apply({ faults: { storage: "full" } });
      expect(device.freeBytes()).toBe(STORAGE_FREE_BYTES_LEFT.full);

      const cleared = await controller.apply({ faults: { storage: "unset" } });
      expect(cleared.changes).toEqual([{ key: "faults.storage", status: "cleared" }]);
      expect(cleared.active).toEqual([]);
      expect(device.freeBytes()).toBe(BASE);
    });

    test("a failed resize whose rollback fails too does not add a second reset", async () => {
      const device = storageDevice({ baseFreeBytes: BASE });
      const controller = controllerFor(device);
      await controller.apply({ faults: { storage: "low" } });

      // The resize removes the old ballast (rm 1), fails to allocate, and its rollback's rm (2) fails.
      device.failOn("fallocate -l", 1);
      device.failOn("rm -f", 2);
      const failed = await controller.apply({ faults: { storage: "full" } });
      expect(failed.success).toBe(false);
      expect(failed.active).toEqual(["faults.storage"]);

      const cleared = await controller.apply({ faults: { storage: "unset" } });
      expect(cleared.changes).toEqual([{ key: "faults.storage", status: "cleared" }]);
      expect(cleared.active).toEqual([]);
      expect(device.freeBytes()).toBe(BASE);
    });
  });

  test("the resolver keeps separate injectors for separate devices", () => {
    const first: BootedDevice = { name: "a", platform: "android", deviceId: "emulator-5554" };
    const second: BootedDevice = { name: "b", platform: "android", deviceId: "emulator-5556" };
    const deps = { adbFactory: { create: () => new FakeAdbExecutor() }, cache: new Map() };
    const one = resolveStorageFaultInjector(first, "faults.storage", deps);
    expect(resolveStorageFaultInjector(first, "faults.storage", deps)).toBe(one);
    expect(resolveStorageFaultInjector(second, "faults.storage", deps)).not.toBe(one);
  });

  test("the resolver serves only this key, only on Android", () => {
    const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
    const ios: BootedDevice = { name: "sim", platform: "ios", deviceId: "UDID" };
    const factory = { create: () => new FakeAdbExecutor() };
    expect(
      resolveStorageFaultInjector(android, "faults.storage", { adbFactory: factory })?.key,
    ).toBe("faults.storage");
    expect(
      resolveStorageFaultInjector(android, "faults.battery", { adbFactory: factory }),
    ).toBeUndefined();
    expect(
      resolveStorageFaultInjector(ios, "faults.storage", { adbFactory: factory }),
    ).toBeUndefined();
  });
});
