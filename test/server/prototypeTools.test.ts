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
import { PROTOTYPE_SHOW_IN_PLACE_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
import {
  registerPrototypeTools,
  prototypeSchema,
  prototypeOutputSchema,
} from "../../src/server/prototypeTools";
import { registerHighlightTools } from "../../src/server/highlightTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { ActionableError, type BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { FakeToolSelectionRepository } from "../fakes/FakeToolSelectionRepository";
import { SessionToolSelectionService } from "../../src/features/toolSelection/SessionToolSelectionService";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { McpTestFixture, precompileMcpOutputSchemas } from "../fixtures/mcpTestFixture";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { compileAjv2020, compileJsonSchema } from "../helpers/jsonSchemaCompile";
import { initializeCliTools } from "../../src/cli/cliToolRegistration";
import { registerToolSelectionTools } from "../../src/server/toolSelectionTools";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../../src/daemon/streamDeviceLifecycleEvents";
import { INTERNAL_TOOL_PARAM_NAMES } from "../../src/daemon/constants";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import { FakePrototypeEventLifecycle } from "../fakes/FakePrototypeEventLifecycle";
import { event } from "../helpers/prototypeTestEvent";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { PROTOTYPE_EVENT_BUFFER_CAPACITY } from "../../src/features/prototype/PrototypeEventBuffer";
import { getRemovedToolActionHint } from "../../src/models/removedTools";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";

const device: BootedDevice = { deviceId: "fake-prototype", platform: "android", name: "Fake" };
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const }, opacity: 80 },
  root: { type: "text" as const, text: "Hello" },
};

