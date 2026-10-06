import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "../../../src/models";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";

/**
 * AdbClient.getDeviceLock against real `dumpsys window policy` captures
 * (test/fixtures/android-window-policy/, taken 2026-10-06 on API 36 emulators,
 * issue #10182). The existing AdbClient-getDeviceLock.test.ts only flips booleans
 * in a templated KeyguardServiceDelegate block; these run the same parser over the
 * whole dump a device actually returns.
 */
const FIXTURES = join(__dirname, "../../fixtures/android-window-policy");
const capture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s) => stdout.includes(s),
  };
}

async function lockFor(dump: string) {
  const commands: string[] = [];
  const client = new AdbClient(null, async (command: string) => {
    commands.push(command);
    return execResult(command.includes("dumpsys window policy") ? dump : "");
  });
  const lock = await client.getDeviceLock();
  return { lock, commands };
}

/** The `KeyguardServiceDelegate` block's own fields, i.e. what the parser is meant to read. */
function keyguardBlock(dump: string): string {
  const start = dump.indexOf("KeyguardServiceDelegate");
  expect(start).toBeGreaterThan(-1);
  const end = dump.indexOf("    Looper state:", start);
  return dump.slice(start, end);
}

const UNLOCKED = [
  "dumpsys-window-policy-unlocked-emulator-5600.txt",
  "dumpsys-window-policy-unlocked-emulator-5602.txt",
];
const ASLEEP = [
  "dumpsys-window-policy-asleep-nokeyguard-emulator-5600.txt",
  "dumpsys-window-policy-asleep-nokeyguard-emulator-5602.txt",
];
const AFTER_WAKE = [
  "dumpsys-window-policy-after-wake-nokeyguard-emulator-5600.txt",
  "dumpsys-window-policy-after-wake-nokeyguard-emulator-5602.txt",
];
const SWIPE_KEYGUARD = "dumpsys-window-policy-swipe-keyguard-showing-emulator-5602.txt";
const ALL = [...UNLOCKED, ...ASLEEP, ...AFTER_WAKE, SWIPE_KEYGUARD];

describe("getDeviceLock over captured `dumpsys window policy` dumps (#10182)", () => {
  it.each(UNLOCKED)("%s: an unlocked, awake device is not locked", async (name) => {
    const { lock, commands } = await lockFor(capture(name));
    expect(lock).toEqual({ locked: false, keyguardShowing: false, secure: false });
    expect(commands).toEqual(["adb shell dumpsys window policy"]);
  });

  it.each(ASLEEP)("%s: asleep with no keyguard showing is not locked", async (name) => {
    const dump = capture(name);
    // The capture really is a sleeping device whose keyguard is enabled but not showing.
    expect(dump).toContain("screenState=SCREEN_STATE_OFF");
    expect(dump).toContain("interactiveState=INTERACTIVE_STATE_SLEEP");
    expect(dump).toContain("deviceHasKeyguard=true");

    const { lock } = await lockFor(dump);

    expect(lock).toEqual({ locked: false, keyguardShowing: false, secure: false });
  });

  it.each(AFTER_WAKE)("%s: waking that device reveals no keyguard", async (name) => {
    const dump = capture(name);
    expect(dump).toContain("interactiveState=INTERACTIVE_STATE_AWAKE");

    const { lock } = await lockFor(dump);

    // Same answer asleep and awake: sleeping alone does not make a keyguard-less device locked.
    expect(lock).toEqual({ locked: false, keyguardShowing: false, secure: false });
  });

  it("a swipe keyguard showing after a fold is locked, not secure and not occluded", async () => {
    const dump = capture(SWIPE_KEYGUARD);
    const block = keyguardBlock(dump);
    expect(block).toContain("showing=true");
    expect(block).toContain("occluded=false");
    expect(block).toContain("secure=false");

    const { lock } = await lockFor(dump);

    expect(lock).toEqual({ locked: true, keyguardShowing: true, secure: false });
  });

  it.each(ALL)(
    "%s: the parsed tokens occur once, inside the KeyguardServiceDelegate block",
    (name) => {
      const dump = capture(name);
      for (const field of ["showing", "occluded", "secure"]) {
        const token = new RegExp(`(?:^|\\s)${field}=(?:true|false)`, "g");
        expect(dump.match(token)).toHaveLength(1);
        expect(keyguardBlock(dump).match(token)).toHaveLength(1);
      }
    },
  );

  it.each(ALL)("%s: the CamelCase look-alikes are present and ignored", async (name) => {
    const dump = capture(name);
    // These share a substring with the parsed fields in the same dump.
    expect(dump).toMatch(/mKeyguardOccluded=/);
    expect(dump).toMatch(/mIsShowing=/);
    expect(dump).toMatch(/mSimSecure=/);

    const { lock } = await lockFor(dump);

    const showing = /(?:^|\s)showing=(true|false)/.exec(dump)?.[1] === "true";
    expect(lock?.keyguardShowing).toBe(showing);
    expect(lock?.locked).toBe(showing);
  });
});
