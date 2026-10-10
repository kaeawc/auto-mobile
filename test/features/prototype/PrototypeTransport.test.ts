import { describe, expect, test } from "bun:test";
import type { PrototypeEvent } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { AndroidPrototypeTransport } from "../../../src/features/prototype/androidPrototypeTransport";
import { IosPrototypeTransport } from "../../../src/features/prototype/ios/iosPrototypeTransport";
import {
  connectPrototypeAgent,
  PROTOTYPE_AGENT_PROTOCOL_VERSION,
} from "../../../src/features/prototype/ios/prototypeAgentClient";
import type { PrototypeAssetUpload } from "../../../src/features/prototype/prototypeAssets";
import type { PrototypeSpec } from "../../../src/features/prototype/prototypeSpec";
import {
  prototypeAssetPutClient,
  prototypeEventSource,
  type PrototypeTransport,
} from "../../../src/features/prototype/PrototypeTransport";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import {
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
  FakePrototypeAgentClient,
} from "../../fakes/FakePrototypeAgentClient";
import {
  FakePrototypeAgentConnector,
  FakePrototypeAgentSocket,
} from "../../fakes/FakePrototypeAgentSocket";
import { FakeTimer } from "../../fakes/FakeTimer";
import { event } from "../../helpers/prototypeTestEvent";

const spec: PrototypeSpec = {
  id: "panel",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "Hello" },
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const asset: PrototypeAssetUpload = { id: "shot", mimeType: "image/png", bytes: PNG };

/** What each platform put on the wire, in one shared vocabulary. */
interface Harness {
  transport: PrototypeTransport;
  shows(): PrototypeSpec[];
  dismissals(): unknown[];
  assets(): Array<{ method: "put" | "remove"; id: string }>;
  emit(event: PrototypeEvent): void;
  listeners(): number;
}

function androidHarness(): Harness {
  const proxy = new FakeCtrlProxy(new FakeTimer());
  return {
    transport: new AndroidPrototypeTransport(proxy),
    shows: () =>
      proxy.getPrototypeHistory().flatMap((entry) => (entry.method === "show" ? [entry.spec] : [])),
    dismissals: () =>
      proxy
        .getPrototypeHistory()
        .flatMap((entry) => (entry.method === "dismiss" ? [entry.target] : [])),
    assets: () =>
      proxy.getPrototypeAssetHistory().map((entry) => ({
        method: entry.method,
        id: entry.method === "put" ? entry.asset.id : entry.id,
      })),
    emit: (pushed) => proxy.emitPrototypeEvent(pushed),
    listeners: () => proxy.getPrototypeListenerCount(),
  };
}

function iosHarness(): Harness {
  const agent = new FakePrototypeAgentClient();
  const of = (type: string) => agent.requests.filter((request) => request.type === type);
  return {
    transport: new IosPrototypeTransport(agent),
    shows: () => of("show_prototype").map((request) => request.body.spec as PrototypeSpec),
    dismissals: () => of("dismiss_prototype").map((request) => request.body),
    assets: () =>
      agent.requests.flatMap((request) =>
        request.type === "put_prototype_asset" || request.type === "remove_prototype_asset"
          ? [
              {
                method:
                  request.type === "put_prototype_asset" ? ("put" as const) : ("remove" as const),
                id: request.body.id as string,
              },
            ]
          : [],
      ),
    emit: (pushed) => agent.emit({ ...pushed }),
    listeners: () => agent.listenerCount(),
  };
}

describe.each([
  ["android", androidHarness],
  ["ios", iosHarness],
] as const)("PrototypeTransport contract (%s)", (_platform, make) => {
  test("show forwards the spec unchanged and succeeds", async () => {
    const harness = make();
    const result = await harness.transport.show(spec);
    expect(result.success).toBe(true);
    expect(harness.shows()).toEqual([spec]);
  });

  test("dismiss forwards an id or all", async () => {
    const harness = make();
    expect((await harness.transport.dismiss({ id: "panel" })).success).toBe(true);
    expect((await harness.transport.dismiss({ all: true })).success).toBe(true);
    expect(harness.dismissals()).toEqual([{ id: "panel" }, { all: true }]);
  });

  test("putAsset and removeAsset are acknowledged, in order", async () => {
    const harness = make();
    const put = await prototypeAssetPutClient(harness.transport).requestPutPrototypeAsset(asset);
    const removed = await harness.transport.removeAsset("shot");
    expect([put, removed].map((result) => [result.success, result.acknowledged])).toEqual([
      [true, true],
      [true, true],
    ]);
    expect(harness.assets()).toEqual([
      { method: "put", id: "shot" },
      { method: "remove", id: "shot" },
    ]);
  });

  test("onEvent delivers decoded events until unsubscribed", () => {
    const harness = make();
    const received: PrototypeEvent[] = [];
    const unsubscribe = harness.transport.onEvent((pushed) => received.push(pushed));
    harness.emit(event(1));
    unsubscribe();
    harness.emit(event(2));
    expect(received).toEqual([event(1)]);
    expect(harness.listeners()).toBe(0);
  });

  test("the coordinator's event source is one stable object per transport", () => {
    const { transport } = make();
    expect(prototypeEventSource(transport)).toBe(prototypeEventSource(transport));
  });
});

