import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import { PrototypeShownSpecs } from "../../src/features/prototype/PrototypeShownSpecs";
import { PrototypeSpecRevisions } from "../../src/features/prototype/prototypeSpecRevisions";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../src/models";
import {
  createPrototypePatchQueue,
  performPrototypePatch,
} from "../../src/server/prototypePatchAction";
import { prototypeOutputSchema } from "../../src/server/prototypeTools";
import {
  attributeRevision,
  registerPrototypeTools,
} from "../../src/server/prototypeTools/registration";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { FakeTimer } from "../fakes/FakeTimer";
import { readToolResponse } from "../helpers/toolResponse";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { deviceId: "fake-revision-session", platform: "android", name: "F" };
const plainSpec = (text: string) => ({
  id: "checkout",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text },
});
const spec = (text: string) => ({ ...plainSpec(text), data: { items: [] as string[] } });

describe("spec revisions are attributed to the MCP session that produced them (#17358)", () => {
  let revisions: PrototypeSpecRevisions;
  let restore: () => void;
  let unsubscribe: () => void;

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    revisions = new PrototypeSpecRevisions(timer);
    const client = new FakeCtrlProxy(timer);
    client.setSupportedCommands([]);
    unsubscribe = registerPrototypeTools({
      store: new InMemoryPrototypeStatusStore(timer, undefined, revisions),
      clientFactory: () => client,
      adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
      assetFileReader: new FakePrototypeAssetFileReader(),
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
    });
  });

  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function showFrom(mcpSessionId: string | undefined, text: string) {
    const call = async () => {
      const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
      const response = await handler(device, { action: "show", spec: plainSpec(text) });
      return prototypeOutputSchema.parse(readToolResponse(response).structuredContent);
    };
    return mcpSessionId === undefined
      ? call()
      : runWithToolSelectionContext({ callerMcpSessionId: mcpSessionId }, call);
  }

  test("each show records and returns its connection; a session filter reads only its own", async () => {
    const first = await showFrom("conn-a", "a");
    const second = await showFrom("conn-b", "b");
    expect(first).toMatchObject({ success: true, mcpSessionId: "conn-a" });
    expect(second).toMatchObject({ success: true, mcpSessionId: "conn-b" });

    expect(revisions.history("checkout").map((entry) => entry.mcpSessionId)).toEqual([
      "conn-a",
      "conn-b",
    ]);
    // conn-b's show landed in between, yet conn-a still finds its own latest revision.
    expect(revisions.revision("checkout", undefined, { mcpSessionId: "conn-a" })).toMatchObject({
      revision: 1,
      mcpSessionId: "conn-a",
    });
  });

  test("a call with no connection records no session and its output has none", async () => {
    const out = await showFrom(undefined, "a");
    expect(out.success).toBe(true);
    expect(out).not.toHaveProperty("mcpSessionId");
    expect(revisions.revision("checkout")).not.toHaveProperty("mcpSessionId");
  });
});

describe("patch attribution (#17358)", () => {
  test("a landed patch records the connection it was issued for", async () => {
    const revisions = new PrototypeSpecRevisions(new FakeTimer());
    const shownSpecs = new PrototypeShownSpecs(revisions);
    const ticket = shownSpecs.beginShow("d", "checkout", true, "android");
    shownSpecs.endShow("d", ticket, { id: "checkout", spec: spec("a"), mcpSessionId: "conn-a" });
    const out = await performPrototypePatch(
      {
        store: { shownSpecs, recordPatch: () => {} },
        transport: { patch: async () => ({ success: true, delivery: "answered", revision: 3 }) },
        supportsPatch: async () => true,
        platform: "android",
        queue: createPrototypePatchQueue(),
        retire: () => {},
        mcpSessionId: "conn-b",
      },
      "d",
      { id: "checkout", ops: [{ op: "add", path: "/data/items/-", value: "x" }] },
    );
    expect(out.success).toBe(true);
    expect(revisions.history("checkout").map((entry) => entry.mcpSessionId)).toEqual([
      "conn-a",
      "conn-b",
    ]);
  });

  test("only a successful show or patch output names the session", () => {
    expect(attributeRevision({ success: true }, "patch", "c")).toEqual({
      success: true,
      mcpSessionId: "c",
    });
    expect(attributeRevision({ success: false }, "show", "c")).toEqual({ success: false });
    expect(attributeRevision({ success: true }, "dismiss", "c")).toEqual({ success: true });
    expect(attributeRevision({ success: true }, "show", undefined)).toEqual({ success: true });
  });
});
