import { describe, expect, test } from "bun:test";
import {
  runDirectModeStartup,
  type DirectModeStartupSteps,
} from "../../src/daemon/directModeStartup";

/**
 * Fake direct-mode steps that record call order with no real guard or DB touch.
 * Exercises the #2871 stretch AC — the direct-mode ordering invariant (guard runs
 * before the first DB touch, only under noProxy) is unit-tested directly instead
 * of only by reading src/index.ts (there is no main() test harness).
 */
function recordingSteps(
  noProxy: boolean,
  overrides: Partial<DirectModeStartupSteps> = {},
): { steps: DirectModeStartupSteps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      noProxy,
      assertDbOwnership: async () => {
        calls.push("assertDbOwnership");
      },
      applyFeatureFlagStartup: async () => {
        calls.push("applyFeatureFlagStartup");
      },
      ...overrides,
    },
  };
}

describe("runDirectModeStartup", () => {
  test("runs the ownership guard BEFORE the first DB touch under --no-proxy", async () => {
    const { steps, calls } = recordingSteps(true);

    await runDirectModeStartup(steps);

    expect(calls).toEqual(["assertDbOwnership", "applyFeatureFlagStartup"]);
  });

  test("keeps proxy startup clear of a contended feature-flag database", async () => {
    const { steps, calls } = recordingSteps(false, {
      applyFeatureFlagStartup: async () => {
        calls.push("applyFeatureFlagStartup");
        throw new Error("SQLITE_BUSY: database is locked");
      },
    });

    await runDirectModeStartup(steps);

    // The daemon owns feature-flag initialization in proxy mode. Skipping the
    // proxy process's DB touch lets it connect its stdio transport even when
    // another writer is temporarily holding the shared database.
    expect(calls).toEqual([]);
  });

  test("does not touch the DB when the guard refuses (guard throws)", async () => {
    const calls: string[] = [];
    const refusal = new Error("a live daemon already owns this DB");

    await expect(
      runDirectModeStartup({
        noProxy: true,
        assertDbOwnership: async () => {
          calls.push("assertDbOwnership");
          throw refusal;
        },
        applyFeatureFlagStartup: async () => {
          calls.push("applyFeatureFlagStartup");
        },
      }),
    ).rejects.toBe(refusal);

    // Feature-flag startup (the first DB touch) must never run once the guard
    // refuses — otherwise a second writer opens the daemon-owned SQLite file.
    expect(calls).toEqual(["assertDbOwnership"]);
  });

  test("awaits the guard to settle before the DB touch", async () => {
    const calls: string[] = [];
    let guardResolved = false;

    await runDirectModeStartup({
      noProxy: true,
      assertDbOwnership: async () => {
        await Promise.resolve();
        guardResolved = true;
        calls.push("assertDbOwnership");
      },
      applyFeatureFlagStartup: async () => {
        expect(guardResolved).toBe(true);
        calls.push("applyFeatureFlagStartup");
      },
    });

    expect(calls).toEqual(["assertDbOwnership", "applyFeatureFlagStartup"]);
  });
});