describe("IosPrototypeTransport", () => {
  test("maps the agent result: error, timing and a non-empty missingAssets list", async () => {
    const agent = new FakePrototypeAgentClient();
    agent.queueReplies(
      { success: true, totalTimeMs: 4, missingAssets: ["shot"], extra: "dropped" },
      { success: true, missingAssets: [] },
      { success: false, error: "Unknown prototype id: other" },
    );
    const transport = new IosPrototypeTransport(agent);
    expect(await transport.show(spec)).toEqual({
      success: true,
      requestId: "r1",
      totalTimeMs: 4,
      missingAssets: ["shot"],
    });
    expect(await transport.show(spec)).toEqual({ success: true, requestId: "r2" });
    expect(await transport.dismiss({ id: "other" })).toEqual({
      success: false,
      requestId: "r3",
      error: "Unknown prototype id: other",
    });
  });

  test("put_prototype_asset carries the bytes as base64 with the MIME type", async () => {
    const agent = new FakePrototypeAgentClient();
    await new IosPrototypeTransport(agent).putAsset(asset);
    expect(agent.requests).toEqual([
      {
        type: "put_prototype_asset",
        body: {
          id: "shot",
          mimeType: "image/png",
          dataBase64: Buffer.from(PNG).toString("base64"),
        },
      },
    ]);
  });

  test("an aborted upload sends nothing; an unanswered one is indeterminate", async () => {
    const agent = new FakePrototypeAgentClient();
    const transport = new IosPrototypeTransport(agent);
    const controller = new AbortController();
    controller.abort();
    const aborted = await transport.putAsset(asset, { abortSignal: controller.signal });
    expect(aborted).toMatchObject({ success: false, dispatched: false, acknowledged: false });
    expect(agent.requests).toEqual([]);

    agent.queueReplies(
      new Error("Prototype agent did not answer put_prototype_asset within 15000 ms."),
    );
    const unanswered = await transport.putAsset(asset);
    expect(unanswered).toMatchObject({ success: false, dispatched: true, acknowledged: false });
    expect(unanswered.error).toContain("indeterminate");
  });

  test("an agent without put_prototype_asset refuses before sending", async () => {
    const agent = new FakePrototypeAgentClient({
      agentVersion: "0.0.1",
      protocolVersion: 1,
      capabilities: FAKE_PROTOTYPE_AGENT_CAPABILITIES.filter(
        (type) => type !== "put_prototype_asset",
      ),
    });
    await expect(new IosPrototypeTransport(agent).putAsset(asset)).rejects.toThrow(
      "does not support",
    );
    expect(agent.requests).toEqual([]);
  });

  test("status returns the agent's status object", async () => {
    const agent = new FakePrototypeAgentClient();
    agent.queueReplies({ success: true, status: { shown: true, id: "panel" } });
    expect(await new IosPrototypeTransport(agent).status()).toEqual({
      success: true,
      status: { shown: true, id: "panel" },
    });
    expect(agent.requests).toEqual([{ type: "get_prototype_status", body: {} }]);
  });

  test("malformed prototype_event pushes are dropped", () => {
    const agent = new FakePrototypeAgentClient();
    const received: PrototypeEvent[] = [];
    new IosPrototypeTransport(agent).onEvent((pushed) => received.push(pushed));
    agent.emit({ type: "prototype_event", id: "panel", sequence: "one" });
    agent.emit({ ...event(3), kind: "teleported" });
    expect(received).toEqual([]);
  });

  test("show reaches the real agent client as one show_prototype frame", async () => {
    const socket = new FakePrototypeAgentSocket();
    const timer = new FakeTimer();
    const connecting = connectPrototypeAgent({
      port: 51_234,
      token: "launch-token-0123456789",
      connector: new FakePrototypeAgentConnector(socket),
      timer,
    });
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    socket.push({
      type: "hello_result",
      agentVersion: "0.1.0",
      protocolVersion: PROTOTYPE_AGENT_PROTOCOL_VERSION,
      capabilities: FAKE_PROTOTYPE_AGENT_CAPABILITIES,
    });
    const transport = new IosPrototypeTransport(await connecting);
    const showing = transport.show(spec);
    const frame = socket.frames().at(-1)!;
    expect(frame).toEqual({ type: "show_prototype", requestId: "r1", spec });
    socket.push({ type: "prototype_result", requestId: "r1", success: true });
    expect(await showing).toEqual({ success: true, requestId: "r1" });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
