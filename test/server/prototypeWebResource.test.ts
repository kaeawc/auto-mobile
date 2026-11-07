import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PrototypeShownSpecs } from "../../src/features/prototype/PrototypeShownSpecs";
import { PrototypeSpecRevisions } from "../../src/features/prototype/prototypeSpecRevisions";
import {
  cachedPrototypeWebAssets,
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
        uriTemplate: "automobile:prototype/{id}/web{?frame,revision,variant,mcpSessionId}",
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

  test("_meta names the producing MCP session and mcpSessionId filters the revisions (#17358)", async () => {
    const ticket = specs.beginShow("d", "checkout", true, "ios");
    specs.endShow("d", ticket, { id: "checkout", spec: spec("mine"), mcpSessionId: "conn-a" });
    patch("theirs");
    const latest = (await request("resources/read", { uri: URI })) as {
      contents: { _meta: Record<string, unknown> }[];
    };
    expect(latest.contents[0]!._meta).toMatchObject({ revision: 2, revisions: [1, 2] });
    expect(latest.contents[0]!._meta).not.toHaveProperty("mcpSessionId");
    const own = (await request("resources/read", {
      uri: `${URI}?mcpSessionId=conn-a&frame=pixel-9`,
    })) as { contents: { uri: string; _meta: Record<string, unknown> }[] };
    expect(own.contents[0]!.uri).toBe(`${URI}?frame=pixel-9&mcpSessionId=conn-a`);
    expect(own.contents[0]!._meta).toMatchObject({
      revision: 1,
      mcpSessionId: "conn-a",
      revisions: [1],
    });
    await expect(request("resources/read", { uri: `${URI}?mcpSessionId=%20` })).rejects.toThrow(
      "Invalid prototype mcpSessionId",
    );
  });

  test("a prototype leaving its variant group also updates its former siblings", async () => {
    const showIn = (id: string, variant?: { group: string; label: string }) => {
      const ticket = specs.beginShow("d", id, false, "android");
      specs.endShow("d", ticket, {
        id,
        spec: { ...spec(id), id },
        replaceOthers: false,
        ...(variant ? { variant } : {}),
      });
    };
    await request("resources/subscribe", { uri: "automobile:prototype/a/web" });
    await request("resources/subscribe", { uri: "automobile:prototype/b/web" });
    showIn("a", { group: "g", label: "A" });
    showIn("b", { group: "g", label: "B" });
    await prototypeWebNotificationsSettled();
    const before = updatedUris().length;
    showIn("b");
    await prototypeWebNotificationsSettled();
    expect(updatedUris().slice(before).sort()).toEqual([
      "automobile:prototype/a/web",
      "automobile:prototype/b/web",
    ]);
  });

  test("evicting a variant updates the siblings it leaves behind", async () => {
    const specOf = (id: string) => ({ ...spec(id), id });
    const bytes = Buffer.byteLength(JSON.stringify(specOf("a")));
    ResourceRegistry.restoreForTesting(snapshot);
    revisions = new PrototypeSpecRevisions(new FakeTimer(), { revisions: 20, bytes: bytes * 2 });
    specs = new PrototypeShownSpecs(revisions);
    registerPrototypeResources(undefined, { revisions, rendererVersion: () => "9.9.9" });
    const showIn = (id: string, variant?: { group: string; label: string }) => {
      const ticket = specs.beginShow("d", id, false, "android");
      specs.endShow("d", ticket, {
        id,
        spec: specOf(id),
        replaceOthers: false,
        ...(variant ? { variant } : {}),
      });
    };
    await request("resources/subscribe", { uri: "automobile:prototype/b/web" });
    showIn("a", { group: "g", label: "A" });
    showIn("b", { group: "g", label: "B" });
    await prototypeWebNotificationsSettled();
    const before = updatedUris().length;
    showIn("c");
    await prototypeWebNotificationsSettled();
    expect(revisions.ids()).toEqual(["b", "c"]);
    expect(updatedUris().slice(before)).toContain("automobile:prototype/b/web");
  });

  test("byte-cap pruning of another prototype's history updates that prototype", async () => {
    const specOf = (id: string, text: string) => ({ ...spec(text), id });
    const bytes = Buffer.byteLength(JSON.stringify(specOf("a", "r1")));
    ResourceRegistry.restoreForTesting(snapshot);
    revisions = new PrototypeSpecRevisions(new FakeTimer(), { revisions: 20, bytes: bytes * 3 });
    specs = new PrototypeShownSpecs(revisions);
    registerPrototypeResources(undefined, { revisions, rendererVersion: () => "9.9.9" });
    const showAs = (id: string, text: string) => {
      const ticket = specs.beginShow("d", id, false, "android");
      specs.endShow("d", ticket, { id, spec: specOf(id, text), replaceOthers: false });
    };
    await request("resources/subscribe", { uri: "automobile:prototype/a/web" });
    showAs("a", "r1");
    showAs("a", "r2");
    showAs("b", "r1");
    await prototypeWebNotificationsSettled();
    const before = updatedUris().length;
    showAs("b", "r2");
    await prototypeWebNotificationsSettled();
    expect(revisions.history("a").map((entry) => entry.revision)).toEqual([2]);
    expect(updatedUris().slice(before)).toContain("automobile:prototype/a/web");
  });

  test("an unknown id is an actionable error listing known ids", async () => {
    show("first");
    expect(request("resources/read", { uri: "automobile:prototype/nope/web" })).rejects.toThrow(
      "Known prototypes: checkout.",
    );
  });
});

