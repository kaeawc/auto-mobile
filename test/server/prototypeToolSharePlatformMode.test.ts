import { toolStructured } from "../helpers/toolResponse";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "fake-share-mode", platform: "android", name: "Fake" };
const ios: BootedDevice = { deviceId: "sim-share-mode", platform: "ios", name: "Sim" };
const SHARE_CAPABILITIES = ["prototype_platform_v1", "prototype_platform_share_v1"];
const shareSpec = {
  id: "share",
  window: { placement: { type: "fullscreen" as const } },
  requires: { platform: ["share"] },
  root: {
    type: "button",
    label: "Share",
    onTap: [{ type: "platform", call: "share.open", args: { text: { value: "Hi" } } }],
  },
};
const plainSpec = {
  id: "plain",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "column", children: [{ type: "text", id: "label", text: "Hello" }] },
};

describe("prototype show platformMode share on the host (#19308)", () => {
  let client: FakeCtrlProxy;
  let agent: FakePrototypeAgentClient;
  let restore: () => void;
  let unsubscribe: () => void;

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands(SHARE_CAPABILITIES);
    agent = new FakePrototypeAgentClient({
      agentVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: [...FAKE_PROTOTYPE_AGENT_CAPABILITIES, ...SHARE_CAPABILITIES],
    });
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      agentConnections: { get: (deviceId) => (deviceId === ios.deviceId ? agent : undefined) },
      adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
      lastRenderedObservation: () => undefined,
      assetFileReader: new FakePrototypeAssetFileReader(),
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function show(device: BootedDevice, input: Record<string, unknown>) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler(device, { action: "show", ...input });
    return prototypeOutputSchema.parse(toolStructured(response));
  }
  const sent = (device: BootedDevice) =>
    device.platform === "android"
      ? client.getPrototypeHistory()
      : agent.requests.filter((request) => request.type === "show_prototype");

  test("platformMode is a show-only input", () => {
    const fake = { share: "fake" };
    expect(
      prototypeSchema.safeParse({ action: "show", spec: shareSpec, platformMode: fake }).success,
    ).toBe(true);
    expect(
      prototypeSchema.safeParse({ action: "show", spec: shareSpec, platformMode: { cast: "fake" } })
        .success,
    ).toBe(false);
    expect(
      prototypeSchema.safeParse({ action: "dismiss", id: "share", platformMode: fake }).success,
    ).toBe(false);
  });

  test.each([android, ios])(
    "$platform refuses a share spec in real mode, unsent",
    async (device) => {
      for (const extra of [{}, { platformMode: { share: "real" } }]) {
        const result = await show(device, { spec: shareSpec, ...extra });
        expect(result.success).toBe(false);
        expect(result.error).toContain('platformMode: {share: "fake"}');
      }
      expect(sent(device)).toEqual([]);
    },
  );

  test.each([android, ios])("$platform shows a share spec in fake mode", async (device) => {
    const result = await show(device, { spec: shareSpec, platformMode: { share: "fake" } });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(sent(device)).toHaveLength(1);
  });

  test("fake mode still needs a runtime advertising the share capability", async () => {
    client.setSupportedCommands(["prototype_platform_v1"]);
    const result = await show(android, { spec: shareSpec, platformMode: { share: "fake" } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("prototype_platform_share_v1");
    expect(sent(android)).toEqual([]);
  });

  test("platformMode.share without share in requires.platform is refused", async () => {
    const result = await show(android, { spec: plainSpec, platformMode: { share: "fake" } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("declares share in requires.platform");
    expect(sent(android)).toEqual([]);
  });

  // Patches cannot edit /requires, and declaring share needs fake mode at show, so a spec shown in
  // real mode cannot gain share through a patch.
  test.each([android, ios])("$platform refuses a patch that adds share, unsent", async (device) => {
    client.setSupportedCommands([...SHARE_CAPABILITIES, "prototype_patch_v1"]);
    agent.handshake.capabilities.push("prototype_patch_v1");
    expect((await show(device, { spec: plainSpec })).success).toBe(true);
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const patched = prototypeOutputSchema.parse(
      toolStructured(
        await handler(device, {
          action: "patch",
          id: plainSpec.id,
          ops: [{ op: "replaceNode", id: "label", node: { ...shareSpec.root, id: "label" } }],
        }),
      ),
    );
    expect(patched.success).toBe(false);
    expect(patched.error).toContain("Platform module share is not declared in requires.platform");
    const patches = device.platform === "android" ? client.patchRequests : agent.patchRequests;
    expect(patches).toEqual([]);
  });
});
