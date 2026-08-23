import { describe, expect, test } from "bun:test";
import {
  AdbClient,
  AdbCommandTimeoutError,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import { defaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice, ExecResult } from "../../../src/models";

/**
 * The complement to `AdbClient-executionContract.test.ts`'s
 * `caches a failed read so it does not re-probe a device that cannot answer`.
 *
 * That contract caches a GENUINE device failure (offline, adb error) as null so a
 * dead device is not re-probed on every call. This one pins the deliberate
 * exception: OUR injected budget timeout — the `timeoutMs` the daemon's
 * append-text path threads (#3351) — is NOT a device verdict, so it must NOT be
 * cached. A later request with a fresh budget has to be free to retry, because the
 * daemon now keeps one AdbClient per device for minutes (finding 4) and a cached
 * null from a single timed-out probe would disable SHIFT chords for that window.
 *
 * The two tests are complementary and non-contradictory: genuine failure cached
 * (one probe), our-timeout not cached (re-probes). Keyed on the `AdbCommandTimeoutError`
 * type, never a message match.
 */
const DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  name: "Test Device",
};

const GETPROP = "getprop ro.build.version.sdk";

function ok(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

describe("AdbClient.getAndroidApiLevel timeout caching", () => {
  test("does not cache an AdbCommandTimeoutError, so a later call re-probes", async () => {
    let calls = 0;
    let timeOut = true;
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes(GETPROP)) {
        calls += 1;
        if (timeOut) {
          return Promise.reject(
            new AdbCommandTimeoutError(`Command timed out after 5ms: adb shell ${GETPROP}`),
          );
        }
        return Promise.resolve(ok("31"));
      }
      return Promise.resolve(ok(""));
    };
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

    // Budget expired: null for THIS call, but the failure is not a device verdict.
    expect(await client.getAndroidApiLevel(5)).toBeNull();

    // Fresh budget: the timed-out probe must not have poisoned the cache.
    timeOut = false;
    expect(await client.getAndroidApiLevel(5000)).toBe(31);

    // Re-probed: one probe per call, precisely because the first was not cached.
    expect(calls).toBe(2);
  });

  test("still caches a GENUINE failure that only differs by error type", async () => {
    // Guards the boundary from the other side: a plain Error is a device verdict
    // and IS cached (matching the execution-contract test), so switching the error
    // type is what flips the caching decision — not the fact that it failed.
    let calls = 0;
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes(GETPROP)) {
        calls += 1;
        return Promise.reject(new Error("getprop failed: device offline"));
      }
      return Promise.resolve(ok(""));
    };
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

    expect(await client.getAndroidApiLevel(5000)).toBeNull();
    expect(await client.getAndroidApiLevel(5000)).toBeNull();
    expect(calls).toBe(1);
  });
});
