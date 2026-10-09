import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  OVERLAY_ANCHOR_CAPABILITY,
  OVERLAY_DISPLAY_CAPABILITY,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import type {
  HierarchyCapture,
  HierarchyCaptureRequest,
  HierarchySnapshot,
} from "../../src/features/observe/HierarchyCapture";
import { CtrlProxyHierarchy } from "../../src/features/observe/ios/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../src/features/observe/ios/types";
import type { BootedDevice, ViewHierarchyResult } from "../../src/models";
import { overlayOutputSchema, registerOverlayTools } from "../../src/server/overlayTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import {
  FAKE_OVERLAY_AGENT_CAPABILITIES,
  FakeOverlayAgentClient,
} from "../fakes/FakeOverlayAgentClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { iosFloatingOverlayOverSettings } from "../fixtures/observe/iosOverlayWindow";
import { capturedFloatingCoverHierarchy } from "../helpers/overlayWindowCapture";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "fake-anchor", platform: "android", name: "Fake" };
const ios: BootedDevice = { deviceId: "sim-anchor", platform: "ios", name: "Sim" };
const UPDATED_AT = 1791481170726;

/** Serves the captured API 36 Playground hierarchy with the CtrlProxy overlay over it. */
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
    client.setSupportedCommands([OVERLAY_ANCHOR_CAPABILITY]);
    hierarchy = new CapturedHierarchy();
    unsubscribe = registerOverlayTools({
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
    return overlayOutputSchema.parse(response.structuredContent);
  }

  test("an element anchor is sent as resolved dp bounds and reported with the hierarchy time", async () => {
    const payload = await call({
      action: "show",
      spec: anchoredSpec({ elementId: "button_elevated" }),
    });
    expect(payload.success).toBe(true);
    expect(hierarchy.requests).toHaveLength(1);
    expect(hierarchy.requests[0].freshness).toBe("fresh");
    const sent = client.getOverlayHistory()[0] as {
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
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("an overlay node is not an anchor target", async () => {
    const payload = await call({ action: "show", spec: anchoredSpec({ testTag: "coverBox" }) });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Only the app is searched");
    expect(client.getOverlayHistory()).toEqual([]);
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
      expect(payload.error).toContain(OVERLAY_ANCHOR_CAPABILITY);
    }
    expect(hierarchy.requests).toEqual([]);
    expect(client.getOverlayHistory()).toEqual([]);
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
    expect((client.getOverlayHistory()[0] as { spec: unknown }).spec).toEqual(spec);
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
    expect(client.getOverlayHistory()).toEqual([]);
    const fullscreen = { ...spec, window: { placement: { type: "fullscreen" } } };
    expect((await call({ action: "show", spec: fullscreen })).success).toBe(true);
  });

  test("a spec without anchors never captures a hierarchy", async () => {
    const spec = { ...anchoredSpec({}), root: { type: "text", text: "hi" } };
    expect((await call({ action: "show", spec })).success).toBe(true);
    expect(hierarchy.requests).toEqual([]);
  });

  test("element anchors on another display are refused", async () => {
    client.setSupportedCommands([OVERLAY_ANCHOR_CAPABILITY, OVERLAY_DISPLAY_CAPABILITY]);
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout:
        'Display id 0: DisplayInfo{uniqueId "local:cover-key" type INTERNAL, real 100 x 100}\n' +
        'Display id 2: DisplayInfo{uniqueId "local:inner-key" type INTERNAL, real 200 x 200}',
      stderr: "",
    });
    unsubscribe();
    const timer = new FakeTimer();
    unsubscribe = registerOverlayTools({
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
    expect(client.getOverlayHistory()).toEqual([]);
    expect(hierarchy.requests).toEqual([]);
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
  let agent: FakeOverlayAgentClient;
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
    agent = new FakeOverlayAgentClient({
      agentVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: [...FAKE_OVERLAY_AGENT_CAPABILITIES, OVERLAY_ANCHOR_CAPABILITY],
    });
    hierarchy = new CapturedIosHierarchy(converted);
    unsubscribe = registerOverlayTools({
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
    return overlayOutputSchema.parse(response.structuredContent);
  }
  const shows = () => agent.requests.filter((request) => request.type === "show_overlay");

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
      spec: anchoredSpec({ elementId: "automobile-overlay-dismiss" }),
    });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Only the app is searched");
    expect(shows()).toEqual([]);
  });

  test("an agent without anchor support is refused before anything is captured or sent", async () => {
    agent = new FakeOverlayAgentClient();
    unsubscribe();
    const timer = new FakeTimer();
    unsubscribe = registerOverlayTools({
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
        `iOS overlay agent does not advertise ${OVERLAY_ANCHOR_CAPABILITY}`,
      );
      expect(payload.error).toContain("launchApp overlay: true");
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
