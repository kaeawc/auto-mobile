import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  overlayOutputSchema,
  overlaySchema,
  registerOverlayTools,
  type OverlayEventLifecycle,
} from "../../src/server/overlayTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import type { OverlayEvent } from "../../src/features/observe/android/ctrlProxyProtocol";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const event = (
  sequence: number,
  kind: OverlayEvent["kind"],
  name: string | null,
  overrides: Partial<OverlayEvent> = {},
): OverlayEvent => ({
  type: "overlay_event",
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

describe("overlay inspect (#10494)", () => {
  let client: FakeCtrlProxy;
  let restore: () => void;
  let unsubscribe: () => void;
  let releaseSession: (sessionUuid: string, deviceId?: string) => void = () => {};

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands(["overlay_window_options_v1", "overlay_persistence_replay_v1"]);
    const lifecycle: OverlayEventLifecycle = {
      subscribeSessionRelease: (listener) => {
        releaseSession = listener;
        return () => {};
      },
      subscribeDeviceRemoval: () => () => {},
      subscribeDeviceUnbound: () => () => {},
    };
    unsubscribe = registerOverlayTools({
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
    const handler = ToolRegistry.getTool("overlay")!.deviceAwareHandler!;
    const response = await handler(device, input);
    return overlayOutputSchema.parse(response.structuredContent);
  }

  test("inspect is an argument-free action", () => {
    expect(overlaySchema.safeParse({ action: "inspect" }).success).toBe(true);
    expect(overlaySchema.safeParse({ action: "inspect", id: "proto" }).success).toBe(false);
  });

  test("a device without overlay_persistence_replay_v1 gets a clear error and nothing is sent", async () => {
    client.setSupportedCommands(["overlay_window_options_v1"]);
    const payload = await call({ action: "inspect" });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("overlay_persistence_replay_v1");
    expect(client.getInspectCount()).toBe(0);
  });

  test("status is empty after a session release, and inspect brings the persisted overlay back", async () => {
    await call({
      action: "show",
      spec: {
        id: "proto",
        window: { placement: { type: "fullscreen" }, persistence: "device" },
        root: { type: "text", text: "Hello" },
      },
    });
    releaseSession("session-1", device.deviceId);
    expect((await call({ action: "status" })).overlays).toEqual([]);

    client.setInspectReply({ success: true, overlays: [reported(5)], droppedEvents: 2 });
    const payload = await call({ action: "inspect" });

    expect(payload.success).toBe(true);
    expect(payload.deviceDroppedEvents).toBe(2);
    expect(payload.overlays).toMatchObject([
      {
        id: "proto",
        adopted: true,
        pages: { pager: 1 },
        state: { label: "typed" },
        lastKnown: true,
        lastSequence: 5,
      },
    ]);
    // The adopted overlay now shows in a plain status call, with no further device request.
    const status = await call({ action: "status" });
    expect(status.overlays).toMatchObject([{ id: "proto", adopted: true, lastSequence: 5 }]);
    expect(client.getInspectCount()).toBe(1);
  });

  test("events the device buffered offline are delivered to awaitEvent in order", async () => {
    client.setInspectReply({ success: true, overlays: [reported(3)] }, [
      event(1, "emit", "tap"),
      event(2, "page_changed", null),
      event(3, "emit", "change"),
    ]);
    const inspected = await call({ action: "inspect" });
    expect(inspected.overlays).toMatchObject([{ id: "proto", pendingCount: 3, lastSequence: 3 }]);

    const first = await call({ action: "awaitEvent", id: "proto" });
    expect([first.event?.sequence, first.event?.name]).toEqual([1, "tap"]);
    const second = await call({ action: "awaitEvent", id: "proto", kind: "page_changed" });
    expect(second.event?.sequence).toBe(2);
    const third = await call({ action: "awaitEvent", id: "proto", afterSequence: 2 });
    expect(third.event?.name).toBe("change");
  });

  test("a device buffer overflow shows as deviceDroppedEvents and a sequence gap", async () => {
    client.setInspectReply({ success: true, overlays: [reported(9)], droppedEvents: 6 }, [
      event(7, "emit", "a"),
      event(8, "emit", "b"),
      event(9, "emit", "c"),
    ]);
    const payload = await call({ action: "inspect" });
    expect(payload.deviceDroppedEvents).toBe(6);
    const first = await call({ action: "awaitEvent", id: "proto" });
    expect(first.event?.sequence).toBe(7);
  });

  test("an overlay dismissed while no host was connected still delivers its terminal event", async () => {
    client.setInspectReply({ success: true, overlays: [] }, [
      event(1, "emit", "tap"),
      event(2, "dismissed", null, { payload: { reason: "user" } }),
    ]);
    const payload = await call({ action: "inspect" });
    expect(payload.overlays).toEqual([]);

    const first = await call({ action: "awaitEvent", id: "proto" });
    expect(first.event?.name).toBe("tap");
    const terminal = await call({ action: "awaitEvent", id: "proto", kind: "dismissed" });
    expect(terminal.event?.kind).toBe("dismissed");
  });

  test("replayed events a second inspect sends again are not delivered twice", async () => {
    client.setInspectReply({ success: true, overlays: [reported(1)] }, [event(1, "emit", "tap")]);
    await call({ action: "inspect" });
    const second = await call({ action: "inspect" });
    expect(second.overlays).toMatchObject([{ id: "proto", pendingCount: 1, lastSequence: 1 }]);
  });

  test("a failed device reply is reported and adopts nothing", async () => {
    client.setInspectReply({ success: false, error: "Overlay host destroyed" });
    const payload = await call({ action: "inspect" });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Overlay host destroyed");
    expect((await call({ action: "status" })).overlays).toEqual([]);
  });

  test("malformed overlays in the reply are ignored", async () => {
    client.setInspectReply({
      success: true,
      overlays: [{ id: "", persistent: true }, reported(1)] as never,
    });
    const payload = await call({ action: "inspect" });
    expect(payload.overlays).toMatchObject([{ id: "proto" }]);
  });
});
