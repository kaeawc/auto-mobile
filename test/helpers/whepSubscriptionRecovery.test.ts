import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  recoverWhepSubscription,
  subscribeWhepReaderForPlatform,
  type ChromeReader,
  type WhepSubscriptionRecoveryDependencies,
} from "./whepSubscriptionRecovery";

interface FakeCdp {
  readonly id: string;
}

type FakeChrome = string;

function reader(chrome: FakeChrome, cdp: FakeCdp): ChromeReader<FakeChrome, FakeCdp> {
  return { chrome, cdp };
}

function dependencies(
  timer: FakeTimer,
  events: string[],
  subscribe: (cdp: FakeCdp) => Promise<void>,
  launch: () => Promise<ChromeReader<FakeChrome, FakeCdp>>,
): WhepSubscriptionRecoveryDependencies<FakeChrome, FakeCdp> {
  return {
    subscribe,
    launch,
    close: (cdp) => events.push(`close:${cdp.id}`),
    stop: async (chrome) => {
      events.push(`stop:${chrome}`);
    },
    timer,
  };
}

describe("recoverWhepSubscription", () => {
  test("subscribes directly in non-iOS lanes", async () => {
    const timer = new FakeTimer();
    const events: string[] = [];
    const initial = reader("initial-chrome", { id: "initial-cdp" });

    const subscribed = await subscribeWhepReaderForPlatform(
      "android",
      initial,
      dependencies(
        timer,
        events,
        async (cdp) => {
          events.push(`subscribe:${cdp.id}`);
        },
        async () => {
          throw new Error("Android must not launch a recovery browser");
        },
      ),
    );

    expect(subscribed.retried).toBe(false);
    expect(subscribed.chrome).toBe(initial.chrome);
    expect(subscribed.cdp).toBe(initial.cdp);
    expect(events).toEqual(["subscribe:initial-cdp"]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("replaces a failed reader and retains the successful replacement", async () => {
    const timer = new FakeTimer();
    const events: string[] = [];
    const initial = reader("initial-chrome", { id: "initial-cdp" });
    const replacement = reader("replacement-chrome", { id: "replacement-cdp" });

    const recovery = recoverWhepSubscription(
      initial,
      dependencies(
        timer,
        events,
        async (cdp) => {
          events.push(`subscribe:${cdp.id}`);
          if (cdp === initial.cdp) {
            throw new Error("initial subscription failed");
          }
        },
        async () => {
          events.push("launch");
          return replacement;
        },
      ),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(timer.getPendingSleeps()).toEqual([1_000]);
    expect(events).toEqual(["subscribe:initial-cdp", "close:initial-cdp", "stop:initial-chrome"]);

    timer.advanceTime(999);
    expect(events).not.toContain("launch");
    await timer.advanceTimeAsync(1);

    const recovered = await recovery;
    expect(recovered.retried).toBe(true);
    expect(recovered.chrome).toBe(replacement.chrome);
    expect(recovered.cdp).toBe(replacement.cdp);
    expect(events).toEqual([
      "subscribe:initial-cdp",
      "close:initial-cdp",
      "stop:initial-chrome",
      "launch",
      "subscribe:replacement-cdp",
    ]);
    expect(timer.getSleepHistory()).toEqual([1_000]);
  });

  test("cleans up both readers and propagates the retry failure", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const events: string[] = [];
    const initial = reader("initial-chrome", { id: "initial-cdp" });
    const replacement = reader("replacement-chrome", { id: "replacement-cdp" });

    await expect(
      recoverWhepSubscription(
        initial,
        dependencies(
          timer,
          events,
          async (cdp) => {
            events.push(`subscribe:${cdp.id}`);
            throw new Error(cdp === initial.cdp ? "initial subscription failed" : "retry failed");
          },
          async () => {
            events.push("launch");
            return replacement;
          },
        ),
      ),
    ).rejects.toThrow(
      "WHEP recovery reader failed after a fresh-browser retry: first=initial subscription failed; retry=retry failed",
    );

    expect(events).toEqual([
      "subscribe:initial-cdp",
      "close:initial-cdp",
      "stop:initial-chrome",
      "launch",
      "subscribe:replacement-cdp",
      "close:replacement-cdp",
      "stop:replacement-chrome",
    ]);
    expect(timer.getSleepHistory()).toEqual([1_000]);
  });
});
