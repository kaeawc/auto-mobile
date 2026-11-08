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

const URI = "automobile:prototype/checkout/embed";
const spec = (id: string, text: string) => ({
  id,
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text },
});

let snapshot: ReturnType<typeof ResourceRegistry.snapshotForTesting>;
let specs: PrototypeShownSpecs;
let server: FakeMcpServer;

interface ReadResult {
  contents: { uri: string; mimeType: string; text: string; _meta: Record<string, unknown> }[];
}

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

function show(id: string, text: string, variant?: { group: string; label: string }): void {
  const ticket = specs.beginShow("d", id, false, "android");
  specs.endShow("d", ticket, {
    id,
    spec: spec(id, text),
    replaceOthers: false,
    ...(variant ? { variant } : {}),
  });
}

describe("automobile:prototype/{id}/embed (#16452)", () => {
  beforeEach(() => {
    snapshot = ResourceRegistry.snapshotForTesting();
    ResourceRegistry.clearServersForTesting();
    const revisions = new PrototypeSpecRevisions(new FakeTimer());
    specs = new PrototypeShownSpecs(revisions);
    registerPrototypeResources(undefined, { revisions, rendererVersion: () => "9.9.9" });
    server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server);
  });

  afterEach(() => {
    ResourceRegistry.clearServersForTesting();
    ResourceRegistry.restoreForTesting(snapshot);
  });

  test("registers the template", () => {
    expect(ResourceRegistry.getTemplateDefinitions()).toContainEqual(
      expect.objectContaining({
        uriTemplate: "automobile:prototype/{id}/embed{?revision,variant,mcpSessionId}",
        mimeType: "application/json",
      }),
    );
  });

  test("lists one parameter-free entry once the prototype is first shown", async () => {
    expect(ResourceRegistry.getResource(URI)).toBeUndefined();
    show("checkout", "first");
    await prototypeWebNotificationsSettled();
    expect(ResourceRegistry.getResourceDefinitions()).toContainEqual({
      uri: URI,
      name: "prototype-checkout-embed",
      title: "checkout (embed)",
      description: expect.any(String),
      mimeType: "application/json",
    });
  });

  test("reads the envelope with _meta and notifies only the parameter-free URI", async () => {
    await request("resources/subscribe", { uri: URI });
    await request("resources/subscribe", { uri: `${URI}?revision=1` });
    show("checkout", "first");
    show("checkout", "second");
    await prototypeWebNotificationsSettled();
    expect(updatedUris()).toEqual([URI, URI]);

    const latest = (await request("resources/read", { uri: URI })) as ReadResult;
    expect(latest.contents[0]).toMatchObject({
      uri: URI,
      mimeType: "application/json",
      _meta: { revision: 2, revisions: [1, 2], variants: ["checkout"], rendererVersion: "9.9.9" },
    });
    expect(latest.contents[0]!._meta).not.toHaveProperty("frame");
    expect(JSON.parse(latest.contents[0]!.text)).toMatchObject({
      format: "automobile-prototype-embed",
      version: 1,
      requires: expect.any(Array),
      spec: spec("checkout", "second"),
    });

    const pinned = (await request("resources/read", {
      uri: `${URI}?variant=checkout&revision=1`,
    })) as ReadResult;
    expect(pinned.contents[0]!.uri).toBe(`${URI}?revision=1&variant=checkout`);
    expect(JSON.parse(pinned.contents[0]!.text).spec).toEqual(spec("checkout", "first"));
  });

  test("a sibling joining the variant group updates every member's embed URI", async () => {
    await request("resources/subscribe", { uri: "automobile:prototype/a/embed" });
    show("a", "a", { group: "g", label: "A" });
    await prototypeWebNotificationsSettled();
    const before = updatedUris().length;
    show("b", "b", { group: "g", label: "B" });
    await prototypeWebNotificationsSettled();
    expect(updatedUris().slice(before)).toEqual(["automobile:prototype/a/embed"]);
  });

  test("_meta names the producing MCP session and mcpSessionId filters the revisions (#17358)", async () => {
    const ticket = specs.beginShow("d", "checkout", false, "android");
    specs.endShow("d", ticket, {
      id: "checkout",
      spec: spec("checkout", "mine"),
      replaceOthers: false,
      mcpSessionId: "conn-a",
    });
    show("checkout", "theirs");
    const latest = (await request("resources/read", { uri: URI })) as {
      contents: { text: string; _meta: Record<string, unknown> }[];
    };
    expect(latest.contents[0]!._meta).toMatchObject({ revision: 2, revisions: [1, 2] });
    expect(latest.contents[0]!._meta).not.toHaveProperty("mcpSessionId");
    const own = (await request("resources/read", { uri: `${URI}?mcpSessionId=conn-a` })) as {
      contents: { uri: string; text: string; _meta: Record<string, unknown> }[];
    };
    expect(own.contents[0]!.uri).toBe(`${URI}?mcpSessionId=conn-a`);
    expect(own.contents[0]!._meta).toMatchObject({
      revision: 1,
      mcpSessionId: "conn-a",
      revisions: [1],
    });
    expect(own.contents[0]!.text).toContain("mine");
  });

  test("an unknown id is an actionable error listing known ids", async () => {
    show("checkout", "first");
    expect(request("resources/read", { uri: "automobile:prototype/nope/embed" })).rejects.toThrow(
      "Known prototypes: checkout.",
    );
  });
});
