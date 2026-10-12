import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  prototypeOutputSchema,
  prototypeSchema,
  registerPrototypeTools,
  type PrototypeEventLifecycle,
} from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../src/models";
import type { PrototypeEvent } from "../../src/features/observe/android/ctrlProxyProtocol";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const event = (
  sequence: number,
  kind: PrototypeEvent["kind"],
  name: string | null,
  overrides: Partial<PrototypeEvent> = {},
): PrototypeEvent => ({
  type: "prototype_event",
  timestamp: 1000 + sequence,
  id: "proto",
  sequence,
  kind,
  name,
  payload: null,
  state: { label: "typed" },
  pages: { pager: 1 },
  ...overrides,
});
const reported = (lastSequence: number) => ({
  id: "proto",
  persistent: true,
  state: { label: "typed" },
  pages: { pager: 1 },
  lastSequence,
});

describe("prototype inspect (#10494)", () => {
  let client: FakeCtrlProxy;
  let fakeTimer: FakeTimer;
  let restore: () => void;
  let unsubscribe: () => void;
  let releaseSession: (sessionUuid: string, deviceId?: string) => void = () => {};

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    fakeTimer = timer;
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands(["prototype_window_options_v1", "prototype_persistence_replay_v1"]);
    const lifecycle: PrototypeEventLifecycle = {
      subscribeSessionRelease: (listener) => {
        releaseSession = listener;
        return () => {};
      },
      subscribeDeviceRemoval: () => () => {},
      subscribeDeviceUnbound: () => () => {},
    };
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
      lifecycle,
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: Record<string, unknown>) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler(device, input);
    return prototypeOutputSchema.parse(response.structuredContent);
  }

  test("inspect is an argument-free action", () => {
    expect(prototypeSchema.safeParse({ action: "inspect" }).success).toBe(true);
    expect(prototypeSchema.safeParse({ action: "inspect", id: "proto" }).success).toBe(false);
  });

  test("a device without prototype_persistence_replay_v1 gets a clear error and nothing is sent", async () => {
    client.setSupportedCommands(["prototype_window_options_v1"]);
    const payload = await call({ action: "inspect" });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("prototype_persistence_replay_v1");
    expect(client.getInspectCount()).toBe(0);
  });

  test("status is empty after a session release, and inspect brings the persisted prototype back", async () => {
    await call({
      action: "show",
      spec: {
        id: "proto",
        window: { placement: { type: "fullscreen" }, persistence: "device" },
        root: { type: "text", text: "Hello" },
      },
    });
    releaseSession("session-1", device.deviceId);
    expect((await call({ action: "status" })).prototypes).toEqual([]);

    client.setInspectReply({ success: true, prototypes: [reported(5)], droppedEvents: 2 });
    const payload = await call({ action: "inspect" });

    expect(payload.success).toBe(true);
    expect(payload.deviceDroppedEvents).toBe(2);
    expect(payload.prototypes).toMatchObject([
      {
        id: "proto",
        adopted: true,
        pages: { pager: 1 },
        state: { label: "typed" },
        lastKnown: true,
        lastSequence: 5,
      },
    ]);
    // The adopted prototype now shows in a plain status call, with no further device request.
    const status = await call({ action: "status" });
    expect(status.prototypes).toMatchObject([{ id: "proto", adopted: true, lastSequence: 5 }]);
    expect(client.getInspectCount()).toBe(1);
  });

  test("events the device buffered offline are delivered to awaitEvent in order", async () => {
    client.setInspectReply({ success: true, prototypes: [reported(3)] }, [
      event(1, "emit", "tap"),
      event(2, "page_changed", "pager", { payload: 1 }),
      event(3, "emit", "change"),
    ]);
    const inspected = await call({ action: "inspect" });
    expect(inspected.prototypes).toMatchObject([{ id: "proto", pendingCount: 3, lastSequence: 3 }]);

    const first = await call({ action: "awaitEvent", id: "proto" });
    expect([first.event?.sequence, first.event?.name]).toEqual([1, "tap"]);
    const second = await call({ action: "awaitEvent", id: "proto", kind: "page_changed" });
    expect(second.event?.sequence).toBe(2);
    const third = await call({ action: "awaitEvent", id: "proto", afterSequence: 2 });
    expect(third.event?.name).toBe("change");
  });

  test("a device buffer overflow shows as deviceDroppedEvents and a sequence gap", async () => {
    client.setInspectReply({ success: true, prototypes: [reported(9)], droppedEvents: 6 }, [
      event(7, "emit", "a"),
      event(8, "emit", "b"),
      event(9, "emit", "c"),
    ]);
    const payload = await call({ action: "inspect" });
    expect(payload.deviceDroppedEvents).toBe(6);
    const first = await call({ action: "awaitEvent", id: "proto" });
    expect(first.event?.sequence).toBe(7);
  });

  test("a prototype dismissed while no host was connected still delivers its terminal event", async () => {
    client.setInspectReply({ success: true, prototypes: [] }, [
      event(1, "emit", "tap"),
      event(2, "dismissed", null, { payload: { reason: "user" } }),
    ]);
    const payload = await call({ action: "inspect" });
    expect(payload.prototypes).toEqual([]);

    const first = await call({ action: "awaitEvent", id: "proto" });
    expect(first.event?.name).toBe("tap");
    const terminal = await call({ action: "awaitEvent", id: "proto", kind: "dismissed" });
    expect(terminal.event?.kind).toBe("dismissed");
  });

  test("replayed events a second inspect sends again are not delivered twice", async () => {
    client.setInspectReply({ success: true, prototypes: [reported(1)] }, [event(1, "emit", "tap")]);
    await call({ action: "inspect" });
    const second = await call({ action: "inspect" });
    expect(second.prototypes).toMatchObject([{ id: "proto", pendingCount: 1, lastSequence: 1 }]);
  });

  test("a failed device reply is reported and adopts nothing", async () => {
    client.setInspectReply({ success: false, error: "Prototype host destroyed" });
    const payload = await call({ action: "inspect" });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Prototype host destroyed");
    expect((await call({ action: "status" })).prototypes).toEqual([]);
  });

  test("malformed prototypes in the reply are ignored", async () => {
    client.setInspectReply({
      success: true,
      prototypes: [{ id: "", persistent: true }, reported(1)] as never,
    });
    const payload = await call({ action: "inspect" });
    expect(payload.prototypes).toMatchObject([{ id: "proto" }]);
  });

  test("events replayed while the capability probe connects are not lost", async () => {
    client.setProbeEvents([event(1, "emit", "tap")]);
    client.setInspectReply({ success: true, prototypes: [reported(1)] });
    await call({ action: "inspect" });
    const first = await call({ action: "awaitEvent", id: "proto" });
    expect([first.event?.sequence, first.event?.name]).toEqual([1, "tap"]);
    // Only the coordinator's subscription for the adopted prototype remains; the capture is gone.
    expect(client.getPrototypeListenerCount()).toBe(1);
  });

  test("the capture listener is removed when the runner lacks the capability", async () => {
    client.setSupportedCommands(["prototype_window_options_v1"]);
    await call({ action: "inspect" });
    expect(client.getPrototypeListenerCount()).toBe(0);
  });

  test("a second inspect keeps events the first one buffered and not yet awaited", async () => {
    client.setInspectReply({ success: true, prototypes: [reported(2)] }, [
      event(1, "emit", "a"),
      event(2, "emit", "b"),
    ]);
    await call({ action: "inspect" });
    client.setInspectReply({ success: true, prototypes: [reported(2)] });
    const again = await call({ action: "inspect" });
    expect(again.prototypes).toMatchObject([{ id: "proto", pendingCount: 2, lastSequence: 2 }]);
    const first = await call({ action: "awaitEvent", id: "proto" });
    expect(first.event?.name).toBe("a");
  });

  test("the reported persistence flag is carried into status", async () => {
    client.setInspectReply({ success: true, prototypes: [reported(1)] });
    expect((await call({ action: "inspect" })).prototypes).toMatchObject([
      { id: "proto", persistent: true },
    ]);
    client.setInspectReply({
      success: true,
      prototypes: [{ ...reported(1), persistent: false }],
    });
    expect((await call({ action: "inspect" })).prototypes).toMatchObject([
      { id: "proto", persistent: false },
    ]);
  });

  test("a suspended prototype is reported in status, cleared on return, and warns when awaited", async () => {
    client.setInspectReply({ success: true, prototypes: [{ ...reported(1), suspended: true }] });
    expect((await call({ action: "inspect" })).prototypes).toMatchObject([
      { id: "proto", suspended: true },
    ]);
    expect((await call({ action: "status" })).prototypes).toMatchObject([
      { id: "proto", suspended: true },
    ]);
    const waiting = call({ action: "awaitEvent", id: "proto", timeoutMs: 10 });
    fakeTimer.advanceTime(10);
    const waited = await waiting;
    expect(waited.timedOut).toBe(true);
    expect(waited.warning).toContain("hidden because the app it was shown over is not in front");

    client.setInspectReply({ success: true, prototypes: [reported(1)] });
    const visible = await call({ action: "inspect" });
    expect(visible.prototypes?.[0]).not.toHaveProperty("suspended");
    const again = call({ action: "awaitEvent", id: "proto", timeoutMs: 10 });
    fakeTimer.advanceTime(10);
    expect((await again).warning).toBeUndefined();
  });

  test("an empty report clears a prototype the device no longer shows", async () => {
    client.setInspectReply({ success: true, prototypes: [reported(1)] });
    await call({ action: "inspect" });
    expect((await call({ action: "status" })).prototypes).toHaveLength(1);

    client.setInspectReply({ success: true, prototypes: [] });
    const payload = await call({ action: "inspect" });
    expect(payload.success).toBe(true);
    expect(payload.prototypes).toEqual([]);
    expect((await call({ action: "status" })).prototypes).toEqual([]);
  });
});

describe("prototype inspect across sessions (#10494)", () => {
  test("an empty report clears the prototype another session tracked on the device", async () => {
    const restore = preserveToolRegistry();
    const timer = new FakeTimer();
    const client = new FakeCtrlProxy(timer);
    client.setSupportedCommands(["prototype_window_options_v1", "prototype_persistence_replay_v1"]);
    const unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
    });
    try {
      const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
      const run = async (session: string, input: Record<string, unknown>) =>
        runWithToolSelectionContext({ routingSessionUuid: session }, async () =>
          prototypeOutputSchema.parse((await handler(device, input)).structuredContent),
        );
      await run("session-a", {
        action: "show",
        spec: {
          id: "proto",
          window: { placement: { type: "fullscreen" } },
          root: { type: "text", text: "Hello" },
        },
      });
      expect((await run("session-a", { action: "status" })).prototypes).toHaveLength(1);

      client.setInspectReply({ success: true, prototypes: [] });
      await run("session-b", { action: "inspect" });

      expect((await run("session-a", { action: "status" })).prototypes).toEqual([]);
    } finally {
      unsubscribe();
      restore();
    }
  });
});
