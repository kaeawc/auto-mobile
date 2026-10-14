import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { prototypePlatformNotes } from "../../src/features/prototype/prototypePlatformNotes";
import type { PrototypeSpec } from "../../src/features/prototype/prototypeSpec";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import {
  FakePrototypeAgentClient,
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
} from "../fakes/FakePrototypeAgentClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const ios: BootedDevice = { deviceId: "notes-ios", platform: "ios", name: "Fake iPhone" };
const android: BootedDevice = {
  deviceId: "notes-android",
  platform: "android",
  name: "Fake Android",
};
const spec: PrototypeSpec = {
  id: "panel",
  window: { placement: { type: "fullscreen" } },
  state: { open: true },
  root: {
    type: "column",
    children: [
      { type: "icon", id: "glyph", name: "alarm_add", variant: "outlined" },
      {
        type: "bottomSheet",
        openWhen: { key: "open", equals: true },
        detents: ["half", "full"],
        child: { type: "text", text: "Sheet" },
      },
    ],
  },
};

describe("prototype tool platform notes", () => {
  let agent: FakePrototypeAgentClient;
  let client: FakeCtrlProxy;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeAll(async () => {
    // Initialise the host's shared schema/transport machinery once using an unrelated fake show.
    // Each test still gets a new coordinator, status store and transport below.
    const restoreRegistry = preserveToolRegistry();
    const timer = new FakeTimer();
    const warmClient = new FakeCtrlProxy(timer);
    const warmAgent = new FakePrototypeAgentClient();
    const cleanup = registerPrototypeTools({
      clientFactory: () => warmClient,
      agentConnections: { get: () => warmAgent },
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
    try {
      await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(ios, {
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
    agent = new FakePrototypeAgentClient();
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      agentConnections: { get: () => agent },
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });
  async function call(input: unknown, device = ios) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return {
      raw: response.structuredContent,
      payload: prototypeOutputSchema.parse(response.structuredContent),
    };
  }
  test("successful iOS show returns all five typed notes", async () => {
    const { payload } = await call({ action: "show", spec });
    expect(payload.success).toBe(true);
    expect(payload.platformNotes).toEqual(prototypePlatformNotes(spec, "ios", () => false));
    expect(payload.platformNotes).toHaveLength(5);
  });
  test("iOS text field options return substituted notes without a counter difference", async () => {
    const { payload } = await call({
      action: "show",
      spec: {
        ...spec,
        state: { name: "Ada" },
        root: {
          type: "textField",
          stateKey: "name",
          label: "Name",
          variant: "outlined",
          maxLength: 20,
        },
      },
    });
    expect(payload.success).toBe(true);
    expect(
      payload.platformNotes?.map(({ construct, effect, paths }) => ({ construct, effect, paths })),
    ).toEqual([
      { construct: "textField.variant", effect: "substituted", paths: ["root.variant"] },
      { construct: "textField.label", effect: "substituted", paths: ["root.label"] },
    ]);
  });
  test("iOS stack show explains the back gesture", async () => {
    agent.handshake.capabilities = [...agent.handshake.capabilities, "prototype_stack_v1"];
    const { payload } = await call({
      action: "show",
      spec: {
        ...spec,
        root: {
          type: "stack",
          id: "nav",
          start: "home",
          screens: { home: { type: "text", text: "Home" } },
        },
      },
    });
    expect(payload.success).toBe(true);
    expect(payload.platformNotes).toContainEqual(
      expect.objectContaining({
        construct: "stack",
        detail: expect.stringContaining("left-edge swipe"),
      }),
    );
  });
  test("Android show retains its exact result shape", async () => {
    const { raw, payload } = await call({ action: "show", spec }, android);
    expect(raw).not.toHaveProperty("platformNotes");
    expect(payload).toEqual({
      success: true,
      lastResult: { id: "panel", lastAction: "show", success: true, timestamp: 0, chrome: "bar" },
    });
  });
  test("failed iOS show has no platformNotes key", async () => {
    agent.queueReplies({ success: false, error: "Device refused" });
    const { raw, payload } = await call({ action: "show", spec });
    expect(payload.success).toBe(false);
    expect(raw).not.toHaveProperty("platformNotes");
  });
  test("unaffected shows, status and dismiss omit platformNotes", async () => {
    const clean = { ...spec, root: { type: "icon", name: "home" } };
    for (const input of [
      { action: "show", spec: clean },
      { action: "status" },
      { action: "dismiss", id: "panel" },
    ]) {
      const { raw, payload } = await call(input);
      expect(payload.success).toBe(true);
      expect(raw).not.toHaveProperty("platformNotes");
    }
  });
  test("agent capabilities lift the corresponding notes", async () => {
    agent = new FakePrototypeAgentClient({
      agentVersion: "future",
      protocolVersion: 1,
      capabilities: [
        ...FAKE_PROTOTYPE_AGENT_CAPABILITIES,
        "prototype_identifier_test_tag_only_v1",
        "prototype_bottom_sheet_drag_v1",
        "prototype_icon_set_material_v1",
        "prototype_icon_variant_v1",
      ],
    });
    const { raw, payload } = await call({ action: "show", spec });
    expect(payload.success).toBe(true);
    expect(raw).not.toHaveProperty("platformNotes");
  });
  test("notes describe expanded components as sent to the device", async () => {
    const authored = {
      ...spec,
      components: { glyph: { root: { type: "icon", id: "glyph", name: "alarm_add" } } },
      root: { type: "use", component: "glyph" },
    };
    const { payload } = await call({ action: "show", spec: authored });
    expect(payload.success).toBe(true);
    expect(payload.platformNotes?.map(({ construct, paths }) => ({ construct, paths }))).toEqual([
      { construct: "node.id", paths: ["root.id"] },
      { construct: "icon.name", paths: ["root.name"] },
    ]);
    expect(agent.requests[0].body.spec).toMatchObject({
      root: { type: "icon", name: "alarm_add" },
    });
  });
  test.each(["onLongPress", "onDoubleTap"] as const)(
    "%s notes name only the authored gesture",
    async (gesture) => {
      agent.handshake.capabilities.push("prototype_gestures_v1");
      const authored = {
        ...spec,
        root: { type: "text", text: "Press", [gesture]: [{ type: "emit", name: "gesture" }] },
      };
      const { payload } = await call({ action: "show", spec: authored });
      expect(payload.success).toBe(true);
      const note = payload.platformNotes?.find((entry) => entry.construct === "node.gestures");
      expect(note?.paths).toEqual([`root.${gesture}`]);
      if (gesture === "onLongPress") {
        expect(note?.detail).toContain("Long-press");
        expect(note?.detail).not.toContain("double-tap");
        expect(note?.detail).not.toContain("onTap fires");
      } else {
        expect(note?.detail).not.toContain("Long-press");
        expect(note?.detail).toContain("double-tap");
        expect(note?.detail).toContain("onTap fires only after");
      }
    },
  );
  test("gesture shows report system timing on iOS only, including expanded components", async () => {
    agent.handshake.capabilities.push("prototype_gestures_v1");
    client.setSupportedCommands(["prototype_gestures_v1", "prototype_persistence_replay_v1"]);
    const authored = {
      ...spec,
      components: {
        tile: {
          root: {
            type: "text",
            text: "Press",
            onLongPress: [{ type: "emit", name: "long" }],
            onDoubleTap: [{ type: "emit", name: "double" }],
          },
        },
      },
      root: { type: "use", component: "tile" },
    };
    const { payload } = await call({ action: "show", spec: authored });
    expect(payload.success).toBe(true);
    expect(payload.platformNotes).toMatchObject([
      {
        platform: "ios",
        construct: "node.gestures",
        effect: "substituted",
        paths: ["root.onLongPress", "root.onDoubleTap"],
      },
    ]);
    expect(payload.platformNotes?.[0].detail).toContain("0.5 s");
    expect(payload.platformNotes?.[0].detail).toContain("0.4 s");
    expect(payload.platformNotes?.[0].detail).toContain("double-tap window is the system's");
    expect((await call({ action: "show", spec: authored }, android)).raw).not.toHaveProperty(
      "platformNotes",
    );
    agent.queueReplies({ success: false, error: "Device refused" });
    expect((await call({ action: "show", spec: authored })).raw).not.toHaveProperty(
      "platformNotes",
    );
  });
});
