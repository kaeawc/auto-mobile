import { describe, expect, test } from "bun:test";
import type { OverlayEvent } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { AndroidOverlayTransport } from "../../../src/features/overlay/androidOverlayTransport";
import { IosOverlayTransport } from "../../../src/features/overlay/ios/iosOverlayTransport";
import {
  connectOverlayAgent,
  OVERLAY_AGENT_PROTOCOL_VERSION,
} from "../../../src/features/overlay/ios/overlayAgentClient";
import type { OverlayAssetUpload } from "../../../src/features/overlay/overlayAssets";
import type { OverlaySpec } from "../../../src/features/overlay/overlaySpec";
import {
  overlayAssetPutClient,
  overlayEventSource,
  type OverlayTransport,
} from "../../../src/features/overlay/OverlayTransport";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import {
  FAKE_OVERLAY_AGENT_CAPABILITIES,
  FakeOverlayAgentClient,
} from "../../fakes/FakeOverlayAgentClient";
import {
  FakeOverlayAgentConnector,
  FakeOverlayAgentSocket,
} from "../../fakes/FakeOverlayAgentSocket";
import { FakeTimer } from "../../fakes/FakeTimer";
import { event } from "../../helpers/overlayTestEvent";

const spec: OverlaySpec = {
  id: "panel",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "Hello" },
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const asset: OverlayAssetUpload = { id: "shot", mimeType: "image/png", bytes: PNG };

/** What each platform put on the wire, in one shared vocabulary. */
interface Harness {
  transport: OverlayTransport;
  shows(): OverlaySpec[];
  dismissals(): unknown[];
  assets(): Array<{ method: "put" | "remove"; id: string }>;
  emit(event: OverlayEvent): void;
  listeners(): number;
}

function androidHarness(): Harness {
  const proxy = new FakeCtrlProxy(new FakeTimer());
  return {
    transport: new AndroidOverlayTransport(proxy),
    shows: () =>
      proxy.getOverlayHistory().flatMap((entry) => (entry.method === "show" ? [entry.spec] : [])),
    dismissals: () =>
      proxy
        .getOverlayHistory()
        .flatMap((entry) => (entry.method === "dismiss" ? [entry.target] : [])),
    assets: () =>
      proxy.getOverlayAssetHistory().map((entry) => ({
        method: entry.method,
        id: entry.method === "put" ? entry.asset.id : entry.id,
      })),
    emit: (pushed) => proxy.emitOverlayEvent(pushed),
    listeners: () => proxy.getOverlayListenerCount(),
  };
}

