import { describe, expect, test } from "bun:test";
import type { EmulatorConsoleBusyRegistry } from "../../src/utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";

/**
 * Shared behavioural contract for {@link EmulatorConsoleBusyRegistry} (#11868): the fake and
 * InMemoryEmulatorConsoleBusyRegistry agree on busy marking, generations and overlapping
 * console-exclusive operations on one serial.
 */
export function runEmulatorConsoleBusyRegistryContract(
  name: string,
  make: () => EmulatorConsoleBusyRegistry,
): void {
  const A = "emulator-5554";
  const B = "emulator-5556";

  describe(`EmulatorConsoleBusyRegistry contract: ${name}`, () => {
    test("a fresh registry is idle at generation zero", () => {
      const registry = make();
      expect(registry.isBusy(A)).toBe(false);
      expect(registry.getGeneration(A)).toBe(0);
    });

    test("runExclusive marks the serial busy only while the task runs and returns its result", async () => {
      const registry = make();
      let busyDuring = false;
      const result = await registry.runExclusive(A, async () => {
        busyDuring = registry.isBusy(A);
        return "done";
      });
      expect(result).toBe("done");
      expect(busyDuring).toBe(true);
      expect(registry.isBusy(A)).toBe(false);
    });

    test("a rejected task propagates and still clears busy", async () => {
      const registry = make();
      await expect(
        registry.runExclusive(A, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(registry.isBusy(A)).toBe(false);
    });

    test("the generation changes when an operation starts and again when it settles", async () => {
      const registry = make();
      let duringStart = -1;
      await registry.runExclusive(A, async () => {
        duringStart = registry.getGeneration(A);
      });
      expect(duringStart).toBeGreaterThan(0);
      expect(registry.getGeneration(A)).toBeGreaterThan(duringStart);
    });

    test("serials are isolated from each other", async () => {
      const registry = make();
      let otherBusy = true;
      await registry.runExclusive(A, async () => {
        otherBusy = registry.isBusy(B);
      });
      expect(otherBusy).toBe(false);
      expect(registry.getGeneration(B)).toBe(0);
    });

    test("overlapping operations keep the serial busy until the last one settles", async () => {
      const registry = make();
      let releaseOuter: () => void = () => undefined;
      const outerGate = new Promise<void>((resolve) => {
        releaseOuter = resolve;
      });
      let outerStarted: () => void = () => undefined;
      const outerRunning = new Promise<void>((resolve) => {
        outerStarted = resolve;
      });
      const outer = registry.runExclusive(A, async () => {
        outerStarted();
        await outerGate;
      });
      await outerRunning;
      await registry.runExclusive(A, async () => undefined);
      expect(registry.isBusy(A)).toBe(true);
      releaseOuter();
      await outer;
      expect(registry.isBusy(A)).toBe(false);
    });
  });
}
