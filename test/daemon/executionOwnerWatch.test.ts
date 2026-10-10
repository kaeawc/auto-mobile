import { describe, expect, test } from "bun:test";
import {
  EXECUTION_OWNER_CHECK_INTERVAL_MS,
  ExecutionOwnerWatch,
  type ExecutionOwnerLossReason,
} from "../../src/daemon/executionOwnerWatch";
import { FakeTimer } from "../fakes/FakeTimer";

// #11176: a managed slot proxy must not renew its sessions after its execution owner is gone.

const PARENT = 4100;
const SUPERVISOR = 4200;

function harness(options: { ownerPid?: number; launchParentPid?: number } = {}) {
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
