import { beforeAll, expect, test } from "bun:test";
import {
  runSlotAgreement,
  assertSlotAgreement,
  slotAgreementRig,
  type SlotAgreementRun,
} from "../helpers/sessionSlotAgreementHarness";
import { SESSION_RELEASE_TEARDOWN_CAP_MS } from "../../src/daemon/sessionManager";
import { deriveSlot } from "../../src/daemon/sessionSlots";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { SeededRandom } from "../fakes/SeededRandom";

// Pinned to this generator: covers overlapping release, rebind, reissue and expiry windows.
const REGRESSION_SEEDS = [1, 7, 12, 27, 122, 238, 27666, 97677];
const SEEDS = [...new Set([...REGRESSION_SEEDS, ...Array.from({ length: 24 }, (_, i) => i + 1)])];
const results = new Map<number, SlotAgreementRun>();

beforeAll(async () => {
  for (const seed of SEEDS) {
    results.set(seed, await runSlotAgreement(seed));
  }
});

test.each(SEEDS)("real manager agrees at every checkpoint for seed %d", (seed) => {
  const result = results.get(seed)!;
  expect(result.violations).toEqual([]);
  expect(result.incarnations).toBeGreaterThanOrEqual(3);
});

test("seed corpus exercises each operation, forced removal, residue and real rehydration", () => {
  const observed = new Set([...results.values()].flatMap((run) => run.observed));
  for (const event of [
    "create",
    "rebind",
    "graceful",
    "force",
    "forced",
    "supersede",
    "reissue",
    "expiry",
    "shutdown",
    "restart",
    "rehydrated",
    "residue",
    "orphan-release",
  ]) {
    expect(observed.has(event)).toBe(true);
  }
});

const RELEASE_SEEDS = [7, 27, 122];
const releaseRuns = new Map<string, { violations: string[]; observed: string[] }>();

beforeAll(async () => {
  for (const seed of RELEASE_SEEDS) {
    for (const kind of ["forced", "stuck"] as const) {
      releaseRuns.set(`${seed}-${kind}`, await runReleaseAgreement(seed, kind));
    }
  }
});

async function runReleaseAgreement(seed: number, kind: "forced" | "stuck") {
  const random = new SeededRandom(seed);
  const teardown = Promise.withResolvers<void>();
  let teardownStarted = false;
  const rig = slotAgreementRig(undefined, undefined, undefined, () => ({
    restore: async () => {
      teardownStarted = true;
      await teardown.promise;
      return { status: "restored" as const };
    },
  }));
  const uuid = `release-${seed}`;
  const session = await rig.manager.createSession(uuid, `device-${uuid}`, "android");
  const identities = [session];
  const observed = new Set<string>();
  const violations: string[] = [];
  const check = (event: string) => {
    observed.add(event);
    try {
      assertSlotAgreement(rig, [uuid], identities, event);
    } catch (error) {
      violations.push(errorMessage(error));
    }
  };
  const turns = async () => {
    for (let i = 0; i < 80; i++) {
      await Promise.resolve();
      check("microtask");
    }
  };
  const slots = Reflect.get(rig.manager, "sessionSlots") as ReleaseStore;
  const view = rig.manager.getLegacyLifecycleView();
  const hold = Promise.withResolvers<"teardown">();
  if (kind === "forced") {
    rig.manager.setReleaseDeviceHold(() => ({ settled: hold.promise, capMs: 10_000 }));
  } else {
    rig.manager.setKeepScreenAwake(uuid, { applied: true });
  }
  const reason = random.pick(["plan-auto-release", "daemon-shutdown"]);
  const release = rig.manager.releaseSession(uuid, reason);
  const op = view.releaseOps.get(uuid)!;
  check("release-start");
  await turns();
  expect(rig.manager.forceStuckRelease(uuid)).toBeDefined();
  expect(slots.hasForcedNonTerminal(session)).toBe(true);
  expect(slots.getForcedNonTerminal(session)).toMatchObject({ releaseReason: reason });
  expect(slots.activeReleases.has(op)).toBe(true);
  expect(view.sessions.has(uuid)).toBe(false);
  expect(deriveSlot(view, uuid).residue).toBe(true);
  check("forced-snapshot-and-active-op");
  await rig.timer.advanceTimeAsync(SESSION_RELEASE_TEARDOWN_CAP_MS, turns);
  await turns();
  if (kind === "forced") {
    // An ownership wait has no deadline: forcing unpublishes, but its continuation still owns
    // both bookkeeping entries and the WeakSet mark until the hold actually resolves.
    expect(view.releaseOps.get(uuid)).toBe(op);
    expect(slots.activeReleases.has(op)).toBe(true);
    expect(view.isReleasing(session)).toBe(true);
    check("indefinitely-stuck-residue");
    hold.resolve("teardown");
    await release;
  } else {
    expect(teardownStarted).toBe(true);
    // The restorer never resolves. Its bounded release can finish and the UUID can be reused.
    await release;
    const reincarnated = await rig.manager.createSession(uuid, `next-${uuid}`, "android");
    identities.push(reincarnated);
    expect(reincarnated).not.toBe(session);
    expect(slots.hasForcedNonTerminal(reincarnated)).toBe(false);
    expect(slots.hasForcedNonTerminal(session)).toBe(true);
    expect(view.releaseOps.has(uuid)).toBe(false);
    expect(view.isReleasing(reincarnated)).toBe(false);
    check("reincarnated-with-unsettled-teardown");
    await rig.manager.releaseSession(uuid, "plan-auto-release");
  }
  expect(view.releaseOps.has(uuid)).toBe(false);
  expect(view.isReleasing(session)).toBe(false);
  expect(slots.activeReleases.has(op)).toBe(false);
  check("settled");
  expect(rig.timer.getSleepHistory()).toEqual([]);
  rig.timer.reset();
  return { violations, observed: [...observed] };
}

interface ReleaseStore {
  readonly activeReleases: ReadonlySet<object>;
  hasForcedNonTerminal(session: object): boolean;
  getForcedNonTerminal(session: object): object | undefined;
}

for (const kind of ["forced", "stuck"] as const) {
  test.each(RELEASE_SEEDS)(`${kind} release agrees across seeded checkpoints %d`, (seed) => {
    const result = releaseRuns.get(`${seed}-${kind}`)!;
    expect(result.violations).toEqual([]);
    expect(result.observed).toContain("forced-snapshot-and-active-op");
    expect(result.observed).toContain("settled");
    expect(result.observed).toContain(
      kind === "forced" ? "indefinitely-stuck-residue" : "reincarnated-with-unsettled-teardown",
    );
  });
}
