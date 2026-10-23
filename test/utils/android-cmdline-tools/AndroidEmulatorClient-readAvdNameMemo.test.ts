import { afterEach, describe, expect, test } from "bun:test";
import {
  AndroidEmulatorClient,
  ANDROID_INVENTORY_ENRICHMENT_TTL_MS,
  resetAndroidInventoryEnrichmentCache,
} from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { withAndroidTransportId, copyAndroidTransportId } from "../../../src/utils/androidSerial";
import { createExecResult } from "../../../src/utils/execResult";
import { getAbortSignal, runWithAbortSignal } from "../../../src/utils/AbortContext";
import { InMemoryEmulatorConsoleBusyRegistry } from "../../../src/utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { FakeTimer } from "../../fakes/FakeTimer";

const readListing = { bypassDeviceListCache: true, memoizeReadAvdNames: true };
function row(transportId: string | undefined = "7", deviceId = "emulator-5554"): BootedDevice {
  return withAndroidTransportId(
    { name: "ignored", platform: "android" as const, deviceId },
    transportId,
  );
}
function fixture() {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  const busy = new InMemoryEmulatorConsoleBusyRegistry();
  adb.setDevices([row()]);
  adb.setCommandResponse("emu avd name", createExecResult("Pixel_A\nOK", ""));
  const clients = Array.from(
    { length: 2 },
    () =>
      new AndroidEmulatorClient({
        execAsync: async () => {
          throw new Error("unexpected host command");
        },
        spawnFn: () => {
          throw new Error("unexpected host spawn");
        },
        timer,
        adbFactory: new FakeAdbClientFactory(adb),
        avdConfigReader: new FakeAvdConfigReader({ deviceName: "pixel", architecture: "x86_64" }),
        consoleBusyRegistry: busy,
      }),
  );
  const probeCount = () =>
    adb.getExecutedCommands().filter((command) => command === "emu avd name").length;
  const scan = (options = readListing) => clients[0].getBootedDevicesChecked(true, options);
  return { timer, adb, clients, busy, probeCount, scan };
}

afterEach(async () => {
  resetAndroidInventoryEnrichmentCache();
  // Pin the process-wide reset through behavior, including across client instances.
  try {
    const f = fixture();
    await f.scan();
    resetAndroidInventoryEnrichmentCache();
    await f.clients[1].getBootedDevicesChecked(true, readListing);
    expect(f.probeCount()).toBe(2);
  } finally {
    resetAndroidInventoryEnrichmentCache();
  }
});

