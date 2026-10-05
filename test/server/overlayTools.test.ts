import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  registerOverlayTools,
  overlaySchema,
  overlayOutputSchema,
} from "../../src/server/overlayTools";
import { registerHighlightTools } from "../../src/server/highlightTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { ActionableError, type BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { FakeToolSelectionRepository } from "../fakes/FakeToolSelectionRepository";
import { SessionToolSelectionService } from "../../src/features/toolSelection/SessionToolSelectionService";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { compileJsonSchema } from "../helpers/jsonSchemaCompile";
import { initializeCliTools } from "../../src/cli/cliToolRegistration";
import { registerToolSelectionTools } from "../../src/server/toolSelectionTools";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../../src/daemon/streamDeviceLifecycleEvents";
import { INTERNAL_TOOL_PARAM_NAMES } from "../../src/daemon/constants";
import { InMemoryOverlayStatusStore } from "../../src/features/overlay/OverlayStatusStore";

const device: BootedDevice = { deviceId: "fake-overlay", platform: "android", name: "Fake" };
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const }, opacity: 80 },
  root: { type: "text" as const, text: "Hello" },
};

describe("overlay MCP tool", () => {
  let client: FakeCtrlProxy;
  let timer: FakeTimer;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeEach(() => {
    restore = preserveToolRegistry();
    timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    unsubscribe = registerOverlayTools({ clientFactory: () => client, clock: timer });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: unknown, target = device) {
    const response = await ToolRegistry.getTool("overlay")!.deviceAwareHandler!(target, input);
    const payload = overlayOutputSchema.parse(response.structuredContent);
    expect(JSON.parse(response.content[0].text)).toEqual(payload);
    expect(response.content.every((item: { type: string }) => item.type === "text")).toBe(true);
    return { response, payload };
  }

  test("registering overlay preserves an existing highlight registration", () => {
    registerHighlightTools();
    const highlight = ToolRegistry.getTool("highlight");
    const unsubscribeReplacement = registerOverlayTools({
      clientFactory: () => client,
      clock: timer,
    });
    unsubscribeReplacement();
    expect(ToolRegistry.getTool("highlight")).toBe(highlight);
  });

  test("replacement registration retires lifecycle subscriptions for the previous store", () => {
    const oldStore = new InMemoryOverlayStatusStore(timer);
    const newStore = new InMemoryOverlayStatusStore(timer);
    const scope = { deviceId: device.deviceId, sessionUuid: "one" };
    oldStore.record(scope, "show", { id: "old" }, { success: true });
    newStore.record(scope, "show", { id: "new" }, { success: true });
    const unsubscribeOld = registerOverlayTools({ clientFactory: () => client, store: oldStore });
    unsubscribe = registerOverlayTools({ clientFactory: () => client, store: newStore });
    // A stale disposer must not detach the replacement's listeners.
    unsubscribeOld();
    SessionReleaseBroadcaster.emit("one", "released");
    getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(device.deviceId);
    expect(oldStore.status(scope).overlays.map((entry) => entry.id)).toEqual(["old"]);
    expect(newStore.status(scope)).toEqual({ overlays: [] });
  });

  test("ambient routing session scopes local status when input omits sessionUuid", async () => {
    await runWithToolSelectionContext({ routingSessionUuid: "ambient" }, async () => {
      await call({ action: "show", spec });
      expect((await call({ action: "status" })).payload.overlays).toHaveLength(1);
    });
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "ambient" })).payload.overlays,
    ).toHaveLength(1);
  });

  test("show forwards valid spec unchanged and status stays local", async () => {
    await call({ action: "show", spec, sessionUuid: "session", timeoutMs: 50 });
    expect(client.getOverlayHistory()).toEqual([
      { method: "show", spec, timeoutMs: 50, perf: undefined },
    ]);
    timer.advanceTime(12);
    const { payload } = await call({ action: "status", sessionUuid: "session" });
    expect(payload.overlays).toEqual([
      { id: "panel", lastAction: "show", success: true, timestamp: 0 },
    ]);
    expect(payload.lastResult).toEqual(payload.overlays![0]);
    expect(client.getOverlayHistory()).toHaveLength(1);
  });

  test("omitted opacity uses the existing spec default", async () => {
    await call({ action: "show", spec: { ...spec, window: { placement: spec.window.placement } } });
    expect(client.getOverlayHistory()[0].spec?.window).toEqual({
      placement: spec.window.placement,
    });
  });

  test("successful show replaces the previous id, which status no longer offers for dismissal", async () => {
    await call({ action: "show", spec });
    await call({ action: "show", spec: { ...spec, id: "second" } });
    const status = (await call({ action: "status" })).payload;
    expect(status.overlays?.map((entry) => entry.id)).toEqual(["second"]);
    client.setOverlayResult({ success: false, error: "Unknown overlay id" });
    await call({ action: "dismiss", id: "panel" });
    expect((await call({ action: "status" })).payload.overlays?.map((entry) => entry.id)).toEqual([
      "second",
    ]);
  });

  test("successful show replaces presence across sessions on only that device", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec, sessionUuid: "one" }, { ...device, deviceId: "other" });
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "two" })).payload.overlays?.map(
        (entry) => entry.id,
      ),
    ).toEqual(["second"]);
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toHaveLength(1);
  });

  test("session release forgets all device scopes but preserves unrelated devices", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    await call({ action: "show", spec, sessionUuid: "other" }, { ...device, deviceId: "other" });
    SessionReleaseBroadcaster.emit("one", "released");
    expect((await call({ action: "status", sessionUuid: "one" })).payload).toEqual({
      success: true,
      overlays: [],
    });
    expect((await call({ action: "status", sessionUuid: "two" })).payload).toEqual({
      success: true,
      overlays: [],
    });
    expect(
      (await call({ action: "status", sessionUuid: "other" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toHaveLength(1);
  });

  test("device removal forgets every scope for that device", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    await call({ action: "show", spec, sessionUuid: "one" }, { ...device, deviceId: "other" });
    getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(device.deviceId);
    for (const sessionUuid of ["one", "two"]) {
      expect((await call({ action: "status", sessionUuid })).payload).toEqual({
        success: true,
        overlays: [],
      });
    }
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toHaveLength(1);
  });

  test("canonical metadata is stripped only from tool input, preserving authored state keys", async () => {
    const state = Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, "authored"]));
    const metadata = Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, true]));
    const authored = { ...spec, state };
    expect((await call({ action: "show", spec: authored, ...metadata })).payload.success).toBe(
      true,
    );
    await call({ action: "update", id: "panel", state, ...metadata });
    expect(client.getOverlayHistory()[0].spec).toEqual(authored);
    expect(client.getOverlayHistory()[1].update).toEqual({ id: "panel", state });
    expect(state).toEqual(
      Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, "authored"])),
    );
  });

  test("failed replacement preserves presence and lastResult for an existing scope", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    client.setOverlayResult({ success: false, error: "Service refused" });
    const failed = await call({
      action: "show",
      spec: { ...spec, id: "second" },
      sessionUuid: "one",
    });
    const status = (await call({ action: "status", sessionUuid: "one" })).payload;
    expect(status.overlays?.map((entry) => entry.id)).toEqual(["panel"]);
    expect(status.lastResult).toEqual(failed.payload.lastResult);
    await call({ action: "show", spec: { ...spec, id: "second" }, sessionUuid: "two" });
    expect(
      (await call({ action: "status", sessionUuid: "two" })).payload.lastResult,
    ).toBeUndefined();
    expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toHaveLength(1);
  });

  test("a reserved name in authored state is still validated", async () => {
    const state = { [INTERNAL_TOOL_PARAM_NAMES[0]]: { invalid: true } };
    expect((await call({ action: "update", id: "panel", state })).response.isError).toBe(true);
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("release snapshot clears unscoped device entries even without session history", async () => {
    await call({ action: "show", spec });
    SessionReleaseBroadcaster.emit("unrecorded-session", "released", {
      sessionId: "unrecorded-session",
      deviceId: device.deviceId,
      releaseReason: "released",
      releasedAtMs: timer.now(),
      terminal: true,
      heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: true, timeoutMs: 50, ageMs: 0 },
    });
    expect((await call({ action: "status" })).payload).toEqual({ success: true, overlays: [] });
  });

  test("update spec and state, dismiss id and all update local status", async () => {
    await call({ action: "show", spec });
    timer.advanceTime(5);
    const replacement = { ...spec, window: { ...spec.window, opacity: 30 } };
    await call({ action: "update", id: "panel", spec: replacement });
    expect(client.getOverlayHistory()[1].update).toEqual({ id: "panel", spec: replacement });
    await call({ action: "update", id: "panel", state: { title: "Updated", enabled: true } });
    expect(client.getOverlayHistory()[2].update).toEqual({
      id: "panel",
      state: { title: "Updated", enabled: true },
    });
    expect((await call({ action: "status" })).payload.overlays).toEqual([
      { id: "panel", lastAction: "update", success: true, timestamp: 5 },
    ]);
    await call({ action: "dismiss", id: "panel" });
    expect(client.getOverlayHistory()[3].target).toEqual({ id: "panel" });
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
    await call({ action: "show", spec });
    await call({ action: "show", spec: { ...spec, id: "second" } });
    await call({ action: "dismiss", all: true });
    expect(client.getOverlayHistory().at(-1)?.target).toEqual({ all: true });
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
  });

  test("status isolates device and session and never invents shows on update", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    expect((await call({ action: "status", sessionUuid: "two" })).payload.overlays).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toEqual([]);
    await call({ action: "show", spec, sessionUuid: "one" }, { ...device, deviceId: "other" });
    await call({ action: "dismiss", all: true, sessionUuid: "two" });
    expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toHaveLength(1);
    await call({ action: "update", id: "unknown", state: {} });
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
  });

  test("dismiss by id removes that device's known id across sessions", async () => {
    await call({ action: "show", spec, sessionUuid: "one" });
    await call({ action: "show", spec, sessionUuid: "two" });
    await call({ action: "show", spec, sessionUuid: "one" }, { ...device, deviceId: "other" });
    await call({ action: "dismiss", id: "panel", sessionUuid: "two" });
    expect((await call({ action: "status", sessionUuid: "one" })).payload.overlays).toEqual([]);
    expect((await call({ action: "status", sessionUuid: "two" })).payload.overlays).toEqual([]);
    expect(
      (await call({ action: "status", sessionUuid: "one" }, { ...device, deviceId: "other" }))
        .payload.overlays,
    ).toHaveLength(1);
  });

  test.each(["show", "update", "dismiss", "status"])(
    "iOS %s fails with Android-only guidance",
    async (action) => {
      const input =
        action === "show"
          ? { action, spec }
          : action === "update"
            ? { action, id: "panel", state: {} }
            : action === "dismiss"
              ? { action, all: true }
              : { action };
      const { response, payload } = await call(input, { ...device, platform: "ios" });
      expect(response.isError).toBe(true);
      expect(payload.error).toContain("Android only");
      expect(client.getOverlayHistory()).toEqual([]);
    },
  );

  test.each([
    [{ ...spec, root: { type: "unknown" } }, "root.type", "text"],
    [{ ...spec, window: { ...spec.window, opacity: 101 } }, "window.opacity", "100"],
    [{ ...spec, root: { type: "icon", name: "unknown" } }, "root", "home"],
    [{ ...spec, root: { ...spec.root, unknown: true } }, "root.unknown", "Unknown property"],
  ])("invalid spec rejected before client call", async (invalid, path, allowed) => {
    const input = { action: "show", spec: invalid };
    expect(overlaySchema.safeParse(input).success).toBe(false);
    const { response, payload } = await call(input);
    expect(response.isError).toBe(true);
    expect(payload.error).toContain(path);
    expect(payload.error).toContain(allowed);
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test.each([
    { action: "show" },
    { action: "show", spec, state: {} },
    { action: "update", id: "panel" },
    { action: "update", id: "panel", spec, state: {} },
    { action: "update", id: "different", spec },
    { action: "update", id: "panel", state: { nested: {} } },
    { action: "dismiss", id: "panel", all: true },
    { action: "dismiss" },
    { action: "status", id: "panel" },
  ])("action contract rejects ambiguous input %j", async (input) => {
    expect(overlaySchema.safeParse(input).success).toBe(false);
    expect((await call(input)).response.isError).toBe(true);
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("failed show has lastResult but is not shown; failed update/dismiss preserve presence", async () => {
    client.setOverlayResult({ success: false, error: "Permission denied; enable accessibility" });
    const failed = await call({ action: "show", spec });
    expect(failed.response.isError).toBe(true);
    expect(failed.payload.error).toContain("enable accessibility");
    let status = (await call({ action: "status" })).payload;
    expect(status.overlays).toEqual([]);
    expect(status.lastResult).toBeUndefined();
    expect(failed.payload.lastResult?.success).toBe(false);
    client.setOverlayResult({ success: true });
    await call({ action: "show", spec });
    client.setOverlayResult({ success: false, error: "Service refused" });
    await call({ action: "update", id: "panel", state: {} });
    status = (await call({ action: "status" })).payload;
    expect(status.overlays![0]).toMatchObject({
      lastAction: "update",
      success: false,
      error: "Service refused",
    });
    await call({ action: "dismiss", all: true });
    expect((await call({ action: "status" })).payload.overlays).toHaveLength(1);
  });

  test("unsupported capability ActionableError surfaces unchanged", async () => {
    const message =
      "show_overlay: this CtrlProxy build does not support overlays; update the connected CtrlProxy.";
    client.setFailureMode("requestShowOverlay", new ActionableError(message));
    const { response, payload } = await call({ action: "show", spec });
    expect(response.isError).toBe(true);
    expect(payload.error).toBe(message);
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
  });

  test("default off mirrors highlight; setToolEnabled enables discovery without changing highlight", async () => {
    registerHighlightTools();
    registerToolSelectionTools();
    const overlay = ToolRegistry.getTool("overlay")!;
    expect(overlay.defaultEnabled).toBe(false);
    expect(ToolRegistry.getTool("highlight")!.defaultEnabled).toBe(false);
    expect(ToolRegistry.getConfigurableToolNames()).toContain("overlay");
    const selection = new SessionToolSelectionService(new FakeToolSelectionRepository());
    await runWithToolSelectionContext(
      { toolSelectionProfileUuid: "profile", sessionToolSelectionService: selection },
      async () => {
        expect(await selection.isEnabled("profile", "overlay", overlay.defaultEnabled)).toBe(false);
        const response = await ToolRegistry.getTool("setToolEnabled")!.handler({
          toolName: "overlay",
          enabled: true,
        });
        expect(response.isError).not.toBe(true);
        expect(await selection.isEnabled("profile", "overlay", false)).toBe(true);
        expect(await selection.isEnabled("profile", "highlight", false)).toBe(false);
      },
    );
  });
});

describe("overlay discovery over MCP", () => {
  let fixture: McpTestFixture;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeAll(async () => {
    restore = installHermeticServerFixture();
    fixture = new McpTestFixture();
    await fixture.setup();
    ToolRegistry.clearTools();
    unsubscribe = registerOverlayTools();
    registerHighlightTools();
    registerToolSelectionTools();
  });
  afterAll(async () => {
    unsubscribe();
    await fixture.teardown();
    restore();
  });

  test("omitted by default, enabled through setToolEnabled, then disabled", async () => {
    const names = async () => (await fixture.client.listTools()).tools.map((tool) => tool.name);
    expect(await names()).not.toContain("overlay");
    const enabled = await fixture.client.callTool({
      name: "setToolEnabled",
      arguments: { toolName: "overlay", enabled: true },
    });
    expect(enabled.isError).not.toBe(true);
    expect(await names()).toContain("overlay");
    expect(await names()).not.toContain("highlight");
    const disabled = await fixture.client.callTool({
      name: "setToolEnabled",
      arguments: { toolName: "overlay", enabled: false },
    });
    expect(disabled.isError).not.toBe(true);
    expect(await names()).not.toContain("overlay");
  });
});

describe("overlay CLI and advertised schema registration", () => {
  let restore: () => void;
  let definition: ReturnType<typeof ToolRegistry.getToolDefinitions>[number];
  beforeAll(() => {
    restore = preserveToolRegistry();
    ToolRegistry.clearTools();
    initializeCliTools();
    definition = ToolRegistry.getToolDefinitions().find((tool) => tool.name === "overlay")!;
    compileJsonSchema(definition.inputSchema);
    compileJsonSchema(definition.outputSchema);
  });
  afterAll(() => restore());
  test("CLI registers overlay default-off alongside unchanged highlight", () => {
    expect(ToolRegistry.getTool("overlay")!.defaultEnabled).toBe(false);
    expect(ToolRegistry.getTool("highlight")!.defaultEnabled).toBe(false);
    expect(definition.name).toBe("overlay");
    expect(definition.outputSchema).toBeDefined();
  });
});
