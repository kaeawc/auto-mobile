import { describe, expect, test } from "bun:test";
import {
  EXECUTION_OWNER_CHECK_INTERVAL_MS,
  ExecutionOwnerWatch,
  type ExecutionOwnerLossReason,
} from "../../src/daemon/executionOwnerWatch";
import { FakeLockOwnerGenerationProbe } from "../fakes/FakeLockOwnerGenerationProbe";
import { FakeTimer } from "../fakes/FakeTimer";

// #11176: a managed slot proxy must not renew its sessions after its execution owner is gone.

const PARENT = 4100;
const SUPERVISOR = 4200;

function harness(
  options: {
    ownerPid?: number;
    launchParentPid?: number;
    ownerGenerationToken?: string;
    generationCheckEvery?: number;
  } = {},
  generation?: FakeLockOwnerGenerationProbe,
) {
  const timer = new FakeTimer();
  const running = new Set([1, PARENT, SUPERVISOR]);
  let parent = options.launchParentPid ?? PARENT;
  const losses: { at: number; reason: ExecutionOwnerLossReason }[] = [];
  const watch = new ExecutionOwnerWatch(
    {
      launchParentPid: PARENT,
      ...options,
      onOwnerLost: (reason) => {
        losses.push({ at: timer.now(), reason });
      },
    },
    { isProcessRunning: (pid) => running.has(pid), currentParentPid: () => parent },
    timer,
    generation,
  );
  return {
    timer,
    watch,
    losses,
    kill: (pid: number) => running.delete(pid),
    reparent: (pid: number) => {
      parent = pid;
    },
  };
}

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("ExecutionOwnerWatch", () => {
  test("a live owner is never reported lost", async () => {
    const { timer, watch, losses } = harness();
    watch.start();
    timer.advanceTime(10 * EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(losses).toEqual([]);
    watch.stop();
  });

  test("owner death is reported within one check interval, exactly once", async () => {
    const { timer, watch, losses, kill } = harness();
    watch.start();
    timer.advanceTime(500);
    kill(PARENT);
    for (let tick = 0; tick < 5; tick++) {
      timer.advanceTime(EXECUTION_OWNER_CHECK_INTERVAL_MS / 2);
      await settle();
    }

    expect(losses).toEqual([{ at: EXECUTION_OWNER_CHECK_INTERVAL_MS, reason: "owner-exited" }]);
    expect(watch.lossReason).toBe("owner-exited");
    expect(EXECUTION_OWNER_CHECK_INTERVAL_MS).toBeLessThanOrEqual(2_000);
  });

  test("re-parenting (the launching parent died, init adopted us) counts as owner loss", async () => {
    const { timer, watch, losses, reparent } = harness();
    watch.start();
    reparent(1);
    timer.advanceTime(EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(losses.map((loss) => loss.reason)).toEqual(["parent-changed"]);
  });

  test("a proxy launched already orphaned (parent pid 1) is lost at the first check (#11232)", async () => {
    const { watch, losses } = harness({ launchParentPid: 1 });
    watch.start();
    await settle();
    expect(losses.map((loss) => loss.reason)).toEqual(["parent-changed"]);
  });

  test("a live explicit owner keeps a PID-1-launched proxy running (#11287)", async () => {
    const { timer, watch, losses } = harness({ launchParentPid: 1, ownerPid: SUPERVISOR });
    watch.start();
    timer.advanceTime(3 * EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(losses).toEqual([]);
  });

  test("a declared owner pid is watched besides the parent", async () => {
    const { timer, watch, losses, kill } = harness({ ownerPid: SUPERVISOR });
    watch.start();
    kill(SUPERVISOR);
    timer.advanceTime(EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(losses.map((loss) => loss.reason)).toEqual(["owner-exited"]);
  });

  test("a live parent does not mask the declared owner's death, and a live owner is not lost", async () => {
    const { timer, watch, losses, kill } = harness({ ownerPid: SUPERVISOR });
    watch.start();
    timer.advanceTime(3 * EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(losses).toEqual([]);
    kill(SUPERVISOR);
    timer.advanceTime(EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(losses.map((loss) => loss.reason)).toEqual(["owner-exited"]);
  });

  test("an explicit live owner outlives a re-parent: the wrapper exiting does not end the execution (#11342)", async () => {
    const { timer, watch, losses, reparent, kill } = harness({ ownerPid: SUPERVISOR });
    watch.start();
    reparent(1);
    timer.advanceTime(3 * EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(losses).toEqual([]);
    kill(SUPERVISOR);
    timer.advanceTime(EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(losses.map((loss) => loss.reason)).toEqual(["owner-exited"]);
  });

  test("an owner already gone at launch is caught by the first check", async () => {
    const { watch, losses, kill } = harness();
    kill(PARENT);
    watch.start();
    await settle();
    expect(losses).toEqual([{ at: 0, reason: "owner-exited" }]);
  });

  test("a failing release callback does not escape the watch", async () => {
    const timer = new FakeTimer();
    const watch = new ExecutionOwnerWatch(
      {
        launchParentPid: PARENT,
        onOwnerLost: async () => {
          throw new Error("daemon gone");
        },
      },
      { isProcessRunning: () => false, currentParentPid: () => PARENT },
      timer,
    );
    expect(watch.check()).toBe("owner-exited");
    await settle();
    expect(watch.check()).toBe("owner-exited");
  });
});

describe("ExecutionOwnerWatch process generation", () => {
  test.each([undefined, SUPERVISOR])(
    "a live reused PID is lost exactly once (owner %s)",
    async (ownerPid) => {
      const generation = new FakeLockOwnerGenerationProbe();
      const { timer, watch, losses } = harness({ ownerPid }, generation);
      watch.start();
      expect(generation.currentCalls).toEqual([ownerPid ?? PARENT]);
      expect(generation.compareCalls).toHaveLength(0);
      generation.verdict = "different";
      timer.advanceTime(5 * EXECUTION_OWNER_CHECK_INTERVAL_MS);
      await settle();
      expect(losses).toHaveLength(1);
      expect(losses[0].reason).toBe("owner-exited");
      expect(losses[0].at).toBeLessThanOrEqual(5 * EXECUTION_OWNER_CHECK_INTERVAL_MS);
      timer.advanceTime(10 * EXECUTION_OWNER_CHECK_INTERVAL_MS);
      await settle();
      expect(losses).toHaveLength(1);
    },
  );

  test.each(["unknown", "throws", "capture-throws", "same"])(
    "a live PID stays trusted when generation is %s",
    async (kind) => {
      const generation = new FakeLockOwnerGenerationProbe();
      if (kind === "throws") {
        generation.compareError = new Error("unreadable");
      }
      if (kind === "capture-throws") {
        generation.currentError = new Error("unreadable");
      }
      if (kind === "same") {
        generation.verdict = "same";
      }
      const { timer, watch, losses } = harness({ ownerPid: SUPERVISOR }, generation);
      watch.start();
      timer.advanceTime(20 * EXECUTION_OWNER_CHECK_INTERVAL_MS);
      await settle();
      expect(losses).toEqual([]);
      watch.stop();
    },
  );

  test("compares the supplied startup token without capturing another", () => {
    const generation = new FakeLockOwnerGenerationProbe();
    const { timer, watch } = harness(
      { ownerPid: SUPERVISOR, ownerGenerationToken: "startup" },
      generation,
    );
    watch.start();
    timer.advanceTime(5 * EXECUTION_OWNER_CHECK_INTERVAL_MS);
    expect(generation.currentCalls).toEqual([]);
    expect(generation.compareCalls).toEqual([{ pid: SUPERVISOR, recorded: "startup" }]);
    watch.stop();
  });

  test("generation comparison costs at most one per five checks; PID death takes one interval", async () => {
    const generation = new FakeLockOwnerGenerationProbe();
    const { timer, watch, losses, kill } = harness({}, generation);
    watch.start();
    for (let check = 1; check <= 16; check++) {
      timer.advanceTime(EXECUTION_OWNER_CHECK_INTERVAL_MS);
      expect(generation.compareCalls).toHaveLength(Math.floor((check + 1) / 5));
    }
    kill(PARENT);
    timer.advanceTime(EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(losses).toEqual([
      { at: 17 * EXECUTION_OWNER_CHECK_INTERVAL_MS, reason: "owner-exited" },
    ]);
  });
});

describe("ExecutionOwnerWatch generation cadence and recapture", () => {
  test("cheap identity reads detect reuse at the next interval exactly once", async () => {
    const generation = new FakeLockOwnerGenerationProbe();
    generation.verdict = "same";
    const { timer, watch, losses } = harness(
      { ownerPid: SUPERVISOR, generationCheckEvery: 1 },
      generation,
    );
    watch.start();
    expect(generation.compareCalls).toHaveLength(1);
    generation.verdict = "different";
    timer.advanceTime(EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(losses).toEqual([{ at: EXECUTION_OWNER_CHECK_INTERVAL_MS, reason: "owner-exited" }]);
    timer.advanceTime(10 * EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(losses).toHaveLength(1);
  });

  test.each([undefined, 0, -1, 1.5, NaN, Infinity])(
    "cadence %s uses the fifth-check fallback",
    async (generationCheckEvery) => {
      const generation = new FakeLockOwnerGenerationProbe();
      const { timer, watch, losses } = harness({ generationCheckEvery }, generation);
      watch.start(); // Startup is check 1.
      generation.verdict = "different";
      timer.advanceTime(3 * EXECUTION_OWNER_CHECK_INTERVAL_MS);
      await settle();
      expect(losses).toEqual([]);
      expect(generation.compareCalls).toEqual([]);
      timer.advanceTime(EXECUTION_OWNER_CHECK_INTERVAL_MS);
      await settle();
      expect(losses).toEqual([
        { at: 4 * EXECUTION_OWNER_CHECK_INTERVAL_MS, reason: "owner-exited" },
      ]);
    },
  );

  test("recaptures an initially unreadable token and compares only on the following check", async () => {
    const generation = new FakeLockOwnerGenerationProbe();
    generation.token = undefined;
    const { timer, watch, losses } = harness(
      { ownerPid: SUPERVISOR, generationCheckEvery: 1 },
      generation,
    );
    watch.start();
    const startupReads = generation.currentCalls.length;
    generation.token = "darwin-utc:Thu Oct 1 07:45:41 2026";
    generation.verdict = "different";
    timer.advanceTime(EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(generation.currentCalls.length).toBe(startupReads + 1);
    expect(generation.compareCalls).toEqual([]);
    expect(losses).toEqual([]);
    timer.advanceTime(EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(generation.compareCalls).toEqual([{ pid: SUPERVISOR, recorded: generation.token }]);
    expect(losses).toEqual([{ at: 2 * EXECUTION_OWNER_CHECK_INTERVAL_MS, reason: "owner-exited" }]);
  });

  test("a permanently unreadable token keeps PID-only liveness and stops on PID death", async () => {
    const generation = new FakeLockOwnerGenerationProbe();
    generation.token = undefined;
    const { timer, watch, losses, kill } = harness({ generationCheckEvery: 1 }, generation);
    watch.start();
    timer.advanceTime(3 * EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(generation.currentCalls).toEqual([PARENT, PARENT, PARENT, PARENT, PARENT]);
    expect(generation.compareCalls).toEqual([]);
    expect(losses).toEqual([]);
    const reads = generation.currentCalls.length;
    kill(PARENT);
    timer.advanceTime(EXECUTION_OWNER_CHECK_INTERVAL_MS);
    await settle();
    expect(generation.currentCalls).toHaveLength(reads);
    expect(losses).toEqual([{ at: 4 * EXECUTION_OWNER_CHECK_INTERVAL_MS, reason: "owner-exited" }]);
  });
});
