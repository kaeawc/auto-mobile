import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import * as path from "path";
import {
  AndroidCtrlProxyManager,
  REBIND_MUTATION_COMMAND_TIMEOUT_MS,
} from "../../src/ctrlProxy/CtrlProxyManager";
import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import type { BootedDevice, ExecResult } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";

// Issue #10199. These tests run the manager on a REAL AdbClient so the ambient
// abort-signal check (`signal ?? getAbortSignal()`) is exercised; FakeAdbExecutor
// ignores the ambient signal and cannot see the dropped restore write.

// Derived from the same API 36 capture the main manager suite uses.
const boundCapture = readFileSync(
  path.join(import.meta.dir, "../fixtures/ctrlproxy/accessibility-api36-bound.txt"),
  "utf8",
);
const component = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;
const boundLine = boundCapture.match(/^     Bound services:.*$/m)?.[0] ?? "";
const crashedCapture = boundCapture
  .replace(boundLine, "     Bound services:{}")
  .replace("     Crashed services:{}", `     Crashed services:{{${component}}}`);
const otherService = "com.example.reader/com.example.reader.ReaderService";
const DEVICE_PREFIX = "adb -s test-device ";
const SETTINGS_PUT = "shell settings put secure enabled_accessibility_services";
const FORCE_STOP = `shell am force-stop ${AndroidCtrlProxyManager.PACKAGE}`;

const testDevice: BootedDevice = {
  deviceId: "test-device",
  platform: "android",
  isEmulator: true,
  name: "Test Device",
};

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: () => false,
  };
}

type Handler = (command: string) => Promise<string | undefined> | string | undefined;

function createHarness(handler: Handler = () => undefined) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const executed: string[] = [];
  const exec = async (full: string): Promise<ExecResult> => {
    const command = full.startsWith(DEVICE_PREFIX) ? full.slice(DEVICE_PREFIX.length) : full;
    executed.push(command);
    const custom = await handler(command);
    if (custom !== undefined) {
      return execResult(custom);
    }
    if (command.includes("dumpsys accessibility")) {
      return execResult(crashedCapture);
    }
    if (command.includes("settings get secure enabled_accessibility_services")) {
      return execResult(`${otherService}:${component}`);
    }
    return execResult("");
  };
  const adb = new AdbClient(testDevice, exec, null, new DefaultRetryExecutor(timer), timer);
  const manager = AndroidCtrlProxyManager.createForTestingWithDeps(testDevice, adb, timer);
  return { manager, executed, timer };
}

const puts = (executed: string[]) => executed.filter((command) => command.startsWith(SETTINGS_PUT));
const readdWrites = (executed: string[]) =>
  puts(executed).filter((command) => command.includes(component));

