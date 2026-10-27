import { toolStructured } from "../helpers/toolResponse";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROTOTYPE_DATA_MODEL_CAPABILITY,
  PROTOTYPE_PLATFORM_CAPABILITY,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import { PROTOTYPE_PLATFORM_EVENT_NAME } from "../../src/features/prototype/prototypePlatform";
import type { BootedDevice } from "../../src/models";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
// The shared native-parity fixture: a call to the placeholder `test` module with follow-ups.
const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../fixtures/prototype-spec/valid/platform-call.json"),
    "utf8",
  ),
) as { id: string; root: { children: Record<string, unknown>[] } };
const TEST_MODULE = "prototype_platform_test_v1";
const capabilities = [
  "prototype_patch_v1",
  PROTOTYPE_DATA_MODEL_CAPABILITY,
  PROTOTYPE_PLATFORM_CAPABILITY,
  TEST_MODULE,
];

describe("platform vocabulary through the registered prototype tool (#14294)", () => {
  let client: FakeCtrlProxy;
  let restore: () => void;
  let unsubscribe: () => void;

  function setup(): void {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands(capabilities);
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
    });
  }
  beforeEach(setup);
  beforeAll(async () => {
    // Warm the registered show/patch schema path before measuring the scenarios.
    setup();
    try {
      await call({ action: "show", spec: fixture });
      await call({ action: "dismiss", id: fixture.id });
    } finally {
      unsubscribe();
      restore();
    }
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: Record<string, unknown>) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return prototypeOutputSchema.parse(toolStructured(response));
  }

  test("a device lacking the module capability refuses show before anything is sent", async () => {
    client.setSupportedCommands(capabilities.filter((name) => name !== TEST_MODULE));
    const refused = await call({ action: "show", spec: fixture });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain(TEST_MODULE);
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test("a device lacking the vocabulary capability refuses show", async () => {
    client.setSupportedCommands(
      capabilities.filter((name) => name !== PROTOTYPE_PLATFORM_CAPABILITY),
    );
    const refused = await call({ action: "show", spec: fixture });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain(PROTOTYPE_PLATFORM_CAPABILITY);
  });

  test("a replaceNode patch is refused once the device stops advertising the module", async () => {
    expect((await call({ action: "show", spec: fixture })).success).toBe(true);
    client.setSupportedCommands(capabilities.filter((name) => name !== TEST_MODULE));
    const replaced = await call({
      action: "patch",
      id: fixture.id,
      ops: [{ op: "replaceNode", id: "go", node: { ...fixture.root.children[0], label: "Again" } }],
    });
    expect(replaced.success).toBe(false);
    expect(replaced.error).toContain(TEST_MODULE);
    expect(client.patchRequests).toEqual([]);
  });

  test("awaitEvent returns a finished call under the reserved emit name", async () => {
    expect((await call({ action: "show", spec: fixture })).success).toBe(true);
    const payload = { callId: "c-1", call: "test.echo", outcome: "success", durationMs: 3 };
    client.emitPrototypeEvent({
      type: "prototype_event",
      timestamp: 1,
      id: fixture.id,
      sequence: 1,
      kind: "emit",
      name: PROTOTYPE_PLATFORM_EVENT_NAME,
      payload,
      state: { echoStatus: "success", sent: false },
      pages: {},
    });
    const awaited = await call({
      action: "awaitEvent",
      id: fixture.id,
      kind: "emit",
      eventName: PROTOTYPE_PLATFORM_EVENT_NAME,
    });
    expect(awaited.event).toMatchObject({
      kind: "emit",
      name: PROTOTYPE_PLATFORM_EVENT_NAME,
      payload,
    });
  });
});
