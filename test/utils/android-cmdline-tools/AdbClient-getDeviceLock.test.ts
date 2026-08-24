import { expect, describe, it } from "bun:test";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { ExecResult } from "../../../src/models";

/**
 * Parse-level tests for AdbClient.getDeviceLock (issue #4235). The fixture is the
 * real `dumpsys window policy` KeyguardServiceDelegate block captured from an
 * API 35 emulator; individual booleans are flipped to model the other lock
 * states. Verified against a live device: a PIN-secured device reports
 * `secure=true`, so `locksettings get-disabled` (the first implementation) was
 * replaced because it cannot separate a swipe lock from a PIN.
 */
function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  } as unknown as ExecResult;
}

/** Real KeyguardServiceDelegate block with the three parsed booleans templated. */
function policyDump(opts: { showing?: string; occluded?: string; secure?: string }): string {
  return [
    "  Keyguard occluded state:",
    `    mKeyguardOccluded=false mKeyguardOccludedChanged=false`,
    "    KeyguardServiceDelegate",
    ...(opts.showing === undefined ? [] : [`      showing=${opts.showing}`]),
    "      inputRestricted=false",
    ...(opts.occluded === undefined ? [] : [`      occluded=${opts.occluded}`]),
    ...(opts.secure === undefined ? [] : [`      secure=${opts.secure}`]),
    "      dreaming=false",
    "      deviceHasKeyguard=true",
    "      KeyguardStateMonitor",
    "        mIsShowing=true",
    "        mSimSecure=false",
  ].join("\n");
}

function makeClient(policyStdout: string | { throws: true }): AdbClient {
  const mockExec = (command: string): Promise<ExecResult> => {
    if (command.includes("dumpsys window policy")) {
      if (typeof policyStdout === "object") {
        return Promise.reject(new Error("dumpsys boom"));
      }
      return Promise.resolve(execResult(policyStdout));
    }
    return Promise.resolve(execResult(""));
  };
  return new AdbClient(null, mockExec, null as any);
}

describe("AdbClient.getDeviceLock", () => {
  it("reports a secure lock when the keyguard is showing and secure=true", async () => {
    const client = makeClient(policyDump({ showing: "true", occluded: "false", secure: "true" }));
    const lock = await client.getDeviceLock();
    expect(lock).toEqual({ locked: true, keyguardShowing: true, secure: true });
  });

  it("reports a swipe-only lock (secure=false) — the case get-disabled could not distinguish", async () => {
    const client = makeClient(policyDump({ showing: "true", occluded: "false", secure: "false" }));
    const lock = await client.getDeviceLock();
    expect(lock).toEqual({ locked: true, keyguardShowing: true, secure: false });
  });

  it("reports unlocked when the keyguard is not showing", async () => {
    const client = makeClient(policyDump({ showing: "false", occluded: "false", secure: "true" }));
    const lock = await client.getDeviceLock();
    expect(lock?.locked).toBe(false);
    expect(lock?.keyguardShowing).toBe(false);
  });

  it("treats an occluded keyguard as not locking the app (locked=false, still showing)", async () => {
    const client = makeClient(policyDump({ showing: "true", occluded: "true", secure: "true" }));
    const lock = await client.getDeviceLock();
    expect(lock?.locked).toBe(false);
    expect(lock?.keyguardShowing).toBe(true);
  });

  it("leaves secure undefined (not guessed) when the secure field is absent", async () => {
    const client = makeClient(policyDump({ showing: "true", occluded: "false" }));
    const lock = await client.getDeviceLock();
    expect(lock?.keyguardShowing).toBe(true);
    expect(lock?.secure).toBeUndefined();
  });

  it("does not confuse the CamelCase siblings (mSimSecure / mKeyguardOccluded / mIsShowing)", async () => {
    // secure=true present, but mSimSecure=false also in the dump; must read secure=true.
    const client = makeClient(policyDump({ showing: "true", occluded: "false", secure: "true" }));
    const lock = await client.getDeviceLock();
    expect(lock?.secure).toBe(true);
  });

  it("returns null (lock state unknown) when the keyguard showing field is absent", async () => {
    const client = makeClient(policyDump({ occluded: "false", secure: "true" }));
    const lock = await client.getDeviceLock();
    expect(lock).toBeNull();
  });

  it("returns null when the dumpsys window policy read fails", async () => {
    const client = makeClient({ throws: true });
    const lock = await client.getDeviceLock();
    expect(lock).toBeNull();
  });
});
