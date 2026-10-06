import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  overlayOutputSchema,
  overlaySchema,
  registerOverlayTools,
} from "../../src/server/overlayTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { runSessionDisplayPin } from "../../src/server/sessionDisplayPin";
import type { BootedDevice } from "../../src/models";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const BOTH_PANELS =
  'Display id 0: DisplayInfo{uniqueId "local:cover-key" type INTERNAL, real 100 x 100}\n' +
  'Display id 2: DisplayInfo{uniqueId "local:inner-key" type INTERNAL, real 200 x 200}';
const COVER_ONLY =
  'Display id 0: DisplayInfo{uniqueId "local:cover-key" type INTERNAL, real 100 x 100}';
const device: BootedDevice = {
  deviceId: "fold-overlay",
  platform: "android",
  name: "Fold",
  displays: {
    panels: [
      { key: "inner-key", role: "inner", sizePx: { width: 200, height: 200 } },
      { key: "cover-key", role: "cover", sizePx: { width: 100, height: 100 } },
    ],
    postures: ["opened", "closed"],
  },
};
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "text" as const, text: "Hello" },
};

describe("overlay display targeting", () => {
  let client: FakeCtrlProxy;
  let adb: FakeAdbExecutor;
  let restore: () => void;
  let unsubscribe: () => void;

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands(["overlay_display_id_v1"]);
    adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", { stdout: BOTH_PANELS, stderr: "" });
    unsubscribe = registerOverlayTools({
      clientFactory: () => client,
      adbFactory: new FakeAdbClientFactory(adb),
      lastRenderedObservation: () => undefined,
      clock: timer,
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: Record<string, unknown>) {
    const handler = ToolRegistry.getTool("overlay")!.deviceAwareHandler!;
    const response = await handler(device, input);
    return overlayOutputSchema.parse(response.structuredContent);
  }

  /** The registry wraps device-aware handlers in this seam, which injects a session pin. */
  async function callPinned(input: Record<string, unknown>, pin: string | undefined) {
    const handler = ToolRegistry.getTool("overlay")!.deviceAwareHandler!;
    const response = (await runSessionDisplayPin({
      name: "overlay",
      acceptsDisplay: true,
      device,
      args: input,
      sessionUuid: "one",
      store: {
        getDeviceForSession: () => device.deviceId,
        getDisplayPin: () => pin,
      },
      invoke: (args) => handler(device, args),
    })) as { structuredContent: unknown };
    return overlayOutputSchema.parse(response.structuredContent);
  }

  test("default: no display reads no inventory and sends no display", async () => {
    const payload = await call({ action: "show", spec });
    expect(payload.success).toBe(true);
    expect(client.getOverlayHistory()).toEqual([
      { method: "show", spec, timeoutMs: 5000, perf: undefined },
    ]);
    expect(Object.hasOwn(client.getOverlayHistory()[0], "displayId")).toBe(false);
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(payload.lastResult?.displayId).toBeUndefined();
  });

  test("explicit display resolves a role to its logical display id and records it", async () => {
    const payload = await call({ action: "show", spec, display: "inner" });
    expect(payload.success).toBe(true);
    expect(client.getOverlayHistory()).toMatchObject([{ method: "show", displayId: 2 }]);
    expect(payload.lastResult?.displayId).toBe(2);
    expect(
      (await call({ action: "status" })).overlays?.map((entry) => [entry.id, entry.displayId]),
    ).toEqual([["panel", 2]]);
  });

  test("an explicit physical panel key resolves the same way", async () => {
    await call({ action: "show", spec, display: "inner-key" });
    expect(client.getOverlayHistory()).toMatchObject([{ displayId: 2 }]);
  });

  test("the default display needs no capability and is recorded as display 0", async () => {
    client.setSupportedCommands([]);
    const payload = await call({ action: "show", spec, display: "cover" });
    expect(payload.success).toBe(true);
    expect(client.getOverlayHistory()).toMatchObject([{ displayId: 0 }]);
    expect(payload.lastResult?.displayId).toBe(0);
  });

  test("session pin applies when display is omitted", async () => {
    const payload = await callPinned({ action: "show", spec }, "inner");
    expect(payload.success).toBe(true);
    expect(client.getOverlayHistory()).toMatchObject([{ displayId: 2 }]);
  });

  test("explicit display beats the session pin", async () => {
    await callPinned({ action: "show", spec, display: "cover" }, "inner");
    expect(client.getOverlayHistory()).toMatchObject([{ displayId: 0 }]);
  });

  test("a session pin never injects display into update, dismiss or status", async () => {
    expect((await callPinned({ action: "show", spec }, "inner")).success).toBe(true);
    for (const input of [
      { action: "update", id: "panel", state: { label: "x" } },
      { action: "status" },
      { action: "dismiss", all: true },
    ]) {
      const payload = await callPinned(input, "inner");
      expect(payload.error).toBeUndefined();
      expect(payload.success).toBe(true);
    }
  });

  test("update and dismiss echo the display the overlay was shown on", async () => {
    await call({ action: "show", spec, display: "inner" });
    const update = await call({ action: "update", id: "panel", state: { label: "x" } });
    expect(update.lastResult?.displayId).toBe(2);
    expect((await call({ action: "status" })).overlays).toMatchObject([
      { id: "panel", lastAction: "update", displayId: 2 },
    ]);
    expect((await call({ action: "dismiss", id: "panel" })).lastResult?.displayId).toBe(2);
  });

  test("a disconnected panel is refused with posture guidance and nothing is sent", async () => {
    adb.setCommandResponse("cmd display get-displays", { stdout: COVER_ONLY, stderr: "" });
    const payload = await call({ action: "show", spec, display: "inner" });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('Display "inner-key" (inner) is not connected');
    expect(payload.error).toContain("setPosture");
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("a stale pin on a disconnected panel names the pin remedy", async () => {
    adb.setCommandResponse("cmd display get-displays", { stdout: COVER_ONLY, stderr: "" });
    const payload = await callPinned({ action: "show", spec }, "inner");
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Clear the pin with setActiveDevice");
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("an unknown display is refused before any display read or send", async () => {
    const payload = await call({ action: "show", spec, display: "nonesuch" });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('Unknown or unavailable display "nonesuch"');
    expect(client.getOverlayHistory()).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("a device without overlay_display_id_v1 is refused instead of defaulting silently", async () => {
    client.setSupportedCommands(["gesture_display_id_v1", "show_overlay"]);
    const payload = await call({ action: "show", spec, display: "inner" });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("overlay_display_id_v1");
    expect(payload.error).toContain("display 2");
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("display is a show-only argument", () => {
    for (const input of [
      { action: "update", id: "panel", state: { a: 1 }, display: "inner" },
      { action: "dismiss", all: true, display: "inner" },
      { action: "status", display: "inner" },
    ]) {
      const parsed = overlaySchema.safeParse(input);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("display");
    }
    expect(overlaySchema.safeParse({ action: "show", spec, display: "inner" }).success).toBe(true);
  });
});
