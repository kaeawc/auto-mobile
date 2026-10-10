import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PROTOTYPE_APPEARANCE_CAPABILITY,
  type PrototypeAppearance,
  type PrototypeEvent,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import type { BootedDevice } from "../../src/models";
import {
  prototypeOutputSchema,
  prototypeSchema,
  registerPrototypeTools,
} from "../../src/server/prototypeTools";
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
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "fake-appearance", platform: "android", name: "Fake" };
const ios: BootedDevice = { deviceId: "sim-appearance", platform: "ios", name: "Sim" };
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "text" as const, text: "Hello" },
};
const darkOverride: PrototypeAppearance = { mode: "dark", source: "override", deviceDark: false };
const lightSystem: PrototypeAppearance = { mode: "light", source: "system", deviceDark: false };
const INSPECT = "prototype_persistence_replay_v1";

function changed(
  sequence: number,
  payload: PrototypeEvent["payload"],
  overrides: Partial<PrototypeEvent> = {},
): PrototypeEvent {
  return {
    type: "prototype_event",
    timestamp: 100 + sequence,
    id: spec.id,
    sequence,
    kind: "appearance_changed",
    name: null,
    payload,
    state: {},
    pages: {},
    ...overrides,
  };
}

describe("prototype appearance on the host (#11223)", () => {
  let client: FakeCtrlProxy;
  let agent: FakePrototypeAgentClient;
  let adb: FakeAdbExecutor;
  let restore: () => void;
  let unsubscribe: () => void;

  function register(agentCapabilities: readonly string[] = FAKE_PROTOTYPE_AGENT_CAPABILITIES) {
    const timer = new FakeTimer();
    adb = new FakeAdbExecutor();
    client = new FakeCtrlProxy(timer);
    agent = new FakePrototypeAgentClient({
      agentVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: [...agentCapabilities],
    });
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      agentConnections: { get: (deviceId) => (deviceId === ios.deviceId ? agent : undefined) },
      adbFactory: new FakeAdbClientFactory(adb),
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
  }
  const withAppearance = () => [
    ...FAKE_PROTOTYPE_AGENT_CAPABILITIES,
    PROTOTYPE_APPEARANCE_CAPABILITY,
  ];
  beforeEach(() => {
    restore = preserveToolRegistry();
    register();
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(device: BootedDevice, input: Record<string, unknown>) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler(device, input);
    return prototypeOutputSchema.parse(response.structuredContent);
  }
  const show = (device: BootedDevice, extra: Record<string, unknown> = {}) =>
    call(device, { action: "show", spec, ...extra });
  const agentShows = () => agent.requests.filter((request) => request.type === "show_prototype");

  describe("input", () => {
    test("appearance takes device, light or dark, on show only", () => {
      for (const appearance of ["device", "light", "dark"]) {
        expect(prototypeSchema.safeParse({ action: "show", spec, appearance }).success).toBe(true);
      }
      expect(prototypeSchema.safeParse({ action: "show", spec, appearance: "sepia" }).success).toBe(
        false,
      );
      expect(
        prototypeSchema.safeParse({ action: "dismiss", id: "panel", appearance: "dark" }).success,
      ).toBe(false);
      expect(
        prototypeSchema.safeParse({ action: "awaitEvent", id: "panel", kind: "appearance_changed" })
          .success,
      ).toBe(true);
    });
  });

  describe("the override on the wire", () => {
    test.each(["light", "dark"] as const)(
      "Android forwards %s to a CtrlProxy advertising the capability",
      async (appearance) => {
        client.setSupportedCommands([PROTOTYPE_APPEARANCE_CAPABILITY]);
        expect((await show(android, { appearance })).success).toBe(true);
        expect(client.getPrototypeHistory()).toMatchObject([{ method: "show", appearance }]);
      },
    );

    test.each([[undefined], ["device"]])(
      "Android sends no appearance field for %p, with or without the capability",
      async (appearance) => {
        client.setSupportedCommands([PROTOTYPE_APPEARANCE_CAPABILITY]);
        expect((await show(android, appearance ? { appearance } : {})).success).toBe(true);
        client.setSupportedCommands([]);
        expect((await show(android, appearance ? { appearance } : {})).success).toBe(true);
        const history = client.getPrototypeHistory();
        expect(history).toHaveLength(2);
        for (const entry of history) {
          expect(entry).not.toHaveProperty("appearance");
        }
      },
    );

    test("Android refuses a pinned mode without the capability and sends nothing", async () => {
      client.setSupportedCommands(["prototype_window_options_v1"]);
      const payload = await show(android, {
        appearance: "dark",
        spec: { ...spec, window: { ...spec.window, layer: "app" } },
      });
      expect(payload.success).toBe(false);
      expect(payload.error).toContain(
        `connected CtrlProxy does not advertise ${PROTOTYPE_APPEARANCE_CAPABILITY}`,
      );
      expect(payload.error).toContain('appearance "dark"');
      expect(payload.error).toContain("Nothing was shown. Update the connected CtrlProxy");
      // No show, no app-layer appop grant, and no host presence for the refused prototype.
      expect(client.getPrototypeHistory()).toEqual([]);
      expect(adb.getExecutedCommands()).toEqual([]);
      expect((await call(android, { action: "status" })).prototypes).toEqual([]);
    });

    test("iOS forwards a pinned mode to an agent advertising the capability", async () => {
      unsubscribe();
      register(withAppearance());
      expect((await show(ios, { appearance: "light" })).success).toBe(true);
      expect(agentShows().map((request) => request.body)).toEqual([{ spec, appearance: "light" }]);
    });

    test("iOS sends no appearance field for device or an omitted appearance", async () => {
      unsubscribe();
      register(withAppearance());
      await show(ios);
      await show(ios, { appearance: "device" });
      expect(agentShows().map((request) => request.body)).toEqual([{ spec }, { spec }]);
    });

    test("iOS refuses a pinned mode without the capability and sends nothing", async () => {
      const payload = await show(ios, { appearance: "light" });
      expect(payload.success).toBe(false);
      expect(payload.error).toContain(
        `connected iOS prototype agent does not advertise ${PROTOTYPE_APPEARANCE_CAPABILITY}`,
      );
      expect(payload.error).toContain("launchApp prototype: true");
      expect(agent.requests).toEqual([]);
      // device needs no capability.
      expect((await show(ios, { appearance: "device" })).success).toBe(true);
      expect(agentShows().map((request) => request.body)).toEqual([{ spec }]);
    });
  });

  describe("the resolved appearance in results", () => {
    test("an Android show result's appearance reaches lastResult and status", async () => {
      client.setSupportedCommands([PROTOTYPE_APPEARANCE_CAPABILITY]);
      client.setPrototypeResult({ success: true, appearance: darkOverride });
      const shown = await show(android, { appearance: "dark" });
      expect(shown.lastResult?.appearance).toEqual(darkOverride);
      const status = await call(android, { action: "status" });
      expect(status.prototypes?.[0]?.appearance).toEqual(darkOverride);
      expect(status.lastResult?.appearance).toEqual(darkOverride);
    });

    test("a device that reports none leaves the field absent, and a malformed one is dropped", async () => {
      const plain = await show(android);
      expect(plain.lastResult).not.toHaveProperty("appearance");
      client.setPrototypeResult({
        success: true,
        // A wire value outside the contract, as a device bug would send it.
        appearance: { mode: "sepia", source: "system", deviceDark: false } as never,
      });
      const malformed = await show(android);
      expect(malformed.success).toBe(true);
      expect(malformed.lastResult).not.toHaveProperty("appearance");
      const status = await call(android, { action: "status" });
      expect(status.prototypes?.[0]).not.toHaveProperty("appearance");
    });

    test("a refused same-id show keeps the appearance of the prototype still on screen", async () => {
      client.setPrototypeResult({ success: true, appearance: lightSystem });
      await show(android);
      client.setPrototypeResult({ success: false, error: "device refused" });
      const refused = await show(android);
      expect(refused.lastResult).not.toHaveProperty("appearance");
      const status = await call(android, { action: "status" });
      expect(status.prototypes?.[0]?.appearance).toEqual(lightSystem);
    });

    test("a dismiss result carries no appearance", async () => {
      client.setPrototypeResult({ success: true, appearance: lightSystem });
      await show(android);
      const dismissed = await call(android, { action: "dismiss", id: spec.id });
      expect(dismissed.lastResult).not.toHaveProperty("appearance");
    });

    test("an iOS show result's appearance reaches lastResult and status", async () => {
      unsubscribe();
      register(withAppearance());
      agent.queueReplies({ appearance: darkOverride });
      const shown = await show(ios, { appearance: "dark" });
      expect(shown.lastResult?.appearance).toEqual(darkOverride);
      expect((await call(ios, { action: "status" })).prototypes?.[0]?.appearance).toEqual(
        darkOverride,
      );
      // An agent without the capability reports none.
      const plain = await show(ios);
      expect(plain.lastResult).not.toHaveProperty("appearance");
    });

    test("Android inspect carries each reported prototype's appearance into status", async () => {
      client.setSupportedCommands([INSPECT]);
      const entry = { id: "panel", persistent: true, state: {}, pages: {}, lastSequence: 3 };
      client.setInspectReply({
        success: true,
        prototypes: [{ ...entry, appearance: darkOverride }],
        droppedEvents: 0,
      });
      const inspected = await call(android, { action: "inspect" });
      expect(inspected.prototypes?.[0]?.appearance).toEqual(darkOverride);
      expect((await call(android, { action: "status" })).prototypes?.[0]?.appearance).toEqual(
        darkOverride,
      );
      // An older CtrlProxy omits it; the host does not carry the previous value over.
      client.setInspectReply({ success: true, prototypes: [entry], droppedEvents: 0 });
      const older = await call(android, { action: "inspect" });
      expect(older.prototypes).toHaveLength(1);
      expect(older.prototypes?.[0]).not.toHaveProperty("appearance");
    });

    test("iOS inspect reads the flat status.appearance, absent when the agent reports none", async () => {
      const status = { shown: true, id: "panel", pages: {}, state: {}, lastSequence: 2 };
      agent.queueReplies({ status: { ...status, appearance: lightSystem } });
      const inspected = await call(ios, { action: "inspect" });
      expect(inspected.prototypes?.[0]?.appearance).toEqual(lightSystem);
      agent.queueReplies({ status });
      const older = await call(ios, { action: "inspect" });
      expect(older.prototypes).toHaveLength(1);
      expect(older.prototypes?.[0]).not.toHaveProperty("appearance");
    });
  });

  describe("appearance_changed events", () => {
    test("Android delivers the event through awaitEvent by kind and refreshes status", async () => {
      client.setPrototypeResult({ success: true, appearance: lightSystem });
      await show(android);
      client.emitPrototypeEvent(changed(1, { mode: "dark", source: "system" }));
      const waited = await call(android, {
        action: "awaitEvent",
        id: spec.id,
        kind: "appearance_changed",
      });
      expect(waited.event).toEqual({
        id: spec.id,
        sequence: 1,
        kind: "appearance_changed",
        name: null,
        payload: { mode: "dark", source: "system" },
        state: {},
        pages: {},
        timestamp: 101,
      });
      const status = await call(android, { action: "status" });
      // A system-sourced change is the device's own setting flipping.
      expect(status.prototypes?.[0]?.appearance).toEqual({
        mode: "dark",
        source: "system",
        deviceDark: true,
      });
      // lastResult stays the record of what the show itself reported.
      expect(status.lastResult?.appearance).toEqual(lightSystem);
    });

    test("a change the prototype's own state caused keeps the last reported deviceDark", async () => {
      client.setPrototypeResult({ success: true, appearance: lightSystem });
      await show(android);
      client.emitPrototypeEvent(changed(1, { mode: "dark", source: "authoredBackground" }));
      const status = await call(android, { action: "status" });
      expect(status.prototypes?.[0]?.appearance).toEqual({
        mode: "dark",
        source: "authoredBackground",
        deviceDark: false,
      });
    });

    test("a payload outside the contract is still delivered but leaves status as it was", async () => {
      client.setPrototypeResult({ success: true, appearance: lightSystem });
      await show(android);
      client.emitPrototypeEvent(changed(1, { mode: "sepia" }));
      const waited = await call(android, { action: "awaitEvent", id: spec.id });
      expect(waited.event?.kind).toBe("appearance_changed");
      const status = await call(android, { action: "status" });
      expect(status.prototypes?.[0]?.appearance).toEqual(lightSystem);
    });

    test("iOS delivers the agent's push through awaitEvent and refreshes status", async () => {
      unsubscribe();
      register(withAppearance());
      agent.queueReplies({ appearance: lightSystem });
      await show(ios);
      agent.emit({ ...changed(1, { mode: "dark", source: "system" }) });
      const waited = await call(ios, {
        action: "awaitEvent",
        id: spec.id,
        kind: "appearance_changed",
      });
      expect(waited.event).toMatchObject({
        sequence: 1,
        kind: "appearance_changed",
        name: null,
        payload: { mode: "dark", source: "system" },
      });
      expect((await call(ios, { action: "status" })).prototypes?.[0]?.appearance).toEqual({
        mode: "dark",
        source: "system",
        deviceDark: true,
      });
    });

    test("an event kind this host does not know is skipped, its sequence still counted", async () => {
      await show(ios);
      agent.emit({ ...changed(1, { anything: [1, 2] }), kind: "pose_changed", name: 7 });
      const afterUnknown = await call(ios, { action: "status" });
      expect(afterUnknown.prototypes?.[0]).toMatchObject({ pendingCount: 0, lastSequence: 1 });
      // The connection and the next known event are unaffected.
      agent.emit({ ...changed(2, { mode: "dark", source: "system" }) });
      const waited = await call(ios, { action: "awaitEvent", id: spec.id });
      expect(waited.event).toMatchObject({ sequence: 2, kind: "appearance_changed" });
      expect(waited.droppedCount).toBe(0);
    });
  });
});
