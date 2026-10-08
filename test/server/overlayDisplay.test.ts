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
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler(device, input);
    return overlayOutputSchema.parse(response.structuredContent);
  }

  /** The registry wraps device-aware handlers in this seam, which injects a session pin. */
  async function callPinned(input: Record<string, unknown>, pin: string | undefined) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = (await runSessionDisplayPin({
      name: "prototype",
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

  test("the default display needs no capability and records no displayId", async () => {
    client.setSupportedCommands([]);
    const payload = await call({ action: "show", spec, display: "cover" });
    expect(payload.success).toBe(true);
    expect(client.getOverlayHistory()[0].displayId).toBeUndefined();
    expect(payload.lastResult).toBeDefined();
    expect(Object.hasOwn(payload.lastResult ?? {}, "displayId")).toBe(false);
    const status = await call({ action: "status" });
    expect(status.overlays?.map((entry) => Object.hasOwn(entry, "displayId"))).toEqual([false]);
  });

  test("a session pin that resolves to the default display records no displayId", async () => {
    const payload = await callPinned({ action: "show", spec }, "cover");
    expect(payload.success).toBe(true);
    expect(client.getOverlayHistory()[0].displayId).toBeUndefined();
    expect(Object.hasOwn(payload.lastResult ?? {}, "displayId")).toBe(false);
  });

  test("session pin applies when display is omitted", async () => {
    const payload = await callPinned({ action: "show", spec }, "inner");
    expect(payload.success).toBe(true);
    expect(client.getOverlayHistory()).toMatchObject([{ displayId: 2 }]);
  });

  test("explicit display beats the session pin", async () => {
    await callPinned({ action: "show", spec, display: "cover" }, "inner");
    expect(client.getOverlayHistory()).toHaveLength(1);
    expect(client.getOverlayHistory()[0].displayId).toBeUndefined();
  });

  test("a session pin never injects display into dismiss or status", async () => {
    expect((await callPinned({ action: "show", spec }, "inner")).success).toBe(true);
    for (const input of [{ action: "status" }, { action: "dismiss", all: true }]) {
      const payload = await callPinned(input, "inner");
      expect(payload.error).toBeUndefined();
      expect(payload.success).toBe(true);
    }
  });

  test("a same-id show and a dismiss echo the display the overlay was shown on", async () => {
    await call({ action: "show", spec, display: "inner" });
    const again = await call({ action: "show", spec });
    expect(again.lastResult?.displayId).toBe(2);
    expect(again.warning).toBeUndefined();
    const elsewhere = await call({ action: "show", spec, display: "cover" });
    expect(elsewhere.lastResult?.displayId).toBe(2);
    expect(elsewhere.warning).toContain("display was ignored");
    expect(elsewhere.warning).toContain("logical display 2");
    expect((await call({ action: "status" })).overlays).toMatchObject([
      { id: "panel", lastAction: "show", displayId: 2 },
    ]);
    expect((await call({ action: "dismiss", id: "panel" })).lastResult?.displayId).toBe(2);
  });

  test("a same-id show on the same display carries no warning", async () => {
    await call({ action: "show", spec, display: "inner" });
    const again = await call({ action: "show", spec, display: "inner" });
    expect(again.success).toBe(true);
    expect(again.warning).toBeUndefined();
    // The in-place replacement names the display it replaces on, so a dismissal racing the
    // replacement cannot move it to the default display.
    expect(client.getOverlayHistory()[0].displayId).toBe(2);
    expect(client.getOverlayHistory()[1].displayId).toBe(2);
  });

  test("a same-id show under the pin it was shown with carries no warning", async () => {
    await callPinned({ action: "show", spec }, "inner");
    const again = await callPinned({ action: "show", spec }, "inner");
    expect(again.warning).toBeUndefined();
    expect(again.lastResult?.displayId).toBe(2);
  });

  test("a same-id show asking for another display keeps the shown one and warns", async () => {
    await call({ action: "show", spec });
    const moved = await call({ action: "show", spec, display: "inner" });
    expect(moved.success).toBe(true);
    expect(moved.warning).toContain("already shown on the default display");
    expect(moved.warning).toContain("reset: true");
    expect(Object.hasOwn(moved.lastResult ?? {}, "displayId")).toBe(false);
  });

  test("reset: true moves a same-id show to the requested display without a warning", async () => {
    await call({ action: "show", spec });
    const moved = await call({ action: "show", spec, display: "inner", reset: true });
    expect(moved.warning).toBeUndefined();
    expect(moved.lastResult?.displayId).toBe(2);
    expect(client.getOverlayHistory()[1]).toMatchObject({ displayId: 2, reset: true });
  });

  test("a same-id show ignores a selector that cannot resolve instead of failing", async () => {
    await call({ action: "show", spec });
    adb.setCommandResponse("cmd display get-displays", { stdout: COVER_ONLY, stderr: "" });
    const moved = await call({ action: "show", spec, display: "inner" });
    expect(moved.success).toBe(true);
    expect(moved.error).toBeUndefined();
    expect(moved.warning).toContain("display was ignored");
    expect(client.getOverlayHistory()).toHaveLength(2);
    const unknown = await call({ action: "show", spec, display: "nonesuch" });
    expect(unknown.success).toBe(true);
    expect(unknown.warning).toContain("display was ignored");
  });

  test("a failed reset show keeps the display the overlay is still on", async () => {
    await call({ action: "show", spec, display: "inner" });
    client.setOverlayResult({ success: false, error: "rejected" });
    const failed = await call({ action: "show", spec, display: "cover", reset: true });
    expect(failed.success).toBe(false);
    expect(failed.lastResult?.displayId).toBe(2);
    expect((await call({ action: "status" })).overlays).toMatchObject([{ displayId: 2 }]);
  });

  test("a show of another id is never in place and never warns about display", async () => {
    await call({ action: "show", spec });
    const other = await call({ action: "show", spec: { ...spec, id: "other" }, display: "inner" });
    expect(other.warning).toBeUndefined();
    expect(other.lastResult?.displayId).toBe(2);
  });

  test("a same-id show from another session is in place on the display the first one chose", async () => {
    await call({ action: "show", spec, display: "inner", sessionUuid: "one" });
    const second = await call({ action: "show", spec, display: "cover", sessionUuid: "two" });
    expect(second.success).toBe(true);
    expect(second.warning).toContain("logical display 2");
    expect(second.lastResult?.displayId).toBe(2);
    expect(client.getOverlayHistory()[1].displayId).toBe(2);
    expect(
      (await call({ action: "status", sessionUuid: "two" })).overlays?.map((e) => e.displayId),
    ).toEqual([2]);
  });

  test("a same-id show from another session ignores a selector the device cannot resolve", async () => {
    await call({ action: "show", spec, display: "inner", sessionUuid: "one" });
    adb.setCommandResponse("cmd display get-displays", { stdout: COVER_ONLY, stderr: "" });
    const second = await call({ action: "show", spec, display: "inner", sessionUuid: "two" });
    expect(second.success).toBe(true);
    expect(second.lastResult?.displayId).toBe(2);
  });

  test("only the latest concurrent same-id show commits its status", async () => {
    const reached: Array<() => void> = [];
    const release: Array<() => void> = [];
    const show = client.requestShowOverlay.bind(client);
    let calls = 0;
    client.requestShowOverlay = async (...args) => {
      if (calls++ === 0) {
        // The first show is held after the device accepted it, so it finishes last.
        const result = await show(...args);
        await new Promise<void>((resolve) => {
          release.push(resolve);
          reached.forEach((notify) => notify());
        });
        return result;
      }
      return show(...args);
    };
    const held = new Promise<void>((resolve) => reached.push(resolve));
    const older = call({ action: "show", spec, display: "inner" });
    await held;
    const newer = await call({ action: "show", spec });
    expect(newer.lastResult?.displayId).toBeUndefined();
    release[0]();
    const olderPayload = await older;
    expect(olderPayload.success).toBe(true);
    expect(olderPayload.lastResult?.displayId).toBe(2);
    const overlays = (await call({ action: "status" })).overlays;
    expect(overlays).toHaveLength(1);
    expect(Object.hasOwn(overlays?.[0] ?? {}, "displayId")).toBe(false);
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