function iosHarness(): Harness {
  const agent = new FakeOverlayAgentClient();
  const of = (type: string) => agent.requests.filter((request) => request.type === type);
  return {
    transport: new IosOverlayTransport(agent),
    shows: () => of("show_overlay").map((request) => request.body.spec as OverlaySpec),
    dismissals: () => of("dismiss_overlay").map((request) => request.body),
    assets: () =>
      agent.requests.flatMap((request) =>
        request.type === "put_overlay_asset" || request.type === "remove_overlay_asset"
          ? [
              {
                method:
                  request.type === "put_overlay_asset" ? ("put" as const) : ("remove" as const),
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
] as const)("OverlayTransport contract (%s)", (_platform, make) => {
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
    const put = await overlayAssetPutClient(harness.transport).requestPutOverlayAsset(asset);
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
    const received: OverlayEvent[] = [];
    const unsubscribe = harness.transport.onEvent((pushed) => received.push(pushed));
    harness.emit(event(1));
    unsubscribe();
    harness.emit(event(2));
    expect(received).toEqual([event(1)]);
    expect(harness.listeners()).toBe(0);
  });

  test("the coordinator's event source is one stable object per transport", () => {
    const { transport } = make();
    expect(overlayEventSource(transport)).toBe(overlayEventSource(transport));
  });
});

describe("IosOverlayTransport", () => {
  test("maps the agent result: error, timing and a non-empty missingAssets list", async () => {
    const agent = new FakeOverlayAgentClient();
    agent.queueReplies(
      { success: true, totalTimeMs: 4, missingAssets: ["shot"], extra: "dropped" },
      { success: true, missingAssets: [] },
      { success: false, error: "Unknown overlay id: other" },
    );
    const transport = new IosOverlayTransport(agent);
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
      error: "Unknown overlay id: other",
    });
  });

  test("put_overlay_asset carries the bytes as base64 with the MIME type", async () => {
    const agent = new FakeOverlayAgentClient();
    await new IosOverlayTransport(agent).putAsset(asset);
    expect(agent.requests).toEqual([
      {
        type: "put_overlay_asset",
        body: {
          id: "shot",
          mimeType: "image/png",
          dataBase64: Buffer.from(PNG).toString("base64"),
        },
      },
    ]);
  });

  test("an aborted upload sends nothing; an unanswered one is indeterminate", async () => {
    const agent = new FakeOverlayAgentClient();
    const transport = new IosOverlayTransport(agent);
    const controller = new AbortController();
    controller.abort();
    const aborted = await transport.putAsset(asset, { abortSignal: controller.signal });
    expect(aborted).toMatchObject({ success: false, dispatched: false, acknowledged: false });
    expect(agent.requests).toEqual([]);

    agent.queueReplies(
      new Error("Overlay agent did not answer put_overlay_asset within 15000 ms."),
    );
    const unanswered = await transport.putAsset(asset);
    expect(unanswered).toMatchObject({ success: false, dispatched: true, acknowledged: false });
    expect(unanswered.error).toContain("indeterminate");
  });

  test("an agent without put_overlay_asset refuses before sending", async () => {
    const agent = new FakeOverlayAgentClient({
      agentVersion: "0.0.1",
      protocolVersion: 1,
      capabilities: FAKE_OVERLAY_AGENT_CAPABILITIES.filter((type) => type !== "put_overlay_asset"),
    });
    await expect(new IosOverlayTransport(agent).putAsset(asset)).rejects.toThrow(
      "does not support",
    );
    expect(agent.requests).toEqual([]);
  });

  test("status returns the agent's status object", async () => {
    const agent = new FakeOverlayAgentClient();
    agent.queueReplies({ success: true, status: { shown: true, id: "panel" } });
    expect(await new IosOverlayTransport(agent).status()).toEqual({
      success: true,
      status: { shown: true, id: "panel" },
    });
    expect(agent.requests).toEqual([{ type: "get_overlay_status", body: {} }]);
  });

  test("malformed overlay_event pushes are dropped", () => {
    const agent = new FakeOverlayAgentClient();
    const received: OverlayEvent[] = [];
    new IosOverlayTransport(agent).onEvent((pushed) => received.push(pushed));
    agent.emit({ type: "overlay_event", id: "panel", sequence: "one" });
    agent.emit({ ...event(3), kind: "teleported" });
    expect(received).toEqual([]);
  });

  test("show reaches the real agent client as one show_overlay frame", async () => {
    const socket = new FakeOverlayAgentSocket();
    const timer = new FakeTimer();
    const connecting = connectOverlayAgent({
      port: 51_234,
      token: "launch-token-0123456789",
      connector: new FakeOverlayAgentConnector(socket),
      timer,
    });
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    socket.push({
      type: "hello_result",
      agentVersion: "0.1.0",
      protocolVersion: OVERLAY_AGENT_PROTOCOL_VERSION,
      capabilities: FAKE_OVERLAY_AGENT_CAPABILITIES,
    });
    const transport = new IosOverlayTransport(await connecting);
    const showing = transport.show(spec);
    const frame = socket.frames().at(-1)!;
    expect(frame).toEqual({ type: "show_overlay", requestId: "r1", spec });
    socket.push({ type: "overlay_result", requestId: "r1", success: true });
    expect(await showing).toEqual({ success: true, requestId: "r1" });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
