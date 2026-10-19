import { prototypeSpecSchema } from "../../src/features/prototype/prototypeSpec";
import { toolStructured } from "../helpers/toolResponse";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ctrlProxyRequests,
  type PrototypeEvent,
  type PrototypeResult,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import { AndroidPrototypeTransport } from "../../src/features/prototype/androidPrototypeTransport";
import { IosPrototypeTransport } from "../../src/features/prototype/ios/iosPrototypeTransport";
import {
  prototypeOutputSchema,
  prototypeSchema,
  registerPrototypeTools,
} from "../../src/server/prototypeTools";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakePrototypeAgentClient } from "../fakes/FakePrototypeAgentClient";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { drainUntil } from "../helpers/fakeTimerStepping";

const capability = "prototype_multi_surface_v1";
const device = { deviceId: "multi-surface", platform: "android" as const, name: "Fake" };
const spec = (id: string, text = id) => ({
  id,
  window: { placement: { type: "fullscreen" as const } },
  state: { value: id },
  root: { type: "text" as const, text },
});
const reported = (id: string) => ({ id, persistent: false, pages: {}, state: {}, lastSequence: 0 });
const event = (id: string): PrototypeEvent => ({
  type: "prototype_event",
  id,
  sequence: 1,
  timestamp: 1,
  kind: "emit",
  name: id,
  payload: null,
  pages: {},
  state: { value: id },
});

