import type { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import { describe, expect, test } from "bun:test";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

/**
 * The scenario driver each implementation supplies. The real AdbClient is driven by stubbing
 * its process execution; the fake by its scripting methods. Scenarios only use this surface, so
 * both run the same assertions.
 */
export interface ScriptedAdb {
  adb: AdbExecutor & Pick<AdbClient, "getAndroidApiLevel">;
  /** Make every command containing `pattern` succeed with this output. */
  script(pattern: string, output: { stdout: string; stderr?: string }): void;
  /** Make every command containing `pattern` fail with this error. */
  scriptFailure(pattern: string, error: Error): void;
  scriptApiLevel(level: number | null): void;
  scriptWakefulness(state: "Awake" | "Asleep" | "Dozing"): void;
  /** The device answers `date +%s%3N`. */
  scriptDeviceTimeMs(timestampMs: number): void;
  /** The device only answers the second-resolution `date +%s`. */
  scriptDeviceTimeSeconds(seconds: number): void;
  /** The device answers neither clock read. */
  scriptDeviceTimeUnavailable(): void;
  dispose?: () => Promise<void> | void;
}

/**
 * Shared behavioural contract for {@link AdbExecutor} (#11868): the scripted fake and the real
 * AdbClient over stubbed process execution agree on command results, failures, cancellation and
 * the parsed device reads that tests script most.
 */
export function runAdbExecutorContract(
  name: string,
  make: () => Promise<ScriptedAdb> | ScriptedAdb,
): void {
  const withAdb = async (body: (scripted: ScriptedAdb) => Promise<void>): Promise<void> => {
    const scripted = await make();
    try {
      await body(scripted);
    } finally {
      await scripted.dispose?.();
    }
  };

  describe(`AdbExecutor contract: ${name}`, () => {
    test("executeCommand returns the scripted output with working string helpers", () =>
      withAdb(async (scripted) => {
        scripted.script("echo hello", { stdout: "  hello\n", stderr: "warn" });
        const result = await scripted.adb.executeCommand("shell echo hello");
        expect(result.stdout).toBe("  hello\n");
        expect(result.stderr).toBe("warn");
        expect(result.toString()).toBe("  hello\n");
        expect(result.trim()).toBe("hello");
        expect(result.includes("hello")).toBe(true);
        expect(result.includes("absent")).toBe(false);
      }));

    test("execute(argv) behaves like executeCommand of the joined arguments", () =>
      withAdb(async (scripted) => {
        scripted.script("echo hello", { stdout: "hello\n" });
        const result = await scripted.adb.execute(["shell", "echo", "hello"]);
        expect(result.stdout).toBe("hello\n");
      }));

    test("a failing command rejects with its error", () =>
      withAdb(async (scripted) => {
        scripted.scriptFailure("boom", new Error("device offline"));
        await expect(scripted.adb.executeCommand("shell boom")).rejects.toThrow("device offline");
      }));

    test("a command handed an already-aborted signal does not return a result", () =>
      withAdb(async (scripted) => {
        scripted.script("echo hello", { stdout: "hello\n" });
        const controller = new AbortController();
        controller.abort();
        await expect(
          scripted.adb.executeCommand("shell echo hello", { signal: controller.signal }),
        ).rejects.toBeDefined();
      }));

    test("getAndroidApiLevel parses the sdk property and reports unknown as null", () =>
      withAdb(async (scripted) => {
        scripted.scriptApiLevel(34);
        expect(await scripted.adb.getAndroidApiLevel()).toBe(34);
      }));

    test("getAndroidApiLevel is null when the property is unreadable", () =>
      withAdb(async (scripted) => {
        scripted.scriptApiLevel(null);
        expect(await scripted.adb.getAndroidApiLevel()).toBeNull();
      }));

    test.each(["Awake", "Asleep", "Dozing"] as const)("wakefulness %s drives isScreenOn", (state) =>
      withAdb(async (scripted) => {
        scripted.scriptWakefulness(state);
        expect(await scripted.adb.getWakefulness()).toBe(state);
        expect(await scripted.adb.isScreenOn()).toBe(state === "Awake");
      }),
    );

    test("the device clock reports its precision", () =>
      withAdb(async (scripted) => {
        scripted.scriptDeviceTimeMs(1_700_000_123_456);
        expect(await scripted.adb.getDeviceTimestampMsWithSource()).toEqual({
          timestampMs: 1_700_000_123_456,
          source: "device-ms",
        });
      }));

    test("a seconds-only device clock is scaled to milliseconds", () =>
      withAdb(async (scripted) => {
        scripted.scriptDeviceTimeSeconds(1_700_000_123);
        expect(await scripted.adb.getDeviceTimestampMsWithSource()).toEqual({
          timestampMs: 1_700_000_123_000,
          source: "device-seconds",
        });
      }));

    test("an unreadable device clock falls back to the host clock", () =>
      withAdb(async (scripted) => {
        scripted.scriptDeviceTimeUnavailable();
        const result = await scripted.adb.getDeviceTimestampMsWithSource();
        expect(result.source).toBe("host");
        expect(Number.isSafeInteger(result.timestampMs)).toBe(true);
        expect(result.timestampMs).toBeGreaterThan(0);
      }));
  });
}
