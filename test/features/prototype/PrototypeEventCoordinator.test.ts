import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  PrototypeEventCoordinator,
  DEFAULT_PROTOTYPE_EVENT_TIMEOUT_MS,
} from "../../../src/features/prototype/PrototypeEventCoordinator";
import { InMemoryPrototypeStatusStore } from "../../../src/features/prototype/PrototypeStatusStore";
import { PROTOTYPE_EVENT_BUFFER_CAPACITY } from "../../../src/features/prototype/PrototypeEventBuffer";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { event } from "../../helpers/prototypeTestEvent";
import { logger } from "../../../src/utils/logger";

const scope = { sessionUuid: "one", deviceId: "device" };
describe("PrototypeEventCoordinator", () => {
  let timer: FakeTimer;
  let client: FakeCtrlProxy;
  let store: InMemoryPrototypeStatusStore;
  let coordinator: PrototypeEventCoordinator;
  beforeEach(() => {
    timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    store = new InMemoryPrototypeStatusStore(timer);
    coordinator = new PrototypeEventCoordinator(timer, store);
  });
  afterEach(() => coordinator.dispose());
  const awaitEvent = (options = {}) => coordinator.awaitEvent(scope, "panel", client, options);

  test("adopting after a replayed terminal event keeps the events the host had queued", async () => {
    coordinator.show(scope, "panel", client);
    const tap = event(1);
    const dismissed = event(2, "panel", "dismissed");
    // The coordinator's own subscription sees the reconnect replay before the inspect reply.
    client.emitPrototypeEvent(tap);
    client.emitPrototypeEvent(dismissed);

    coordinator.adopt(scope, "panel", client, [tap, dismissed], 0);

    expect((await awaitEvent()).event?.sequence).toBe(1);
    expect((await awaitEvent({ kind: "dismissed" })).event?.sequence).toBe(2);
  });

  test("accepted events record telemetry once with their owning scope", () => {
    const recorded: { scope: typeof scope; event: ReturnType<typeof event> }[] = [];
    coordinator = new PrototypeEventCoordinator(timer, store, {
      recordPrototypeEvent: (origin, pushed) => recorded.push({ scope: origin, event: pushed }),
    });
    coordinator.show(scope, "panel", client);
    client.emitPrototypeEvent(event(1, "unknown"));
    client.emitPrototypeEvent(event(2));
    client.emitPrototypeEvent(event(2));
    client.emitPrototypeEvent(event(1));
    client.emitPrototypeEvent(event(3, "panel", "dismissed"));
    client.emitPrototypeEvent(event(4));
    expect(recorded).toEqual([
      { scope, event: event(2) },
      { scope, event: event(3, "panel", "dismissed") },
    ]);
  });

  test("telemetry failures do not prevent dismissed bookkeeping or waiter delivery", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      coordinator = new PrototypeEventCoordinator(timer, store, {
        recordPrototypeEvent: () => {
          throw new Error("telemetry unavailable");
        },
      });
      coordinator.show(scope, "panel", client);
      store.record(scope, "show", { id: "panel" }, { success: true });
      const waiting = awaitEvent();
      client.emitPrototypeEvent(event(1, "panel", "dismissed"));
      expect(store.status(scope).prototypes).toEqual([]);
      expect((await waiting).event?.kind).toBe("dismissed");
      expect(warn).toHaveBeenCalledTimes(1);

      coordinator.show(scope, "panel", client);
      const nonTerminalWaiting = awaitEvent();
      client.emitPrototypeEvent(event(2));
      expect((await nonTerminalWaiting).event?.sequence).toBe(2);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("event before call returns at once and preserves reconnect high-water after consumption", async () => {
    coordinator.show(scope, "panel", client);
    client.emitPrototypeEvent(event(1));
    expect((await awaitEvent()).event?.sequence).toBe(1);
    client.emitPrototypeEvent(event(1));
    client.emitPrototypeEvent(event(0));
    expect(coordinator.counts(scope, "panel")).toEqual({
      pendingCount: 0,
      droppedCount: 0,
      lastSequence: 1,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("an appearance_changed event resolves a waiter filtering on its kind", async () => {
    coordinator.show(scope, "panel", client);
    const waiting = awaitEvent({ kind: "appearance_changed" });
    client.emitPrototypeEvent(event(1));
    const changed = {
      ...event(2, "panel", "appearance_changed"),
      name: null,
      payload: { mode: "dark", source: "system" },
    };
    client.emitPrototypeEvent(changed);
    expect((await waiting).event).toMatchObject({
      sequence: 2,
      kind: "appearance_changed",
      name: null,
      payload: { mode: "dark", source: "system" },
    });
    // The unmatched tap stays buffered for the next wait.
    expect((await awaitEvent()).event?.sequence).toBe(1);
  });
  test("an event of an unknown kind advances the sequence without telemetry, status or delivery", async () => {
    const recorded: number[] = [];
    coordinator = new PrototypeEventCoordinator(timer, store, {
      recordPrototypeEvent: (_origin, pushed) => recorded.push(pushed.sequence),
    });
    store.record(scope, "show", { id: "panel" }, { success: true });
    coordinator.show(scope, "panel", client);
    const waiting = awaitEvent({ timeoutMs: 20 });
    client.emitPrototypeEvent({ ...event(1, "panel", "unknown"), state: {}, payload: null });
    expect(coordinator.counts(scope, "panel")).toEqual({
      pendingCount: 0,
      droppedCount: 0,
      lastSequence: 1,
    });
    expect(recorded).toEqual([]);
    expect(store.status(scope).prototypes[0]).not.toHaveProperty("lastKnown");
    // The waiter is still waiting: the next known event is the one it gets.
    client.emitPrototypeEvent(event(2));
    expect((await waiting).event?.sequence).toBe(2);
    expect(recorded).toEqual([2]);
  });
  test("event during wait resolves and removes its timeout", async () => {
    const waiting = awaitEvent();
    expect(timer.getPendingTimeouts()).toEqual([DEFAULT_PROTOTYPE_EVENT_TIMEOUT_MS]);
    client.emitPrototypeEvent(event(1));
    expect((await waiting).event?.sequence).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    // The shared subscriber remains to buffer between calls, until scope cleanup.
    expect(client.getPrototypeListenerCount()).toBe(1);
  });
  test("timeout is an empty result and cleans an unused subscription", async () => {
    const waiting = awaitEvent({ timeoutMs: 20 });
    timer.advanceTime(20);
    expect(await waiting).toEqual({ timedOut: true, pendingCount: 0, droppedCount: 0 });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(client.getPrototypeListenerCount()).toBe(0);
  });
  test("abort preserves the exact reason and leaves no timer, abort listener, or unused subscriber", async () => {
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const reason = new DOMException("Cancelled", "AbortError");
    const waiting = awaitEvent({ signal: controller.signal });
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    remove.mockRestore();
  });
  test("an abort does not consume an event arriving before wait cleanup", async () => {
    coordinator.show(scope, "panel", client);
    const controller = new AbortController();
    const waiting = awaitEvent({ signal: controller.signal });
    controller.abort();
    client.emitPrototypeEvent(event(1));
    await expect(waiting).rejects.toBe(controller.signal.reason);
    expect(coordinator.counts(scope, "panel")?.pendingCount).toBe(1);
    expect((await awaitEvent()).event?.sequence).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(client.getPrototypeListenerCount()).toBe(1);
  });
  test("a timeout does not consume an event arriving before wait cleanup", async () => {
    coordinator.show(scope, "panel", client);
    const waiting = awaitEvent({ timeoutMs: 10 });
    timer.advanceTime(10);
    client.emitPrototypeEvent(event(1));
    expect((await waiting).timedOut).toBe(true);
    expect(coordinator.counts(scope, "panel")?.pendingCount).toBe(1);
    expect((await awaitEvent()).event?.sequence).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("already aborted requests do not consume buffered events or subscribe", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(awaitEvent({ signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(client.getPrototypeListenerCount()).toBe(0);
    coordinator.show(scope, "panel", client);
    client.emitPrototypeEvent(event(1));
    await expect(awaitEvent({ signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect((await awaitEvent()).event?.sequence).toBe(1);
  });
  test("replacement client preserves reconnect sequence bookkeeping and removes the old listener", async () => {
    coordinator.show(scope, "panel", client);
    client.emitPrototypeEvent(event(5));
    expect((await awaitEvent()).event?.sequence).toBe(5);
    const replacement = new FakeCtrlProxy(timer);
    const waiting = coordinator.awaitEvent(scope, "panel", replacement, {});
    expect(client.getPrototypeListenerCount()).toBe(0);
    replacement.emitPrototypeEvent(event(5));
    replacement.emitPrototypeEvent(event(4));
    replacement.emitPrototypeEvent(event(6));
    expect((await waiting).event?.sequence).toBe(6);
    coordinator.dismiss(scope.deviceId);
    expect(replacement.getPrototypeListenerCount()).toBe(0);
  });
  test("filters and cursor apply during waits without consuming excluded events", async () => {
    coordinator.show(scope, "panel", client);
    client.emitPrototypeEvent(event(1));
    const waiting = awaitEvent({ afterSequence: 1, eventName: "page", kind: "page_changed" });
    client.emitPrototypeEvent(event(2));
    client.emitPrototypeEvent(event(3, "panel", "page_changed", "page"));
    expect((await waiting).event?.sequence).toBe(3);
    expect((await awaitEvent()).event?.sequence).toBe(1);
    expect((await awaitEvent()).event?.sequence).toBe(2);
  });
  test("overflow reports count with event and timeout results", async () => {
    coordinator.show(scope, "panel", client);
    for (let sequence = 1; sequence <= PROTOTYPE_EVENT_BUFFER_CAPACITY + 1; sequence++) {
      client.emitPrototypeEvent(event(sequence));
    }
    expect(await awaitEvent()).toMatchObject({
      event: { sequence: 2 },
      droppedCount: 1,
      pendingCount: PROTOTYPE_EVENT_BUFFER_CAPACITY - 1,
    });
    const waiting = awaitEvent({ eventName: "other", timeoutMs: 10 });
    timer.advanceTime(10);
    expect(await waiting).toMatchObject({ timedOut: true, droppedCount: 1 });
  });
  test("two prototypes share one listener; explicit dismiss removes only its buffer", async () => {
    coordinator.show(scope, "panel", client);
    coordinator.show(scope, "second", client);
    expect(client.getPrototypeListenerCount()).toBe(1);
    client.emitPrototypeEvent(event(1, "second"));
    coordinator.dismiss(scope.deviceId, "panel");
    expect(client.getPrototypeListenerCount()).toBe(1);
    expect((await coordinator.awaitEvent(scope, "second", client, {})).event?.id).toBe("second");
    coordinator.dismiss(scope.deviceId);
    expect(client.getPrototypeListenerCount()).toBe(0);
    client.emitPrototypeEvent(event(2));
    expect(coordinator.counts(scope, "panel")).toBeUndefined();
  });
  test.each(["session", "device", "dismiss"])(
    "%s release settles waits as dismissed and drops buffers and subscriptions",
    async (release) => {
      coordinator.show(scope, "panel", client);
      store.record(scope, "show", { id: "panel" }, { success: true });
      const waiting = awaitEvent();
      if (release === "session") {
        coordinator.releaseSession(scope.sessionUuid);
      } else if (release === "device") {
        coordinator.releaseDevice(scope.deviceId);
      } else {
        coordinator.dismiss(scope.deviceId);
      }
      expect(await waiting).toEqual({ reason: "dismissed", pendingCount: 0, droppedCount: 0 });
      expect(client.getPrototypeListenerCount()).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(coordinator.counts(scope, "panel")).toBeUndefined();
      if (release !== "dismiss") {
        expect(store.status(scope).prototypes).toEqual([]);
      }
    },
  );
  test("terminal dismissed event removes shown status but remains deliverable and clears older events on consumption", async () => {
    coordinator.show(scope, "panel", client);
    store.record(scope, "show", { id: "panel" }, { success: true });
    client.emitPrototypeEvent(event(1));
    client.emitPrototypeEvent(event(2, "panel", "dismissed"));
    expect(store.status(scope).prototypes).toEqual([]);
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect(coordinator.counts(scope, "panel")?.pendingCount).toBe(2);
    expect(await awaitEvent({ kind: "dismissed" })).toMatchObject({
      event: { kind: "dismissed" },
      pendingCount: 0,
      lastSequence: 2,
    });
    // The consumed terminal entry is gone; nothing is retained until release.
    expect(coordinator.counts(scope, "panel")).toBeUndefined();
    expect(client.getPrototypeListenerCount()).toBe(0);
    coordinator.show(scope, "panel", client);
    client.emitPrototypeEvent(event(1));
    client.emitPrototypeEvent(event(2));
    expect((await awaitEvent()).event?.sequence).toBe(1);
  });
  test("a consumed device-dismissed entry is removed, but an unconsumed one stays deliverable", async () => {
    coordinator.show(scope, "panel", client);
    client.emitPrototypeEvent(event(1, "panel", "dismissed"));
    expect(coordinator.counts(scope, "panel")?.pendingCount).toBe(1);
    expect((await awaitEvent()).event?.kind).toBe("dismissed");
    expect(coordinator.counts(scope, "panel")).toBeUndefined();
    expect(client.getPrototypeListenerCount()).toBe(0);
  });
  test("a terminal entry is kept while another waiter still needs to settle", async () => {
    const first = awaitEvent();
    const second = awaitEvent();
    client.emitPrototypeEvent(event(1, "panel", "dismissed"));
    expect((await first).event?.kind).toBe("dismissed");
    expect((await second).reason).toBe("dismissed");
    expect(coordinator.counts(scope, "panel")).toBeUndefined();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("a show starts a fresh sequence epoch so a restarted device's events are accepted", async () => {
    coordinator.show(scope, "panel", client);
    for (let sequence = 1; sequence <= 40; sequence++) {
      client.emitPrototypeEvent(event(sequence));
    }
    expect(coordinator.counts(scope, "panel")?.lastSequence).toBe(40);
    // CtrlProxy restarts: its in-memory ledger starts again at 1 for the re-shown id.
    coordinator.show(scope, "panel", client);
    expect(coordinator.counts(scope, "panel")).toEqual({ pendingCount: 0, droppedCount: 0 });
    client.emitPrototypeEvent(event(1));
    expect(await awaitEvent()).toMatchObject({ event: { sequence: 1 }, lastSequence: 1 });
    // Within the new epoch the high-water rule still applies.
    client.emitPrototypeEvent(event(1));
    client.emitPrototypeEvent(event(2));
    client.emitPrototypeEvent(event(2));
    expect(coordinator.counts(scope, "panel")).toMatchObject({ pendingCount: 1, lastSequence: 2 });
  });
  test("a re-show keeps the cumulative dropped count that status documents", () => {
    coordinator.show(scope, "panel", client);
    for (let sequence = 1; sequence <= PROTOTYPE_EVENT_BUFFER_CAPACITY + 1; sequence++) {
      client.emitPrototypeEvent(event(sequence));
    }
    coordinator.show(scope, "panel", client);
    expect(coordinator.counts(scope, "panel")).toEqual({ pendingCount: 0, droppedCount: 1 });
  });
  test("replaceShown ends the replaced prototype's waiters as dismissed and keeps the new one", async () => {
    coordinator.show(scope, "panel", client);
    coordinator.show(scope, "second", client);
    const waiting = awaitEvent();
    client.emitPrototypeEvent(event(1, "second"));
    coordinator.replaceShown(scope.deviceId, "second");
    expect(await waiting).toEqual({ reason: "dismissed", pendingCount: 0, droppedCount: 0 });
    expect(coordinator.counts(scope, "panel")).toBeUndefined();
    expect(coordinator.counts(scope, "second")?.pendingCount).toBe(1);
    expect(client.getPrototypeListenerCount()).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("replaceShown leaves other devices and unshown awaited ids alone", () => {
    const otherDevice = { ...scope, deviceId: "other" };
    const otherClient = new FakeCtrlProxy(timer);
    coordinator.show(otherDevice, "panel", otherClient);
    const waiting = coordinator.awaitEvent(scope, "later", client, { timeoutMs: 10 });
    coordinator.replaceShown(scope.deviceId, "second");
    expect(coordinator.counts(otherDevice, "panel")).toBeDefined();
    timer.advanceTime(10);
    return expect(waiting).resolves.toMatchObject({ timedOut: true });
  });
  test("session release clears a co-tenant's buffers, waiters and listener like the status store", async () => {
    const coTenant = { ...scope, sessionUuid: "two" };
    coordinator.show(scope, "panel", client);
    coordinator.show(coTenant, "second", client);
    store.record(scope, "show", { id: "panel" }, { success: true });
    store.record(coTenant, "show", { id: "second" }, { success: true });
    client.emitPrototypeEvent(event(1, "second"));
    const waiting = coordinator.awaitEvent(coTenant, "second", client, { afterSequence: 5 });
    coordinator.releaseSession("one");
    expect(store.status(coTenant).prototypes).toEqual([]);
    expect((await waiting).reason).toBe("dismissed");
    expect(coordinator.counts(coTenant, "second")).toBeUndefined();
    expect(coordinator.counts(scope, "panel")).toBeUndefined();
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("device dismissed resolves an active waiter with the terminal event", async () => {
    const waiting = awaitEvent();
    client.emitPrototypeEvent(event(1, "panel", "dismissed"));
    expect((await waiting).event?.kind).toBe("dismissed");
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(client.getPrototypeListenerCount()).toBe(0);
  });
  test("concurrent waiters consume each event at most once", async () => {
    const first = awaitEvent();
    const second = awaitEvent();
    client.emitPrototypeEvent(event(1));
    client.emitPrototypeEvent(event(2));
    expect((await first).event?.sequence).toBe(1);
    expect((await second).event?.sequence).toBe(2);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("sessions and devices never mix events, cleanup preserves the other scope", async () => {
    const otherSession = { ...scope, sessionUuid: "two" };
    const otherDevice = { ...scope, deviceId: "other" };
    const otherClient = new FakeCtrlProxy(timer);
    coordinator.show(scope, "panel", client);
    coordinator.show(otherSession, "second", client);
    coordinator.show(otherDevice, "panel", otherClient);
    client.emitPrototypeEvent(event(1));
    client.emitPrototypeEvent(event(2, "second"));
    otherClient.emitPrototypeEvent(event(3));
    expect((await awaitEvent()).event?.sequence).toBe(1);
    expect((await coordinator.awaitEvent(otherSession, "second", client, {})).event?.sequence).toBe(
      2,
    );
    expect(
      (await coordinator.awaitEvent(otherDevice, "panel", otherClient, {})).event?.sequence,
    ).toBe(3);
    coordinator.releaseSession("two");
    expect(client.getPrototypeListenerCount()).toBe(1);
    expect(otherClient.getPrototypeListenerCount()).toBe(1);
    coordinator.dispose();
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect(otherClient.getPrototypeListenerCount()).toBe(0);
  });
  test("latest show owns a device/id and another session cannot await its events", async () => {
    coordinator.show(scope, "panel", client);
    const other = { ...scope, sessionUuid: "two" };
    coordinator.show(other, "panel", client);
    client.emitPrototypeEvent(event(1));
    await expect(awaitEvent()).rejects.toThrow("another session");
    expect((await coordinator.awaitEvent(other, "panel", client, {})).event?.sequence).toBe(1);
    expect(client.getPrototypeListenerCount()).toBe(1);
  });
});