describe("prototype multiple surfaces", () => {
  let client: FakeCtrlProxy;
  let agent: FakePrototypeAgentClient;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    agent = new FakePrototypeAgentClient();
    client.setSupportedCommands([
      capability,
      "prototype_persistence_replay_v1",
      "prototype_patch_v1",
    ]);
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      agentConnections: { get: () => agent },
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });
  async function call(input: Record<string, unknown>, target: BootedDevice = device) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(target, input);
    return prototypeOutputSchema.parse(toolStructured(response));
  }
  const show = (id: string, extra: Record<string, unknown> = {}) =>
    call({ action: "show", spec: spec(id), replaceOthers: false, ...extra });
  const status = () => call({ action: "status" });

  test("schema leaves the default absent and accepts false", () => {
    expect(prototypeSchema.parse({ action: "show", spec: spec("a") })).not.toHaveProperty(
      "replaceOthers",
    );
    expect(
      prototypeSchema.safeParse({ action: "show", spec: spec("a"), replaceOthers: false }).success,
    ).toBe(true);
    expect(
      prototypeSchema.safeParse({ action: "show", spec: spec("a"), replaceOthers: "false" })
        .success,
    ).toBe(false);
  });
  test.each(["dismiss", "patch", "status", "inspect", "awaitEvent"])(
    "replaceOthers is refused on %s",
    (action) => {
      const input = {
        action,
        ...(["dismiss", "patch", "awaitEvent"].includes(action) ? { id: "a" } : {}),
        ...(action === "patch"
          ? { ops: [{ op: "replace", path: "/state/value", value: "new" }] }
          : {}),
      };
      expect(prototypeSchema.safeParse(input).success).toBe(true);
      expect(prototypeSchema.safeParse({ ...input, replaceOthers: false }).success).toBe(false);
    },
  );
  test.each([undefined, true, false])("wire sends only false (%s)", (replaceOthers) => {
    const args = { requestId: "r", spec: prototypeSpecSchema.parse(spec("a")), replaceOthers };
    const wire = ctrlProxyRequests.showPrototype(args);
    expect(Object.hasOwn(wire, "replaceOthers")).toBe(replaceOthers === false);
    if (replaceOthers === false) {
      expect(wire).toHaveProperty("replaceOthers", false);
    }
  });
  test("Android transport forwards false", async () => {
    await new AndroidPrototypeTransport(client).show(prototypeSpecSchema.parse(spec("a")), {
      ...{ replaceOthers: false },
    });
    expect(client.getPrototypeHistory()[0]).toHaveProperty("replaceOthers", false);
  });
  test("missing capability refuses before any request", async () => {
    client.setSupportedCommands([]);
    const refused = await show("a");
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("replaceOthers:false");
    expect(refused.error).toContain(capability);
    expect(client.getPrototypeHistory()).toEqual([]);
    expect(client.getPrototypeAssetHistory()).toEqual([]);
    expect((await show("a", { replaceOthers: true })).success).toBe(true);
  });
  test("iOS transport refuses false before requesting the agent", async () => {
    const agent = new FakePrototypeAgentClient();
    await expect(
      new IosPrototypeTransport(agent).show(prototypeSpecSchema.parse(spec("a")), {
        ...{ replaceOthers: false },
      }),
    ).rejects.toThrow(
      "iOS shows one prototype at a time; replaceOthers:false is Android only (prototype_multi_surface_v1)",
    );
    expect(agent.requests).toEqual([]);
  });
  test("iOS tool refuses before uploads or agent requests; true and absent still show", async () => {
    const ios: BootedDevice = { deviceId: "multi-ios", platform: "ios", name: "Fake" };
    const refused = await call(
      {
        action: "show",
        spec: spec("a"),
        replaceOthers: false,
        assets: [{ id: "logo", path: "/missing.png" }],
      },
      ios,
    );
    expect(refused.success).toBe(false);
    expect(refused.error).toContain(
      "iOS shows one prototype at a time; replaceOthers:false is Android only (prototype_multi_surface_v1)",
    );
    expect(agent.requests).toEqual([]);
    expect(
      (await call({ action: "show", spec: spec("a"), replaceOthers: true }, ios)).success,
    ).toBe(true);
    expect((await call({ action: "show", spec: spec("b") }, ios)).success).toBe(true);
    expect(agent.requests.every((request) => !Object.hasOwn(request.body, "replaceOthers"))).toBe(
      true,
    );
  });

  test("additive shows and same-id replacement retain siblings", async () => {
    await show("a");
    await show("b");
    expect((await status()).prototypes?.map((entry) => entry.id)).toEqual(["a", "b"]);
    await show("a", { spec: spec("a", "updated") });
    expect((await status()).prototypes?.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
  });
  test.each([{}, { replaceOthers: true }])(
    "default/true show drops siblings (%j)",
    async (extra) => {
      await show("a");
      await show("b");
      await call({ action: "show", spec: spec("c"), ...extra });
      expect((await status()).prototypes?.map((entry) => entry.id)).toEqual(["c"]);
    },
  );
  test("dismiss id keeps the sibling, dismiss all clears it", async () => {
    await show("a");
    await show("b");
    await call({ action: "dismiss", id: "a" });
    expect((await status()).prototypes?.map((entry) => entry.id)).toEqual(["b"]);
    await call({ action: "dismiss", all: true });
    expect((await status()).prototypes).toEqual([]);
  });
  test("inspect retains the full list, adopts extras and drops missing ids", async () => {
    await show("a");
    await show("gone");
    client.setInspectReply({
      success: true,
      prototypes: [reported("a"), reported("b")],
      droppedEvents: 0,
    });
    expect((await call({ action: "inspect" })).prototypes?.map((entry) => entry.id)).toEqual([
      "a",
      "b",
    ]);
    client.setInspectReply({ success: true, prototypes: [reported("b")], droppedEvents: 0 });
    expect((await call({ action: "inspect" })).prototypes?.map((entry) => entry.id)).toEqual(["b"]);
  });
  test("a refused fifth preserves all presence and event snapshots", async () => {
    for (const id of ["a", "b", "c", "d"]) {
      await show(id);
    }
    client.emitPrototypeEvent(event("a"));
    const before = (await status()).prototypes;
    client.setPrototypeResult({
      success: false,
      error: "Too many prototypes on screen (max 4): a, b, c, d",
    });
    expect((await show("e")).success).toBe(false);
    expect((await status()).prototypes).toEqual(before);
    expect(
      (
        await call({
          action: "patch",
          id: "a",
          baseRevision: 0,
          ops: [{ op: "replace", path: "/state/value", value: "retained" }],
        })
      ).success,
    ).toBe(true);
  });
  test("awaitEvent and status snapshots stay per id", async () => {
    await show("a");
    await show("b");
    client.emitPrototypeEvent(event("a"));
    client.emitPrototypeEvent(event("b"));
    const entries = (await status()).prototypes;
    expect(entries?.map((entry) => entry.state)).toEqual([{ value: "a" }, { value: "b" }]);
    expect((await call({ action: "awaitEvent", id: "b" })).event?.id).toBe("b");
    expect((await call({ action: "awaitEvent", id: "a" })).event?.id).toBe("a");
  });
  test("an additive display refusal preserves sibling specs for patches", async () => {
    await show("a");
    await show("b");
    client.setPrototypeResult({ success: false, error: "Unknown or disconnected display: 9" });
    expect((await show("c")).success).toBe(false);
    for (const id of ["a", "b"]) {
      expect(
        (
          await call({
            action: "patch",
            id,
            baseRevision: 0,
            ops: [{ op: "replace", path: "/state/value", value: "retained" }],
          })
        ).success,
      ).toBe(true);
    }
  });
  test("a refused default show still forgets sibling specs", async () => {
    await show("a");
    await show("b");
    client.setPrototypeResult({ success: false, error: "Unknown or disconnected display: 9" });
    expect((await call({ action: "show", spec: spec("c") })).success).toBe(false);
    expect(
      (
        await call({
          action: "patch",
          id: "a",
          baseRevision: 0,
          ops: [{ op: "replace", path: "/state/value", value: "retained" }],
        })
      ).error,
    ).toContain("not tracking its spec");
  });
  test("overlapping additive shows retain both specs when the first finishes first", async () => {
    const a = Promise.withResolvers<PrototypeResult>();
    client.holdShowReply(a.promise);
    const showingA = show("a");
    await drainUntil(() => client.getPrototypeHistory().length === 1, {
      description: "first prototype show dispatch",
    });
    expect(client.getPrototypeHistory()).toHaveLength(1);
    const b = Promise.withResolvers<PrototypeResult>();
    client.holdShowReply(b.promise);
    const showingB = show("b");
    await drainUntil(() => client.getPrototypeHistory().length === 2, {
      description: "second prototype show dispatch",
    });
    expect(client.getPrototypeHistory()).toHaveLength(2);
    a.resolve({ success: true });
    expect((await showingA).success).toBe(true);
    b.resolve({ success: true });
    expect((await showingB).success).toBe(true);
    for (const id of ["a", "b"]) {
      expect(
        (
          await call({
            action: "patch",
            id,
            baseRevision: 0,
            ops: [{ op: "replace", path: "/state/value", value: "tracked" }],
          })
        ).success,
      ).toBe(true);
    }
  });
  test("patches validate against each id's acknowledged spec", async () => {
    await show("a");
    await show("b");
    for (const id of ["a", "b"]) {
      const result = await call({
        action: "patch",
        id,
        baseRevision: 0,
        ops: [{ op: "replace", path: "/state/value", value: id }],
      });
      expect(result).toMatchObject({ success: true });
    }
  });
});
