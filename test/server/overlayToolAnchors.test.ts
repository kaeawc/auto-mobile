import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  OVERLAY_ANCHOR_CAPABILITY,
  OVERLAY_DISPLAY_CAPABILITY,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import type {
  HierarchyCapture,
  HierarchyCaptureRequest,
  HierarchySnapshot,
} from "../../src/features/observe/HierarchyCapture";
import type { BootedDevice } from "../../src/models";
import { overlayOutputSchema, registerOverlayTools } from "../../src/server/overlayTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeTimer } from "../fakes/FakeTimer";
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

  test("anchors are refused on iOS rather than drawn unanchored", async () => {
    const payload = await call(
      { action: "show", spec: anchoredSpec({ elementId: "button_elevated" }) },
      ios,
    );
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("anchor is Android only");
  });
});
