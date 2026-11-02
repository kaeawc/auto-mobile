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

const URI = "automobile:prototype/checkout/web";
const spec = (text: string) => ({
  id: "checkout",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text },
});

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

function show(text: string): void {
  const ticket = specs.beginShow("d", "checkout", true, "ios");
  specs.endShow("d", ticket, { id: "checkout", spec: spec(text) });
}

function patch(text: string): void {
  const read = specs.read("d", "checkout");
  if (read.kind !== "known") {
    throw new Error("expected a known spec");
  }
  specs.commitPatch("d", "checkout", read.version, { spec: spec(text), deviceRevision: 4 });
}

describe("automobile:prototype/{id}/web (#16345)", () => {
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

  test("registers the template", () => {
    expect(ResourceRegistry.getTemplateDefinitions()).toContainEqual(
      expect.objectContaining({
        uriTemplate: "automobile:prototype/{id}/web{?frame,revision,variant}",
        mimeType: "text/html",
      }),
    );
  });

  test("the guide points to the web resource and variant grouping", () => {
    const guide = renderPrototypeGuide();
    expect(guide).toContain("automobile:prototype/<id>/web");
    expect(guide).toContain("`variant: {group, label}`");
  });

  test("lists one parameter-free entry once the prototype is first shown", async () => {
    expect(ResourceRegistry.getResource(URI)).toBeUndefined();
    show("first");
    await prototypeWebNotificationsSettled();
    expect(ResourceRegistry.getResourceDefinitions()).toContainEqual({
      uri: URI,
      name: "prototype-checkout-web",
      title: "checkout (web)",
      description: expect.any(String),
      mimeType: "text/html",
    });
    expect(server.server.notifications.map((notification) => notification.method)).toContain(
      "notifications/resources/list_changed",
    );
  });

  test("a show then a patch notifies the parameter-free URI; a pinned revision never fires", async () => {
    await request("resources/subscribe", { uri: URI });
    await request("resources/subscribe", { uri: `${URI}?revision=1` });
    show("first");
    await prototypeWebNotificationsSettled();
    expect(updatedUris()).toEqual([URI]);
    patch("second");
    await prototypeWebNotificationsSettled();
    expect(updatedUris()).toEqual([URI, URI]);

    const latest = (await request("resources/read", { uri: URI })) as {
      contents: { uri: string; mimeType: string; text: string; _meta: Record<string, unknown> }[];
    };
    expect(latest.contents[0]).toMatchObject({
      uri: URI,
      mimeType: "text/html",
      _meta: { revision: 2, deviceRevision: 4, revisions: [1, 2], frame: "iphone-16" },
    });
    expect(latest.contents[0]!._meta.rendererVersion).toBe("9.9.9");
  });

  test("reads a pinned revision and frame through the template", async () => {
    show("first");
    patch("second");
    const pinned = (await request("resources/read", {
      uri: `${URI}?revision=1&frame=pixel-9`,
    })) as { contents: { uri: string; _meta: Record<string, unknown> }[] };
    expect(pinned.contents[0]!.uri).toBe(`${URI}?frame=pixel-9&revision=1`);
    expect(pinned.contents[0]!._meta).toMatchObject({ revision: 1, frame: "pixel-9" });
  });

  test("an unknown id is an actionable error listing known ids", async () => {
    show("first");
    expect(request("resources/read", { uri: "automobile:prototype/nope/web" })).rejects.toThrow(
      "Known prototypes: checkout.",
    );
  });
});
