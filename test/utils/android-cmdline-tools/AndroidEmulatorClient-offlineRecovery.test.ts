import { describe, expect, spyOn, test } from "bun:test";
import {
  AndroidEmulatorClient,
  AndroidOfflineProbeError,
} from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { logger } from "../../../src/utils/logger";
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
 * bounded, serial-scoped reconnect.
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

  test("distinguishes a failed offline probe from an authoritative empty result", async () => {
    const adb = new RejectingDeviceStatesAdbExecutor();
    const client = new AndroidEmulatorClient(
      async () => execResult(""),
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    await expect(client.getOfflineDeviceIdsAmong(["emulator-5554"])).rejects.toBeInstanceOf(
      AndroidOfflineProbeError,
    );
  });
});

describe("AndroidEmulatorClient.recoverOfflineDevices", () => {
  function recoveryClient(adb: FakeAdbExecutor, factory = new FakeAdbClientFactory(adb)) {
    return new AndroidEmulatorClient(async () => execResult(""), null, new FakeTimer(), factory);
  }

  test("reconnects each distinct serial once with explicit argv and noRetry", async () => {
    const adb = new FakeAdbExecutor();
    const factory = new FakeAdbClientFactory(adb);
    const signal = new AbortController().signal;
    await recoveryClient(adb, factory).recoverOfflineDevices(
      ["emulator-5554", "emulator-5558", "emulator-5554"],
      { timeoutMs: 1234, signal },
    );
    expect(adb.getExecutedArgv()).toEqual([
      ["-s", "emulator-5554", "reconnect"],
      ["-s", "emulator-5558", "reconnect"],
    ]);
    expect(adb.getCommandCalls()).toHaveLength(2);
    for (const call of adb.getCommandCalls()) {
      expect(call.noRetry).toBe(true);
      expect(call.timeoutMs).toBe(1234);
      expect(call.signal).toBe(signal);
    }
    expect(factory.getCalls().map((call) => call.device)).toEqual([null, null]);
  });

  test("empty targets dispatch no command", async () => {
    const adb = new FakeAdbExecutor();
    await recoveryClient(adb).recoverOfflineDevices([]);
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(adb.getExecutedArgv()).toEqual([]);
  });

  test("logs a serial's failed reconnect and still dispatches the other serial", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("-s emulator-5554 reconnect", new Error("adb server unreachable"));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(
        recoveryClient(adb).recoverOfflineDevices(["emulator-5554", "emulator-5558"]),
      ).resolves.toBeUndefined();
      expect(adb.getExecutedArgv()).toEqual([
        ["-s", "emulator-5554", "reconnect"],
        ["-s", "emulator-5558", "reconnect"],
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("emulator-5554"),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("dispatches serials concurrently before either reconnect settles", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof execResult>>();
    class PendingAdb extends FakeAdbExecutor {
      override async executeCommand(...args: Parameters<FakeAdbExecutor["executeCommand"]>) {
        await super.executeCommand(...args);
        return pending.promise;
      }
    }
    const adb = new PendingAdb();
    const recovery = recoveryClient(adb).recoverOfflineDevices(["emulator-5554", "emulator-5558"]);
    await Promise.resolve();
    expect(adb.getExecutedArgv()).toHaveLength(2);
    pending.resolve(execResult(""));
    await recovery;
  });

  test("propagates an already-aborted signal without dispatch", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    await expect(
      recoveryClient(adb).recoverOfflineDevices(["emulator-5554"], { signal: controller.signal }),
    ).rejects.toThrow("caller cancelled");
    expect(adb.getExecutedArgv()).toEqual([]);
  });

  test("propagates abort during a reconnect", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    adb.abortAfterCommand("-s emulator-5554 reconnect", controller);
    await expect(
      recoveryClient(adb).recoverOfflineDevices(["emulator-5554"], { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
