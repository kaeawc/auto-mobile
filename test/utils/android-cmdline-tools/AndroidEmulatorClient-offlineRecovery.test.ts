import { describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

function execResult(stdout: string) {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

class RejectingDeviceStatesAdbExecutor extends FakeAdbExecutor {
  override async getDeviceStates(): Promise<never> {
    throw new Error("adb server unavailable");
  }
}

/**
 * Exercises the disconnect monitor's in-session offline recovery seam
 * (#7536): distinguishing offline-vs-absent candidates and issuing the
 * bounded, shared `adb reconnect offline` re-detect.
 */
describe("AndroidEmulatorClient.getOfflineDeviceIdsAmong", () => {
  test("returns candidates observed as ADB offline", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDeviceStates([
      { deviceId: "emulator-5554", state: "offline" },
      { deviceId: "emulator-5556", state: "device" },
    ]);
    const client = new AndroidEmulatorClient(
      async () => execResult(""),
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    const offline = await client.getOfflineDeviceIdsAmong(["emulator-5554", "emulator-5556"]);

    expect(offline).toEqual(new Set(["emulator-5554"]));
  });

  test("excludes an offline serial that is not among the given candidates", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDeviceStates([{ deviceId: "emulator-9999", state: "offline" }]);
    const client = new AndroidEmulatorClient(
      async () => execResult(""),
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    const offline = await client.getOfflineDeviceIdsAmong(["emulator-5554"]);

    expect(offline.size).toBe(0);
  });

  test("returns an empty set without probing when there are no candidates", async () => {
    const adb = new FakeAdbExecutor();
    let probed = false;
    adb.setDeviceStates([{ deviceId: "emulator-5554", state: "offline" }]);
    const originalGetDeviceStates = adb.getDeviceStates.bind(adb);
    adb.getDeviceStates = async (...args) => {
      probed = true;
      return originalGetDeviceStates(...args);
    };
    const client = new AndroidEmulatorClient(
      async () => execResult(""),
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    const offline = await client.getOfflineDeviceIdsAmong([]);

    expect(offline.size).toBe(0);
    expect(probed).toBe(false);
  });

  test("degrades to an empty set instead of throwing when the probe fails", async () => {
    const adb = new RejectingDeviceStatesAdbExecutor();
    const client = new AndroidEmulatorClient(
      async () => execResult(""),
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    const offline = await client.getOfflineDeviceIdsAmong(["emulator-5554"]);

    expect(offline.size).toBe(0);
  });
});

describe("AndroidEmulatorClient.recoverOfflineDevices", () => {
  test("issues exactly one noRetry 'adb reconnect offline'", async () => {
    const adb = new FakeAdbExecutor();
    const client = new AndroidEmulatorClient(
      async () => execResult(""),
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    await client.recoverOfflineDevices();

    const reconnectCalls = adb
      .getCommandCalls()
      .filter((call) => call.command.includes("reconnect offline"));
    expect(reconnectCalls).toHaveLength(1);
    expect(reconnectCalls[0]?.noRetry).toBe(true);
  });

  test("swallows a failed reconnect instead of throwing", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("reconnect offline", new Error("adb server unreachable"));
    const client = new AndroidEmulatorClient(
      async () => execResult(""),
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    await expect(client.recoverOfflineDevices()).resolves.toBeUndefined();
  });

  test("propagates an abort instead of swallowing it", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    adb.setCommandError("reconnect offline", new Error("aborted"));
    controller.abort(new Error("caller cancelled"));
    const client = new AndroidEmulatorClient(
      async () => execResult(""),
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    await expect(client.recoverOfflineDevices({ signal: controller.signal })).rejects.toThrow(
      "caller cancelled",
    );
  });
});
