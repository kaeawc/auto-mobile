import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  PROTOTYPE_FLOW_GRID_CAPABILITY,
  PROTOTYPE_THEME_MODES_CAPABILITY,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import type { BootedDevice } from "../../src/models";
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
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "fake-modes", platform: "android", name: "Fake" };
const ios: BootedDevice = { deviceId: "sim-modes", platform: "ios", name: "Sim" };
const window = { placement: { type: "fullscreen" as const } };
const plain = { id: "modes", window, root: { type: "text" as const, text: "Hello" } };
const paired = {
  ...plain,
  root: { ...plain.root, style: { background: { light: "#FFFFFF", dark: "surface" } } },
};
/** One spec per per-mode form, with the field the refusal names. */
const perModeSpecs: Array<[string, Record<string, unknown>]> = [
  ["root.style.background", paired],
  ["theme.colors.dark", { ...plain, theme: { colors: { dark: { surface: "#101014" } } } }],
  [
    "window.placement.scrim",
    { ...plain, window: { placement: { ...window.placement, scrim: "scrim" } } },
  ],
  [
    "root.style.gradient.stops[1].color",
    {
      ...plain,
      root: {
        ...plain.root,
        style: {
          gradient: { type: "radial", stops: [{ color: "#000000" }, { color: "primary" }] },
        },
      },
    },
  ],
  ["root.asset", { ...plain, root: { type: "image", asset: { light: "a", dark: "b" } } }],
];

