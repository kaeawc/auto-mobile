import { expect, describe, test } from "bun:test";
import { DefaultScreenTransitionWaiter } from "../../../src/features/navigation/DefaultScreenTransitionWaiter";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * A clock whose now() replays a fixed script (last value sticky) and whose
 * sleep() resolves immediately. The waiter polls getCurrentScreen() between
 * now()-gated deadline checks, so scripting now() makes the poll loop fully
 * deterministic and — crucially — guaranteed to terminate (autoAdvance would
 * leave now() pinned at 0 and spin forever against the deadline check).
 */
class ScriptedClock extends FakeTimer {
  private index = 0;
  constructor(private readonly times: number[]) {
    super();
  }
  now(): number {
    const value = this.times[Math.min(this.index, this.times.length - 1)];
    this.index += 1;
    return value;
  }
  async sleep(): Promise<void> {
    // Immediate: the deadline is driven by the scripted now(), not real elapsed time.
  }
}

/** Navigation-graph stub exposing only the method the waiter consumes. */
function stubManager(screens: Array<string | null>): {
  manager: NavigationGraphManager;
  pollCount: () => number;
} {
  let index = 0;
  const manager = {
    getCurrentScreen(): string | null {
      const value = screens[Math.min(index, screens.length - 1)];
      index += 1;
      return value;
    },
  } as unknown as NavigationGraphManager;
  return { manager, pollCount: () => index };
}

describe("DefaultScreenTransitionWaiter", function () {
  test("resolves true on the first poll when already on the target screen", async function () {
    const { manager, pollCount } = stubManager(["TargetScreen"]);
    const waiter = new DefaultScreenTransitionWaiter(manager, 500, new ScriptedClock([0, 250]));

    expect(await waiter.waitForScreen("TargetScreen", 1000)).toBe(true);
    expect(pollCount()).toBe(1);
  });

  test("resolves true once the target screen appears on a later poll", async function () {
    const { manager, pollCount } = stubManager(["Splash", "Splash", "TargetScreen"]);
    const waiter = new DefaultScreenTransitionWaiter(
      manager,
      500,
      new ScriptedClock([0, 200, 400, 600]),
    );

    expect(await waiter.waitForScreen("TargetScreen", 1000)).toBe(true);
    expect(pollCount()).toBe(3);
  });

  test("resolves false when the target screen never appears before the deadline", async function () {
    const { manager, pollCount } = stubManager(["Other"]);
    // startTime=0, then deadline checks at 250/500/750/1000; 1000 is not < 1000.
    const waiter = new DefaultScreenTransitionWaiter(
      manager,
      500,
      new ScriptedClock([0, 250, 500, 750, 1000, 1500]),
    );

    expect(await waiter.waitForScreen("TargetScreen", 1000)).toBe(false);
    expect(pollCount()).toBe(3);
  });

  test("resolves false when the screen only becomes current exactly at the deadline", async function () {
    // Elapsed reaches the timeout on the very first check. A strict `< timeoutMs`
    // gate gives up without polling; the `<= timeoutMs` mutant would poll and
    // wrongly report success. So a screen that is "ready" at t == timeout is a
    // miss.
    const { manager, pollCount } = stubManager(["TargetScreen"]);
    const waiter = new DefaultScreenTransitionWaiter(
      manager,
      500,
      new ScriptedClock([0, 1000, 1500]),
    );

    expect(await waiter.waitForScreen("TargetScreen", 1000)).toBe(false);
    expect(pollCount()).toBe(0);
  });
});
