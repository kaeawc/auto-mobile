import { describe, test } from "bun:test";
import {
  assertTwoDaemonInvariants,
  twoDaemonSeedOverride,
  type TwoDaemonProfile,
  type TwoDaemonViolationKind,
} from "../helpers/twoDaemonOwnershipHarness";

// Seeded cross-daemon ownership properties: two daemons sharing one database, adb server, claim
// files and data directory (see twoDaemonOwnershipHarness.ts for the steps and invariants). CI runs
// the fixed seeds below, a few per test so each stays inside the 100 ms budget. Widen locally with
// AUTOMOBILE_TWO_DAEMON_SEEDS (how many) and AUTOMOBILE_TWO_DAEMON_SEED_BASE (first seed), e.g.
//   AUTOMOBILE_TWO_DAEMON_SEEDS=2000 bun test test/daemon/poolOwnershipConcurrency.twoDaemon.property.test.ts
// AUTOMOBILE_TWO_DAEMON_TRACE=1 streams the trace live, for a seed that hangs.
//
// Known, open bugs (#11200) with minimized regressions in
// poolOwnershipConcurrency.twoDaemon.regressions.test.ts are tolerated; the fix for each removes
// its kinds here so the property is enforced again.
const KNOWN_VIOLATIONS: ReadonlySet<TwoDaemonViolationKind> = new Set<TwoDaemonViolationKind>([
  // Concurrent startups both rehydrate one recoverable row; the loser terminalizes the winner's.
  "foreign-session-revived",
  "live-row-not-owned",
]);

const STEPS = 30;
const SEEDS_PER_TEST = 3;
const TESTS_PER_PROFILE = 3;

const PROFILES: Record<string, TwoDaemonProfile> = {
  /** Wedged terminal writes, crashes and restarts: journal adoption and startup sweeps. */
  journal: {
    steps: STEPS,
    weights: {
      acquire: 6,
      acquireAny: 2,
      release: 5,
      control: 2,
      advance: 3,
      monitorTick: 2,
      wedge: 5,
      unwedge: 2,
      crash: 4,
      stop: 2,
      start: 6,
      settle: 3,
    },
  },
  contention: {
    steps: STEPS,
    weights: {
      acquire: 8,
      acquireAny: 3,
      release: 4,
      control: 3,
      advance: 3,
      monitorTick: 2,
      kill: 2,
      disconnect: 1,
      reconnect: 3,
      settle: 4,
    },
  },
  restarts: {
    steps: STEPS,
    weights: {
      acquire: 7,
      acquireAny: 2,
      release: 3,
      control: 3,
      loseHeartbeat: 2,
      resumeHeartbeat: 2,
      advance: 4,
      monitorTick: 2,
      cleanupSweep: 1,
      wedge: 2,
      unwedge: 1,
      crash: 2,
      stop: 1,
      start: 4,
      settle: 3,
    },
  },
};

/** A local sweep runs many seeds in one test; the checked-in seeds keep the default timeout. */
const SWEEP_TIMEOUT_MS = twoDaemonSeedOverride() ? 1_800_000 : undefined;

function seedChunks(firstSeed: number): number[][] {
  const sweep = twoDaemonSeedOverride();
  if (sweep) {
    return [sweep];
  }
  return Array.from({ length: TESTS_PER_PROFILE }, (_, chunk) =>
    Array.from({ length: SEEDS_PER_TEST }, (_, i) => firstSeed + chunk * SEEDS_PER_TEST + i),
  );
}

describe("two daemons sharing one database, adb server, claims and data directory", () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    for (const seeds of seedChunks(1)) {
      test(
        `${name}: seeds ${seeds[0]}-${seeds.at(-1)} keep every cross-daemon invariant`,
        async () => {
          await assertTwoDaemonInvariants(seeds, profile, { tolerate: KNOWN_VIOLATIONS });
        },
        SWEEP_TIMEOUT_MS,
      );
    }
  }
});