describe("prototype show with per-mode spec forms (#11218)", () => {
  let client: FakeCtrlProxy;
  let agent: FakePrototypeAgentClient;
  let restore: () => void;
  let unsubscribe: () => void;

  let adb: FakeAdbExecutor;
  let reader: FakePrototypeAssetFileReader;

  function register(agentCapabilities: readonly string[]) {
    const timer = new FakeTimer();
    adb = new FakeAdbExecutor();
    reader = new FakePrototypeAssetFileReader();
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
      assetFileReader: reader,
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
  }
  beforeAll(async () => {
    const restoreWarmup = preserveToolRegistry();
    register(FAKE_PROTOTYPE_AGENT_CAPABILITIES);
    await call(android, plain);
    await call(ios, plain);
    unsubscribe();
    restoreWarmup();
  });
  beforeEach(() => {
    restore = preserveToolRegistry();
    register(FAKE_PROTOTYPE_AGENT_CAPABILITIES);
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(device: BootedDevice, spec: unknown) {
    return callWith(device, { action: "show", spec });
  }
  async function callWith(device: BootedDevice, input: unknown) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler(device, input);
    return prototypeOutputSchema.parse(response.structuredContent);
  }
  const agentShows = () => agent.requests.filter((request) => request.type === "show_prototype");
  test.each([android, ios])(
    "refuses stack navigation on $platform without capability",
    async (device) => {
      client.setSupportedCommands([]);
      const payload = await call(device, {
        ...plain,
        root: { type: "stack", id: "nav", start: "home", screens: { home: plain.root } },
      });
      expect(payload.success).toBe(false);
      expect(payload.error).toContain("prototype_stack_v1");
      expect(payload.error).toContain("Nothing was shown");
      expect(client.getPrototypeHistory()).toHaveLength(0);
      expect(agentShows()).toHaveLength(0);
    },
  );

  test.each(["flow", "grid"])(
    "%s is refused without the wrapping capability and sent with it",
    async (type) => {
      const spec = {
        ...plain,
        root: { type, children: [plain.root], ...(type === "grid" ? { columns: 2 } : {}) },
      };
      client.setSupportedCommands([]);
      for (const device of [android, ios]) {
        const result = await call(device, spec);
        expect(result.success).toBe(false);
        expect(result.error).toContain(PROTOTYPE_FLOW_GRID_CAPABILITY);
        expect(result.error).toContain("node at root");
        expect(result.error).toContain(
          device.platform === "android"
            ? "Update the connected CtrlProxy"
            : "launchApp prototype: true",
        );
      }
      expect(client.getPrototypeHistory()).toEqual([]);
      expect(agentShows()).toEqual([]);
      client.setSupportedCommands([PROTOTYPE_FLOW_GRID_CAPABILITY]);
      expect((await call(android, spec)).success).toBe(true);
      unsubscribe();
      register([...FAKE_PROTOTYPE_AGENT_CAPABILITIES, PROTOTYPE_FLOW_GRID_CAPABILITY]);
      expect((await call(ios, spec)).success).toBe(true);
      expect(agentShows()).toMatchObject([{ body: { spec } }]);
    },
  );

  test.each([
    ["root.style.runSpacing", { style: { runSpacing: 0 } }],
    [
      "root.styleWhen[0].style.runSpacing",
      { styleWhen: [{ when: { key: "active", equals: true }, style: { runSpacing: 2 } }] },
    ],
  ])("ordinary row with %s requires flow/grid capability", async (field, styles) => {
    const spec = {
      ...plain,
      state: { active: true },
      root: { type: "row", children: [plain.root], ...styles },
    };
    client.setSupportedCommands([]);
    for (const device of [android, ios]) {
      const result = await call(device, spec);
      expect(result.success).toBe(false);
      expect(result.error).toContain(PROTOTYPE_FLOW_GRID_CAPABILITY);
      expect(result.error).toContain(`runSpacing value at ${field}`);
      expect(result.error).toContain("Nothing was shown.");
    }
    expect(client.getPrototypeHistory()).toEqual([]);
    expect(agentShows()).toEqual([]);
    client.setSupportedCommands([PROTOTYPE_FLOW_GRID_CAPABILITY]);
    expect((await call(android, spec)).success).toBe(true);
    unsubscribe();
    register([...FAKE_PROTOTYPE_AGENT_CAPABILITIES, PROTOTYPE_FLOW_GRID_CAPABILITY]);
    expect((await call(ios, spec)).success).toBe(true);
    expect(agentShows()).toMatchObject([{ body: { spec } }]);
  });

  test("component flow is refused after expansion before any asset upload", async () => {
    client.setSupportedCommands([]);
    const result = await call(android, {
      ...plain,
      root: { type: "use", component: "wrap" },
      components: { wrap: { root: { type: "flow", children: [plain.root] } } },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("node at root");
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test("the fakes advertise no theme-modes capability by default, as both platforms do today", () => {
    expect(FAKE_PROTOTYPE_AGENT_CAPABILITIES).not.toContain(PROTOTYPE_THEME_MODES_CAPABILITY);
  });

  test.each(perModeSpecs)(
    "Android refuses %s unsent without the capability",
    async (field, spec) => {
      client.setSupportedCommands([]);
      const payload = await call(android, spec);
      expect(payload.success).toBe(false);
      expect(payload.error).toContain(
        `CtrlProxy does not advertise ${PROTOTYPE_THEME_MODES_CAPABILITY}`,
      );
      expect(payload.error).toContain(`per-mode value at ${field}`);
      expect(payload.error).toContain("Update the connected CtrlProxy");
      expect(client.getPrototypeHistory()).toEqual([]);
    },
  );

  test.each(perModeSpecs)("iOS refuses %s unsent without the capability", async (field, spec) => {
    const payload = await call(ios, spec);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain(
      `iOS prototype agent does not advertise ${PROTOTYPE_THEME_MODES_CAPABILITY}`,
    );
    expect(payload.error).toContain(`per-mode value at ${field}`);
    expect(payload.error).toContain("launchApp prototype: true");
    expect(agentShows()).toEqual([]);
  });

  test("a spec without per-mode forms is sent with no capability on either platform", async () => {
    client.setSupportedCommands([]);
    expect((await call(android, plain)).success).toBe(true);
    expect(client.getPrototypeHistory()).toMatchObject([{ method: "show", spec: plain }]);
    expect((await call(ios, plain)).success).toBe(true);
    expect(agentShows()).toHaveLength(1);
  });

  test("a device advertising the capability receives the pair unchanged", async () => {
    client.setSupportedCommands([PROTOTYPE_THEME_MODES_CAPABILITY]);
    expect((await call(android, paired)).success).toBe(true);
    expect(client.getPrototypeHistory()).toMatchObject([{ method: "show", spec: paired }]);
    unsubscribe();
    register([...FAKE_PROTOTYPE_AGENT_CAPABILITIES, PROTOTYPE_THEME_MODES_CAPABILITY]);
    expect((await call(ios, paired)).success).toBe(true);
    expect(agentShows()).toMatchObject([{ body: { spec: paired } }]);
  });

  test("the refusal counts further per-mode fields after the first", async () => {
    client.setSupportedCommands([]);
    const payload = await call(android, {
      ...paired,
      theme: { colors: { light: { primary: "#B3261E" } } },
    });
    expect(payload.error).toContain("per-mode value at theme.colors.light (and 1 more)");
  });

  test("a refused per-mode show grants nothing and sends nothing for an app-layer window (#11377)", async () => {
    client.setSupportedCommands(["prototype_window_options_v1"]);
    const payload = await call(android, {
      ...paired,
      window: { ...window, layer: "app" },
    });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain(PROTOTYPE_THEME_MODES_CAPABILITY);
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test("a per-mode pair inside a component definition is refused after expansion", async () => {
    client.setSupportedCommands([]);
    const payload = await call(android, {
      ...plain,
      components: {
        card: {
          root: {
            type: "text",
            text: "Hi",
            style: { background: { light: "#FFFFFF", dark: "surface" } },
          },
        },
      },
      root: { type: "use", component: "card" },
    });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain(
      `CtrlProxy does not advertise ${PROTOTYPE_THEME_MODES_CAPABILITY}`,
    );
    expect(payload.error).toContain("per-mode value at root.style.background");
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test("a specPath show of a per-mode spec is refused unsent", async () => {
    client.setSupportedCommands([]);
    reader.addFile("/work/modes.json", Buffer.from(JSON.stringify(paired)));
    const payload = await callWith(android, { action: "show", specPath: "/work/modes.json" });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain(
      `CtrlProxy does not advertise ${PROTOTYPE_THEME_MODES_CAPABILITY}`,
    );
    expect(payload.error).toContain("per-mode value at root.style.background");
    expect(client.getPrototypeHistory()).toEqual([]);
  });
});
