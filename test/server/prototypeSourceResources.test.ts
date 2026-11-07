import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PrototypeShownSpecs } from "../../src/features/prototype/PrototypeShownSpecs";
import { PrototypeSpecRevisions } from "../../src/features/prototype/prototypeSpecRevisions";
import {
  prototypeWebNotificationsSettled,
  registerPrototypeResources,
} from "../../src/server/prototypeResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { FakeMcpServer } from "../fakes/FakeMcpServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { renderPrototypeGuide } from "../../src/features/prototype/prototypeGuide";

const COMPOSE = "automobile:prototype/checkout/compose";
const SWIFTUI = "automobile:prototype/checkout/swiftui";
const WEB = "automobile:prototype/checkout/web";
const spec = (text: string) => ({
  id: "checkout",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text },
});

interface ReadResult {
  contents: { uri: string; mimeType: string; text: string; _meta: Record<string, unknown> }[];
}

let snapshot: ReturnType<typeof ResourceRegistry.snapshotForTesting>;
let revisions: PrototypeSpecRevisions;
let specs: PrototypeShownSpecs;
let server: FakeMcpServer;

async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  const handler = server.server.handlersBySchema.get(method);
  if (!handler) {
    throw new Error(`no ${method} handler`);
  }
  return handler({ params }, { mcpReq: { signal: new AbortController().signal } });
}

function updatedUris(): string[] {
  return server.server.notifications
    .filter((notification) => notification.method === "notifications/resources/updated")
    .map((notification) => (notification.params as { uri: string }).uri);
}

function show(text: string, id = "checkout"): void {
  const ticket = specs.beginShow("d", id, false, "ios");
  specs.endShow("d", ticket, { id, spec: { ...spec(text), id }, replaceOthers: false });
}

function patch(text: string): void {
  const read = specs.read("d", "checkout");
  if (read.kind !== "known") {
    throw new Error("expected a known spec");
  }
  specs.commitPatch("d", "checkout", read.version, { spec: spec(text), deviceRevision: 4 });
}

