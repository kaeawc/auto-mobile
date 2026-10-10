import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  PROTOTYPE_ANCHOR_CAPABILITY,
  PROTOTYPE_DISPLAY_CAPABILITY,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import type {
  HierarchyCapture,
  HierarchyCaptureRequest,
  HierarchySnapshot,
} from "../../src/features/observe/HierarchyCapture";
import { CtrlProxyHierarchy } from "../../src/features/observe/ios/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../src/features/observe/ios/types";
import type { BootedDevice, ViewHierarchyResult } from "../../src/models";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import {
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
  FakePrototypeAgentClient,
} from "../fakes/FakePrototypeAgentClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { iosFloatingOverlayOverSettings } from "../fixtures/observe/iosOverlayWindow";
import { capturedFloatingCoverHierarchy } from "../helpers/prototypeWindowCapture";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "fake-anchor", platform: "android", name: "Fake" };
const ios: BootedDevice = { deviceId: "sim-anchor", platform: "ios", name: "Sim" };
const UPDATED_AT = 1791481170726;

/** Serves the captured API 36 Playground hierarchy with the CtrlProxy prototype over it. */
class CapturedHierarchy implements HierarchyCapture {
  readonly requests: HierarchyCaptureRequest[] = [];
  async capture(request: HierarchyCaptureRequest): Promise<HierarchySnapshot> {
    this.requests.push(request);
    return {
      captureId: "captured",
      platform: "android",
      requestedFreshness: request.freshness,
      updatedAt: UPDATED_AT,
      receivedAt: 0,
      hierarchy: capturedFloatingCoverHierarchy(),
      nodes: [],
    };
  }
}

function anchoredSpec(selector: Record<string, unknown>) {
  return {
    id: "cover",
    window: { placement: { type: "floating", gravity: "topStart", offset: { x: 0, y: 0 } } },
    root: {
      type: "box",
      children: [],
      style: { background: "#80FF0000" },
      anchor: { type: "element", selector, alignment: "cover" },
    },
  };
}