describe("read-only connection-keyed AVD name memo", () => {
  test("consecutive bypass listings reuse names while preserving row shaping and transport metadata", async () => {
    const f = fixture();
    const first = (await f.scan())[0];
    const second = (await f.scan())[0];
    expect(first.name).toBe("Pixel_A");
    expect(second).toEqual({ ...first, observedAt: second.observedAt });
    expect(second.observedAt).not.toBe(first.observedAt);
    expect(copyAndroidTransportId(second, {})).toEqual(copyAndroidTransportId(row(), {}));
    expect(f.probeCount()).toBe(1);
  });

  test("a recycled serial with a new transport id re-probes and evicts the old identity", async () => {
    const f = fixture();
    await f.scan();
    f.adb.setDevices([row("9")]);
    f.adb.setCommandResponse("emu avd name", createExecResult("Pixel_B", ""));
    expect((await f.scan())[0].name).toBe("Pixel_B");
    f.adb.setDevices([row("7")]);
    expect((await f.scan())[0].name).toBe("Pixel_B");
    expect(f.probeCount()).toBe(3);
  });

  test("two serials with the same transport id have separate name probes", async () => {
    const f = fixture();
    f.adb.setDevices([row(), row("7", "emulator-5556")]);
    expect(await f.scan()).toHaveLength(2);
    expect(await f.scan()).toHaveLength(2);
    expect(f.probeCount()).toBe(2);
  });

  test("a changed transport in an ordinary listing evicts the read memo", async () => {
    const f = fixture();
    await f.scan();
    f.adb.setDevices([row("9")]);
    await f.clients[1].getBootedDevicesChecked(true, { bypassDeviceListCache: true });
    f.adb.setDevices([row()]);
    f.adb.setCommandResponse("emu avd name", createExecResult("Pixel_B", ""));
    expect((await f.scan())[0].name).toBe("Pixel_B");
    expect(f.probeCount()).toBe(3);
  });

  test.each([true, false])(
    "a full listing (opted in: %s) evicts vanished serials",
    async (optedIn) => {
      const f = fixture();
      await f.scan();
      f.adb.setDevices([]);
      await f.scan({ ...readListing, memoizeReadAvdNames: optedIn });
      f.adb.setDevices([row()]);
      f.adb.setCommandResponse("emu avd name", createExecResult("Pixel_B", ""));
      expect((await f.scan())[0].name).toBe("Pixel_B");
      expect(f.probeCount()).toBe(2);
    },
  );

  test("caller subsets and narrowed scans do not evict serials they cannot see", async () => {
    const f = fixture();
    await f.scan();
    await f.clients[1].getBootedDevicesChecked(true, { devices: [], bypassDeviceListCache: true });
    f.adb.setDevices([]);
    await f.clients[1].getBootedDevicesChecked(true, { targetDeviceId: "emulator-5556" });
    f.adb.setDevices([row()]);
    await f.scan();
    expect(f.probeCount()).toBe(1);
  });

  test("TTL expires after 2500ms without sliding on hits", async () => {
    const f = fixture();
    await f.scan();
    f.timer.advanceTime(ANDROID_INVENTORY_ENRICHMENT_TTL_MS - 1);
    await f.scan();
    expect(f.probeCount()).toBe(1);
    f.timer.advanceTime(2);
    await f.scan();
    expect(f.probeCount()).toBe(2);
  });

  test("rows without transport ids always probe and invalidate previously identified rows", async () => {
    const f = fixture();
    await f.scan();
    f.adb.setDevices([row("")]);
    await f.scan();
    await f.scan();
    f.adb.setDevices([row()]);
    await f.scan();
    expect(f.probeCount()).toBe(4);
  });

  test.each(["empty", "failed"])("%s name probes are never memoized", async (outcome) => {
    const f = fixture();
    f.adb.setCommandResponse("emu avd name", createExecResult("", ""));
    if (outcome === "failed") {
      f.adb.setCommandError("emu avd name", new Error("console failed"));
      f.adb.setCommandError("getprop ro.boot.qemu.avd_name", new Error("property failed"));
    }
    expect((await f.scan())[0].name).toBe("Unknown (emulator-5554)");
    await f.scan();
    expect(f.probeCount()).toBe(2);
  });

  test("timed-out name probes are never memoized", async () => {
    const f = fixture();
    const execute = f.adb.executeCommand.bind(f.adb);
    f.adb.executeCommand = async (command, ...args) => {
      if (command === "emu avd name") {
        f.timer.advanceTime(2_001);
        throw new Error("Command timed out after 2000ms");
      }
      return await execute(command, ...args);
    };
    expect((await f.scan())[0]).toMatchObject({
      name: "Unknown (emulator-5554)",
      nameProbeTimedOut: true,
    });

    f.adb.executeCommand = execute;
    expect((await f.scan())[0].name).toBe("Pixel_A");
    expect(f.probeCount()).toBe(1);
  });

  test("console-busy results are never memoized", async () => {
    const f = fixture();
    await f.busy.runExclusive("emulator-5554", async () => {
      expect((await f.scan())[0].consoleBusyDuringProbe).toBe(true);
      await f.scan();
      expect(f.probeCount()).toBe(0);
    });
    expect((await f.scan())[0].name).toBe("Pixel_A");
    expect(f.probeCount()).toBe(1);
  });

  test("ordinary bypass and destructive name resolution never consult the read memo", async () => {
    const f = fixture();
    await f.scan();
    f.adb.setCommandResponse("emu avd name", createExecResult("Pixel_B", ""));
    for (let i = 0; i < 2; i++) {
      expect(
        (await f.clients[1].getBootedDevicesChecked(true, { bypassDeviceListCache: true }))[0].name,
      ).toBe("Pixel_B");
      expect(await f.clients[1].resolveRunningAvdName(row(), 2000)).toBe("Pixel_B");
      expect(await f.clients[1].resolveAvdNameForSerial("emulator-5554", { timeoutMs: 2000 })).toBe(
        "Pixel_B",
      );
    }
    expect((await f.scan())[0].name).toBe("Pixel_A");
    expect(f.probeCount()).toBe(7);
  });

  test("concurrent callers share a probe and the leader's abort does not poison the survivor", async () => {
    const f = fixture();
    const execute = f.adb.executeCommand.bind(f.adb);
    f.adb.executeCommand = async (command, ...args) => {
      if (command === "emu avd name") {
        const signal = args[0]?.signal ?? getAbortSignal();
        await f.timer.sleep(25);
        signal?.throwIfAborted();
      }
      return execute(command, ...args);
    };
    const leader = new AbortController();
    const first = runWithAbortSignal(leader.signal, () => f.scan()).then(
      () => "resolved",
      () => "cancelled",
    );
    const second = f.clients[1].getBootedDevicesChecked(true, readListing);
    await new Promise<void>((resolve) => setImmediate(resolve));
    leader.abort();
    await f.timer.advanceTimeAsync(25);
    expect(await first).toBe("cancelled");
    expect((await second)[0].name).toBe("Pixel_A");
    expect(f.probeCount()).toBe(1);
    expect((await f.scan())[0].name).toBe("Pixel_A");
    expect(f.probeCount()).toBe(1);
  });

  test("an aborted sole caller cannot populate the memo", async () => {
    const f = fixture();
    const execute = f.adb.executeCommand.bind(f.adb);
    let dispatches = 0;
    f.adb.executeCommand = async (command, ...args) => {
      if (command === "emu avd name" && dispatches++ === 0) {
        await f.timer.sleep(25);
      }
      return execute(command, ...args);
    };
    const caller = new AbortController();
    const first = runWithAbortSignal(caller.signal, () => f.scan()).then(
      () => "resolved",
      () => "cancelled",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    caller.abort();
    await f.timer.advanceTimeAsync(25);
    expect(await first).toBe("cancelled");
    await f.scan();
    expect(dispatches).toBe(2);
  });

  test.each(["vanish", "reset"])(
    "a late probe after %s cannot join or refill the replacement memo",
    async (invalidation) => {
      const f = fixture();
      const execute = f.adb.executeCommand.bind(f.adb);
      let firstProbe = true;
      f.adb.executeCommand = async (command, ...args) => {
        const result = await execute(command, ...args);
        if (command === "emu avd name" && firstProbe) {
          firstProbe = false;
          await f.timer.sleep(25);
        }
        return result;
      };
      const departed = f.scan();
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (invalidation === "reset") {
        resetAndroidInventoryEnrichmentCache();
      } else {
        f.adb.setDevices([]);
        await f.clients[1].getBootedDevicesChecked(true);
      }
      f.adb.setDevices([row()]);
      f.adb.setCommandResponse("emu avd name", createExecResult("Pixel_B", ""));
      expect((await f.scan())[0].name).toBe("Pixel_B");
      await f.timer.advanceTimeAsync(25);
      expect((await departed)[0].name).toBe("Pixel_A");
      expect((await f.scan())[0].name).toBe("Pixel_B");
      expect(f.probeCount()).toBe(2);
    },
  );
});

describe("reset AVD timeout propagation", () => {
  test("reset callers can distinguish a timed-out name probe from a mismatched name", async () => {
    const f = fixture();
    const execute = f.adb.executeCommand.bind(f.adb);
    f.adb.executeCommand = async (command, options) => {
      if (command === "emu avd name") {
        f.timer.advanceTime(options?.timeoutMs ?? 2000);
        throw new Error("Command timed out after 2000ms");
      }
      return execute(command, options);
    };
    await expect(
      f.clients[0].resolveAvdNameForSerial("emulator-5558", {
        timeoutMs: 2000,
        throwOnTimeout: true,
      }),
    ).rejects.toThrow("timed out after 2000ms");
    expect(
      await f.clients[0].resolveAvdNameForSerial("emulator-5558", { timeoutMs: 2000 }),
    ).toBeUndefined();
    f.adb.executeCommand = execute;
    expect(
      await f.clients[0].resolveAvdNameForSerial("emulator-5558", {
        timeoutMs: 2000,
        throwOnTimeout: true,
      }),
    ).toBe("Pixel_A");
  });
});