describe("automobile:prototype/{id}/compose and /swiftui (#16345)", () => {
  beforeEach(() => {
    snapshot = ResourceRegistry.snapshotForTesting();
    ResourceRegistry.clearServersForTesting();
    revisions = new PrototypeSpecRevisions(new FakeTimer());
    specs = new PrototypeShownSpecs(revisions);
    registerPrototypeResources(undefined, { revisions, rendererVersion: () => "9.9.9" });
    server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server);
  });

  afterEach(() => {
    ResourceRegistry.clearServersForTesting();
    ResourceRegistry.restoreForTesting(snapshot);
  });

  test("registers both templates", () => {
    const templates = ResourceRegistry.getTemplateDefinitions();
    expect(templates).toContainEqual(
      expect.objectContaining({
        uriTemplate: "automobile:prototype/{id}/compose{?frame,revision,mcpSessionId}",
        mimeType: "text/x-kotlin",
      }),
    );
    expect(templates).toContainEqual(
      expect.objectContaining({
        uriTemplate: "automobile:prototype/{id}/swiftui{?frame,revision,mcpSessionId}",
        mimeType: "text/x-swift",
      }),
    );
  });

  test("the guide points to both single-file resources", () => {
    const guide = renderPrototypeGuide();
    expect(guide).toContain("automobile:prototype/<id>/compose");
    expect(guide).toContain("automobile:prototype/<id>/swiftui");
  });

  test("lists one parameter-free entry per format once the prototype is shown", async () => {
    expect(ResourceRegistry.getResource(COMPOSE)).toBeUndefined();
    show("first");
    await prototypeWebNotificationsSettled();
    const definitions = ResourceRegistry.getResourceDefinitions();
    expect(definitions).toContainEqual({
      uri: COMPOSE,
      name: "prototype-checkout-compose",
      title: "checkout (Compose)",
      description: expect.any(String),
      mimeType: "text/x-kotlin",
    });
    expect(definitions).toContainEqual({
      uri: SWIFTUI,
      name: "prototype-checkout-swiftui",
      title: "checkout (SwiftUI)",
      description: expect.any(String),
      mimeType: "text/x-swift",
    });
    expect(definitions).toContainEqual(
      expect.objectContaining({ uri: WEB, title: "checkout (web)" }),
    );
  });

  test("an evicted id is unlisted in every format", async () => {
    ResourceRegistry.restoreForTesting(snapshot);
    const bytes = Buffer.byteLength(JSON.stringify({ ...spec("a"), id: "a" }));
    revisions = new PrototypeSpecRevisions(new FakeTimer(), { revisions: 20, bytes });
    specs = new PrototypeShownSpecs(revisions);
    registerPrototypeResources(undefined, { revisions, rendererVersion: () => "9.9.9" });
    show("a", "a");
    await prototypeWebNotificationsSettled();
    expect(ResourceRegistry.getResource("automobile:prototype/a/swiftui")).toBeDefined();
    show("b", "b");
    await prototypeWebNotificationsSettled();
    for (const format of ["web", "compose", "swiftui"]) {
      expect(ResourceRegistry.getResource(`automobile:prototype/a/${format}`)).toBeUndefined();
      expect(ResourceRegistry.getResource(`automobile:prototype/b/${format}`)).toBeDefined();
    }
  });

  test("a show then a patch notifies every format's parameter-free URI; a pinned revision never fires", async () => {
    for (const uri of [COMPOSE, SWIFTUI, `${COMPOSE}?revision=1`, `${SWIFTUI}?revision=1`]) {
      await request("resources/subscribe", { uri });
    }
    show("first");
    await prototypeWebNotificationsSettled();
    expect(updatedUris().sort()).toEqual([COMPOSE, SWIFTUI]);
    patch("second");
    await prototypeWebNotificationsSettled();
    expect(updatedUris().sort()).toEqual([COMPOSE, COMPOSE, SWIFTUI, SWIFTUI]);
  });

  test("reads the latest revision with _meta, defaulting the frame per format", async () => {
    show("first");
    patch("second");
    const compose = (await request("resources/read", { uri: COMPOSE })) as ReadResult;
    expect(compose.contents[0]).toMatchObject({
      uri: COMPOSE,
      mimeType: "text/x-kotlin",
      _meta: {
        revision: 2,
        deviceRevision: 4,
        revisions: [1, 2],
        frame: "pixel-9",
        rendererVersion: "9.9.9",
      },
    });
    expect(compose.contents[0]!.text).toContain("second");
    expect(compose.contents[0]!._meta.sha256).toEqual(expect.any(String));
    const swiftui = (await request("resources/read", { uri: SWIFTUI })) as ReadResult;
    expect(swiftui.contents[0]).toMatchObject({
      uri: SWIFTUI,
      mimeType: "text/x-swift",
      _meta: { revision: 2, frame: "iphone-16" },
    });
  });

  test("reads a pinned revision and frame through the template", async () => {
    show("first");
    patch("second");
    const pinned = (await request("resources/read", {
      uri: `${SWIFTUI}?revision=1&frame=iphone-se-3`,
    })) as ReadResult;
    expect(pinned.contents[0]!.uri).toBe(`${SWIFTUI}?frame=iphone-se-3&revision=1`);
    expect(pinned.contents[0]!._meta).toMatchObject({ revision: 1, frame: "iphone-se-3" });
    expect(pinned.contents[0]!.text).toContain("first");
  });

  test("_meta names the producing MCP session and mcpSessionId filters the revisions (#17358)", async () => {
    const first = specs.beginShow("d", "checkout", false, "ios");
    specs.endShow("d", first, { id: "checkout", spec: spec("mine"), mcpSessionId: "conn-a" });
    show("theirs");
    const latest = (await request("resources/read", { uri: COMPOSE })) as ReadResult;
    expect(latest.contents[0]!._meta).toMatchObject({ revision: 2, revisions: [1, 2] });
    expect(latest.contents[0]!._meta).not.toHaveProperty("mcpSessionId");
    const own = (await request("resources/read", {
      uri: `${SWIFTUI}?mcpSessionId=conn-a`,
    })) as ReadResult;
    expect(own.contents[0]!.uri).toBe(`${SWIFTUI}?mcpSessionId=conn-a`);
    expect(own.contents[0]!._meta).toMatchObject({
      revision: 1,
      mcpSessionId: "conn-a",
      revisions: [1],
    });
    expect(own.contents[0]!.text).toContain("mine");
    await expect(
      request("resources/read", { uri: `${COMPOSE}?mcpSessionId=other` }),
    ).rejects.toThrow('no kept revision from MCP session "other"');
  });

  test("an unknown id or frame is an actionable error", async () => {
    show("first");
    expect(request("resources/read", { uri: "automobile:prototype/nope/compose" })).rejects.toThrow(
      "Known prototypes: checkout.",
    );
    expect(request("resources/read", { uri: `${COMPOSE}?frame=nokia` })).rejects.toThrow(
      'Unknown device frame "nokia". Valid frames:',
    );
  });
});
