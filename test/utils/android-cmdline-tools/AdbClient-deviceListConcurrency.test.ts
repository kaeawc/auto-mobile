import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import {
  AdbClient,
  resetAdbClientCaches,
  resetAdbDeviceListCache,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

function resultFor(deviceId: string): ExecResult {
  const stdout = `List of devices attached\n${deviceId}\tdevice\n`;
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

describe("AdbClient concurrent device-list snapshots", () => {
  beforeEach(resetAdbClientCaches);
  afterEach(resetAdbClientCaches);

  test("coalesces eight cold readers, isolates cancellation, and refreshes after 5 seconds", async () => {
    const timer = new FakeTimer();
    let adbDeviceListCalls = 0;
    const execute = async (command: string): Promise<ExecResult> => {
      expect(command).toContain("devices -l");
      adbDeviceListCalls += 1;
      if (adbDeviceListCalls === 1) {
        await timer.sleep(25);
        return resultFor("emulator-5554");
      }
      return resultFor("emulator-5556");
    };
    const clients = Array.from(
      { length: 8 },
      () => new AdbClient(null, execute, null, undefined, timer),
    );
    const cancelled = new AbortController();
    const cancellation = new Error("client one disconnected");

    const reads = clients.map((client, index) =>
      client.getBootedAndroidDevices({ signal: index === 0 ? cancelled.signal : undefined }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(adbDeviceListCalls).toBe(1);

    cancelled.abort(cancellation);
    await expect(reads[0]).rejects.toBe(cancellation);
    timer.advanceTime(25);
    const snapshots = await Promise.all(reads.slice(1));

    expect(adbDeviceListCalls).toBe(1);
    expect(timer.now()).toBe(25);
    expect(snapshots.flatMap((snapshot) => snapshot.map((device) => device.deviceId))).toEqual(
      Array(7).fill("emulator-5554"),
    );

    timer.advanceTime(4_999);
    await expect(clients[0].getBootedAndroidDevices()).resolves.toMatchObject([
      { deviceId: "emulator-5554" },
    ]);
    expect(adbDeviceListCalls).toBe(1);

    timer.advanceTime(1);
    await expect(clients[0].getBootedAndroidDevices()).resolves.toMatchObject([
      { deviceId: "emulator-5556" },
    ]);
    expect(adbDeviceListCalls).toBe(2);
  });

  test("bypass reads execute separately from an in-flight coalesced read", async () => {
    const timer = new FakeTimer();
    let adbDeviceListCalls = 0;
    const execute = async (command: string): Promise<ExecResult> => {
      expect(command).toContain("devices -l");
      adbDeviceListCalls += 1;
      if (adbDeviceListCalls === 1) {
        await timer.sleep(25);
        return resultFor("emulator-5554");
      }
      return resultFor("emulator-5556");
    };
    const client = new AdbClient(null, execute, null, undefined, timer);

    const coalescedRead = client.getBootedAndroidDevices();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(adbDeviceListCalls).toBe(1);

    const bypassRead = client.getBootedAndroidDevices({ bypassCache: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(adbDeviceListCalls).toBe(2);
    await expect(bypassRead).resolves.toMatchObject([{ deviceId: "emulator-5556" }]);

    timer.advanceTime(25);
    await expect(coalescedRead).resolves.toMatchObject([{ deviceId: "emulator-5554" }]);
  });

  test("does not let an older read overwrite a newer cache publication", async () => {
    const timer = new FakeTimer();
    let adbDeviceListCalls = 0;
    const execute = async (command: string): Promise<ExecResult> => {
      expect(command).toContain("devices -l");
      adbDeviceListCalls += 1;
      if (adbDeviceListCalls === 1) {
        await timer.sleep(25);
        return resultFor("emulator-5554");
      }
      return resultFor("emulator-5556");
    };
    const client = new AdbClient(null, execute, null, undefined, timer);

    const olderRead = client.getBootedAndroidDevices();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const newerRead = client.getBootedAndroidDevices({ bypassCache: true });
    await expect(newerRead).resolves.toMatchObject([{ deviceId: "emulator-5556" }]);

    timer.advanceTime(25);
    await expect(olderRead).resolves.toMatchObject([{ deviceId: "emulator-5554" }]);
    await expect(client.getBootedAndroidDevices()).resolves.toMatchObject([
      { deviceId: "emulator-5556" },
    ]);
  });

  test("does not let a pre-reset read repopulate the cleared cache", async () => {
    const timer = new FakeTimer();
    let adbDeviceListCalls = 0;
    const execute = async (command: string): Promise<ExecResult> => {
      expect(command).toContain("devices -l");
      adbDeviceListCalls += 1;
      if (adbDeviceListCalls === 1) {
        await timer.sleep(25);
        return resultFor("emulator-5554");
      }
      return resultFor("emulator-5556");
    };
    const client = new AdbClient(null, execute, null, undefined, timer);

    const preResetRead = client.getBootedAndroidDevices();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(adbDeviceListCalls).toBe(1);

    resetAdbDeviceListCache();
    await expect(client.getBootedAndroidDevices()).resolves.toMatchObject([
      { deviceId: "emulator-5556" },
    ]);
    expect(adbDeviceListCalls).toBe(2);

    timer.advanceTime(25);
    await expect(preResetRead).resolves.toMatchObject([{ deviceId: "emulator-5554" }]);
    await expect(client.getBootedAndroidDevices()).resolves.toMatchObject([
      { deviceId: "emulator-5556" },
    ]);
    expect(adbDeviceListCalls).toBe(2);
  });
});
