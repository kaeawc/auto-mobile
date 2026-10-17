import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROTOTYPE_DATA_ACTIONS_CAPABILITY,
  PROTOTYPE_DATA_MODEL_CAPABILITY,
  PROTOTYPE_NETWORK_CAPABILITY,
  PROTOTYPE_NETWORK_DEVICE_CAPABILITY,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import { PROTOTYPE_REQUEST_EVENT_NAME } from "../../src/features/prototype/prototypeRequest";
import type { BootedDevice } from "../../src/models";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
// The shared native-parity fixture: a schema-valid spec with a host and a via-device request.
const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../fixtures/prototype-spec/valid/request-actions.json"),
    "utf8",
  ),
) as { id: string };
const capabilities = [
  "prototype_persistence_replay_v1",
  "prototype_window_options_v1",
  PROTOTYPE_NETWORK_CAPABILITY,
  PROTOTYPE_NETWORK_DEVICE_CAPABILITY,
  PROTOTYPE_DATA_ACTIONS_CAPABILITY,
  PROTOTYPE_DATA_MODEL_CAPABILITY,
];

describe("request actions through the registered prototype tool (#12523, #12530)", () => {
  let client: FakeCtrlProxy;
  let adb: FakeAdbExecutor;
  let restore: () => void;
  let unsubscribe: () => void;

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands(capabilities);
    adb = new FakeAdbExecutor();
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      adbFactory: new FakeAdbClientFactory(adb),
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: Record<string, unknown>) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return prototypeOutputSchema.parse(response.structuredContent);
  }
  const reverses = () =>
    adb.getExecutedCommands().filter((command) => command.startsWith("reverse"));

  test("show reverses the port of a schema-valid via device request, dismiss removes it", async () => {
    const shown = await call({ action: "show", spec: fixture });
    expect(shown.success).toBe(true);
    expect(reverses()).toEqual(["reverse --list", "reverse tcp:8080 tcp:8080"]);
    expect(shown.unreversiblePorts).toBeUndefined();

    expect((await call({ action: "dismiss", id: fixture.id })).success).toBe(true);
    expect(reverses().at(-1)).toBe("reverse --remove tcp:8080");
  });

  test("awaitEvent returns the request event under the reserved emit name", async () => {
    await call({ action: "show", spec: fixture });
    const payload = {
      requestId: "r-1",
      method: "GET",
      url: "http://localhost:8080/feed?q=cats",
      via: "host",
      into: "/data/feed",
      outcome: "success",
      status: 200,
      durationMs: 31,
    };
    client.emitPrototypeEvent({
      type: "prototype_event",
      timestamp: 1,
      id: fixture.id,
      sequence: 1,
      kind: "emit",
      name: PROTOTYPE_REQUEST_EVENT_NAME,
      payload,
      state: { feedStatus: "success" },
      pages: {},
    });
    const awaited = await call({
      action: "awaitEvent",
      id: fixture.id,
      kind: "emit",
      eventName: PROTOTYPE_REQUEST_EVENT_NAME,
    });
    expect(awaited.event).toMatchObject({ kind: "emit", name: "prototype_request", payload });
  });

  test("a via host request alone reverses nothing", async () => {
    const hostOnly = {
      id: "host-only",
      window: { placement: { type: "fullscreen" } },
      state: { s: "idle" },
      root: {
        type: "button",
        label: "Go",
        onTap: [{ type: "request", url: "http://localhost:9000/x", statusKey: "s" }],
      },
    };
    expect((await call({ action: "show", spec: hostOnly })).success).toBe(true);
    expect(reverses()).toEqual([]);
  });

  test("a templated via device host is reported by show and inspect, never reversed", async () => {
    const templated = {
      id: "templated",
      window: { placement: { type: "fullscreen" }, persistence: "device" },
      state: { port: "8080" },
      root: {
        type: "button",
        label: "Go",
        onTap: [{ type: "request", via: "device", url: "http://localhost:{port}/x" }],
      },
    };
    const shown = await call({ action: "show", spec: templated });
    expect(shown.success).toBe(true);
    expect(shown.unreversiblePorts).toMatchObject([
      { prototypeId: "templated", url: "http://localhost:{port}/x" },
    ]);
    expect(reverses().filter((command) => command.startsWith("reverse tcp"))).toEqual([]);

    client.setInspectReply({
      success: true,
      prototypes: [
        { id: "templated", persistent: true, state: { port: "8080" }, pages: {}, lastSequence: 0 },
      ],
    });
    const inspected = await call({ action: "inspect" });
    expect(inspected.unreversiblePorts).toMatchObject([{ prototypeId: "templated" }]);
  });

  test("a device lacking prototype_network_device_v1 refuses a via device request before adb runs", async () => {
    client.setSupportedCommands(
      capabilities.filter((c) => c !== PROTOTYPE_NETWORK_DEVICE_CAPABILITY),
    );
    const refused = await call({ action: "show", spec: fixture });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain(PROTOTYPE_NETWORK_DEVICE_CAPABILITY);
    expect(reverses()).toEqual([]);
  });

  test("a device lacking prototype_network_v1 refuses any request", async () => {
    client.setSupportedCommands(capabilities.filter((c) => c !== PROTOTYPE_NETWORK_CAPABILITY));
    const refused = await call({ action: "show", spec: fixture });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain(PROTOTYPE_NETWORK_CAPABILITY);
  });
});
