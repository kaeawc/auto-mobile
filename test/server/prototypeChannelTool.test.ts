import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROTOTYPE_DATA_ACTIONS_CAPABILITY,
  PROTOTYPE_DATA_MODEL_CAPABILITY,
  PROTOTYPE_NETWORK_CAPABILITY,
  PROTOTYPE_NETWORK_DEVICE_CAPABILITY,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import type {
  PrototypeChannelExecutor,
  PrototypeChannelHandle,
  PrototypeChannelOpenRequest,
  PrototypeChannelSink,
} from "../../src/features/prototype/PrototypeChannelExecutor";
import type { BootedDevice } from "../../src/models";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { toolStructured } from "../helpers/toolResponse";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../fixtures/prototype-spec/valid/request-actions.json"),
    "utf8",
  ),
) as { id: string };

class FakeChannelExecutor implements PrototypeChannelExecutor {
  readonly opened: {
    request: PrototypeChannelOpenRequest;
    sink: PrototypeChannelSink;
    signal: AbortSignal;
  }[] = [];
  open(
    request: PrototypeChannelOpenRequest,
    sink: PrototypeChannelSink,
    signal: AbortSignal,
  ): PrototypeChannelHandle {
    this.opened.push({ request, sink, signal });
    return { send: () => ({ ok: true }), close: () => undefined };
  }
}

let restore: () => void, dispose: () => void;
let client: FakeCtrlProxy;
let executor: FakeChannelExecutor;

beforeEach(() => {
  restore = preserveToolRegistry();
  const timer = new FakeTimer();
  client = new FakeCtrlProxy(timer);
  client.setSupportedCommands([
    "prototype_persistence_replay_v1",
    "prototype_window_options_v1",
    PROTOTYPE_NETWORK_CAPABILITY,
    PROTOTYPE_NETWORK_DEVICE_CAPABILITY,
    PROTOTYPE_DATA_ACTIONS_CAPABILITY,
    PROTOTYPE_DATA_MODEL_CAPABILITY,
  ]);
  executor = new FakeChannelExecutor();
  dispose = registerPrototypeTools({
    clientFactory: () => client,
    adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
    lastRenderedObservation: () => undefined,
    clock: timer,
    timer,
    channelExecutor: executor,
  });
});
afterEach(() => {
  dispose();
  restore();
});

async function call(input: Record<string, unknown>) {
  const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
  return prototypeOutputSchema.parse(toolStructured(response));
}

const openFrame = {
  type: "prototype_channel_open",
  connectionId: "c1",
  prototypeId: fixture.id,
  channel: "chat",
  kind: "websocket",
  url: "wss://chat.example.test/socket",
};

test("a channel the device opens is relayed by the host and ended when the prototype is dismissed", async () => {
  expect((await call({ action: "show", spec: fixture })).success).toBe(true);
  const host = client.getPrototypeChannelHost();
  expect(host).toBeDefined();
  const sent: unknown[] = [];
  host!.handleOpen(openFrame, (frame) => sent.push(frame));
  expect(executor.opened).toHaveLength(1);
  expect(executor.opened[0].request).toMatchObject({ kind: "websocket", url: openFrame.url });

  executor.opened[0].sink.opened("chat.v1");
  expect(sent).toEqual([
    { type: "prototype_channel_opened", connectionId: "c1", protocol: "chat.v1" },
  ]);

  expect(executor.opened[0].signal.aborted).toBe(false);
  const dismissed = await call({ action: "dismiss", id: fixture.id });
  expect(dismissed.success).toBe(true);
  expect(executor.opened[0].signal.aborted).toBe(true);
});
