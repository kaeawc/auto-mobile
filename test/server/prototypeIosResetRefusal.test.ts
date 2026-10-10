import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerPrototypeTools, prototypeOutputSchema } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import type { PrototypeAgentConnections } from "../../src/features/prototype/ios/iosPrototypeTransport";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import {
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
  FakePrototypeAgentClient,
} from "../fakes/FakePrototypeAgentClient";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { FakeTimer } from "../fakes/FakeTimer";
import { event } from "../helpers/prototypeTestEvent";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const simulator: BootedDevice = { deviceId: "SIM-UDID", platform: "ios", name: "iPhone" };
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4),
]);
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "image" as const, asset: "logo" },
};

describe("iOS reset show on an agent without prototype_show_in_place_v1", () => {
  let agent: FakePrototypeAgentClient;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    agent = new FakePrototypeAgentClient({
      agentVersion: "0.0.1",
      protocolVersion: 1,
      capabilities: FAKE_PROTOTYPE_AGENT_CAPABILITIES.filter(
        (capability) => capability !== "prototype_show_in_place_v1",
      ),
    });
    const connections: PrototypeAgentConnections = { get: () => agent };
    unsubscribe = registerPrototypeTools({
      clientFactory: () => new FakeCtrlProxy(timer),
      agentConnections: connections,
      clock: timer,
      timer,
      assetFileReader: new FakePrototypeAssetFileReader().addFile("/img/logo.png", png),
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });
  async function call(input: unknown) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(simulator, input);
    return prototypeOutputSchema.parse(response.structuredContent);
  }

  test("is refused before assets are uploaded", async () => {
    await call({ action: "show", spec });
    agent.requests.length = 0;

    const refused = await call({
      action: "show",
      spec,
      reset: true,
      assets: [{ id: "logo", path: "/img/logo.png" }],
    });

    expect(refused.success).toBe(false);
    expect(refused.error).toContain("does not support reset");
    // Contract: unsupported capability forms are refused before any device side effect.
    expect(agent.requests.map((request) => request.type)).not.toContain("put_prototype_asset");
  });

  test("a reset show that fails while staging assets keeps the shown prototype's events", async () => {
    await call({ action: "show", spec });
    agent.emit(event(1, "panel", "emit", "save"));

    const failed = await call({
      action: "show",
      spec,
      reset: true,
      assets: [{ id: "logo", path: "/img/missing.png" }],
    });

    expect(failed.success).toBe(false);
    const status = await call({ action: "status" });
    expect(status.prototypes?.[0]).toMatchObject({ id: "panel", lastSequence: 1, pendingCount: 1 });
  });

  test("keeps the still-shown prototype's buffered events", async () => {
    await call({ action: "show", spec });
    agent.emit(event(1, "panel", "emit", "save"));

    const refused = await call({ action: "show", spec, reset: true });

    expect(refused.success).toBe(false);
    // The refused show left the old prototype on screen, so its event must still be pending.
    const status = await call({ action: "status" });
    expect(status.prototypes?.[0]).toMatchObject({ id: "panel", lastSequence: 1, pendingCount: 1 });
  });
});
