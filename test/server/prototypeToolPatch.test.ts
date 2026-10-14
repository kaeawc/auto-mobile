import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  PROTOTYPE_PATCH_CAPABILITY,
  PROTOTYPE_DATA_MODEL_CAPABILITY,
  type PrototypeResult,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import { prototypePatchUnsupportedMessage } from "../../src/features/prototype/prototypePatchWire";
import type { PrototypePatchReply } from "../../src/features/prototype/prototypePatchWire";
import { MAX_PROTOTYPE_SPEC_BYTES } from "../../src/features/prototype/prototypeSpec";
import {
  prototypeOutputSchema,
  prototypeSchema,
  registerPrototypeTools,
  type PrototypeEventLifecycle,
} from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import {
  FakePrototypeAgentClient,
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
} from "../fakes/FakePrototypeAgentClient";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { event } from "../helpers/prototypeTestEvent";

const android: BootedDevice = { deviceId: "patch-android", platform: "android", name: "Fake" };
const ios: BootedDevice = { deviceId: "patch-ios", platform: "ios", name: "Fake" };
const spec = {
  id: "orders",
  window: { placement: { type: "fullscreen" } },
  data: { cartCount: 1 },
  state: { liked: false },
  root: { type: "column", children: [{ type: "text", id: "label", text: "Hello" }] },
};
const replace = [{ op: "replace", path: "/data/cartCount", value: 2 }];
const check = [{ op: "test", path: "/data/cartCount", value: 2 }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
// Drain deterministic promise continuations; no timers or host processes.
async function drain() {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

describe("prototype patch host", () => {
  let proxy: FakeCtrlProxy;
  let agent: FakePrototypeAgentClient;
  let store: InMemoryPrototypeStatusStore;
  let timer: FakeTimer;
  let restore: () => void;
  let unsubscribe: () => void;
  let releaseSession: (session: string, device?: string) => void;
  let removeDevice: (device: string) => void;
  function setup() {
    timer = new FakeTimer();
    proxy = new FakeCtrlProxy(timer);
    proxy.setSupportedCommands([
      PROTOTYPE_PATCH_CAPABILITY,
      PROTOTYPE_DATA_MODEL_CAPABILITY,
      "prototype_persistence_replay_v1",
      "prototype_show_in_place_v1",
    ]);
    agent = new FakePrototypeAgentClient({
      agentVersion: "test",
      protocolVersion: 1,
      capabilities: [
        ...FAKE_PROTOTYPE_AGENT_CAPABILITIES,
        PROTOTYPE_PATCH_CAPABILITY,
        PROTOTYPE_DATA_MODEL_CAPABILITY,
      ],
    });
    store = new InMemoryPrototypeStatusStore(timer);
    const lifecycle: PrototypeEventLifecycle = {
      subscribeSessionRelease: (listener) => {
        releaseSession = listener;
        return () => {};
      },
      subscribeDeviceRemoval: (listener) => {
        removeDevice = listener;
        return () => {};
      },
      subscribeDeviceUnbound: () => () => {},
    };
    unsubscribe = registerPrototypeTools({
      clientFactory: () => proxy,
      agentConnections: { get: () => agent },
      store,
      timer,
      clock: timer,
      lifecycle,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
  }
  async function call(input: unknown, device = android) {
    const result = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return prototypeOutputSchema.parse(result.structuredContent);
  }
  const show = (device = android) => call({ action: "show", spec }, device);
  const patch = (ops: unknown = replace, extra: Record<string, unknown> = {}, device = android) =>
    call({ action: "patch", id: "orders", ops, ...extra }, device);
  beforeAll(async () => {
    const undo = preserveToolRegistry();
    setup();
    try {
      await show();
      await patch();
      await show(ios);
      await patch(replace, {}, ios);
    } finally {
      unsubscribe();
      undo();
    }
  });
  beforeEach(() => {
    restore = preserveToolRegistry();
    setup();
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  test.each([android, ios])(
    "$platform capability refusal precedes tracking and op validation",
    async (device) => {
      proxy.setSupportedCommands([]);
      agent.handshake.capabilities.splice(0);
      for (const ops of [replace, [{ op: "replace", path: "bad" }]]) {
        expect(await patch(ops, {}, device)).toEqual({
          success: false,
          error: prototypePatchUnsupportedMessage(
            device.platform === "android" ? "android" : "ios",
          ),
        });
      }
      expect(proxy.patchRequests).toEqual([]);
      expect(agent.requests).toEqual([]);
    },
  );
  test.each([android, ios])(
    "$platform advances the copy and status data without changing lastResult",
    async (device) => {
      expect((await show(device)).success).toBe(true);
      const before = await call({ action: "status" }, device);
      expect(await patch(replace, {}, device)).toEqual({ success: true });
      const requests = device === android ? proxy.patchRequests : agent.patchRequests;
      expect(requests).toEqual([{ id: "orders", ops: replace }]);
      const after = await call({ action: "status" }, device);
      expect(after.prototypes?.[0].data).toEqual({ cartCount: 2 });
      expect(after.lastResult).toEqual(before.lastResult);
      expect((await patch(check, {}, device)).success).toBe(true);
      const count = requests.length;
      expect(
        (await patch([{ op: "test", path: "/data/cartCount", value: 1 }], {}, device)).error,
      ).toBe("Invalid patch at ops[0].value: Test failed");
      expect(requests.length).toBe(count);
    },
  );
  test("tracking requires a show and successful dismiss and terminal events remove it", async () => {
    expect((await patch()).error).toContain("not tracking its spec");
    await show();
    await call({ action: "dismiss", id: "orders" });
    expect((await patch()).error).toContain("not tracking its spec");
    await show();
    proxy.emitPrototypeEvent({ ...event(1), id: "orders", kind: "dismissed" });
    expect((await patch()).error).toContain("not tracking its spec");
    expect(proxy.patchRequests).toEqual([]);
  });
  test("inspect retains only the same tracked id", async () => {
    await show();
    proxy.setInspectReply({
      success: true,
      prototypes: [{ id: "orders", persistent: false, pages: {}, state: {}, lastSequence: 0 }],
    });
    await call({ action: "inspect" });
    expect((await patch()).success).toBe(true);
    proxy.setInspectReply({
      success: true,
      prototypes: [{ id: "different", persistent: false, pages: {}, state: {}, lastSequence: 0 }],
    });
    await call({ action: "inspect" });
    expect((await patch()).error).toContain("not tracking its spec");
  });
  test.each(["release", "remove"])("%s lifecycle forgets the spec", async (hook) => {
    await show();
    if (hook === "release") {
      releaseSession("session", android.deviceId);
    } else {
      removeDevice(android.deviceId);
    }
    expect((await patch()).error).toContain("not tracking its spec");
  });
  test("host op and whole-result validation leave the copy unchanged", async () => {
    await show();
    expect((await patch([{ op: "replace", path: "invalid", value: 0 }])).error).toBe(
      "Invalid patch at ops[0].path: Patch paths start with /data or /state",
    );
    const invalid = await patch([
      { op: "replaceNode", id: "label", node: { id: "label", type: "nonsense" } },
    ]);
    expect(invalid.error).toStartWith("Invalid patch result at spec.root.children[0].type:");
    expect(proxy.patchRequests).toEqual([]);
    expect((await patch([{ op: "test", path: "/data/cartCount", value: 1 }])).success).toBe(true);
  });
  test("state requires baseRevision and leaves state tests to the device", async () => {
    await show();
    const ops = [{ op: "test", path: "/state/liked", value: true }];
    expect((await patch(ops)).error).toBe(
      "Invalid patch at baseRevision: required when a patch has /state ops",
    );
    expect((await patch(ops, { baseRevision: 12 })).success).toBe(true);
    expect(proxy.patchRequests).toEqual([{ id: "orders", ops, baseRevision: 12 }]);
  });
  test("success revision and atomic conflict reply; malformed fields are dropped", async () => {
    await show();
    proxy.setPatchResult({ success: true, revision: 13 });
    expect(await patch()).toEqual({ success: true, revision: 13 });
    const conflict = { revision: 14, state: { liked: true } };
    proxy.setPatchResult({ success: false, error: "conflict", conflict });
    expect(await patch([{ op: "replace", path: "/data/cartCount", value: 3 }])).toEqual({
      success: false,
      error: "conflict",
      conflict,
    });
    proxy.setPatchResult({
      success: true,
      revision: -1,
      conflict: { revision: 1, state: { "bad-key": true } },
    });
    expect(await patch(check)).toEqual({ success: true });
  });
  test("Android timeout forgets tracking and never exposes delivery", async () => {
    await show();
    const timeout = {
      success: false,
      error: "prototype_result timed out after 50ms",
      delivery: "indeterminate",
    };
    proxy.setPatchResult(timeout);
    const output = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(android, {
      action: "patch",
      id: "orders",
      ops: replace,
    });
    expect(output.structuredContent).not.toHaveProperty("delivery");
    expect(prototypeOutputSchema.parse(output.structuredContent).error).toEndWith(
      " The device may or may not have applied the patch: show the prototype again before the next patch.",
    );
    proxy.setPatchResult({ success: true });
    expect((await patch()).error).toContain("not tracking its spec");
    await show();
    expect((await patch()).success).toBe(true);
  });
  test("Android patch timeout distrusts a pending same-id show until a new show", async () => {
    await show();
    const heldPatch = deferred<PrototypePatchReply>();
    const heldShow = deferred<PrototypeResult>();
    proxy.holdPatchReply(heldPatch.promise);
    const patching = patch(replace, { timeoutMs: 50 });
    await drain();
    expect(proxy.patchRequests).toHaveLength(1);
    proxy.holdShowReply(heldShow.promise);
    const showing = call({ action: "show", spec: { ...spec, data: { cartCount: 3 } } });
    await drain();
    expect(proxy.getPrototypeHistory()).toHaveLength(2);
    timer.setTimeout(() => {
      heldPatch.resolve({
        success: false,
        delivery: "indeterminate",
        error: "prototype_result timed out after 50ms",
      });
    }, 50);
    timer.advanceTime(49);
    expect(store.shownSpecs.read(android.deviceId, "orders")).toEqual({ kind: "busy" });
    timer.advanceTime(1);
    expect((await patching).error).toBe(
      "prototype_result timed out after 50ms The device may or may not have applied the patch: show the prototype again before the next patch.",
    );
    heldShow.resolve({ success: true });
    expect((await showing).success).toBe(true);
    expect((await patch()).error).toContain("not tracking its spec");
    expect(proxy.patchRequests).toHaveLength(1);
    expect((await show()).success).toBe(true);
    expect((await patch()).success).toBe(true);
    expect(proxy.patchRequests).toHaveLength(2);
  });
  test("unsent and answered failures keep tracking", async () => {
    await show();
    for (const delivery of ["unsent", "answered"] as const) {
      const refusal = {
        success: false,
        error: delivery === "unsent" ? "Not connected" : "refused",
        delivery,
      };
      proxy.setPatchResult(refusal);
      expect(await patch()).toEqual({ success: false, error: refusal.error });
      proxy.setPatchResult({ success: true });
      expect((await patch([{ op: "test", path: "/data/cartCount", value: 1 }])).success).toBe(true);
    }
  });
  test("iOS rejection after dispatch forgets tracking", async () => {
    await show(ios);
    agent.setPatchResult(new Error("socket closed"));
    expect((await patch(replace, {}, ios)).error).toEndWith(
      " The device may or may not have applied the patch: show the prototype again before the next patch.",
    );
    agent.setPatchResult({ success: true });
    expect((await patch(replace, {}, ios)).error).toContain("not tracking its spec");
    await show(ios);
    expect((await patch(replace, {}, ios)).success).toBe(true);
  });
  test("deep patch value is a typed failure before sending", async () => {
    await show();
    let value: Record<string, unknown> = {};
    for (let i = 0; i < 8000; i++) {
      value = { child: value };
    }
    // Native stringify's overflow threshold varies by engine; inject its RangeError
    // at the byte-limit boundary to exercise the catch without a slow native overflow.
    const serialize = spyOn(JSON, "stringify").mockImplementationOnce(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    try {
      expect(await patch([{ op: "add", path: "/data/deep", value }])).toEqual({
        success: false,
        error: "Invalid patch at ops: Patch is nested too deeply",
      });
      expect(serialize.mock.calls[0][0]).toEqual({
        id: "orders",
        baseRevision: undefined,
        ops: [{ op: "add", path: "/data/deep", value }],
      });
      expect(proxy.patchRequests).toEqual([]);
    } finally {
      serialize.mockRestore();
    }
  });
  test("a transport throw forgets tracking until a new show", async () => {
    await show();
    proxy.setFailureMode("requestPatchPrototype", new Error("lost reply"));
    expect((await patch()).error).toEndWith(
      "The device may or may not have applied the patch: show the prototype again before the next patch.",
    );
    proxy.setFailureMode("requestPatchPrototype", null);
    expect((await patch()).error).toContain("not tracking its spec");
    await show();
    expect((await patch()).success).toBe(true);
  });
  test("FIFO patches see the previous commit and failures release the queue", async () => {
    await show();
    const held = deferred<PrototypeResult>();
    proxy.holdPatchReply(held.promise);
    const first = patch();
    const second = patch(check);
    await drain();
    expect(proxy.patchRequests).toHaveLength(1);
    held.resolve({ success: true });
    expect((await first).success).toBe(true);
    expect((await second).success).toBe(true);
    expect(proxy.patchRequests).toHaveLength(2);
    const bad = patch([{ op: "test", path: "/data/cartCount", value: 0 }]);
    const good = patch(check);
    expect((await bad).success).toBe(false);
    expect((await good).success).toBe(true);
  });
  test("patch during show is refused; overlapping show is poisoned by an applied patch", async () => {
    await show();
    const heldShow = deferred<PrototypeResult>();
    proxy.holdShowReply(heldShow.promise);
    const showing = show();
    await drain();
    expect((await patch()).error).toContain("a show is in flight");
    heldShow.resolve({ success: true });
    await showing;
    const heldPatch = deferred<PrototypeResult>();
    const overlap = deferred<PrototypeResult>();
    proxy.holdPatchReply(heldPatch.promise);
    const patching = patch();
    await drain();
    proxy.holdShowReply(overlap.promise);
    const overlapping = show();
    await drain();
    heldPatch.resolve({ success: true });
    expect((await patching).warning).toContain("overlapped this patch");
    overlap.resolve({ success: true });
    await overlapping;
    expect((await patch()).error).toContain("not tracking its spec");
    await show();
    expect((await patch()).success).toBe(true);
  });
  test("a refused dispatched show forgets tracking", async () => {
    await show();
    proxy.setPrototypeResult({ success: false, error: "refused" });
    expect((await show()).success).toBe(false);
    expect((await patch()).error).toContain("not tracking its spec");
    proxy.setPrototypeResult({ success: true });
    await show();
    expect((await patch()).success).toBe(true);
  });
  test("replaceNode introduces an id that a later patch can target", async () => {
    await show();
    const ops = [
      {
        op: "replaceNode",
        id: "label",
        node: { id: "label", type: "column", children: [{ type: "text", id: "new", text: "new" }] },
      },
    ];
    expect((await patch(ops)).success).toBe(true);
    expect(proxy.patchRequests[0].ops).toEqual(ops);
    expect(
      (
        await patch([
          { op: "replaceNode", id: "new", node: { type: "text", id: "new", text: "updated" } },
        ])
      ).success,
    ).toBe(true);
  });
  test("patch frame byte limit is enforced before sending", async () => {
    await show();
    expect(
      (
        await patch([
          { op: "add", path: "/data/large", value: "x".repeat(MAX_PROTOTYPE_SPEC_BYTES) },
        ])
      ).error,
    ).toBe("Invalid patch at ops: Patch byte limit exceeded");
    expect(proxy.patchRequests).toEqual([]);
  });
  test("strict schema action fields, op counts and revisions", () => {
    const input = { action: "patch", id: "orders", ops: replace };
    expect(prototypeSchema.safeParse(input).success).toBe(true);
    for (const value of [
      { action: "patch", ops: replace },
      { action: "patch", id: "orders" },
      { ...input, ops: [] },
      { ...input, ops: Array(65).fill(replace[0]) },
      { ...input, baseRevision: -1 },
      { ...input, baseRevision: 1.5 },
    ]) {
      expect(prototypeSchema.safeParse(value).success).toBe(false);
    }
    for (const field of ["spec", "assets", "reset", "all"]) {
      expect(
        prototypeSchema.safeParse({ ...input, [field]: field === "spec" ? spec : true }).success,
      ).toBe(false);
    }
    for (const action of ["show", "dismiss", "status", "inspect", "awaitEvent"]) {
      for (const extra of [{ ops: replace }, { baseRevision: 1 }]) {
        expect(
          prototypeSchema.safeParse({
            action,
            ...(action === "show"
              ? { spec }
              : action === "dismiss" || action === "awaitEvent"
                ? { id: "orders" }
                : {}),
            ...extra,
          }).success,
        ).toBe(false);
      }
    }
  });
});
