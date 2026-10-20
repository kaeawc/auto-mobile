import { toolStructured } from "../helpers/toolResponse";
import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import type {
  HierarchyCapture,
  HierarchyCaptureRequest,
} from "../../src/features/observe/HierarchyCapture";
import type { BootedDevice } from "../../src/models";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import {
  FakePrototypeAgentClient,
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
} from "../fakes/FakePrototypeAgentClient";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  capturedAppLayerPrototypeHierarchy,
  capturedTwoWindowHierarchy,
} from "../helpers/prototypeWindowCapture";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "visibility", platform: "android", name: "Fake" };
const ios: BootedDevice = { deviceId: "visibility-ios", platform: "ios", name: "Fake" };
const absent = capturedTwoWindowHierarchy();
const present = capturedAppLayerPrototypeHierarchy();
let frame = absent;
let client: FakeCtrlProxy;
let requests: HierarchyCaptureRequest[];
let restore: () => void;
let unsubscribe: () => void;
let onCapture: (() => void) | undefined;
function setup() {
  restore = preserveToolRegistry();
  frame = absent;
  requests = [];
  onCapture = undefined;
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  client = new FakeCtrlProxy(timer);
  client.setSupportedCommands(["prototype_window_options_v1"]);
  const capture: HierarchyCapture = {
    async capture(request) {
      requests.push(request);
      onCapture?.();
      request.signal?.throwIfAborted();
      return {
        captureId: "capture",
        platform: "android",
        requestedFreshness: "fresh",
        receivedAt: 0,
        hierarchy: frame,
        nodes: [],
      };
    },
  };
  const agent = new FakePrototypeAgentClient({
    agentVersion: "0.1.0",
    protocolVersion: 1,
    capabilities: [...FAKE_PROTOTYPE_AGENT_CAPABILITIES, "prototype_window_options_v1"],
  });
  unsubscribe = registerPrototypeTools({
    agentConnections: { get: () => agent },
    clientFactory: () => client,
    adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
    clock: timer,
    timer,
    cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    lastRenderedObservation: () => undefined,
    anchorHierarchyCaptureFactory: () => capture,
  });
}
beforeEach(setup);
beforeAll(async () => {
  setup();
  try {
    await call();
    // Warm the app-layer handler and visibility output validation outside test timing.
    await call("app");
  } finally {
    unsubscribe();
    restore();
  }
});
afterEach(() => {
  unsubscribe();
  restore();
});
async function call(layer?: "app", device = android, action = "show", signal?: AbortSignal) {
  const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
    device,
    {
      action,
      spec: {
        id: "panel",
        window: { placement: { type: "fullscreen" }, ...(layer ? { layer } : {}) },
        root: { type: "text", text: "Hello" },
      },
    },
    undefined,
    signal,
  );
  return prototypeOutputSchema.parse(toolStructured(response));
}
test("successful hidden app-layer show keeps success and validates its visibility warning", async () => {
  const result = await call("app");
  expect(result).toMatchObject({
    success: true,
    visible: false,
    notVisibleReason: "no_prototype_window_on_screen",
  });
  expect(result.warning).toContain(
    `The prototype was shown with window.layer "app" but no prototype window is on screen. The app in front (${absent.packageName}) most likely hides app-layer windows`,
  );
  expect(requests).toHaveLength(3);
});
test("visible app-layer show adds no output fields or warning", async () => {
  frame = present;
  const result = await call("app");
  expect(result.success).toBe(true);
  expect(result).not.toHaveProperty("visible");
  expect(result).not.toHaveProperty("notVisibleReason");
  expect(result).not.toHaveProperty("warning");
  expect(requests).toHaveLength(1);
});
test("default-layer show does not capture", async () => {
  expect((await call()).success).toBe(true);
  expect(requests).toHaveLength(0);
});
test("failed app-layer show does not capture", async () => {
  client.setPrototypeResult({ success: false, error: "refused" });
  expect((await call("app")).success).toBe(false);
  expect(requests).toHaveLength(0);
});
test("iOS show does not capture", async () => {
  expect((await call("app", ios)).success).toBe(true);
  expect(requests).toHaveLength(0);
});

test("post-dispatch abort keeps success and never dismisses the sent show", async () => {
  const controller = new AbortController();
  onCapture = () => controller.abort(new Error("cancelled after show"));
  const result = await call("app", android, "show", controller.signal);
  expect(result.success).toBe(true);
  expect(result).not.toHaveProperty("visible");
  expect(result).not.toHaveProperty("notVisibleReason");
  expect(result).not.toHaveProperty("warning");
  expect(client.getPrototypeHistory()).toMatchObject([{ method: "show" }]);
  expect(client.getPrototypeHistory()).toHaveLength(1);
  expect(requests).toHaveLength(1);
});
test("dismiss does not capture", async () => {
  await call("app", android, "dismiss");
  expect(requests).toHaveLength(0);
});

