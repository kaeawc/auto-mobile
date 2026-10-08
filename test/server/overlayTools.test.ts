import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  registerOverlayTools,
  overlaySchema,
  overlayOutputSchema,
} from "../../src/server/overlayTools";
import { registerHighlightTools } from "../../src/server/highlightTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { ActionableError, type BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { FakeToolSelectionRepository } from "../fakes/FakeToolSelectionRepository";
import { SessionToolSelectionService } from "../../src/features/toolSelection/SessionToolSelectionService";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { compileJsonSchema } from "../helpers/jsonSchemaCompile";
import { initializeCliTools } from "../../src/cli/cliToolRegistration";
import { registerToolSelectionTools } from "../../src/server/toolSelectionTools";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../../src/daemon/streamDeviceLifecycleEvents";
import { INTERNAL_TOOL_PARAM_NAMES } from "../../src/daemon/constants";
import { InMemoryOverlayStatusStore } from "../../src/features/overlay/OverlayStatusStore";
import { FakeOverlayEventLifecycle } from "../fakes/FakeOverlayEventLifecycle";
import { event } from "../helpers/overlayTestEvent";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { OVERLAY_EVENT_BUFFER_CAPACITY } from "../../src/features/overlay/OverlayEventBuffer";
import { composeVariantCarousel } from "../../src/features/overlay/overlayVariants";
import { DEFAULT_OVERLAY_EVENT_TIMEOUT_MS } from "../../src/features/overlay/overlayEventTimeout";

const device: BootedDevice = { deviceId: "fake-overlay", platform: "android", name: "Fake" };
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const }, opacity: 80 },
  root: { type: "text" as const, text: "Hello" },
};

