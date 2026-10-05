import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  OverlayEventCoordinator,
  DEFAULT_OVERLAY_EVENT_TIMEOUT_MS,
} from "../../../src/features/overlay/OverlayEventCoordinator";
import { InMemoryOverlayStatusStore } from "../../../src/features/overlay/OverlayStatusStore";
import { OVERLAY_EVENT_BUFFER_CAPACITY } from "../../../src/features/overlay/OverlayEventBuffer";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { event } from "../../helpers/overlayTestEvent";

const scope = { sessionUuid: "one", deviceId: "device" };
describe("OverlayEventCoordinator", () => {
  let timer: FakeTimer;
  let client: FakeCtrlProxy;
  let store: InMemoryOverlayStatusStore;
  let coordinator: OverlayEventCoordinator;
  beforeEach(() => {
    timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    store = new InMemoryOverlayStatusStore(timer);
    coordinator = new OverlayEventCoordinator(timer, store);
  });
  afterEach(() => coordinator.dispose());
  const awaitEvent = (options = {}) => coordinator.awaitEvent(scope, "panel", client, options);

  test("event before call returns at once and preserves reconnect high-water after consumption", async () => {
    coordinator.show(scope, "panel", client);
    client.emitOverlayEvent(event(1));
    expect((await awaitEvent()).event?.sequence).toBe(1);
    client.emitOverlayEvent(event(1));
    client.emitOverlayEvent(event(0));
    expect(coordinator.counts(scope, "panel")).toEqual({
      pendingCount: 0,
      droppedCount: 0,
      lastSequence: 1,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("event during wait resolves and removes its timeout", async () => {
    const waiting = awaitEvent();
    expect(timer.getPendingTimeouts()).toEqual([DEFAULT_OVERLAY_EVENT_TIMEOUT_MS]);
    client.emitOverlayEvent(event(1));
    expect((await waiting).event?.sequence).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    // The shared subscriber remains to buffer between calls, until scope cleanup.
    expect(client.getOverlayListenerCount()).toBe(1);
  });
  test("timeout is an empty result and cleans an unused subscription", async () => {
    const waiting = awaitEvent({ timeoutMs: 20 });
    timer.advanceTime(20);
    expect(await waiting).toEqual({ timedOut: true, pendingCount: 0, droppedCount: 0 });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(client.getOverlayListenerCount()).toBe(0);
  });
  test("abort preserves the exact reason and leaves no timer, abort listener, or unused subscriber", async () => {
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const reason = new DOMException("Cancelled", "AbortError");
    const waiting = awaitEvent({ signal: controller.signal });
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(client.getOverlayListenerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    remove.mockRestore();
  });
  test("an abort does not consume an event arriving before wait cleanup", async () => {
    coordinator.show(scope, "panel", client);
    const controller = new AbortController();
    const waiting = awaitEvent({ signal: controller.signal });
    controller.abort();
    client.emitOverlayEvent(event(1));
    await expect(waiting).rejects.toBe(controller.signal.reason);
    expect(coordinator.counts(scope, "panel")?.pendingCount).toBe(1);
    expect((await awaitEvent()).event?.sequence).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(client.getOverlayListenerCount()).toBe(1);
  });
  test("a timeout does not consume an event arriving before wait cleanup", async () => {
    coordinator.show(scope, "panel", client);
    const waiting = awaitEvent({ timeoutMs: 10 });
    timer.advanceTime(10);
    client.emitOverlayEvent(event(1));
    expect((await waiting).timedOut).toBe(true);
    expect(coordinator.counts(scope, "panel")?.pendingCount).toBe(1);
    expect((await awaitEvent()).event?.sequence).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("already aborted requests do not consume buffered events or subscribe", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(awaitEvent({ signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(client.getOverlayListenerCount()).toBe(0);
    coordinator.show(scope, "panel", client);
    client.emitOverlayEvent(event(1));
    await expect(awaitEvent({ signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect((await awaitEvent()).event?.sequence).toBe(1);
  });
  test("replacement client preserves reconnect sequence bookkeeping and removes the old listener", async () => {
    coordinator.show(scope, "panel", client);
    client.emitOverlayEvent(event(5));
    expect((await awaitEvent()).event?.sequence).toBe(5);
    const replacement = new FakeCtrlProxy(timer);
    const waiting = coordinator.awaitEvent(scope, "panel", replacement, {});
    expect(client.getOverlayListenerCount()).toBe(0);
    replacement.emitOverlayEvent(event(5));
    replacement.emitOverlayEvent(event(4));
    replacement.emitOverlayEvent(event(6));
    expect((await waiting).event?.sequence).toBe(6);
    coordinator.dismiss(scope.deviceId);
    expect(replacement.getOverlayListenerCount()).toBe(0);
  });
  test("filters and cursor apply during waits without consuming excluded events", async () => {
    coordinator.show(scope, "panel", client);
    client.emitOverlayEvent(event(1));
    const waiting = awaitEvent({ afterSequence: 1, eventName: "page", kind: "page_changed" });
    client.emitOverlayEvent(event(2));
    client.emitOverlayEvent(event(3, "panel", "page_changed", "page"));
    expect((await waiting).event?.sequence).toBe(3);
    expect((await awaitEvent()).event?.sequence).toBe(1);
    expect((await awaitEvent()).event?.sequence).toBe(2);
  });
  test("overflow reports count with event and timeout results", async () => {
    coordinator.show(scope, "panel", client);
    for (let sequence = 1; sequence <= OVERLAY_EVENT_BUFFER_CAPACITY + 1; sequence++) {
      client.emitOverlayEvent(event(sequence));
    }
    expect(await awaitEvent()).toMatchObject({
      event: { sequence: 2 },
      droppedCount: 1,
      pendingCount: OVERLAY_EVENT_BUFFER_CAPACITY - 1,
    });
    const waiting = awaitEvent({ eventName: "other", timeoutMs: 10 });
    timer.advanceTime(10);
    expect(await waiting).toMatchObject({ timedOut: true, droppedCount: 1 });
  });
  test("two overlays share one listener; explicit dismiss removes only its buffer", async () => {
    coordinator.show(scope, "panel", client);
    coordinator.show(scope, "second", client);
    expect(client.getOverlayListenerCount()).toBe(1);
    client.emitOverlayEvent(event(1, "second"));
    coordinator.dismiss(scope.deviceId, "panel");
    expect(client.getOverlayListenerCount()).toBe(1);
    expect((await coordinator.awaitEvent(scope, "second", client, {})).event?.id).toBe("second");
    coordinator.dismiss(scope.deviceId);
    expect(client.getOverlayListenerCount()).toBe(0);
    client.emitOverlayEvent(event(2));
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
      expect(client.getOverlayListenerCount()).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(coordinator.counts(scope, "panel")).toBeUndefined();
      if (release !== "dismiss") {
        expect(store.status(scope).overlays).toEqual([]);
      }
    },
  );
  test("terminal dismissed event removes shown status but remains deliverable and clears older events on consumption", async () => {
    coordinator.show(scope, "panel", client);
    store.record(scope, "show", { id: "panel" }, { success: true });
    client.emitOverlayEvent(event(1));
    client.emitOverlayEvent(event(2, "panel", "dismissed"));
    expect(store.status(scope).overlays).toEqual([]);
    expect(client.getOverlayListenerCount()).toBe(0);
    expect(coordinator.counts(scope, "panel")?.pendingCount).toBe(2);
    expect(await awaitEvent({ kind: "dismissed" })).toMatchObject({
      event: { kind: "dismissed" },
      pendingCount: 0,
      lastSequence: 2,
    });
    expect(await awaitEvent()).toMatchObject({ reason: "dismissed", pendingCount: 0 });
    expect(client.getOverlayListenerCount()).toBe(0);
    coordinator.show(scope, "panel", client);
    client.emitOverlayEvent(event(2));
    client.emitOverlayEvent(event(3));
    expect((await awaitEvent()).event?.sequence).toBe(3);
  });
  test("device dismissed resolves an active waiter with the terminal event", async () => {
    const waiting = awaitEvent();
    client.emitOverlayEvent(event(1, "panel", "dismissed"));
    expect((await waiting).event?.kind).toBe("dismissed");
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(client.getOverlayListenerCount()).toBe(0);
  });
  test("concurrent waiters consume each event at most once", async () => {
    const first = awaitEvent();
    const second = awaitEvent();
    client.emitOverlayEvent(event(1));
    client.emitOverlayEvent(event(2));
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
    client.emitOverlayEvent(event(1));
    client.emitOverlayEvent(event(2, "second"));
    otherClient.emitOverlayEvent(event(3));
    expect((await awaitEvent()).event?.sequence).toBe(1);
    expect((await coordinator.awaitEvent(otherSession, "second", client, {})).event?.sequence).toBe(
      2,
    );
    expect(
      (await coordinator.awaitEvent(otherDevice, "panel", otherClient, {})).event?.sequence,
    ).toBe(3);
    coordinator.releaseSession("two");
    expect(client.getOverlayListenerCount()).toBe(1);
    expect(otherClient.getOverlayListenerCount()).toBe(1);
    coordinator.dispose();
    expect(client.getOverlayListenerCount()).toBe(0);
    expect(otherClient.getOverlayListenerCount()).toBe(0);
  });
  test("latest show owns a device/id and another session cannot await its events", async () => {
    coordinator.show(scope, "panel", client);
    const other = { ...scope, sessionUuid: "two" };
    coordinator.show(other, "panel", client);
    client.emitOverlayEvent(event(1));
    await expect(awaitEvent()).rejects.toThrow("another session");
    expect((await coordinator.awaitEvent(other, "panel", client, {})).event?.sequence).toBe(1);
    expect(client.getOverlayListenerCount()).toBe(1);
  });
});