describe("prototype show with anchors (#9316)", () => {
  let client: FakeCtrlProxy;
  let hierarchy: CapturedHierarchy;
  let restore: () => void;
  let unsubscribe: () => void;

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands([PROTOTYPE_ANCHOR_CAPABILITY]);
    hierarchy = new CapturedHierarchy();
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      anchorHierarchyCaptureFactory: () => hierarchy,
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: unknown, device = android) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return prototypeOutputSchema.parse(response.structuredContent);
  }

  test("an element anchor is sent as resolved dp bounds and reported with the hierarchy time", async () => {
    const payload = await call({
      action: "show",
      spec: anchoredSpec({ elementId: "button_elevated" }),
    });
    expect(payload.success).toBe(true);
    expect(hierarchy.requests).toHaveLength(1);
    expect(hierarchy.requests[0].freshness).toBe("fresh");
    const sent = client.getPrototypeHistory()[0] as {
      spec: { root: { anchor: unknown } };
    };
    const bounds = { x: 550 / 2.625, y: 1589 / 2.625, width: 446 / 2.625, height: 126 / 2.625 };
    expect(sent.spec.root.anchor).toEqual({ type: "bounds", bounds, alignment: "cover" });
    expect(payload.anchors).toEqual([
      {
        path: "root",
        alignment: "cover",
        boundsPx: { left: 550, top: 1589, right: 996, bottom: 1715 },
        bounds,
      },
    ]);
    expect(payload.hierarchyUpdatedAt).toBe(UPDATED_AT);
  });

  test("an unresolvable anchor fails the show and sends nothing", async () => {
    const payload = await call({ action: "show", spec: anchoredSpec({ text: "Text" }) });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Target ambiguous: 2 matches");
    expect(payload.error).toContain("Nothing was shown");
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test("a prototype node is not an anchor target", async () => {
    const payload = await call({ action: "show", spec: anchoredSpec({ testTag: "coverBox" }) });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Only the app is searched");
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test("a CtrlProxy without anchor support is refused before anything is captured or sent", async () => {
    client.setSupportedCommands([]);
    for (const spec of [
      anchoredSpec({ elementId: "button_elevated" }),
      {
        ...anchoredSpec({}),
        root: {
          type: "box",
          children: [],
          anchor: { type: "bounds", bounds: { x: 0, y: 0, width: 10, height: 10 } },
        },
      },
    ]) {
      const payload = await call({ action: "show", spec });
      expect(payload.success).toBe(false);
      expect(payload.error).toContain(PROTOTYPE_ANCHOR_CAPABILITY);
    }
    expect(hierarchy.requests).toEqual([]);
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test("a bounds anchor is sent as authored without a hierarchy capture", async () => {
    const spec = {
      ...anchoredSpec({}),
      root: {
        type: "box",
        children: [],
        anchor: { type: "bounds", bounds: { x: 1, y: 2, width: 3, height: 4 }, alignment: "top" },
      },
    };
    const payload = await call({ action: "show", spec });
    expect(payload.success).toBe(true);
    expect(payload.anchors).toBeUndefined();
    expect(hierarchy.requests).toEqual([]);
    expect((client.getPrototypeHistory()[0] as { spec: unknown }).spec).toEqual(spec);
  });

  test("a floating window refuses an anchor below its root before capturing", async () => {
    const spec = {
      ...anchoredSpec({}),
      root: {
        type: "column",
        children: [
          {
            type: "box",
            children: [],
            anchor: {
              type: "element",
              selector: { elementId: "button_elevated" },
              alignment: "cover",
            },
          },
        ],
      },
    };
    const payload = await call({ action: "show", spec });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("root.children[0].anchor: in a floating window only the root");
    expect(hierarchy.requests).toEqual([]);
    expect(client.getPrototypeHistory()).toEqual([]);
    const fullscreen = { ...spec, window: { placement: { type: "fullscreen" } } };
    expect((await call({ action: "show", spec: fullscreen })).success).toBe(true);
  });

  test("a spec without anchors never captures a hierarchy", async () => {
    const spec = { ...anchoredSpec({}), root: { type: "text", text: "hi" } };
    expect((await call({ action: "show", spec })).success).toBe(true);
    expect(hierarchy.requests).toEqual([]);
  });

  test("element anchors on another display are refused", async () => {
    client.setSupportedCommands([PROTOTYPE_ANCHOR_CAPABILITY, PROTOTYPE_DISPLAY_CAPABILITY]);
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout:
        'Display id 0: DisplayInfo{uniqueId "local:cover-key" type INTERNAL, real 100 x 100}\n' +
        'Display id 2: DisplayInfo{uniqueId "local:inner-key" type INTERNAL, real 200 x 200}',
      stderr: "",
    });
    unsubscribe();
    const timer = new FakeTimer();
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      anchorHierarchyCaptureFactory: () => hierarchy,
      adbFactory: new FakeAdbClientFactory(adb),
      lastRenderedObservation: () => undefined,
    });
    const fold: BootedDevice = {
      ...android,
      displays: {
        panels: [
          { key: "inner-key", role: "inner", sizePx: { width: 200, height: 200 } },
          { key: "cover-key", role: "cover", sizePx: { width: 100, height: 100 } },
        ],
        postures: ["opened", "closed"],
      },
    };
    const payload = await call(
      { action: "show", display: "inner", spec: anchoredSpec({ elementId: "button_elevated" }) },
      fold,
    );
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("default display");
    expect(client.getPrototypeHistory()).toEqual([]);
    expect(hierarchy.requests).toEqual([]);
  });
});

/** The captured hierarchy, optionally with a shorter screen so a lower element is off screen. */
class ShortScreenHierarchy extends CapturedHierarchy {
  constructor(private readonly screenHeight?: number) {
    super();
  }
  override async capture(request: HierarchyCaptureRequest): Promise<HierarchySnapshot> {
    const snapshot = await super.capture(request);
    return this.screenHeight === undefined
      ? snapshot
      : { ...snapshot, hierarchy: { ...snapshot.hierarchy, screenHeight: this.screenHeight } };
  }
}

