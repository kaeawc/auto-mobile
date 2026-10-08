import { event } from "../helpers/overlayTestEvent";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  overlayOutputSchema,
  overlaySchema,
  registerOverlayTools,
  type OverlayEventLifecycle,
} from "../../src/server/overlayTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { validateOverlaySpec } from "../../src/features/overlay/overlayValidation";
import {
  grantOverlayAppLayer,
  OVERLAY_APP_LAYER_APPOP_COMMAND,
} from "../../src/features/overlay/overlayWindowOptions";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const spec = (window: Record<string, unknown> = {}) => ({
  id: "proto",
  window: { placement: { type: "fullscreen" as const }, ...window },
  root: { type: "text" as const, text: "Hello" },
});

describe("overlay window.layer and window.persistence", () => {
  let client: FakeCtrlProxy;
  let adb: FakeAdbExecutor;
  let restore: () => void;
  let unsubscribe: () => void;
  let releaseSession: (sessionUuid: string, deviceId?: string) => void = () => {};

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands(["overlay_window_options_v1"]);
    adb = new FakeAdbExecutor();
    const lifecycle: OverlayEventLifecycle = {
      subscribeSessionRelease: (listener) => {
        releaseSession = listener;
        return () => {};
      },
      subscribeDeviceRemoval: () => () => {},
      subscribeDeviceUnbound: () => () => {},
    };
    unsubscribe = registerOverlayTools({
      clientFactory: () => client,
      adbFactory: new FakeAdbClientFactory(adb),
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
      lifecycle,
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

  test("the spec schema and the shared contract accept both fields and reject unknown values", () => {
    const both = spec({ layer: "app", persistence: "device" });
    expect(validateOverlaySpec(both).success).toBe(true);
    expect(overlaySchema.safeParse({ action: "show", spec: both }).success).toBe(true);
    expect(validateOverlaySpec(spec({ layer: "system", persistence: "session" })).success).toBe(
      true,
    );
    expect(validateOverlaySpec(spec({ layer: "top" })).success).toBe(false);
    expect(validateOverlaySpec(spec({ persistence: "forever" })).success).toBe(false);
  });

  test("defaults send the spec unchanged with no capability check or appop grant", async () => {
    client.setSupportedCommands([]);
    const payload = await call({ action: "show", spec: spec() });
    expect(payload.success).toBe(true);
    expect(client.getOverlayHistory()).toMatchObject([{ method: "show", spec: spec() }]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("an app layer grants SYSTEM_ALERT_WINDOW before the show is sent", async () => {
    const payload = await call({ action: "show", spec: spec({ layer: "app" }) });
    expect(payload.success).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([OVERLAY_APP_LAYER_APPOP_COMMAND]);
    expect(OVERLAY_APP_LAYER_APPOP_COMMAND).toBe(
      "shell appops set dev.jasonpearson.automobile.ctrlproxy SYSTEM_ALERT_WINDOW allow",
    );
    expect(client.getOverlayHistory()).toMatchObject([
      { method: "show", spec: spec({ layer: "app" }) },
    ]);
  });

  test("a failed appop grant is logged and the device decides", async () => {
    adb.setCommandResponse(OVERLAY_APP_LAYER_APPOP_COMMAND, {
      stdout: "",
      stderr: "Error: Unknown package",
    });
    const payload = await call({ action: "show", spec: spec({ layer: "app" }) });
    expect(payload.success).toBe(true);
    expect(client.getOverlayHistory()).toHaveLength(1);
  });

  test("a cancelled appop grant is rethrown, not treated as a failed grant", async () => {
    adb.setThrowOnAbortedSignal();
    const controller = new AbortController();
    controller.abort();
    await expect(grantOverlayAppLayer(adb, controller.signal)).rejects.toThrow();
    // Without cancellation a failing grant is still only logged.
    adb.setCommandError(OVERLAY_APP_LAYER_APPOP_COMMAND, new Error("adb down"));
    await expect(grantOverlayAppLayer(adb)).resolves.toBeUndefined();
  });

  test("a request cancelled before the grant never sends the overlay", async () => {
    adb.setThrowOnAbortedSignal();
    const controller = new AbortController();
    controller.abort();
    const handler = ToolRegistry.getTool("overlay")!.deviceAwareHandler!;
    await expect(
      handler(
        device,
        { action: "show", spec: spec({ layer: "app" }) },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("device persistence needs no grant", async () => {
    const payload = await call({ action: "show", spec: spec({ persistence: "device" }) });
    expect(payload.success).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("a device without overlay_window_options_v1 is refused before anything is sent", async () => {
    client.setSupportedCommands([]);
    const payload = await call({
      action: "show",
      spec: spec({ layer: "app", persistence: "device" }),
    });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("overlay_window_options_v1");
    expect(payload.error).toContain('window.layer "app" and window.persistence "device"');
    expect(client.getOverlayHistory()).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("a persistence-only request cancelled during the capability lookup never sends", async () => {
    const controller = new AbortController();
    controller.abort();
    const handler = ToolRegistry.getTool("overlay")!.deviceAwareHandler!;
    await expect(
      handler(
        device,
        { action: "show", spec: spec({ persistence: "device" }) },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("a refused replacement keeps the buffered events of the overlay still on screen", async () => {
    await call({ action: "show", spec: spec() });
    client.emitOverlayEvent(event(1, "proto"));
    client.setSupportedCommands([]);
    const refused = await call({ action: "show", spec: spec({ layer: "app" }) });
    expect(refused.success).toBe(false);
    const awaited = await call({ action: "awaitEvent", id: "proto" });
    expect(awaited.event?.sequence).toBe(1);
  });

  test("update with a spec is checked like show", async () => {
    await call({ action: "show", spec: spec() });
    client.setSupportedCommands([]);
    const payload = await call({
      action: "update",
      id: "proto",
      spec: spec({ persistence: "device" }),
    });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("overlay_window_options_v1");
    expect(client.getOverlayHistory()).toHaveLength(1);
  });

  test("showVariants carries layer and persistence onto the composed window", async () => {
    const payload = await call({
      action: "showVariants",
      id: "proto",
      variants: [{ spec: { type: "text", text: "Only" } }],
      layer: "app",
      persistence: "device",
    });
    expect(payload.success).toBe(true);
    expect(client.getOverlayHistory()).toMatchObject([
      { method: "show", spec: { window: { layer: "app", persistence: "device" } } },
    ]);
    expect(adb.getExecutedCommands()).toEqual([OVERLAY_APP_LAYER_APPOP_COMMAND]);
  });

  test("layer and persistence are showVariants-only top-level parameters", () => {
    const parsed = overlaySchema.safeParse({ action: "show", spec: spec(), layer: "app" });
    expect(parsed.success).toBe(false);
  });

  test("session release sends no dismiss for a device persistent overlay", async () => {
    await call({ action: "show", spec: spec({ persistence: "device" }) });
    releaseSession("session-1", device.deviceId);
    expect(client.getOverlayHistory().map((entry) => entry.method)).toEqual(["show"]);
  });
});
