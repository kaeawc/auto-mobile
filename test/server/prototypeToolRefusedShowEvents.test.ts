import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { event } from "../helpers/prototypeTestEvent";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { deviceId: "refused-events", platform: "android", name: "Fake" };
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "text" as const, text: "Hello" },
};

describe("refused show event ownership", () => {
  let client: FakeCtrlProxy;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeAll(async () => {
    // Initialise the host's shared schema/transport machinery once using an unrelated fake show.
    // Each test still gets a new coordinator, status store and transport below.
    const restoreRegistry = preserveToolRegistry();
    const timer = new FakeTimer();
    const warmClient = new FakeCtrlProxy(timer);
    const cleanup = registerPrototypeTools({
      clientFactory: () => warmClient,
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
    try {
      await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, {
        action: "show",
        spec: { ...spec, id: "setup-only" },
      });
    } finally {
      cleanup();
      restoreRegistry();
    }
  });
  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands([]);
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });
  async function call(input: unknown) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return prototypeOutputSchema.parse(response.structuredContent);
  }
  test("a host refusal preserves events of a fresh show already dispatched", async () => {
    const request = client.requestShowPrototype.bind(client);
    let release!: () => void;
    let notify!: () => void;
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    client.requestShowPrototype = async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        notify();
      });
      return request(...args);
    };
    const pending = call({ action: "show", spec });
    await started;
    const refused = await call({ action: "show", spec, appearance: "dark" });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("prototype_appearance_v1");
    const pushed = {
      ...event(1, "panel", "appearance_changed"),
      name: null,
      payload: { mode: "dark", source: "device" },
    };
    client.emitPrototypeEvent(pushed);
    release();
    expect((await pending).success).toBe(true);
    expect((await call({ action: "status" })).prototypes?.[0]?.pendingCount).toBe(1);
    expect((await call({ action: "awaitEvent", id: "panel" })).event?.kind).toBe(
      "appearance_changed",
    );
  });
  test("a dispatched failed fresh show clears its event epoch", async () => {
    client.setPrototypeResult({ success: false, error: "Device refused" });
    expect((await call({ action: "show", spec })).success).toBe(false);
    client.emitPrototypeEvent(event(1));
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect((await call({ action: "status" })).prototypes).toEqual([]);
  });
  test("a host refusal without an in-flight show creates no event epoch", async () => {
    const refused = await call({ action: "show", spec, appearance: "dark" });
    expect(refused.error).toContain("prototype_appearance_v1");
    expect(refused.success).toBe(false);
    expect(client.getPrototypeHistory()).toEqual([]);
    expect(client.getPrototypeListenerCount()).toBe(0);
    expect((await call({ action: "status" })).prototypes).toEqual([]);
  });
});
