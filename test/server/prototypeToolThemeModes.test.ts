import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOTYPE_THEME_MODES_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
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

  function register(agentCapabilities: readonly string[]) {
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    agent = new FakePrototypeAgentClient({
      agentVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: [...agentCapabilities],
    });
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      agentConnections: { get: (deviceId) => (deviceId === ios.deviceId ? agent : undefined) },
      adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
  }
  beforeEach(() => {
    restore = preserveToolRegistry();
    register(FAKE_PROTOTYPE_AGENT_CAPABILITIES);
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(device: BootedDevice, spec: unknown) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler(device, { action: "show", spec });
    return prototypeOutputSchema.parse(response.structuredContent);
  }
  const agentShows = () => agent.requests.filter((request) => request.type === "show_prototype");

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
});