describe("web page images from the host asset cache (#16533)", () => {
  const cache = {
    get: async (serial: string, id: string) =>
      serial === "pixel" && id === "hero"
        ? { id, mimeType: "image/png" as const, bytes: Uint8Array.of(1) }
        : undefined,
  };

  test("reads an asset from the first device showing a variant that cached it", async () => {
    const devices: Record<string, string[]> = { a: ["sim"], b: ["pixel", "sim"] };
    const source = cachedPrototypeWebAssets((id) => devices[id] ?? [], cache)(["a", "b"]);
    expect((await source.get("hero"))?.mimeType).toBe("image/png");
    expect(await source.get("other")).toBeUndefined();
    expect(await cachedPrototypeWebAssets(() => [], cache)(["a"]).get("hero")).toBeUndefined();
  });

  test("an asset id two devices cached with different bytes stays a placeholder (#17241)", async () => {
    const bytes: Record<string, Uint8Array> = { pixel: Uint8Array.of(1), sim: Uint8Array.of(2) };
    const differing = {
      get: async (serial: string, id: string) =>
        id === "hero" ? { id, mimeType: "image/png" as const, bytes: bytes[serial]! } : undefined,
    };
    const devices: Record<string, string[]> = { a: ["pixel"], b: ["sim"] };
    const assets = cachedPrototypeWebAssets((id) => devices[id] ?? [], differing);
    // Variant a's page also shows variant b: one slot per id cannot hold both images.
    expect(await assets(["a", "b"]).get("hero")).toBeUndefined();
    expect((await assets(["a"]).get("hero"))?.bytes).toEqual(Uint8Array.of(1));
    // The same bytes on both devices are one image.
    bytes.sim = Uint8Array.of(1);
    expect((await assets(["a", "b"]).get("hero"))?.bytes).toEqual(Uint8Array.of(1));
  });

  test("skips a device whose cache cannot be read", async () => {
    const failing = {
      get: async (serial: string, id: string) => {
        if (serial === "sim") {
          throw new Error("EACCES: permission denied");
        }
        return cache.get(serial, id);
      },
    };
    const source = cachedPrototypeWebAssets(() => ["sim", "pixel"], failing)(["a"]);
    expect((await source.get("hero"))?.mimeType).toBe("image/png");
    expect(await source.get("other")).toBeUndefined();
  });

  test("the web resource inlines a cached asset the page draws", async () => {
    const before = ResourceRegistry.snapshotForTesting();
    ResourceRegistry.clearServersForTesting();
    const store = new PrototypeSpecRevisions(new FakeTimer());
    const shown = new PrototypeShownSpecs(store);
    registerPrototypeResources(undefined, {
      revisions: store,
      rendererVersion: () => "v",
      images: {
        assets: cachedPrototypeWebAssets((id) => shown.devicesShowing(id), cache),
        encoder: { encode: async () => ({ bytes: Uint8Array.of(7), width: 2, height: 1 }) },
      },
    });
    const fake = new FakeMcpServer();
    ResourceRegistry.registerWithServer(fake);
    try {
      const ticket = shown.beginShow("pixel", "checkout", true, "android");
      shown.endShow("pixel", ticket, {
        id: "checkout",
        spec: { id: "checkout", root: { type: "image", asset: "hero" } },
      });
      const handler = fake.server.handlersBySchema.get("resources/read")!;
      const read = (await handler(
        { params: { uri: URI } },
        { mcpReq: { signal: new AbortController().signal } },
      )) as { contents: { text: string }[] };
      expect(read.contents[0]!.text).toContain("--pa-0:url(data:image/webp;base64,Bw==)");
    } finally {
      ResourceRegistry.clearServersForTesting();
      ResourceRegistry.restoreForTesting(before);
    }
  });
});