describe("prototype MCP tool", () => {
  let client: FakeCtrlProxy;
  let timer: FakeTimer;
  let restore: () => void;
  let unsubscribe: () => void;
  let invalidator: FakeDeviceWindowCacheInvalidator;
  beforeEach(() => {
    restore = preserveToolRegistry();
    timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands([PROTOTYPE_SHOW_IN_PLACE_CAPABILITY]);
    invalidator = new FakeDeviceWindowCacheInvalidator();
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      clock: timer,
      timer,
      cacheInvalidator: invalidator,
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: unknown, target = device) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(target, input);
    const payload = prototypeOutputSchema.parse(response.structuredContent);
    expect(JSON.parse(response.content[0].text)).toEqual(payload);
    expect(response.content.every((item: { type: string }) => item.type === "text")).toBe(true);
    return { response, payload };
  }

  test.each([
    ["showVariants", { action: "showVariants", id: "panel", variants: [] }],
    ["update", { action: "update", id: "panel", state: { title: "x" } }],
  ])("removed %s action is refused with the replacement before dispatch", async (action, input) => {
    expect(prototypeSchema.safeParse(input).success).toBe(false);
    const { response, payload } = await call(input);
    expect(response.isError).toBe(true);
    expect(payload.error).toContain(getRemovedToolActionHint("prototype", action)!);
    expect(payload.error).toContain("use show");
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test("a landed show or dismiss retires the device's cached observation; status and failures do not", async () => {
    const preserved: (boolean | undefined)[] = [];
    unsubscribe();
    invalidator = new FakeDeviceWindowCacheInvalidator((_device, keep) => preserved.push(keep));
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      clock: timer,
      timer,
      cacheInvalidator: invalidator,
    });
    await call({ action: "show", spec });
    await call({ action: "status" });
    await call({ action: "dismiss", id: "panel" });
    expect(invalidator.calls).toEqual([device, device]);
    expect(preserved).toEqual([true, true]);
    client.setPrototypeResult({ success: false, error: "Refused" });
    await call({ action: "show", spec });
    await call({ action: "dismiss", all: true });
    expect(invalidator.calls).toHaveLength(2);
  });

  test("an unknown action names the supported actions", async () => {
    const { payload } = await call({ action: "explode" });
    expect(payload.error).toContain("show, dismiss, status, inspect or awaitEvent");
  });

  test.each([
    [{ action: "show", spec, variants: [] }, "Unrecognized key"],
    [{ action: "show", spec, waitForSelection: true }, "Unrecognized key"],
    [{ action: "show", spec, state: {} }, "Unrecognized key"],
    [{ action: "show", spec, reset: "yes" }, "boolean"],
    [{ action: "dismiss", id: "panel", reset: true }, "dismiss allows id, all"],
    [{ action: "status", reset: false }, "status allows no mutation fields"],
    [
      { action: "awaitEvent", id: "panel", display: "inner" },
      "awaitEvent allows id, eventName, kind, afterSequence",
    ],
  ])("action contract rejects %j", async (input, message) => {
    expect(prototypeSchema.safeParse(input).success).toBe(false);
    const result = await call(input);
    expect(result.response.isError).toBe(true);
    expect(result.payload.error).toContain(message);
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test("a spec with components is expanded on the host before it is sent (#11053)", async () => {
    const authored = {
      id: "panel",
      window: { placement: { type: "fullscreen" as const } },
      components: { greeting: { root: { type: "text", text: "Hello {props.name}" } } },
      root: { type: "use", component: "greeting", props: { name: "Ada" } },
    };
    const { payload } = await call({ action: "show", spec: authored });
    expect(payload.success).toBe(true);
    expect(client.getPrototypeHistory()).toEqual([
      {
        method: "show",
        spec: {
          id: "panel",
          window: { placement: { type: "fullscreen" } },
          root: { type: "text", text: "Hello Ada" },
        },
        timeoutMs: 5000,
        perf: undefined,
      },
    ]);
    const missing = await call({
      action: "show",
      spec: { ...authored, root: { type: "use", component: "greeting" } },
    });
    expect(missing.payload.error).toContain(
      "Invalid prototype at spec.root.props: Missing component prop",
    );
    expect(missing.payload.error).not.toContain("invalid_union_discriminator");
    expect(client.getPrototypeHistory()).toHaveLength(1);
  });

  test("a same-id show is forwarded as a show and keeps one shown entry", async () => {
    await call({ action: "show", spec });
    timer.advanceTime(5);
    const replacement = { ...spec, window: { ...spec.window, opacity: 30 } };
    const { payload } = await call({ action: "show", spec: replacement });
    expect(payload).toEqual({
      success: true,
      lastResult: { id: "panel", lastAction: "show", success: true, timestamp: 5 },
    });
    expect(client.getPrototypeHistory()).toEqual([
      { method: "show", spec, timeoutMs: 5000, perf: undefined },
      { method: "show", spec: replacement, timeoutMs: 5000, perf: undefined },
    ]);
    expect((await call({ action: "status" })).payload.prototypes).toEqual([
      { id: "panel", lastAction: "show", success: true, timestamp: 5 },
    ]);
  });

  test("a same-id show on a CtrlProxy without in-place show warns that pages restarted (#10642)", async () => {
    client.setSupportedCommands([]);
    await call({ action: "show", spec });
    expect((await call({ action: "show", spec: { ...spec, id: "other" } })).payload.warning).toBe(
      undefined,
    );
    const { payload } = await call({ action: "show", spec: { ...spec, id: "other" } });
    expect(payload.success).toBe(true);
    expect(payload.warning).toContain(PROTOTYPE_SHOW_IN_PLACE_CAPABILITY);
    expect(payload.warning).toContain("pager pages restarted");
    expect(client.getPrototypeHistory()).toHaveLength(3);
    // reset: true asks for a fresh show, which every CtrlProxy gives, so nothing to warn about.
    expect((await call({ action: "show", spec, reset: true })).payload.warning).toBeUndefined();
  });

  test("a refused same-id show on a CtrlProxy without in-place show does not warn", async () => {
    client.setSupportedCommands([]);
    await call({ action: "show", spec });
    client.setPrototypeResult({ success: false, error: "rejected" });
    const { payload } = await call({ action: "show", spec });
    expect(payload.success).toBe(false);
    expect(payload.warning).toBeUndefined();
  });

  test.each([true, false])("reset %p is forwarded only as the caller wrote it", async (reset) => {
    await call({ action: "show", spec });
    await call({ action: "show", spec, reset });
    expect(client.getPrototypeHistory()[1]).toEqual({
      method: "show",
      spec,
      timeoutMs: 5000,
      perf: undefined,
      reset,
    });
  });

  test("awaitEvent returns a buffered event immediately without a device request", async () => {
    await call({ action: "show", spec });
    client.emitPrototypeEvent({
      type: "prototype_event",
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
    expect(client.getPrototypeHistory()).toHaveLength(1);
  });

  test("awaitEvent waits with FakeTimer, times out successfully, and forwards no command", async () => {
    const waiting = call({ action: "awaitEvent", id: "panel", timeoutMs: 10 });
    timer.advanceTime(10);
    const { response, payload } = await waiting;
    expect(response.isError).not.toBe(true);
    expect(payload).toEqual({ success: true, timedOut: true, pendingCount: 0, droppedCount: 0 });
    expect(client.getPrototypeHistory()).toEqual([]);
    expect(client.getPrototypeListenerCount()).toBe(0);
  });

  test("awaitEvent reports progress through the existing handler callback", async () => {
    const progress = mock(async (amount: number) => {
      if (amount === 0) {
        client.emitPrototypeEvent(event(1));
      }
    });
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
      device,
      { action: "awaitEvent", id: "panel" },
      progress,
    );
    expect(prototypeOutputSchema.parse(response.structuredContent).event?.sequence).toBe(1);
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
    client.emitPrototypeEvent(event(1));
    client.emitPrototypeEvent(event(2, "panel", "page_changed", "page"));
    client.emitPrototypeEvent(event(3));
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
      expect(client.getPrototypeListenerCount()).toBe(0);
    },
  );

  test("status reports counts without a device request and page changes preserve host mutation status", async () => {
    await call({ action: "show", spec });
    for (let sequence = 1; sequence <= PROTOTYPE_EVENT_BUFFER_CAPACITY + 1; sequence++) {
      client.emitPrototypeEvent(event(sequence, "panel", "page_changed", "page"));
    }
    const history = client.getPrototypeHistory();
    expect((await call({ action: "status" })).payload.prototypes).toEqual([
      {
        id: "panel",
        lastAction: "show",
        success: true,
        timestamp: 0,
        pendingCount: PROTOTYPE_EVENT_BUFFER_CAPACITY,
        lastSequence: PROTOTYPE_EVENT_BUFFER_CAPACITY + 1,
        droppedCount: 1,
        pages: {},
        state: { title: "Hello" },
        lastKnown: true,
      },
    ]);
    expect(client.getPrototypeHistory()).toEqual(history);
    expect((await call({ action: "awaitEvent", id: "panel" })).payload).toMatchObject({
      event: { sequence: 2 },
      droppedCount: 1,
      pendingCount: PROTOTYPE_EVENT_BUFFER_CAPACITY - 1,
    });
  });

  test("status retains the latest event snapshot across consumption without device requests", async () => {
    await call({ action: "show", spec });
    const pushed = {
      ...event(2),
      pages: { carousel: 1, nested: 2 },
      state: { title: "Chosen", enabled: true, count: 3 },
    };
    client.emitPrototypeEvent(pushed);
    client.emitPrototypeEvent(event(1));
    pushed.pages.carousel = 99;
    pushed.state.title = "mutated";
    await call({ action: "awaitEvent", id: "panel" });
    const history = client.getPrototypeHistory();
    const snapshot = (await call({ action: "status" })).payload.prototypes?.[0];
    expect(snapshot).toMatchObject({
      pages: { carousel: 1, nested: 2 },
      state: { title: "Chosen", enabled: true, count: 3 },
      lastKnown: true,
      lastAction: "show",
    });
    expect(client.getPrototypeHistory()).toEqual(history);
    await call({ action: "show", spec });
    expect((await call({ action: "status" })).payload.prototypes?.[0]).not.toHaveProperty(
      "lastKnown",
    );
  });

  test("a failed same-id show keeps the events buffered before it", async () => {
    await call({ action: "show", spec });
    client.emitPrototypeEvent(event(1));
    const show = spyOn(client, "requestShowPrototype").mockResolvedValue({
      success: false,
      error: "refused",
    });
    try {
      await call({ action: "show", spec });
    } finally {
      show.mockRestore();
    }
    const { payload } = await call({ action: "awaitEvent", id: "panel" });
    expect(payload).toMatchObject({ success: true, event: { id: "panel", sequence: 1 } });
  });

  test("a failed replacement show preserves the shown prototype's last known state", async () => {
    await call({ action: "show", spec });
    client.emitPrototypeEvent({ ...event(1), pages: { pager: 2 } });
    const show = spyOn(client, "requestShowPrototype").mockResolvedValue({
      success: false,
      error: "refused",
    });
    try {
      await call({ action: "show", spec: { ...spec, id: "replacement" } });
      expect((await call({ action: "status" })).payload.prototypes?.[0]).toMatchObject({
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
    const show = spyOn(client, "requestShowPrototype").mockImplementation(async () => {
      client.emitPrototypeEvent({ ...event(1), pages: { pager: 2 } });
      return { success: true };
    });
    try {
      await call({ action: "show", spec });
      expect((await call({ action: "status" })).payload.prototypes?.[0]).toMatchObject({
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
    client.emitPrototypeEvent(event(1, "panel", "dismissed"));
    expect((await call({ action: "status" })).payload.prototypes).toEqual([]);
    expect((await call({ action: "awaitEvent", id: "panel" })).payload).toMatchObject({
      success: true,
      event: { kind: "dismissed" },
      pendingCount: 0,
    });
    expect(client.getPrototypeListenerCount()).toBe(0);
  });

  test("dismissal arriving during show acknowledgement is reflected in status", async () => {
    const show = spyOn(client, "requestShowPrototype").mockImplementation(async () => {
      client.emitPrototypeEvent(event(1, "panel", "dismissed"));
      return { success: true };
    });
    await call({ action: "show", spec });
    expect((await call({ action: "status" })).payload.prototypes).toEqual([]);
    expect((await call({ action: "awaitEvent", id: "panel" })).payload.event?.kind).toBe(
      "dismissed",
    );
    show.mockRestore();
  });

  test("session release and device removal clear host status and listeners", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    SessionReleaseBroadcaster.emit("one", "released");
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect((await call({ action: "status", sessionUuid: "one" })).payload.prototypes).toEqual([]);
    await call({ action: "show", spec, sessionUuid: "one" });
    getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(device.deviceId);
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect((await call({ action: "status", sessionUuid: "one" })).payload.prototypes).toEqual([]);
  });

  test("explicit dismiss drops buffered events and unsubscribes", async () => {
    await call({ action: "show", spec });
    client.emitPrototypeEvent(event(1));
    await call({ action: "dismiss", id: "panel" });
    expect(client.getPrototypeListenerCount()).toBe(0);
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
      '{"success":true,"prototypes":[{"id":"panel","lastAction":"show","success":true,"timestamp":0}],"lastResult":{"id":"panel","lastAction":"show","success":true,"timestamp":0}}',
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
    { action: "show", spec, kind: "emit" },
    { action: "dismiss", id: "panel", eventName: "save" },
  ])("rejects invalid wait fields %j", async (input) => {
    expect(prototypeSchema.safeParse(input).success).toBe(false);
    expect((await call(input)).response.isError).toBe(true);
    expect(client.getPrototypeListenerCount()).toBe(0);
  });

  test("the default session broadcaster and device-removal seam clean subscriptions", async () => {
    unsubscribe = registerPrototypeTools({ clientFactory: () => client, timer });
    await call({ action: "show", spec, sessionUuid: "default-one" });
    const waiting = call({ action: "awaitEvent", id: "panel", sessionUuid: "default-one" });
    SessionReleaseBroadcaster.emit("default-one");
    expect((await waiting).payload.reason).toBe("dismissed");
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    await call({ action: "show", spec, sessionUuid: "default-one" });
    getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(device.deviceId);
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect(
      (await call({ action: "status", sessionUuid: "default-one" })).payload.prototypes,
    ).toEqual([]);
  });

  test("release clears old host status even after another scope takes event ownership", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec, sessionUuid: "two" });
    await call({ action: "show", spec, sessionUuid: "other" }, { ...device, deviceId: "other" });
    SessionReleaseBroadcaster.emit("one", "released");
    expect((await call({ action: "status", sessionUuid: "one" })).payload.prototypes).toEqual([]);
    // A release forgets every scope on the session's devices, as the status store pins.
    expect((await call({ action: "status", sessionUuid: "two" })).payload.prototypes).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "other" }, { ...device, deviceId: "other" }))
        .payload.prototypes,
    ).toHaveLength(1);
  });

  test("showing another prototype settles the replaced prototype's waiter as dismissed", async () => {
    await call({ action: "show", spec });
    const waiting = call({ action: "awaitEvent", id: "panel" });
    await call({ action: "show", spec: { ...spec, id: "second" } });
    expect((await waiting).payload).toMatchObject({ success: true, reason: "dismissed" });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    client.emitPrototypeEvent(event(1, "second"));
    expect((await call({ action: "awaitEvent", id: "second" })).payload.event?.sequence).toBe(1);
  });

  test("a failed show leaves the previously shown prototype's waiter waiting", async () => {
    await call({ action: "show", spec });
    const waiting = call({ action: "awaitEvent", id: "panel", timeoutMs: 10 });
    client.setPrototypeResult({ success: false, error: "Refused" });
    await call({ action: "show", spec: { ...spec, id: "second" } });
    timer.advanceTime(10);
    expect((await waiting).payload.timedOut).toBe(true);
  });

  test("release without a snapshot device clears a co-tenant's buffers, waiters and listener", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    client.emitPrototypeEvent(event(1, "second"));
    const waiting = call({
      action: "awaitEvent",
      id: "second",
      afterSequence: 9,
      sessionUuid: "two",
    });
    SessionReleaseBroadcaster.emit("one", "released");
    expect((await waiting).payload.reason).toBe("dismissed");
    expect((await call({ action: "status", sessionUuid: "two" })).payload.prototypes).toEqual([]);
    expect(client.getPrototypeListenerCount()).toBe(0);
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
      client.emitPrototypeEvent(event(sequence));
    }
    await call({ action: "show", spec });
    client.emitPrototypeEvent(event(1));
    expect((await call({ action: "awaitEvent", id: "panel" })).payload).toMatchObject({
      event: { sequence: 1 },
      lastSequence: 1,
    });
  });

  test("re-registration disposes the previous coordinator and its subscriptions", async () => {
    const lifecycle = new FakePrototypeEventLifecycle();
    unsubscribe();
    unsubscribe = registerPrototypeTools({ clientFactory: () => client, timer, lifecycle });
    await call({ action: "show", spec });
    expect(client.getPrototypeListenerCount()).toBe(1);
    expect(lifecycle.getListenerCount()).toBe(3);
    unsubscribe = registerPrototypeTools({ clientFactory: () => client, timer });
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect(lifecycle.getListenerCount()).toBe(0);
  });

  test("a second MCP connection's registration keeps the daemon's status and pending events", async () => {
    unsubscribe();
    const connection = { clientFactory: () => client, cacheInvalidator: invalidator };
    const firstConnection = registerPrototypeTools(connection);
    await call({ action: "show", spec, sessionUuid: "one" });
    client.emitPrototypeEvent(event(1, "panel", "emit", "save"));
    unsubscribe = registerPrototypeTools(connection);
    // The first connection closing must not wipe what the second one now reads.
    firstConnection();
    const status = (await call({ action: "status", sessionUuid: "one" })).payload;
    expect(status.prototypes).toEqual([
      expect.objectContaining({ id: "panel", lastAction: "show", pendingCount: 1 }),
    ]);
    const awaited = await call({ action: "awaitEvent", id: "panel", sessionUuid: "one" });
    expect(awaited.payload.event).toMatchObject({ sequence: 1, name: "save" });
    client.emitPrototypeEvent(event(2, "panel", "emit", "again"));
    expect(
      (await call({ action: "awaitEvent", id: "panel", sessionUuid: "one" })).payload.event,
    ).toMatchObject({ sequence: 2 });
    expect(client.getPrototypeListenerCount()).toBe(1);
  });

  test("an injected lifecycle drives session release, device removal and unbinding", async () => {
    const lifecycle = new FakePrototypeEventLifecycle();
    unsubscribe();
    unsubscribe = registerPrototypeTools({ clientFactory: () => client, timer, lifecycle });
    for (const release of [
      () => lifecycle.releaseSession("one"),
      () => lifecycle.removeDevice(device.deviceId),
      () => lifecycle.unbindDevice(device.deviceId),
    ]) {
      await call({ action: "show", spec, sessionUuid: "one" });
      release();
      expect(client.getPrototypeListenerCount()).toBe(0);
      expect((await call({ action: "status", sessionUuid: "one" })).payload.prototypes).toEqual([]);
    }
  });

  test("a host created before daemon init still clears status when a device is unbound after init", async () => {
    const lifecycle = new FakePrototypeEventLifecycle();
    // The daemon host is created by the first registration, before DaemonState initialises.
    lifecycle.setDeviceUnboundAvailable(false);
    unsubscribe();
    unsubscribe = registerPrototypeTools({ clientFactory: () => client, timer, lifecycle });
    expect(lifecycle.getDeviceUnboundListenerCount()).toBe(0);
    lifecycle.setDeviceUnboundAvailable(true);
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "status", sessionUuid: "one" });
    // Exactly one unbound subscription, however many calls follow initialisation.
    expect(lifecycle.getDeviceUnboundListenerCount()).toBe(1);
    const callsAfterSubscribe = lifecycle.getDeviceUnboundSubscribeCalls();
    await call({ action: "status", sessionUuid: "one" });
    expect(lifecycle.getDeviceUnboundSubscribeCalls()).toBe(callsAfterSubscribe);
    lifecycle.unbindDevice(device.deviceId);
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect((await call({ action: "status", sessionUuid: "one" })).payload.prototypes).toEqual([]);
    unsubscribe();
    expect(lifecycle.getListenerCount()).toBe(0);
  });

  test("re-subscribes device-unbound cleanup when DaemonState is re-initialised (#10715)", async () => {
    const lifecycle = new FakePrototypeEventLifecycle();
    unsubscribe();
    unsubscribe = registerPrototypeTools({ clientFactory: () => client, timer, lifecycle });
    expect(lifecycle.getDeviceUnboundListenerCount()).toBe(1);
    lifecycle.reinitialiseDeviceUnboundSource();
    await call({ action: "show", spec, sessionUuid: "one" });
    // The stale subscription to the old session manager is dropped, not kept alongside.
    expect(lifecycle.getDeviceUnboundListenerCount()).toBe(1);
    lifecycle.unbindDevice(device.deviceId);
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect((await call({ action: "status", sessionUuid: "one" })).payload.prototypes).toEqual([]);
    unsubscribe();
    expect(lifecycle.getListenerCount()).toBe(0);
  });

  test("drops device-unbound cleanup while DaemonState is reset (#10715)", async () => {
    const lifecycle = new FakePrototypeEventLifecycle();
    unsubscribe();
    unsubscribe = registerPrototypeTools({ clientFactory: () => client, timer, lifecycle });
    lifecycle.setDeviceUnboundAvailable(false);
    await call({ action: "status", sessionUuid: "one" });
    expect(lifecycle.getDeviceUnboundListenerCount()).toBe(0);
    unsubscribe();
  });

  test("failed shows do not retain subscriptions and failed dismiss preserves buffered events", async () => {
    client.setPrototypeResult({ success: false, error: "Refused" });
    await call({ action: "show", spec });
    expect(client.getPrototypeListenerCount()).toBe(0);
    client.setPrototypeResult({ success: true });
    await call({ action: "show", spec });
    client.emitPrototypeEvent(event(1));
    client.setPrototypeResult({ success: false, error: "Refused" });
    await call({ action: "dismiss", id: "panel" });
    expect(client.getPrototypeListenerCount()).toBe(1);
    expect((await call({ action: "awaitEvent", id: "panel" })).payload.event?.sequence).toBe(1);
  });

  test("a terminal event removes all host sessions' shown records for its device/id", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec, sessionUuid: "two" });
    client.emitPrototypeEvent(event(1, "panel", "dismissed"));
    expect((await call({ action: "status", sessionUuid: "one" })).payload.prototypes).toEqual([]);
    expect((await call({ action: "status", sessionUuid: "two" })).payload.prototypes).toEqual([]);
    expect(
      (await call({ action: "awaitEvent", id: "panel", sessionUuid: "two" })).payload.event?.kind,
    ).toBe("dismissed");
  });

  test("registering prototype preserves an existing highlight registration", () => {
    registerHighlightTools();
    const highlight = ToolRegistry.getTool("highlight");
    const unsubscribeReplacement = registerPrototypeTools({
      clientFactory: () => client,
      clock: timer,
    });
    unsubscribeReplacement();
    expect(ToolRegistry.getTool("highlight")).toBe(highlight);
  });

  test("replacement registration retires lifecycle subscriptions for the previous store", () => {
    const oldStore = new InMemoryPrototypeStatusStore(timer);
    const newStore = new InMemoryPrototypeStatusStore(timer);
    const scope = { deviceId: device.deviceId, sessionUuid: "one" };
    oldStore.record(scope, "show", { id: "old" }, { success: true });
    newStore.record(scope, "show", { id: "new" }, { success: true });
    const unsubscribeOld = registerPrototypeTools({ clientFactory: () => client, store: oldStore });
    unsubscribe = registerPrototypeTools({ clientFactory: () => client, store: newStore });
    // A stale disposer must not detach the replacement's listeners.
    unsubscribeOld();
    SessionReleaseBroadcaster.emit("one", "released");
    getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(device.deviceId);
    expect(oldStore.status(scope).prototypes.map((entry) => entry.id)).toEqual(["old"]);
    expect(newStore.status(scope)).toEqual({ prototypes: [] });
  });

  test("ambient routing session scopes local status when input omits sessionUuid", async () => {
    await runWithToolSelectionContext({ routingSessionUuid: "ambient" }, async () => {
      await call({ action: "show", spec });
      expect((await call({ action: "status" })).payload.prototypes).toHaveLength(1);
    });
    expect((await call({ action: "status" })).payload.prototypes).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "ambient" })).payload.prototypes,
    ).toHaveLength(1);
  });

  test("show forwards valid spec unchanged and status stays local", async () => {
    await call({ action: "show", spec, sessionUuid: "session", timeoutMs: 50 });
    expect(client.getPrototypeHistory()).toEqual([
      { method: "show", spec, timeoutMs: 50, perf: undefined },
    ]);
    timer.advanceTime(12);
    const { payload } = await call({ action: "status", sessionUuid: "session" });
    expect(payload.prototypes).toEqual([
      { id: "panel", lastAction: "show", success: true, timestamp: 0 },
    ]);
    expect(payload.lastResult).toEqual(payload.prototypes![0]);
    expect(client.getPrototypeHistory()).toHaveLength(1);
  });

  test("omitted opacity uses the existing spec default", async () => {
    await call({ action: "show", spec: { ...spec, window: { placement: spec.window.placement } } });
    expect(client.getPrototypeHistory()[0].spec?.window).toEqual({
      placement: spec.window.placement,
    });
  });

  test("successful show replaces the previous id, which status no longer offers for dismissal", async () => {
    await call({ action: "show", spec });
    await call({ action: "show", spec: { ...spec, id: "second" } });
    const status = (await call({ action: "status" })).payload;
    expect(status.prototypes?.map((entry) => entry.id)).toEqual(["second"]);
    client.setPrototypeResult({ success: false, error: "Unknown prototype id" });
    await call({ action: "dismiss", id: "panel" });
    expect((await call({ action: "status" })).payload.prototypes?.map((entry) => entry.id)).toEqual(
      ["second"],
    );
  });

  test("successful show replaces presence across sessions on only that device", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec, sessionUuid: "one" }, { ...device, deviceId: "other" });
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    expect((await call({ action: "status", sessionUuid: "one" })).payload.prototypes).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "two" })).payload.prototypes?.map(
        (entry) => entry.id,
      ),
    ).toEqual(["second"]);
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.prototypes,
    ).toHaveLength(1);
  });

  test("session release forgets all device scopes but preserves unrelated devices", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    await call({ action: "show", spec, sessionUuid: "other" }, { ...device, deviceId: "other" });
    SessionReleaseBroadcaster.emit("one", "released");
    expect((await call({ action: "status", sessionUuid: "one" })).payload).toEqual({
      success: true,
      prototypes: [],
    });
    expect((await call({ action: "status", sessionUuid: "two" })).payload).toEqual({
      success: true,
      prototypes: [],
    });
    expect(
      (await call({ action: "status", sessionUuid: "other" }, { ...device, deviceId: "other" }))
        .payload.prototypes,
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
        prototypes: [],
      });
    }
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.prototypes,
    ).toHaveLength(1);
  });

  test("canonical metadata is stripped only from tool input, preserving authored state keys", async () => {
    const state = Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, "authored"]));
    const metadata = Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, true]));
    const authored = { ...spec, state };
    expect((await call({ action: "show", spec: authored, ...metadata })).payload.success).toBe(
      true,
    );
    expect(client.getPrototypeHistory()[0].spec).toEqual(authored);
    expect(state).toEqual(
      Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, "authored"])),
    );
  });

  test("failed replacement preserves presence and lastResult for an existing scope", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    client.setPrototypeResult({ success: false, error: "Service refused" });
    const failed = await call({
      action: "show",
      spec: { ...spec, id: "second" },
      sessionUuid: "one",
    });
    const status = (await call({ action: "status", sessionUuid: "one" })).payload;
    expect(status.prototypes?.map((entry) => entry.id)).toEqual(["panel"]);
    expect(status.lastResult).toEqual(failed.payload.lastResult);
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    expect(
      (await call({ action: "status", sessionUuid: "two" })).payload.lastResult,
    ).toBeUndefined();
    expect((await call({ action: "status", sessionUuid: "one" })).payload.prototypes).toHaveLength(
      1,
    );
  });

  test("a reserved name in authored state is still validated", async () => {
    const state = { [INTERNAL_TOOL_PARAM_NAMES[0]]: { invalid: true } };
    expect((await call({ action: "show", spec: { ...spec, state } })).response.isError).toBe(true);
    expect(client.getPrototypeHistory()).toEqual([]);
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
    expect((await call({ action: "status" })).payload).toEqual({ success: true, prototypes: [] });
  });

  test("an upgrade-only re-announcement keeps the device's next owner's prototype state (#11206)", async () => {
    await call({ action: "show", spec });
    SessionReleaseBroadcaster.emit(
      "earlier-owner",
      "explicit-release",
      {
        sessionId: "earlier-owner",
        deviceId: device.deviceId,
        releaseReason: "explicit-release",
        releasedAtMs: timer.now(),
        terminal: true,
        heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: true, timeoutMs: 50, ageMs: 0 },
      },
      { upgradeOnly: true },
    );
    expect((await call({ action: "status" })).payload.prototypes).toHaveLength(1);
  });

  test("dismiss id and all update local status", async () => {
    await call({ action: "show", spec });
    await call({ action: "dismiss", id: "panel" });
    expect(client.getPrototypeHistory()[1].target).toEqual({ id: "panel" });
    expect((await call({ action: "status" })).payload.prototypes).toEqual([]);
    await call({ action: "show", spec });
    await call({ action: "show", spec: { ...spec, id: "second" } });
    await call({ action: "dismiss", all: true });
    expect(client.getPrototypeHistory().at(-1)?.target).toEqual({ all: true });
    expect((await call({ action: "status" })).payload.prototypes).toEqual([]);
  });

  test("status isolates device and session and never invents shows on dismiss", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    expect((await call({ action: "status", sessionUuid: "two" })).payload.prototypes).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.prototypes,
    ).toEqual([]);
    await call({ action: "show", spec, sessionUuid: "one" }, { ...device, deviceId: "other" });
    await call({ action: "dismiss", all: true, sessionUuid: "two" });
    expect((await call({ action: "status", sessionUuid: "one" })).payload.prototypes).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.prototypes,
    ).toHaveLength(1);
    client.setPrototypeResult({ success: false, error: "Unknown prototype id: unknown" });
    await call({ action: "dismiss", id: "unknown" });
    expect((await call({ action: "status" })).payload.prototypes).toEqual([]);
  });

  test("dismiss by id removes that device's known id across sessions", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec, sessionUuid: "two" });
    await call({ action: "show", spec, sessionUuid: "one" }, { ...device, deviceId: "other" });
    await call({ action: "dismiss", id: "panel", sessionUuid: "two" });
    expect((await call({ action: "status", sessionUuid: "one" })).payload.prototypes).toEqual([]);
    expect((await call({ action: "status", sessionUuid: "two" })).payload.prototypes).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.prototypes,
    ).toHaveLength(1);
  });

  test.each([
    [{ action: "show", spec }, "launchApp with prototype: true"],
    [{ action: "dismiss", all: true }, "launchApp with prototype: true"],
    [{ action: "awaitEvent", id: "panel" }, "launchApp with prototype: true"],
    [{ action: "show", spec, reset: true }, "launchApp with prototype: true"],
  ])("iOS %o without an injected agent never reaches CtrlProxy", async (input, guidance) => {
    const { response, payload } = await call(input, { ...device, platform: "ios" });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain(guidance);
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test.each([
    [{ ...spec, root: { type: "unknown" } }, "root.type", "text"],
    [{ ...spec, window: { ...spec.window, opacity: 101 } }, "window.opacity", "100"],
    [{ ...spec, root: { type: "icon", name: "unknown" } }, "root", "Unknown prototype icon name"],
    [{ ...spec, root: { ...spec.root, unknown: true } }, "root.unknown", "Unknown property"],
  ])("invalid spec rejected before client call", async (invalid, path, allowed) => {
    const input = { action: "show", spec: invalid };
    expect(prototypeSchema.safeParse(input).success).toBe(false);
    const { response, payload } = await call(input);
    expect(response.isError).toBe(true);
    expect(payload.error).toContain(path);
    expect(payload.error).toContain(allowed);
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test.each([
    { action: "show" },
    { action: "show", spec, state: {} },
    { action: "show", spec, id: "panel" },
    { action: "dismiss", id: "panel", all: true },
    { action: "dismiss" },
    { action: "status", id: "panel" },
  ])("action contract rejects ambiguous input %j", async (input) => {
    expect(prototypeSchema.safeParse(input).success).toBe(false);
    expect((await call(input)).response.isError).toBe(true);
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test("failed show has lastResult but is not shown; failed same-id show/dismiss preserve presence", async () => {
    client.setPrototypeResult({ success: false, error: "Permission denied; enable accessibility" });
    const failed = await call({ action: "show", spec });
    expect(failed.response.isError).toBe(true);
    expect(failed.payload.error).toContain("enable accessibility");
    let status = (await call({ action: "status" })).payload;
    expect(status.prototypes).toEqual([]);
    expect(status.lastResult).toBeUndefined();
    expect(failed.payload.lastResult?.success).toBe(false);
    client.setPrototypeResult({ success: true });
    await call({ action: "show", spec });
    client.setPrototypeResult({ success: false, error: "Service refused" });
    await call({ action: "show", spec });
    status = (await call({ action: "status" })).payload;
    expect(status.prototypes![0]).toMatchObject({
      lastAction: "show",
      success: false,
      error: "Service refused",
    });
    await call({ action: "dismiss", all: true });
    expect((await call({ action: "status" })).payload.prototypes).toHaveLength(1);
  });

  test("unsupported capability ActionableError surfaces unchanged", async () => {
    const message =
      "show_prototype: this CtrlProxy build does not support prototypes; update the connected CtrlProxy.";
    client.setFailureMode("requestShowPrototype", new ActionableError(message));
    const { response, payload } = await call({ action: "show", spec });
    expect(response.isError).toBe(true);
    expect(payload.error).toBe(message);
    expect((await call({ action: "status" })).payload.prototypes).toEqual([]);
  });

  test("default off mirrors highlight; setToolEnabled enables discovery without changing highlight", async () => {
    registerHighlightTools();
    registerToolSelectionTools();
    const prototype = ToolRegistry.getTool("prototype")!;
    expect(prototype.defaultEnabled).toBe(false);
    expect(ToolRegistry.getTool("highlight")!.defaultEnabled).toBe(false);
    expect(ToolRegistry.getConfigurableToolNames()).toContain("prototype");
    const selection = new SessionToolSelectionService(new FakeToolSelectionRepository());
    await runWithToolSelectionContext(
      { toolSelectionProfileUuid: "profile", sessionToolSelectionService: selection },
      async () => {
        expect(await selection.isEnabled("profile", "prototype", prototype.defaultEnabled)).toBe(
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

describe("prototype discovery over MCP", () => {
  let fixture: McpTestFixture;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeAll(async () => {
    restore = installHermeticServerFixture();
    fixture = new McpTestFixture();
    await fixture.setup();
    ToolRegistry.clearTools();
    unsubscribe = registerPrototypeTools();
    registerHighlightTools();
    registerToolSelectionTools();
    // Compile the advertised output schemas once here, not on the test's first re-list.
    precompileMcpOutputSchemas(
      ToolRegistry.getToolDefinitions().map((definition) => definition.outputSchema),
    );
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

describe("prototype CLI and advertised schema registration", () => {
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
  test("the former overlay tool name is not registered (hard cut)", () => {
    expect(ToolRegistry.getRegisteredTool("overlay")).toBeUndefined();
  });
  test("CLI registers prototype default-off alongside unchanged highlight", () => {
    expect(ToolRegistry.getTool("prototype")!.defaultEnabled).toBe(false);
    expect(ToolRegistry.getTool("highlight")!.defaultEnabled).toBe(false);
    expect(definition.name).toBe("prototype");
    expect(definition.outputSchema).toBeDefined();
  });
  test("the advertised spec accepts a components map and use nodes in any child slot", () => {
    const validate = compileAjv2020(definition.inputSchema);
    const show = (spec: unknown) => validate({ action: "show", spec });
    const authored = {
      id: "panel",
      window: { placement: { type: "fullscreen" } },
      components: { row: { root: { type: "text", text: "{props.label}" } } },
      root: {
        type: "column",
        children: [{ type: "use", component: "row", props: { label: "A" } }],
      },
    };
    expect(show(authored)).toBe(true);
    expect(show({ ...authored, components: { row: { root: authored.root, extra: 1 } } })).toBe(
      false,
    );
    expect(show({ ...authored, root: { type: "use", component: "row", props: { a: [1] } } })).toBe(
      false,
    );
  });
  test("the advertised theme objects reject empty objects like the validator does", () => {
    type Node = { minProperties?: number; properties: Record<string, Node> };
    const root = definition.inputSchema as unknown as Node;
    const theme = root.properties.spec.properties.theme;
    expect(theme.minProperties).toBe(1);
    expect(theme.properties.colors.minProperties).toBe(1);
  });
});
