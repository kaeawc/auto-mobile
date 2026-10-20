import { describe, expect, test } from "bun:test";
import type { ListChangedKind } from "../../src/daemon/listChangedBroadcast";
import { ToolListPoller } from "../../src/daemon/proxy/ToolListPoller";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

const INTERVAL_MS = 1_000;

interface Deferred {
  promise: Promise<unknown>;
  resolve(value: unknown): void;
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A daemon whose lists the test edits, with optional held reads. */
class FakeListDaemon {
  readonly lists: Record<ListChangedKind, unknown[]> = {
    tools: [{ name: "toolA" }],
    resources: [{ uri: "automobile:one" }],
  };
  readonly reads: ListChangedKind[] = [];
  readonly held: Deferred[] = [];
  connected = true;
  failing = false;
  holdReads = false;

  fetch(kind: ListChangedKind): Promise<unknown> {
    this.reads.push(kind);
    if (!this.connected) {
      return Promise.resolve(undefined);
    }
    if (this.failing) {
      return Promise.reject(new Error("daemon busy"));
    }
    const snapshot = structuredClone(this.lists[kind]);
    if (!this.holdReads) {
      return Promise.resolve(snapshot);
    }
    const read = deferred();
    this.held.push(read);
    return read.promise.then(() => snapshot);
  }
}

function setup() {
  const timer = new FakeTimer();
  const daemon = new FakeListDaemon();
  const emitted: ListChangedKind[] = [];
  const poller = new ToolListPoller({
    timer,
    intervalMs: INTERVAL_MS,
    fetchList: (kind) => daemon.fetch(kind),
    emitListChanged: (kind) => emitted.push(kind),
  });
  const tick = async (): Promise<void> => {
    await timer.advanceTimeAsync(INTERVAL_MS, () => drainMicrotasks(8));
  };
  return { timer, daemon, emitted, poller, tick };
}

describe("ToolListPoller", () => {
  test("polls only while the subscription is unavailable, on the injected interval", async () => {
    const { timer, poller, daemon, tick } = setup();
    expect(poller.isPolling()).toBe(false);

    await poller.onSubscriptionUnavailable();
    expect(timer.getPendingIntervals()).toEqual([INTERVAL_MS]);
    await tick();
    expect(daemon.reads).toEqual(["tools", "resources"]);

    await poller.onSubscriptionAcknowledged();
    expect(poller.isPolling()).toBe(false);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  test("emits only when a list's hash changes", async () => {
    const { poller, daemon, emitted, tick } = setup();
    await poller.onSubscriptionUnavailable();

    await tick(); // first read is the baseline
    await tick();
    expect(emitted).toEqual([]);

    daemon.lists.tools = [{ name: "toolA" }, { name: "toolB" }];
    await tick();
    expect(emitted).toEqual(["tools"]);

    await tick();
    expect(emitted).toEqual(["tools"]);

    daemon.lists.resources = [];
    await tick();
    expect(emitted).toEqual(["tools", "resources"]);
  });

  test("a list the proxy observed is the baseline for the first poll", async () => {
    const { poller, daemon, emitted, tick } = setup();
    poller.observe("tools", daemon.lists.tools);
    daemon.lists.tools = [{ name: "toolB" }];

    await poller.onSubscriptionUnavailable();
    await tick();

    expect(emitted).toEqual(["tools"]);
  });

  test("a push and a poll that read the same change emit it once", async () => {
    const { poller, daemon, emitted, tick } = setup();
    await poller.onSubscriptionUnavailable();
    await tick();

    daemon.lists.tools = [{ name: "toolB" }];
    daemon.holdReads = true;
    await tick(); // poll read in flight
    const pushed = poller.onPushed("tools"); // push read in flight
    for (const read of daemon.held.splice(0)) {
      read.resolve(undefined);
    }
    await pushed;
    await drainMicrotasks(8);

    expect(emitted).toEqual(["tools"]);
  });

  test("a push for a change a poll already announced is not emitted again", async () => {
    const { poller, daemon, emitted, tick } = setup();
    await poller.onSubscriptionUnavailable();
    await tick();
    daemon.lists.tools = [{ name: "toolB" }];
    await tick();
    expect(emitted).toEqual(["tools"]);

    await poller.onPushed("tools");

    expect(emitted).toEqual(["tools"]);
  });

  test("a push for a newer change is emitted", async () => {
    const { poller, daemon, emitted, tick } = setup();
    await poller.onSubscriptionUnavailable();
    await tick();

    daemon.lists.tools = [{ name: "toolC" }];
    await poller.onPushed("tools");

    expect(emitted).toEqual(["tools"]);
  });

  test("a push that cannot be compared is emitted anyway", async () => {
    const { poller, daemon, emitted, tick } = setup();
    await poller.onSubscriptionUnavailable();
    await tick();

    daemon.failing = true;
    await poller.onPushed("resources");

    expect(emitted).toEqual(["resources"]);
  });

  test("a change the proxy announced itself becomes the baseline silently", async () => {
    const { poller, daemon, emitted, tick } = setup();
    await poller.onSubscriptionUnavailable();
    await tick();

    daemon.lists.tools = [{ name: "boundScope" }];
    poller.noteEmitted("tools");
    await tick();

    expect(emitted).toEqual([]);
  });

  test("failed and disconnected reads keep the baseline and do not emit", async () => {
    const { poller, daemon, emitted, tick } = setup();
    await poller.onSubscriptionUnavailable();
    await tick();

    daemon.failing = true;
    await tick();
    daemon.failing = false;
    daemon.connected = false;
    await tick();
    expect(emitted).toEqual([]);

    daemon.connected = true;
    daemon.lists.resources = [];
    await tick();
    expect(emitted).toEqual(["resources"]);
  });

  test("a slow daemon does not stack overlapping polls", async () => {
    const { poller, daemon, tick } = setup();
    await poller.onSubscriptionUnavailable();
    daemon.holdReads = true;

    await tick();
    await tick();
    await tick();

    expect(daemon.reads).toEqual(["tools"]);
  });

  test("a connection that drops while polling compares once when push is restored", async () => {
    const { poller, daemon, emitted, tick } = setup();
    await poller.onSubscriptionUnavailable();
    await tick();

    poller.markDropped();
    expect(poller.isPolling()).toBe(false);
    daemon.lists.tools = [{ name: "changedWhileDisconnected" }];
    await poller.onSubscriptionAcknowledged();

    expect(emitted).toEqual(["tools"]);
    expect(poller.isPolling()).toBe(false);
  });

  test("a drop while push was healthy adds no reads on reconnect", async () => {
    const { poller, daemon } = setup();
    poller.observe("tools", daemon.lists.tools);

    poller.markDropped();
    await poller.onSubscriptionAcknowledged();

    expect(daemon.reads).toEqual([]);
  });

  test("stop clears the interval and the baselines", async () => {
    const { timer, poller, daemon, emitted, tick } = setup();
    await poller.onSubscriptionUnavailable();
    await tick();

    poller.stop();
    daemon.lists.tools = [];
    await tick();

    expect(timer.getPendingIntervalCount()).toBe(0);
    expect(daemon.reads).toEqual(["tools", "resources"]);
    expect(emitted).toEqual([]);
  });

  test("an acknowledgement during a pending reconciliation keeps polling off", async () => {
    const { poller, daemon, timer } = setup();
    await poller.onSubscriptionUnavailable();
    poller.observe("tools", daemon.lists.tools);
    poller.markDropped();
    daemon.holdReads = true;

    const unavailable = poller.onSubscriptionUnavailable();
    await drainMicrotasks(4);
    await poller.onSubscriptionAcknowledged();
    daemon.held.forEach((read) => read.resolve(undefined));
    await unavailable;

    expect(poller.isPolling()).toBe(false);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  test("an older read finishing after a newer one does not re-announce a stale list", async () => {
    const { poller, daemon, emitted } = setup();
    poller.observe("tools", [{ name: "toolA" }]);
    daemon.holdReads = true;

    const interval = poller.onPushed("tools"); // reads A (first held read)
    await drainMicrotasks(4);
    daemon.lists.tools = [{ name: "toolB" }];
    const pushed = poller.onPushed("tools"); // reads B (second held read)
    await drainMicrotasks(4);

    daemon.held[1]?.resolve(undefined);
    await drainMicrotasks(4);
    daemon.held[0]?.resolve(undefined);
    await Promise.all([interval, pushed]);

    expect(emitted).toEqual(["tools"]);
  });
});
