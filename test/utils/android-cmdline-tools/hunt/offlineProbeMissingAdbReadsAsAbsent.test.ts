import { describe, expect, test } from "bun:test";
import { AdbClient } from "../../../../src/utils/android-cmdline-tools/AdbClient";
import {
  AndroidEmulatorClient,
  AndroidOfflineProbeError,
} from "../../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { AdbClientFactory } from "../../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeTimer } from "../../../fakes/FakeTimer";

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
function emulatorClientWithMissingAdb(): AndroidEmulatorClient {
  const timer = new FakeTimer();
  const adb = new AdbClient(
    null,
    async () => {
      throw Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" });
    },
    null,
    undefined,
    timer,
  );
  const factory: AdbClientFactory = { create: () => adb };
  return new AndroidEmulatorClient(async () => execResult(""), null, timer, factory);
}

/**
 * The held-device state probe is the second read behind every inventory surface and the
 * disconnect monitor: a held emulator booted discovery misses is asked for here, and "not listed"
 * means it is gone. Its contract is that a probe that could not ask throws
 * `AndroidOfflineProbeError`, so callers answer `discovery_incomplete` (#11573, #11605: tooling
 * that vanishes under a pooled device is unknown, never a true zero). A missing adb executable is
 * swallowed one layer down (`getDeviceStates` without `throwOnMissingAdb` returns `[]`), so the
 * probe reports an authoritative "listed nowhere" for a device it never asked about. Discovery
 * answered from the adb device-list cache just before adb vanished stays "complete", and the two
 * reads together drop the held device from the listing and the counts with nothing unknown.
 */
describe("hunt: held-device state probe when the adb executable is missing", () => {
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
});
