import { expect, describe, it } from "bun:test";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { ExecResult } from "../../../src/models";

/**
 * Parse-level tests for AdbClient.getDeviceLock (issue #4235). A per-command
 * mock exec returns captured `dumpsys window` / `locksettings get-disabled`
 * output so the parse is pinned deterministically, with no device.
 */
function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s)
  } as unknown as ExecResult;
}

/**
 * Build an AdbClient whose exec returns `window` for the dumpsys-window read and
 * `disabled` for the locksettings read. `throwOn` lets a test fail one command.
 */
function makeClient(opts: {
  window?: string;
  disabled?: string;
  throwOn?: "window" | "locksettings";
}): AdbClient {
  const mockExec = (command: string): Promise<ExecResult> => {
    if (command.includes("dumpsys window")) {
      if (opts.throwOn === "window") {
        return Promise.reject(new Error("window boom"));
      }
      return Promise.resolve(execResult(opts.window ?? ""));
    }
    if (command.includes("locksettings get-disabled")) {
      if (opts.throwOn === "locksettings") {
        return Promise.reject(new Error("locksettings boom"));
      }
      return Promise.resolve(execResult(opts.disabled ?? ""));
    }
    return Promise.resolve(execResult(""));
  };
  return new AdbClient(null, mockExec, null as any);
}

describe("AdbClient.getDeviceLock", () => {
  it("reports a secure lock when the keyguard is showing and no lock is disabled", async () => {
    const client = makeClient({
      window: "  mDreamingLockscreen=true\n  isKeyguardShowing=true",
      disabled: "false"
    });
    const lock = await client.getDeviceLock();
    expect(lock).toEqual({ locked: true, keyguardShowing: true, secure: true });
  });

  it("reports a swipe-only lock (secure=false) when the lock screen is disabled", async () => {
    const client = makeClient({
      window: "isKeyguardShowing=true",
      disabled: "true"
    });
    const lock = await client.getDeviceLock();
    expect(lock).toEqual({ locked: true, keyguardShowing: true, secure: false });
  });

  it("reports unlocked when the keyguard is not showing", async () => {
    const client = makeClient({
      window: "isKeyguardShowing=false",
      disabled: "false"
    });
    const lock = await client.getDeviceLock();
    expect(lock?.locked).toBe(false);
    expect(lock?.keyguardShowing).toBe(false);
  });

  it("leaves secure undefined (not guessed) when locksettings is unavailable", async () => {
    const client = makeClient({
      window: "isKeyguardShowing=true",
      throwOn: "locksettings"
    });
    const lock = await client.getDeviceLock();
    expect(lock?.keyguardShowing).toBe(true);
    expect(lock?.secure).toBeUndefined();
  });

  it("leaves secure undefined when locksettings prints unexpected text", async () => {
    const client = makeClient({
      window: "isKeyguardShowing=true",
      disabled: "Permission denial"
    });
    const lock = await client.getDeviceLock();
    expect(lock?.secure).toBeUndefined();
  });

  it("returns null (lock state unknown) when the keyguard state can't be read", async () => {
    const client = makeClient({ window: "no keyguard field here", disabled: "false" });
    const lock = await client.getDeviceLock();
    expect(lock).toBeNull();
  });

  it("returns null when the dumpsys window read fails", async () => {
    const client = makeClient({ throwOn: "window", disabled: "false" });
    const lock = await client.getDeviceLock();
    expect(lock).toBeNull();
  });
});