describe("overlay MCP tool", () => {
  let client: FakeCtrlProxy;
  let timer: FakeTimer;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeEach(() => {
    restore = preserveToolRegistry();
    timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    unsubscribe = registerOverlayTools({ clientFactory: () => client, clock: timer, timer });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: unknown, target = device) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(target, input);
    const payload = overlayOutputSchema.parse(response.structuredContent);
    expect(JSON.parse(response.content[0].text)).toEqual(payload);
    expect(response.content.every((item: { type: string }) => item.type === "text")).toBe(true);
    return { response, payload };
  }

  const variants = [
    { image: { asset: "first" } },
    { image: { asset: "second" }, label: "Second" },
    { spec: { type: "text" as const, text: "Third" } },
  ];
  const carousel = { action: "showVariants", id: "panel", variants };
  const waiting = { ...carousel, waitForSelection: true };
  const selected = (
    payload: Parameters<FakeCtrlProxy["emitOverlayEvent"]>[0]["payload"] = {
      index: 1,
      label: "Second",
    },
  ) => ({ ...event(1, "panel", "emit", "selected"), payload, pages: { variants: 1 } });
  // Runs `act` once the selection wait has started (progress start is reported after the
  // coordinator registered its waiter), so events and aborts land during the wait.
  const duringWait = (input: unknown, act: () => void, signal?: AbortSignal) =>
    ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
      device,
      input,
      async (amount: number) => {
        if (amount === 0) {
          act();
        }
      },
      signal,
    );

  test("showVariants forwards exactly the composed spec and normal show response", async () => {
    const count = ToolRegistry.getToolDefinitions().length;
    const { payload } = await call({ ...carousel, opacity: 40, timeoutMs: 12 });
    expect(client.getOverlayHistory()).toEqual([
      {
        method: "show",
        spec: composeVariantCarousel({ id: "panel", variants, opacity: 40 }),
        timeoutMs: 12,
        perf: undefined,
      },
    ]);
    expect(payload).toEqual({
      success: true,
      lastResult: { id: "panel", lastAction: "show", success: true, timestamp: 0 },
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(ToolRegistry.getToolDefinitions()).toHaveLength(count);
    expect(ToolRegistry.getTool("showVariants")).toBeUndefined();
  });

  test("showVariants accepts floating placement through the tool", async () => {
    await call({
      ...carousel,
      presentation: "floating",
      gravity: "topCenter",
      offset: { x: 2, y: 3 },
    });
    expect(client.getOverlayHistory()[0].spec).toEqual(
      composeVariantCarousel({
        id: "panel",
        variants,
        presentation: "floating",
        gravity: "topCenter",
        offset: { x: 2, y: 3 },
      }),
    );
  });

  test.each([
    [{ action: "showVariants", variants }, "showVariants requires id"],
    [{ action: "showVariants", id: "panel" }, "showVariants requires variants"],
    [{ ...carousel, spec }, "showVariants allows"],
    [{ ...carousel, state: {} }, "showVariants allows"],
    [{ ...carousel, eventName: "selected" }, "showVariants allows"],
    [{ ...carousel, gravity: "center" }, "require showVariants presentation: floating"],
    [{ ...carousel, waitForSelection: "yes" }, "boolean"],
    [{ ...carousel, unknown: true }, "Unrecognized key"],
    [{ action: "show", spec, variants }, "show allows spec"],
    [{ action: "show", spec, waitForSelection: true }, "show allows spec"],
    [{ action: "update", id: "panel", state: {}, variants }, "update allows id, spec, state"],
    [{ action: "dismiss", id: "panel", waitForSelection: false }, "dismiss allows id, all"],
    [{ action: "status", variants }, "status allows no mutation fields"],
    [
      { action: "awaitEvent", id: "panel", waitForSelection: true },
      "awaitEvent allows id, eventName, kind, afterSequence",
    ],
  ])("showVariants action contract rejects %j", async (input, message) => {
    expect(overlaySchema.safeParse(input).success).toBe(false);
    const result = await call(input);
    expect(result.response.isError).toBe(true);
    expect(result.payload.error).toContain(message);
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("showVariants rejects an inline file path before dispatch", async () => {
    const result = await call({ ...carousel, variants: [{ image: { filePath: "mock.png" } }] });
    expect(result.response.isError).toBe(true);
    expect(result.payload.error).toContain("not accepted inside a variant");
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("showVariants ignores canonical internal request metadata", async () => {
    const metadata = Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, true]));
    const result = await call({ ...carousel, ...metadata });
    expect(result.payload.success).toBe(true);
    expect(client.getOverlayHistory()[0].spec).toEqual(
      composeVariantCarousel({ id: "panel", variants }),
    );
  });

  test("showVariants returns the pick that was acknowledged in flight", async () => {
    const show = spyOn(client, "requestShowOverlay").mockImplementation(async () => {
      client.emitOverlayEvent(selected());
      return { success: true };
    });
    try {
      const result = await call(waiting);
      expect(result.payload.selection).toEqual({ index: 1, label: "Second" });
      expect(result.payload.event).toMatchObject({
        name: "selected",
        payload: { index: 1, label: "Second" },
        pages: { variants: 1 },
      });
      expect(result.payload.pendingCount).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      show.mockRestore();
    }
  });

  test("showVariants returns the pick made during the wait and reports progress", async () => {
    const progress = mock(async (amount: number) => {
      if (amount === 0) {
        client.emitOverlayEvent({
          ...event(1, "panel", "page_changed", "selected"),
          pages: { variants: 2 },
        });
        client.emitOverlayEvent({ ...selected({ index: 2 }), sequence: 2 });
      }
    });
    const result = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
      device,
      waiting,
      progress,
    );
    const payload = overlayOutputSchema.parse(result.structuredContent);
    expect(payload.selection).toEqual({ index: 2 });
    expect(payload.lastResult?.lastAction).toBe("show");
    // The page change is still buffered: only the selected emit was consumed.
    expect(payload.pendingCount).toBe(1);
    expect(progress.mock.calls.map(([amount]) => amount)).toEqual([0, 1]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("showVariants dismissal without a pick settles with reason dismissed", async () => {
    const result = await duringWait(waiting, () =>
      client.emitOverlayEvent(event(1, "panel", "dismissed")),
    );
    expect(overlayOutputSchema.parse(result.structuredContent)).toMatchObject({
      success: true,
      reason: "dismissed",
    });
    expect(result.structuredContent).not.toHaveProperty("selection");
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("showVariants selection timeout is the default wait, independent of show timeoutMs", async () => {
    const result = await duringWait({ ...waiting, timeoutMs: 5 }, () => {
      expect(timer.getPendingTimeouts()).toEqual([DEFAULT_OVERLAY_EVENT_TIMEOUT_MS]);
      timer.advanceTime(DEFAULT_OVERLAY_EVENT_TIMEOUT_MS);
    });
    expect(overlayOutputSchema.parse(result.structuredContent)).toMatchObject({
      success: true,
      timedOut: true,
    });
    expect(result.structuredContent).not.toHaveProperty("selection");
    expect(client.getOverlayHistory()[0].timeoutMs).toBe(5);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each(["explicit", "ambient"])(
    "showVariants %s abort rejects with the reason and removes timers",
    async (source) => {
      const controller = new AbortController();
      const reason = new DOMException("Selection cancelled", "AbortError");
      const abort = () => controller.abort(reason);
      const pending =
        source === "explicit"
          ? duringWait(waiting, abort, controller.signal)
          : runWithAbortSignal(controller.signal, () => duringWait(waiting, abort));
      await expect(pending).rejects.toBe(reason);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("showVariants wait settles as dismissed on session release", async () => {
    const result = await duringWait({ ...waiting, sessionUuid: "pick" }, () =>
      SessionReleaseBroadcaster.emit("pick", "released"),
    );
    expect(overlayOutputSchema.parse(result.structuredContent)).toMatchObject({
      success: true,
      reason: "dismissed",
    });
    expect(client.getOverlayListenerCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("showVariants wait settles as dismissed on device removal", async () => {
    const result = await duringWait(waiting, () =>
      getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(device.deviceId),
    );
    expect(overlayOutputSchema.parse(result.structuredContent)).toMatchObject({
      success: true,
      reason: "dismissed",
    });
    expect(client.getOverlayListenerCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("showVariants replaces another shown overlay and settles its waiter", async () => {
    await call({ action: "show", spec: { ...spec, id: "older" } });
    const older = call({ action: "awaitEvent", id: "older" });
    await call(carousel);
    expect((await older).payload).toMatchObject({ success: true, reason: "dismissed" });
    expect((await call({ action: "status" })).payload.overlays?.map((entry) => entry.id)).toEqual([
      "panel",
    ]);
  });

  test("re-showing a carousel starts a fresh sequence epoch", async () => {
    await call(carousel);
    client.emitOverlayEvent({ ...selected(), sequence: 7 });
    await call({ action: "awaitEvent", id: "panel", eventName: "selected" });
    await call(carousel);
    const result = await duringWait(waiting, () => client.emitOverlayEvent(selected()));
    expect(overlayOutputSchema.parse(result.structuredContent).selection).toEqual({
      index: 1,
      label: "Second",
    });
  });

  test("showVariants failed show never waits", async () => {
    client.setOverlayResult({ success: false, error: "Refused" });
    const result = await call(waiting);
    expect(result.payload).toMatchObject({ success: false, error: "Refused" });
    expect(result.payload).not.toHaveProperty("selection");
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(client.getOverlayListenerCount()).toBe(0);
  });

  test.each(
    [
      null,
      [],
      "pick",
      {},
      { index: -1 },
      { index: 1.5 },
      { index: 3 },
      { index: 1, label: 3 },
      { index: 1, label: "wrong" },
      { index: 1 },
      { index: 0, label: "unexpected" },
      { index: 1, label: "Second", extra: true },
    ].map((payload) => ({ payload })),
  )("showVariants malformed selected payload fails clearly: %j", async ({ payload: invalid }) => {
    const result = await duringWait(waiting, () => client.emitOverlayEvent(selected(invalid)));
    expect(result.isError).toBe(true);
    const payload = overlayOutputSchema.parse(result.structuredContent);
    expect(payload.error).toContain("Invalid selected payload");
    expect(payload.selection).toBeUndefined();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("showVariants without waiting supports a subsequent selected awaitEvent", async () => {
    await call(carousel);
    client.emitOverlayEvent(selected());
    expect(
      (await call({ action: "awaitEvent", id: "panel", eventName: "selected" })).payload.event,
    ).toMatchObject({ payload: { index: 1, label: "Second" } });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("awaitEvent returns a buffered event immediately without a device request", async () => {
    await call({ action: "show", spec });
    client.emitOverlayEvent({
      type: "overlay_event",
      id: "panel",
      sequence: 1,
      kind: "emit",
      name: "save",
      payload: null,
      state: {},
      pages: {},
      timestamp: 1,
    });
    const { response, payload } = await call({ action: "awaitEvent", id: "panel" });
    expect(response.isError).not.toBe(true);
    expect(payload).toMatchObject({
      success: true,
      event: { id: "panel", sequence: 1 },
      pendingCount: 0,
      droppedCount: 0,
    });
    expect(client.getOverlayHistory()).toHaveLength(1);
  });

  test("awaitEvent waits with FakeTimer, times out successfully, and forwards no command", async () => {
    const waiting = call({ action: "awaitEvent", id: "panel", timeoutMs: 10 });
    timer.advanceTime(10);
    const { response, payload } = await waiting;
    expect(response.isError).not.toBe(true);
    expect(payload).toEqual({ success: true, timedOut: true, pendingCount: 0, droppedCount: 0 });
    expect(client.getOverlayHistory()).toEqual([]);
    expect(client.getOverlayListenerCount()).toBe(0);
  });

  test("awaitEvent reports progress through the existing handler callback", async () => {
    const progress = mock(async (amount: number) => {
      if (amount === 0) {
        client.emitOverlayEvent(event(1));
      }
    });
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
      device,
      { action: "awaitEvent", id: "panel" },
      progress,
    );
    expect(overlayOutputSchema.parse(response.structuredContent).event?.sequence).toBe(1);
    expect(progress.mock.calls.map(([amount]) => amount)).toEqual([0, 1]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("awaitEvent resolves an event during a wait and returns all event fields", async () => {
    const waiting = call({
      action: "awaitEvent",
      id: "panel",
      eventName: "save",
      kind: "emit",
      afterSequence: 1,
    });
    client.emitOverlayEvent(event(1));
    client.emitOverlayEvent(event(2, "panel", "page_changed", "page"));
    client.emitOverlayEvent(event(3));
    const expected = {
      id: "panel",
      sequence: 3,
      kind: "emit",
      name: "save",
      payload: { value: 3 },
      state: { title: "Hello" },
      pages: {},
      timestamp: 3,
    };
    expect((await waiting).payload.event).toEqual(expected);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each(["explicit", "ambient"])(
    "%s request abort rejects with the abort reason and cleans the wait",
    async (source) => {
      const controller = new AbortController();
      const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
      const waiting =
        source === "explicit"
          ? handler(device, { action: "awaitEvent", id: "panel" }, undefined, controller.signal)
          : runWithAbortSignal(controller.signal, () =>
              handler(device, { action: "awaitEvent", id: "panel" }),
            );
      const reason = new DOMException("Request cancelled", "AbortError");
      controller.abort(reason);
      await expect(waiting).rejects.toBe(reason);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(client.getOverlayListenerCount()).toBe(0);
    },
  );

  test("status reports counts without a device request and page changes preserve host mutation status", async () => {
    await call({ action: "show", spec });
    for (let sequence = 1; sequence <= OVERLAY_EVENT_BUFFER_CAPACITY + 1; sequence++) {
      client.emitOverlayEvent(event(sequence, "panel", "page_changed", "page"));
    }
    const history = client.getOverlayHistory();
    expect((await call({ action: "status" })).payload.overlays).toEqual([
      {
        id: "panel",
        lastAction: "show",
        success: true,
        timestamp: 0,
        pendingCount: OVERLAY_EVENT_BUFFER_CAPACITY,
        lastSequence: OVERLAY_EVENT_BUFFER_CAPACITY + 1,
        droppedCount: 1,
        pages: {},
        state: { title: "Hello" },
        lastKnown: true,
      },
    ]);
    expect(client.getOverlayHistory()).toEqual(history);
    expect((await call({ action: "awaitEvent", id: "panel" })).payload).toMatchObject({
      event: { sequence: 2 },
      droppedCount: 1,
      pendingCount: OVERLAY_EVENT_BUFFER_CAPACITY - 1,
    });
  });

  test("status retains the latest event snapshot across consumption and updates without device requests", async () => {
    await call({ action: "show", spec });
    const pushed = {
      ...event(2),
      pages: { carousel: 1, nested: 2 },
      state: { title: "Chosen", enabled: true, count: 3 },
    };
    client.emitOverlayEvent(pushed);
    client.emitOverlayEvent(event(1));
    pushed.pages.carousel = 99;
    pushed.state.title = "mutated";
    await call({ action: "awaitEvent", id: "panel" });
    await call({ action: "update", id: "panel", state: { title: "requested" } });
    const history = client.getOverlayHistory();
    const snapshot = (await call({ action: "status" })).payload.overlays?.[0];
    expect(snapshot).toMatchObject({
      pages: { carousel: 1, nested: 2 },
      state: { title: "Chosen", enabled: true, count: 3 },
      lastKnown: true,
      lastAction: "update",
    });
    expect(client.getOverlayHistory()).toEqual(history);
    await call({ action: "show", spec });
    expect((await call({ action: "status" })).payload.overlays?.[0]).not.toHaveProperty(
      "lastKnown",
    );
  });

  test("a failed replacement show preserves the shown overlay's last known state", async () => {
    await call({ action: "show", spec });
    client.emitOverlayEvent({ ...event(1), pages: { pager: 2 } });
    const show = spyOn(client, "requestShowOverlay").mockResolvedValue({
      success: false,
      error: "refused",
    });
    try {
      await call({ action: "show", spec: { ...spec, id: "replacement" } });
      expect((await call({ action: "status" })).payload.overlays?.[0]).toMatchObject({
        id: "panel",
        pages: { pager: 2 },
        state: { title: "Hello" },
        lastKnown: true,
      });
    } finally {
      show.mockRestore();
    }
  });

  test("status captures events during the show acknowledgement", async () => {
    const show = spyOn(client, "requestShowOverlay").mockImplementation(async () => {
      client.emitOverlayEvent({ ...event(1), pages: { pager: 2 } });
      return { success: true };
    });
    try {
      await call({ action: "show", spec });
      expect((await call({ action: "status" })).payload.overlays?.[0]).toMatchObject({
        pages: { pager: 2 },
        state: { title: "Hello" },
        lastKnown: true,
      });
    } finally {
      show.mockRestore();
    }
  });

  test("device-side dismissal removes status and remains deliverable", async () => {
    await call({ action: "show", spec });
    client.emitOverlayEvent(event(1, "panel", "dismissed"));
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
    expect((await call({ action: "awaitEvent", id: "panel" })).payload).toMatchObject({
      success: true,
      event: { kind: "dismissed" },
      pendingCount: 0,
    });
    expect(client.getOverlayListenerCount()).toBe(0);
  });

  test("dismissal arriving during show acknowledgement is reflected in status", async () => {
    const show = spyOn(client, "requestShowOverlay").mockImplementation(async () => {
      client.emitOverlayEvent(event(1, "panel", "dismissed"));
      return { success: true };
    });
    await call({ action: "show", spec });
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
    expect((await call({ action: "awaitEvent", id: "panel" })).payload.event?.kind).toBe(
      "dismissed",
    );
    show.mockRestore();
  });

  test("session release and device removal clear host status and listeners", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    SessionReleaseBroadcaster.emit("one", "released");
    expect(client.getOverlayListenerCount()).toBe(0);
    expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toEqual([]);
    await call({ action: "show", spec, sessionUuid: "one" });
    getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(device.deviceId);
    expect(client.getOverlayListenerCount()).toBe(0);
    expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toEqual([]);
  });

  test("explicit dismiss drops buffered events and unsubscribes", async () => {
    await call({ action: "show", spec });
    client.emitOverlayEvent(event(1));
    await call({ action: "dismiss", id: "panel" });
    expect(client.getOverlayListenerCount()).toBe(0);
    const waiting = call({ action: "awaitEvent", id: "panel", timeoutMs: 10 });
    timer.advanceTime(10);
    expect((await waiting).payload).toEqual({
      success: true,
      timedOut: true,
      pendingCount: 0,
      droppedCount: 0,
    });
  });

  test("legacy mutation responses and status without events are byte-identical", async () => {
    const show = await call({ action: "show", spec });
    const expectedShow =
      '{"success":true,"lastResult":{"id":"panel","lastAction":"show","success":true,"timestamp":0}}';
    expect(show.response.content[0].text).toBe(expectedShow);
    expect(JSON.stringify(show.response.structuredContent)).toBe(expectedShow);
    expect((await call({ action: "status" })).response.content[0].text).toBe(
      '{"success":true,"overlays":[{"id":"panel","lastAction":"show","success":true,"timestamp":0}],"lastResult":{"id":"panel","lastAction":"show","success":true,"timestamp":0}}',
    );
    expect(
      (await call({ action: "update", id: "panel", state: {} })).response.content[0].text,
    ).toBe(
      '{"success":true,"lastResult":{"id":"panel","lastAction":"update","success":true,"timestamp":0}}',
    );
    expect((await call({ action: "dismiss", all: true })).response.content[0].text).toBe(
      '{"success":true,"lastResult":{"all":true,"lastAction":"dismiss","success":true,"timestamp":0}}',
    );
  });

  test.each([
    { action: "awaitEvent" },
    { action: "awaitEvent", id: "panel", timeoutMs: 60_001 },
    { action: "awaitEvent", id: "panel", timeoutMs: 0 },
    { action: "awaitEvent", id: "panel", afterSequence: -1 },
    { action: "awaitEvent", id: "panel", afterSequence: 1.5 },
    { action: "awaitEvent", id: "panel", kind: "unknown" },
    { action: "awaitEvent", id: "panel", state: {} },
    { action: "status", afterSequence: 0 },
    { action: "show", spec, eventName: "save" },
    { action: "update", id: "panel", state: {}, kind: "emit" },
    { action: "dismiss", id: "panel", eventName: "save" },
  ])("rejects invalid wait fields %j", async (input) => {
    expect(overlaySchema.safeParse(input).success).toBe(false);
    expect((await call(input)).response.isError).toBe(true);
    expect(client.getOverlayListenerCount()).toBe(0);
  });

  test("the default session broadcaster and device-removal seam clean subscriptions", async () => {
    unsubscribe = registerOverlayTools({ clientFactory: () => client, timer });
    await call({ action: "show", spec, sessionUuid: "default-one" });
    const waiting = call({ action: "awaitEvent", id: "panel", sessionUuid: "default-one" });
    SessionReleaseBroadcaster.emit("default-one");
    expect((await waiting).payload.reason).toBe("dismissed");
    expect(client.getOverlayListenerCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    await call({ action: "show", spec, sessionUuid: "default-one" });
    getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(device.deviceId);
    expect(client.getOverlayListenerCount()).toBe(0);
    expect((await call({ action: "status", sessionUuid: "default-one" })).payload.overlays).toEqual(
      [],
    );
  });

  test("release clears old host status even after another scope takes event ownership", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec, sessionUuid: "two" });
    await call({ action: "show", spec, sessionUuid: "other" }, { ...device, deviceId: "other" });
    SessionReleaseBroadcaster.emit("one", "released");
    expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toEqual([]);
    // A release forgets every scope on the session's devices, as the status store pins.
    expect((await call({ action: "status", sessionUuid: "two" })).payload.overlays).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "other" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toHaveLength(1);
  });

  test("showing another overlay settles the replaced overlay's waiter as dismissed", async () => {
    await call({ action: "show", spec });
    const waiting = call({ action: "awaitEvent", id: "panel" });
    await call({ action: "show", spec: { ...spec, id: "second" } });
    expect((await waiting).payload).toMatchObject({ success: true, reason: "dismissed" });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    client.emitOverlayEvent(event(1, "second"));
    expect((await call({ action: "awaitEvent", id: "second" })).payload.event?.sequence).toBe(1);
  });

  test("a failed show leaves the previously shown overlay's waiter waiting", async () => {
    await call({ action: "show", spec });
    const waiting = call({ action: "awaitEvent", id: "panel", timeoutMs: 10 });
    client.setOverlayResult({ success: false, error: "Refused" });
    await call({ action: "show", spec: { ...spec, id: "second" } });
    timer.advanceTime(10);
    expect((await waiting).payload.timedOut).toBe(true);
  });

  test("release without a snapshot device clears a co-tenant's buffers, waiters and listener", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    client.emitOverlayEvent(event(1, "second"));
    const waiting = call({
      action: "awaitEvent",
      id: "second",
      afterSequence: 9,
      sessionUuid: "two",
    });
    SessionReleaseBroadcaster.emit("one", "released");
    expect((await waiting).payload.reason).toBe("dismissed");
    expect((await call({ action: "status", sessionUuid: "two" })).payload.overlays).toEqual([]);
    expect(client.getOverlayListenerCount()).toBe(0);
    const after = call({ action: "awaitEvent", id: "second", sessionUuid: "two", timeoutMs: 10 });
    timer.advanceTime(10);
    expect((await after).payload).toEqual({
      success: true,
      timedOut: true,
      pendingCount: 0,
      droppedCount: 0,
    });
  });

  test("re-showing an id after a device restart accepts its sequence 1 again", async () => {
    await call({ action: "show", spec });
    for (let sequence = 1; sequence <= 3; sequence++) {
      client.emitOverlayEvent(event(sequence));
    }
    await call({ action: "show", spec });
    client.emitOverlayEvent(event(1));
    expect((await call({ action: "awaitEvent", id: "panel" })).payload).toMatchObject({
      event: { sequence: 1 },
      lastSequence: 1,
    });
  });

  test("re-registration disposes the previous coordinator and its subscriptions", async () => {
    const lifecycle = new FakeOverlayEventLifecycle();
    unsubscribe();
    unsubscribe = registerOverlayTools({ clientFactory: () => client, timer, lifecycle });
    await call({ action: "show", spec });
    expect(client.getOverlayListenerCount()).toBe(1);
    expect(lifecycle.getListenerCount()).toBe(3);
    unsubscribe = registerOverlayTools({ clientFactory: () => client, timer });
    expect(client.getOverlayListenerCount()).toBe(0);
    expect(lifecycle.getListenerCount()).toBe(0);
  });

  test("an injected lifecycle drives session release, device removal and unbinding", async () => {
    const lifecycle = new FakeOverlayEventLifecycle();
    unsubscribe();
    unsubscribe = registerOverlayTools({ clientFactory: () => client, timer, lifecycle });
    for (const release of [
      () => lifecycle.releaseSession("one"),
      () => lifecycle.removeDevice(device.deviceId),
      () => lifecycle.unbindDevice(device.deviceId),
    ]) {
      await call({ action: "show", spec, sessionUuid: "one" });
      release();
      expect(client.getOverlayListenerCount()).toBe(0);
      expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toEqual([]);
    }
  });

  test("failed shows do not retain subscriptions and failed dismiss preserves buffered events", async () => {
    client.setOverlayResult({ success: false, error: "Refused" });
    await call({ action: "show", spec });
    expect(client.getOverlayListenerCount()).toBe(0);
    client.setOverlayResult({ success: true });
    await call({ action: "show", spec });
    client.emitOverlayEvent(event(1));
    client.setOverlayResult({ success: false, error: "Refused" });
    await call({ action: "dismiss", id: "panel" });
    expect(client.getOverlayListenerCount()).toBe(1);
    expect((await call({ action: "awaitEvent", id: "panel" })).payload.event?.sequence).toBe(1);
  });

  test("a terminal event removes all host sessions' shown records for its device/id", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec, sessionUuid: "two" });
    client.emitOverlayEvent(event(1, "panel", "dismissed"));
    expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toEqual([]);
    expect((await call({ action: "status", sessionUuid: "two" })).payload.overlays).toEqual([]);
    expect(
      (await call({ action: "awaitEvent", id: "panel", sessionUuid: "two" })).payload.event?.kind,
    ).toBe("dismissed");
  });

  test("registering overlay preserves an existing highlight registration", () => {
    registerHighlightTools();
    const highlight = ToolRegistry.getTool("highlight");
    const unsubscribeReplacement = registerOverlayTools({
      clientFactory: () => client,
      clock: timer,
    });
    unsubscribeReplacement();
    expect(ToolRegistry.getTool("highlight")).toBe(highlight);
  });

  test("replacement registration retires lifecycle subscriptions for the previous store", () => {
    const oldStore = new InMemoryOverlayStatusStore(timer);
    const newStore = new InMemoryOverlayStatusStore(timer);
    const scope = { deviceId: device.deviceId, sessionUuid: "one" };
    oldStore.record(scope, "show", { id: "old" }, { success: true });
    newStore.record(scope, "show", { id: "new" }, { success: true });
    const unsubscribeOld = registerOverlayTools({ clientFactory: () => client, store: oldStore });
    unsubscribe = registerOverlayTools({ clientFactory: () => client, store: newStore });
    // A stale disposer must not detach the replacement's listeners.
    unsubscribeOld();
    SessionReleaseBroadcaster.emit("one", "released");
    getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(device.deviceId);
    expect(oldStore.status(scope).overlays.map((entry) => entry.id)).toEqual(["old"]);
    expect(newStore.status(scope)).toEqual({ overlays: [] });
  });

  test("ambient routing session scopes local status when input omits sessionUuid", async () => {
    await runWithToolSelectionContext({ routingSessionUuid: "ambient" }, async () => {
      await call({ action: "show", spec });
      expect((await call({ action: "status" })).payload.overlays).toHaveLength(1);
    });
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "ambient" })).payload.overlays,
    ).toHaveLength(1);
  });

  test("show forwards valid spec unchanged and status stays local", async () => {
    await call({ action: "show", spec, sessionUuid: "session", timeoutMs: 50 });
    expect(client.getOverlayHistory()).toEqual([
      { method: "show", spec, timeoutMs: 50, perf: undefined },
    ]);
    timer.advanceTime(12);
    const { payload } = await call({ action: "status", sessionUuid: "session" });
    expect(payload.overlays).toEqual([
      { id: "panel", lastAction: "show", success: true, timestamp: 0 },
    ]);
    expect(payload.lastResult).toEqual(payload.overlays![0]);
    expect(client.getOverlayHistory()).toHaveLength(1);
  });

  test("omitted opacity uses the existing spec default", async () => {
    await call({ action: "show", spec: { ...spec, window: { placement: spec.window.placement } } });
    expect(client.getOverlayHistory()[0].spec?.window).toEqual({
      placement: spec.window.placement,
    });
  });

  test("successful show replaces the previous id, which status no longer offers for dismissal", async () => {
    await call({ action: "show", spec });
    await call({ action: "show", spec: { ...spec, id: "second" } });
    const status = (await call({ action: "status" })).payload;
    expect(status.overlays?.map((entry) => entry.id)).toEqual(["second"]);
    client.setOverlayResult({ success: false, error: "Unknown overlay id" });
    await call({ action: "dismiss", id: "panel" });
    expect((await call({ action: "status" })).payload.overlays?.map((entry) => entry.id)).toEqual([
      "second",
    ]);
  });

  test("successful show replaces presence across sessions on only that device", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec, sessionUuid: "one" }, { ...device, deviceId: "other" });
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "two" })).payload.overlays?.map(
        (entry) => entry.id,
      ),
    ).toEqual(["second"]);
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toHaveLength(1);
  });

  test("session release forgets all device scopes but preserves unrelated devices", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    await call({ action: "show", spec, sessionUuid: "other" }, { ...device, deviceId: "other" });
    SessionReleaseBroadcaster.emit("one", "released");
    expect((await call({ action: "status", sessionUuid: "one" })).payload).toEqual({
      success: true,
      overlays: [],
    });
    expect((await call({ action: "status", sessionUuid: "two" })).payload).toEqual({
      success: true,
      overlays: [],
    });
    expect(
      (await call({ action: "status", sessionUuid: "other" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toHaveLength(1);
  });

  test("device removal forgets every scope for that device", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    await call({ action: "show", spec, sessionUuid: "one" }, { ...device, deviceId: "other" });
    getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(device.deviceId);
    for (const sessionUuid of ["one", "two"]) {
      expect((await call({ action: "status", sessionUuid })).payload).toEqual({
        success: true,
        overlays: [],
      });
    }
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toHaveLength(1);
  });

  test("canonical metadata is stripped only from tool input, preserving authored state keys", async () => {
    const state = Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, "authored"]));
    const metadata = Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, true]));
    const authored = { ...spec, state };
    expect((await call({ action: "show", spec: authored, ...metadata })).payload.success).toBe(
      true,
    );
    await call({ action: "update", id: "panel", state, ...metadata });
    expect(client.getOverlayHistory()[0].spec).toEqual(authored);
    expect(client.getOverlayHistory()[1].update).toEqual({ id: "panel", state });
    expect(state).toEqual(
      Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, "authored"])),
    );
  });

  test("failed replacement preserves presence and lastResult for an existing scope", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    client.setOverlayResult({ success: false, error: "Service refused" });
    const failed = await call({
      action: "show",
      spec: { ...spec, id: "second" },
      sessionUuid: "one",
    });
    const status = (await call({ action: "status", sessionUuid: "one" })).payload;
    expect(status.overlays?.map((entry) => entry.id)).toEqual(["panel"]);
    expect(status.lastResult).toEqual(failed.payload.lastResult);
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    expect(
      (await call({ action: "status", sessionUuid: "two" })).payload.lastResult,
    ).toBeUndefined();
    expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toHaveLength(1);
  });

  test("a reserved name in authored state is still validated", async () => {
    const state = { [INTERNAL_TOOL_PARAM_NAMES[0]]: { invalid: true } };
    expect((await call({ action: "update", id: "panel", state })).response.isError).toBe(true);
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("release snapshot clears unscoped device entries even without session history", async () => {
    await call({ action: "show", spec });
    SessionReleaseBroadcaster.emit("unrecorded-session", "released", {
      sessionId: "unrecorded-session",
      deviceId: device.deviceId,
      releaseReason: "released",
      releasedAtMs: timer.now(),
      terminal: true,
      heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: true, timeoutMs: 50, ageMs: 0 },
    });
    expect((await call({ action: "status" })).payload).toEqual({ success: true, overlays: [] });
  });

  test("update spec and state, dismiss id and all update local status", async () => {
    await call({ action: "show", spec });
    timer.advanceTime(5);
    const replacement = { ...spec, window: { ...spec.window, opacity: 30 } };
    await call({ action: "update", id: "panel", spec: replacement });
    expect(client.getOverlayHistory()[1].update).toEqual({ id: "panel", spec: replacement });
    await call({ action: "update", id: "panel", state: { title: "Updated", enabled: true } });
    expect(client.getOverlayHistory()[2].update).toEqual({
      id: "panel",
      state: { title: "Updated", enabled: true },
    });
    expect((await call({ action: "status" })).payload.overlays).toEqual([
      { id: "panel", lastAction: "update", success: true, timestamp: 5 },
    ]);
    await call({ action: "dismiss", id: "panel" });
    expect(client.getOverlayHistory()[3].target).toEqual({ id: "panel" });
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
    await call({ action: "show", spec });
    await call({ action: "show", spec: { ...spec, id: "second" } });
    await call({ action: "dismiss", all: true });
    expect(client.getOverlayHistory().at(-1)?.target).toEqual({ all: true });
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
  });

  test("status isolates device and session and never invents shows on update", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    expect((await call({ action: "status", sessionUuid: "two" })).payload.overlays).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toEqual([]);
    await call({ action: "show", spec, sessionUuid: "one" }, { ...device, deviceId: "other" });
    await call({ action: "dismiss", all: true, sessionUuid: "two" });
    expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toHaveLength(1);
    await call({ action: "update", id: "unknown", state: {} });
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
  });

  test("dismiss by id removes that device's known id across sessions", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec, sessionUuid: "two" });
    await call({ action: "show", spec, sessionUuid: "one" }, { ...device, deviceId: "other" });
    await call({ action: "dismiss", id: "panel", sessionUuid: "two" });
    expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toEqual([]);
    expect((await call({ action: "status", sessionUuid: "two" })).payload.overlays).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toHaveLength(1);
  });

  test.each(["show", "update", "dismiss", "status", "awaitEvent"])(
    "iOS %s fails with Android-only guidance",
    async (action) => {
      const input =
        action === "show"
          ? { action, spec }
          : action === "update"
            ? { action, id: "panel", state: {} }
            : action === "dismiss"
              ? { action, all: true }
              : action === "awaitEvent"
                ? { action, id: "panel" }
                : { action };
      const { response, payload } = await call(input, { ...device, platform: "ios" });
      expect(response.isError).toBe(true);
      expect(payload.error).toContain("Android only");
      expect(client.getOverlayHistory()).toEqual([]);
    },
  );

  test.each([
    [{ ...spec, root: { type: "unknown" } }, "root.type", "text"],
    [{ ...spec, window: { ...spec.window, opacity: 101 } }, "window.opacity", "100"],
    [{ ...spec, root: { type: "icon", name: "unknown" } }, "root", "Unknown overlay icon name"],
    [{ ...spec, root: { ...spec.root, unknown: true } }, "root.unknown", "Unknown property"],
  ])("invalid spec rejected before client call", async (invalid, path, allowed) => {
    const input = { action: "show", spec: invalid };
    expect(overlaySchema.safeParse(input).success).toBe(false);
    const { response, payload } = await call(input);
    expect(response.isError).toBe(true);
    expect(payload.error).toContain(path);
    expect(payload.error).toContain(allowed);
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test.each([
    { action: "show" },
    { action: "show", spec, state: {} },
    { action: "update", id: "panel" },
    { action: "update", id: "panel", spec, state: {} },
    { action: "update", id: "different", spec },
    { action: "update", id: "panel", state: { nested: {} } },
    { action: "dismiss", id: "panel", all: true },
    { action: "dismiss" },
    { action: "status", id: "panel" },
  ])("action contract rejects ambiguous input %j", async (input) => {
    expect(overlaySchema.safeParse(input).success).toBe(false);
    expect((await call(input)).response.isError).toBe(true);
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("failed show has lastResult but is not shown; failed update/dismiss preserve presence", async () => {
    client.setOverlayResult({ success: false, error: "Permission denied; enable accessibility" });
    const failed = await call({ action: "show", spec });
    expect(failed.response.isError).toBe(true);
    expect(failed.payload.error).toContain("enable accessibility");
    let status = (await call({ action: "status" })).payload;
    expect(status.overlays).toEqual([]);
    expect(status.lastResult).toBeUndefined();
    expect(failed.payload.lastResult?.success).toBe(false);
    client.setOverlayResult({ success: true });
    await call({ action: "show", spec });
    client.setOverlayResult({ success: false, error: "Service refused" });
    await call({ action: "update", id: "panel", state: {} });
    status = (await call({ action: "status" })).payload;
    expect(status.overlays![0]).toMatchObject({
      lastAction: "update",
      success: false,
      error: "Service refused",
    });
    await call({ action: "dismiss", all: true });
    expect((await call({ action: "status" })).payload.overlays).toHaveLength(1);
  });

  test("unsupported capability ActionableError surfaces unchanged", async () => {
    const message =
      "show_overlay: this CtrlProxy build does not support overlays; update the connected CtrlProxy.";
    client.setFailureMode("requestShowOverlay", new ActionableError(message));
    const { response, payload } = await call({ action: "show", spec });
    expect(response.isError).toBe(true);
    expect(payload.error).toBe(message);
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
  });

  test("default off mirrors highlight; setToolEnabled enables discovery without changing highlight", async () => {
    registerHighlightTools();
    registerToolSelectionTools();
    const overlay = ToolRegistry.getTool("prototype")!;
    expect(overlay.defaultEnabled).toBe(false);
    expect(ToolRegistry.getTool("highlight")!.defaultEnabled).toBe(false);
    expect(ToolRegistry.getConfigurableToolNames()).toContain("prototype");
    const selection = new SessionToolSelectionService(new FakeToolSelectionRepository());
    await runWithToolSelectionContext(
      { toolSelectionProfileUuid: "profile", sessionToolSelectionService: selection },
      async () => {
        expect(await selection.isEnabled("profile", "prototype", overlay.defaultEnabled)).toBe(
          false,
        );
        const response = await ToolRegistry.getTool("setToolEnabled")!.handler({
          toolName: "prototype",
          enabled: true,
        });
        expect(response.isError).not.toBe(true);
        expect(await selection.isEnabled("profile", "prototype", false)).toBe(true);
        expect(await selection.isEnabled("profile", "highlight", false)).toBe(false);
      },
    );
  });
});

describe("overlay discovery over MCP", () => {
  let fixture: McpTestFixture;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeAll(async () => {
    restore = installHermeticServerFixture();
    fixture = new McpTestFixture();
    await fixture.setup();
    ToolRegistry.clearTools();
    unsubscribe = registerOverlayTools();
    registerHighlightTools();
    registerToolSelectionTools();
  });
  afterAll(async () => {
    unsubscribe();
    await fixture.teardown();
    restore();
  });

  test("omitted by default, enabled through setToolEnabled, then disabled", async () => {
    const names = async () => (await fixture.client.listTools()).tools.map((tool) => tool.name);
    expect(await names()).not.toContain("prototype");
    const enabled = await fixture.client.callTool({
      name: "setToolEnabled",
      arguments: { toolName: "prototype", enabled: true },
    });
    expect(enabled.isError).not.toBe(true);
    expect(await names()).toContain("prototype");
    expect(await names()).not.toContain("highlight");
    const disabled = await fixture.client.callTool({
      name: "setToolEnabled",
      arguments: { toolName: "prototype", enabled: false },
    });
    expect(disabled.isError).not.toBe(true);
    expect(await names()).not.toContain("prototype");
  });
});

describe("overlay CLI and advertised schema registration", () => {
  let restore: () => void;
  let definition: ReturnType<typeof ToolRegistry.getToolDefinitions>[number];
  beforeAll(() => {
    restore = preserveToolRegistry();
    ToolRegistry.clearTools();
    initializeCliTools();
    definition = ToolRegistry.getToolDefinitions().find((tool) => tool.name === "prototype")!;
    compileJsonSchema(definition.inputSchema);
    compileJsonSchema(definition.outputSchema);
  });
  afterAll(() => restore());
  test("overlay stays a hidden deprecated alias sharing the prototype schema", () => {
    const alias = ToolRegistry.getRegisteredTool("overlay")!;
    expect(alias.hidden).toBe(true);
    expect(alias.defaultEnabled).toBe(false);
    expect(alias.schema).toBe(ToolRegistry.getRegisteredTool("prototype")!.schema);
    expect(ToolRegistry.getToolDefinitions().map((tool) => tool.name)).not.toContain("overlay");
  });
  test("CLI registers prototype default-off alongside unchanged highlight", () => {
    expect(ToolRegistry.getTool("prototype")!.defaultEnabled).toBe(false);
    expect(ToolRegistry.getTool("highlight")!.defaultEnabled).toBe(false);
    expect(definition.name).toBe("prototype");
    expect(definition.outputSchema).toBeDefined();
  });
});