describe("an anchor-refused app-layer show leaves the device untouched (#11379)", () => {
  const APPOP = "shell appops set dev.jasonpearson.automobile.ctrlproxy SYSTEM_ALERT_WINDOW allow";
  const appLayer = (selector: Record<string, unknown>) => {
    const spec = anchoredSpec(selector);
    return { ...spec, window: { ...spec.window, layer: "app" } };
  };
  let client: FakeCtrlProxy;
  let adb: FakeAdbExecutor;
  let hierarchy: ShortScreenHierarchy;
  let restore: () => void;
  let unsubscribe: () => void;

  function register(screenHeight?: number) {
    unsubscribe?.();
    const timer = new FakeTimer();
    hierarchy = new ShortScreenHierarchy(screenHeight);
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      anchorHierarchyCaptureFactory: () => hierarchy,
      adbFactory: new FakeAdbClientFactory(adb),
      lastRenderedObservation: () => undefined,
    });
  }

  beforeEach(() => {
    restore = preserveToolRegistry();
    client = new FakeCtrlProxy(new FakeTimer());
    client.setSupportedCommands([PROTOTYPE_ANCHOR_CAPABILITY, "prototype_window_options_v1"]);
    adb = new FakeAdbExecutor();
    register();
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: unknown, device = android) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return prototypeOutputSchema.parse(response.structuredContent);
  }

  function expectUntouched() {
    expect(adb.getExecutedCommands()).not.toContain(APPOP);
    expect(client.getPrototypeHistory()).toEqual([]);
  }

  test("an unsupported anchor capability grants nothing", async () => {
    client.setSupportedCommands(["prototype_window_options_v1"]);
    const payload = await call({
      action: "show",
      spec: appLayer({ elementId: "button_elevated" }),
    });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain(PROTOTYPE_ANCHOR_CAPABILITY);
    expectUntouched();
  });

  test("a missing element grants nothing", async () => {
    const payload = await call({
      action: "show",
      spec: appLayer({ elementId: "no_such_element" }),
    });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Nothing was shown");
    expectUntouched();
  });

  test("an ambiguous element grants nothing", async () => {
    const payload = await call({ action: "show", spec: appLayer({ text: "Text" }) });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Target ambiguous");
    expectUntouched();
  });

  test("an off-screen element grants nothing", async () => {
    register(1500);
    const payload = await call({
      action: "show",
      spec: appLayer({ elementId: "button_elevated" }),
    });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("is off screen");
    expectUntouched();
  });

  test("an element anchor on another display grants nothing", async () => {
    client.setSupportedCommands([
      PROTOTYPE_ANCHOR_CAPABILITY,
      PROTOTYPE_DISPLAY_CAPABILITY,
      "prototype_window_options_v1",
    ]);
    adb.setCommandResponse("cmd display get-displays", {
      stdout:
        'Display id 0: DisplayInfo{uniqueId "local:cover-key" type INTERNAL, real 100 x 100}\n' +
        'Display id 2: DisplayInfo{uniqueId "local:inner-key" type INTERNAL, real 200 x 200}',
      stderr: "",
    });
    const fold: BootedDevice = {
      ...android,
      displays: {
        panels: [
          { key: "inner-key", role: "inner", sizePx: { width: 200, height: 200 } },
          { key: "cover-key", role: "cover", sizePx: { width: 100, height: 100 } },
        ],
        postures: ["opened", "closed"],
      },
    };
    const payload = await call(
      { action: "show", display: "inner", spec: appLayer({ elementId: "button_elevated" }) },
      fold,
    );
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("default display");
    expectUntouched();
  });

  test("a valid anchored app-layer show grants once, before the show request", async () => {
    const payload = await call({
      action: "show",
      spec: appLayer({ elementId: "button_elevated" }),
    });
    expect(payload.success).toBe(true);
    expect(adb.getExecutedCommands().filter((command) => command === APPOP)).toHaveLength(1);
    expect(client.getPrototypeHistory()).toHaveLength(1);
  });
});

/** Serves the captured iPhone 17 Settings hierarchy with the injected agent's window above it. */
class CapturedIosHierarchy implements HierarchyCapture {
  readonly requests: HierarchyCaptureRequest[] = [];
  constructor(private readonly hierarchy: ViewHierarchyResult) {}
  async capture(request: HierarchyCaptureRequest): Promise<HierarchySnapshot> {
    this.requests.push(request);
    return {
      captureId: "captured-ios",
      platform: "ios",
      requestedFreshness: request.freshness,
      updatedAt: IOS_UPDATED_AT,
      receivedAt: 0,
      hierarchy: this.hierarchy,
      nodes: [],
    };
  }
}

const IOS_UPDATED_AT = 1791385231063;