test("a successful show superseded before its reply makes no capture", async () => {
  let release: () => void = () => {};
  let dispatched: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const original = client.requestShowPrototype.bind(client);
  let sends = 0;
  const show = spyOn(client, "requestShowPrototype").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (++sends === 1) {
      dispatched();
      await gate;
    }
    return result;
  });
  try {
    const older = call("app");
    await sent;
    expect((await call()).success).toBe(true);
    release();
    const result = await older;
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty("visible");
    expect(requests).toHaveLength(0);
  } finally {
    release();
    show.mockRestore();
  }
});
test("visibility warning composes with the existing same-id show warning", async () => {
  await call();
  const result = await call("app");
  expect(result.warning).toContain("pager pages restarted");
  expect(result.warning).toContain(
    'The prototype was shown with window.layer "app" but no prototype window is on screen.',
  );
});

for (const reason of ["app_layer_window_hidden", "device_blocked"] as const) {
  test(`show uses captured hidden reason ${reason}`, async () => {
    frame = { ...absent, prototypeHiddenReason: reason };
    expect(await call("app")).toMatchObject({
      success: true,
      visible: false,
      notVisibleReason: reason,
    });
  });
}
test("system-layer blocked show makes no capture", async () => {
  client.setPrototypeResult({ success: true, hiddenReason: "device_blocked" });
  expect(await call()).toMatchObject({
    success: true,
    visible: false,
    notVisibleReason: "device_blocked",
  });
  expect(requests).toHaveLength(0);
});
test("capture hint beats show reply, and a visible window beats hints", async () => {
  client.setPrototypeResult({ success: true, hiddenReason: "app_layer_window_hidden" });
  frame = { ...absent, prototypeHiddenReason: "device_blocked" };
  expect((await call("app")).notVisibleReason).toBe("device_blocked");
  frame = { ...present, prototypeHiddenReason: "app_layer_window_hidden" };
  expect(await call("app")).not.toHaveProperty("visible");
});
test("show reply supplies app-layer reason when captures omit it", async () => {
  client.setPrototypeResult({ success: true, hiddenReason: "app_layer_window_hidden" });
  expect((await call("app")).notVisibleReason).toBe("app_layer_window_hidden");
});

test("inspect and host status surface hidden reason and clear absent device fields", async () => {
  client.setSupportedCommands(["prototype_persistence_replay_v1"]);
  const entry = { id: "panel", state: {}, pages: {}, persistent: true, lastSequence: 0 };
  const tool = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
  for (const hiddenReason of ["app_layer_window_hidden", "device_blocked"] as const) {
    client.setInspectReply({ success: true, prototypes: [{ ...entry, hiddenReason }] });
    for (const action of ["inspect", "status"]) {
      const response = await tool(android, { action }, undefined);
      expect(
        prototypeOutputSchema.parse(toolStructured(response)).prototypes?.[0].hiddenReason,
      ).toBe(hiddenReason);
    }
  }
  client.setInspectReply({ success: true, prototypes: [entry] });
  for (const action of ["inspect", "status"]) {
    const response = await tool(android, { action }, undefined);
    expect(
      prototypeOutputSchema.parse(toolStructured(response)).prototypes?.[0],
    ).not.toHaveProperty("hiddenReason");
  }
});

test("older-device app-layer tool output deep-equals the previous output", async () => {
  expect(await call("app")).toEqual({
    success: true,
    lastResult: { id: "panel", lastAction: "show", chrome: "bar", success: true, timestamp: 0 },
    visible: false,
    notVisibleReason: "no_prototype_window_on_screen",
    warning: `The prototype was shown with window.layer "app" but no prototype window is on screen. The app in front (${absent.packageName}) most likely hides app-layer windows drawn over it (system apps such as Settings do); a locked device hides it too. Until it is visible, layer "prototype" calls will report that no prototype is showing. Show it again without window.layer (the default layer draws over every app) or over a different app, or dismiss it.`,
  });
});

test("suspended capture ignores the show hidden hint but retains its own reason", async () => {
  client.setPrototypeResult({ success: true, hiddenReason: "app_layer_window_hidden" });
  frame = { ...absent, prototypeSuspended: true };
  const result = await call("app");
  expect(result.success).toBe(true);
  expect(result).not.toHaveProperty("visible");
  expect(result).not.toHaveProperty("notVisibleReason");
  frame = { ...frame, prototypeHiddenReason: "device_blocked" };
  expect((await call("app")).notVisibleReason).toBe("device_blocked");
});
