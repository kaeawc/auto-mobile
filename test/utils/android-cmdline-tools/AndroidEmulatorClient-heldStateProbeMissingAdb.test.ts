import { describe, expect, test } from "bun:test";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import {
  AndroidEmulatorClient,
  AndroidOfflineProbeError,
} from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";

const HELD = "emulator-5554";

function execResult(stdout: string) {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

/** The real adb client over an executable that is not there (replaced mid-upgrade, PATH changed). */
function emulatorClientWithMissingAdb(spawns: string[] = []): AndroidEmulatorClient {
  const timer = new FakeTimer();
  const adb = new AdbClient(
    null,
    async (command: string) => {
      spawns.push(String(command));
      throw Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" });
    },
    { timer },
  );
  const factory: AdbClientFactory = { create: () => adb };
  return new AndroidEmulatorClient({
    execAsync: async () => execResult(""),
    timer,
    adbFactory: factory,
  });
}

/**
 * The held-device state probe is the second read behind every inventory surface and the
 * disconnect monitor: a held emulator booted discovery misses is asked for here, and "not listed"
 * means it is gone. Its contract is that a probe that could not ask throws
 * `AndroidOfflineProbeError`, so callers answer `discovery_incomplete` (#11573, #11605: tooling
 * that vanishes under a pooled device is unknown, never a true zero). `getDeviceStates` answers
 * `[]` for a missing adb executable unless asked to throw, which would read as an authoritative
 * "listed nowhere" for a device the probe never asked about: with discovery still answered from
 * the adb device-list cache, the held device would leave the listing and the counts with nothing
 * unknown (#11643).
 */
describe("held-device state probe when the adb executable is missing", () => {
  test("getListedNonDeviceStatesAmong refuses instead of answering that no candidate is listed", async () => {
    const client = emulatorClientWithMissingAdb();

    const outcome = await client.getListedNonDeviceStatesAmong([HELD]).then(
      (states) => ({ answered: [...states] }),
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(AndroidOfflineProbeError);
  });

  test("getOfflineDeviceIdsAmong refuses instead of answering that no candidate is offline", async () => {
    const client = emulatorClientWithMissingAdb();

    const outcome = await client.getOfflineDeviceIdsAmong([HELD]).then(
      (offline) => ({ answered: [...offline] }),
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(AndroidOfflineProbeError);
  });

  test("with no held candidate the probe answers empty without asking adb", async () => {
    // A host with no Android tooling holds no Android device: nothing to probe, nothing unknown.
    const spawns: string[] = [];
    const client = emulatorClientWithMissingAdb(spawns);

    expect([...(await client.getListedNonDeviceStatesAmong([]))]).toEqual([]);
    expect(spawns).toEqual([]);
  });
});