describe("prototype show with anchors on an iOS simulator (#9316)", () => {
  let converted: ViewHierarchyResult;
  let agent: FakePrototypeAgentClient;
  let hierarchy: CapturedIosHierarchy;
  let restore: () => void;
  let unsubscribe: () => void;

  beforeAll(() => {
    converted = new CtrlProxyHierarchy({} as HierarchyDelegateContext).convertToViewHierarchyResult(
      iosFloatingOverlayOverSettings(),
    );
  });
  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    agent = new FakePrototypeAgentClient({
      agentVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: [...FAKE_PROTOTYPE_AGENT_CAPABILITIES, PROTOTYPE_ANCHOR_CAPABILITY],
    });
    hierarchy = new CapturedIosHierarchy(converted);
    unsubscribe = registerPrototypeTools({
      clientFactory: () => {
        throw new Error("an iOS show must not reach CtrlProxy");
      },
      agentConnections: { get: (deviceId) => (deviceId === ios.deviceId ? agent : undefined) },
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      anchorHierarchyCaptureFactory: () => hierarchy,
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: unknown) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(ios, input);
    return prototypeOutputSchema.parse(response.structuredContent);
  }
  const shows = () => agent.requests.filter((request) => request.type === "show_prototype");

  test("an element anchor is sent to the agent as the element's point bounds, unconverted", async () => {
    const spec = {
      id: "cover",
      window: { placement: { type: "fullscreen" } },
      root: {
        type: "column",
        children: [
          { type: "text", text: "Header" },
          {
            type: "box",
            children: [],
            style: { background: "#80FF0000" },
            anchor: {
              type: "element",
              selector: { elementId: "com.apple.settings.general" },
              alignment: "cover",
            },
          },
        ],
      },
    };
    const payload = await call({ action: "show", spec });
    expect(payload.success).toBe(true);
    expect(hierarchy.requests.map((request) => request.freshness)).toEqual(["fresh"]);
    const bounds = { x: 16, y: 380, width: 370, height: 52 };
    expect(shows()).toHaveLength(1);
    const sent = shows()[0].body as { spec: { root: { children: { anchor?: unknown }[] } } };
    expect(sent.spec.root.children[1].anchor).toEqual({
      type: "bounds",
      bounds,
      alignment: "cover",
    });
    expect(payload.anchors).toEqual([
      {
        path: "root.children[1]",
        alignment: "cover",
        boundsPx: { left: 16, top: 380, right: 386, bottom: 432 },
        bounds,
      },
    ]);
    expect(payload.hierarchyUpdatedAt).toBe(IOS_UPDATED_AT);
  });

  test("a floating root anchored to an app element keeps alignment and offset", async () => {
    const spec = anchoredSpec({ text: "General" });
    spec.root.anchor = {
      type: "element",
      selector: { text: "General" },
      alignment: "bottom",
      offset: { x: 0, y: 8 },
    } as never;
    const payload = await call({ action: "show", spec });
    expect(payload.success).toBe(true);
    expect((shows()[0].body as { spec: { root: { anchor: unknown } } }).spec.root.anchor).toEqual({
      type: "bounds",
      bounds: { x: 16, y: 380, width: 370, height: 52 },
      alignment: "bottom",
      offset: { x: 0, y: 8 },
    });
  });

  test("the agent's own controls are not anchor targets and nothing is sent", async () => {
    const payload = await call({
      action: "show",
      spec: anchoredSpec({ elementId: "automobile-prototype-dismiss" }),
    });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Only the app is searched");
    expect(shows()).toEqual([]);
  });

  test("an agent without anchor support is refused before anything is captured or sent", async () => {
    agent = new FakePrototypeAgentClient();
    unsubscribe();
    const timer = new FakeTimer();
    unsubscribe = registerPrototypeTools({
      agentConnections: { get: () => agent },
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      anchorHierarchyCaptureFactory: () => hierarchy,
    });
    const bounds = {
      ...anchoredSpec({}),
      root: {
        type: "box",
        children: [],
        anchor: { type: "bounds", bounds: { x: 0, y: 0, width: 10, height: 10 } },
      },
    };
    for (const spec of [anchoredSpec({ elementId: "com.apple.settings.general" }), bounds]) {
      const payload = await call({ action: "show", spec });
      expect(payload.success).toBe(false);
      expect(payload.error).toContain(
        `iOS prototype agent does not advertise ${PROTOTYPE_ANCHOR_CAPABILITY}`,
      );
      expect(payload.error).toContain("launchApp prototype: true");
    }
    expect(hierarchy.requests).toEqual([]);
    expect(agent.requests).toEqual([]);
  });

  test("a floating window refuses an anchor below its root, as on Android", async () => {
    const spec = {
      ...anchoredSpec({}),
      root: {
        type: "column",
        children: [
          {
            type: "box",
            children: [],
            anchor: { type: "bounds", bounds: { x: 0, y: 0, width: 1, height: 1 } },
          },
        ],
      },
    };
    const payload = await call({ action: "show", spec });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("in a floating window only the root node can be anchored");
    expect(shows()).toEqual([]);
  });
});