describe("AndroidCtrlProxyManager rebind cancellation (#10199)", () => {
  beforeEach(() => {
    AndroidCtrlProxyManager.resetInstances();
  });

  test("a caller aborting between the two writes still gets the re-add issued", async () => {
    const caller = new AbortController();
    const cancelled = new Error("caller cancelled");
    const { manager, executed } = createHarness((command) => {
      if (command === FORCE_STOP) {
        caller.abort(cancelled);
        throw new Error("force-stop interrupted");
      }
      return undefined;
    });

    await expect(runWithAbortSignal(caller.signal, () => manager.rebindIfUnhealthy())).rejects.toBe(
      cancelled,
    );

    // removal, then the mandatory restore after the failed force-stop
    expect(puts(executed)).toHaveLength(2);
    expect(readdWrites(executed)).toHaveLength(1);
    expect(executed.indexOf(FORCE_STOP)).toBeLessThan(
      executed.findIndex(
        (command) => command.startsWith(SETTINGS_PUT) && command.includes(component),
      ),
    );
  });

  test("the caller's cancellation is reported only after the restore was attempted", async () => {
    const caller = new AbortController();
    let restoreIssuedAtSettle = false;
    const { manager, executed } = createHarness((command) => {
      if (command === FORCE_STOP) {
        caller.abort(new Error("caller cancelled"));
      }
      return undefined;
    });

    await runWithAbortSignal(caller.signal, () => manager.rebindIfUnhealthy()).catch(() => {
      restoreIssuedAtSettle = readdWrites(executed).length === 1;
    });

    expect(restoreIssuedAtSettle).toBe(true);
  });

  test("an abandoned flight that already removed CtrlProxy skips force-stop but re-adds it and stops", async () => {
    const caller = new AbortController();
    const { manager, executed } = createHarness((command) => {
      if (command === `${SETTINGS_PUT} '${otherService}'`) {
        caller.abort(new Error("caller cancelled"));
      }
      return undefined;
    });

    await expect(
      runWithAbortSignal(caller.signal, () => manager.rebindIfUnhealthy()),
    ).rejects.toThrow("caller cancelled");

    expect(executed).not.toContain(FORCE_STOP);
    expect(readdWrites(executed)).toHaveLength(1);
    // The flight stopped after restoring: no health poll once every waiter left.
    const lastPut = executed.lastIndexOf(readdWrites(executed)[0]);
    expect(executed.slice(lastPut + 1).filter((c) => c.includes("dumpsys"))).toEqual([]);
  });

  test("every caller cancelling stops the flight after restoring, and a fresh call starts a new one", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const { manager, executed } = createHarness((command) => {
      if (command === FORCE_STOP) {
        first.abort(new Error("first cancelled"));
        second.abort(new Error("second cancelled"));
      }
      return undefined;
    });

    const results = await Promise.allSettled([
      runWithAbortSignal(first.signal, () => manager.rebindIfUnhealthy()),
      runWithAbortSignal(second.signal, () => manager.rebindIfUnhealthy()),
    ]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(readdWrites(executed)).toHaveLength(1);
    expect(executed.filter((command) => command === FORCE_STOP)).toHaveLength(1);

    expect(await manager.rebindIfUnhealthy()).toBe(true);
    expect(executed.filter((command) => command === FORCE_STOP)).toHaveLength(2);
  });

  test("a second caller that did not cancel is not failed by the first caller's cancellation", async () => {
    const gate = Promise.withResolvers<void>();
    const first = new AbortController();
    const { manager, executed } = createHarness(async (command) => {
      if (command.includes("dumpsys accessibility")) {
        await gate.promise;
      }
      return undefined;
    });

    const cancelled = runWithAbortSignal(first.signal, () => manager.rebindIfUnhealthy());
    const survivor = runWithAbortSignal(undefined, () => manager.rebindIfUnhealthy());
    first.abort(new Error("first cancelled"));
    await expect(cancelled).rejects.toThrow("first cancelled");

    gate.resolve();
    expect(await survivor).toBe(true);
    expect(executed.filter((command) => command === FORCE_STOP)).toHaveLength(1);
    expect(puts(executed)).toHaveLength(2);
  });

  test("a restore that also fails says the service was left disabled and how it comes back", async () => {
    const { manager, executed } = createHarness((command) => {
      if (command === FORCE_STOP) {
        throw new Error("force-stop failed");
      }
      if (command.startsWith(SETTINGS_PUT) && command.includes(component)) {
        throw new Error("settings unavailable");
      }
      return undefined;
    });

    const error = await manager.rebindIfUnhealthy().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("force-stop failed");
    expect(message).toContain("left disabled");
    expect(message).toContain("next rebind or readiness check");
    expect(readdWrites(executed)).toHaveLength(1);
  });

  test("a re-add write that never returns is bounded by the injected timer", async () => {
    const { manager, timer } = createHarness((command) =>
      command.startsWith(SETTINGS_PUT) && command.includes(component)
        ? new Promise<never>(() => {})
        : undefined,
    );
    const startedAt = timer.now();

    const error = await manager.rebindIfUnhealthy().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect((error as Error).message).toContain("left disabled");
    expect(timer.now() - startedAt).toBeGreaterThanOrEqual(REBIND_MUTATION_COMMAND_TIMEOUT_MS);
  });
});
