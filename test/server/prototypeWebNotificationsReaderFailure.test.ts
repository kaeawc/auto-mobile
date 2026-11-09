import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import { PrototypeShownSpecs } from "../../src/features/prototype/PrototypeShownSpecs";
import { PrototypeSpecRevisions } from "../../src/features/prototype/prototypeSpecRevisions";
import {
  prototypeWebNotificationsSettled,
  registerPrototypeResources,
  type PrototypeResourceReaders,
} from "../../src/server/prototypeResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { FakeMcpServer } from "../fakes/FakeMcpServer";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  LAZY_IMPORT_FAILURE,
  recoveringLazyModule,
  type RecoveringLazyModule,
} from "../helpers/recoveringLazyModule";

const WEB = "automobile:prototype/checkout/web";
const COMPOSE = "automobile:prototype/checkout/compose";
const spec = (text: string) => ({
  id: "checkout",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text },
});

let realReaders: PrototypeResourceReaders;
let snapshot: ReturnType<typeof ResourceRegistry.snapshotForTesting>;
let specs: PrototypeShownSpecs;
let server: FakeMcpServer;
let lazy: RecoveringLazyModule<PrototypeResourceReaders>;

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

describe("prototype web notifications while the readers cannot load (#17721)", () => {
  // The readers' first import is a one-time process cost, not part of a test's budget.
  beforeAll(async () => {
    realReaders = await import("../../src/server/prototypeResourceReaders");
  });

  beforeEach(() => {
    snapshot = ResourceRegistry.snapshotForTesting();
    ResourceRegistry.clearServersForTesting();
    const revisions = new PrototypeSpecRevisions(new FakeTimer());
    specs = new PrototypeShownSpecs(revisions);
    lazy = recoveringLazyModule("prototype resources", () => realReaders);
    registerPrototypeResources(
      undefined,
      { revisions, rendererVersion: () => "9.9.9" },
      lazy.module,
    );
    server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server);
  });

  afterEach(() => {
    ResourceRegistry.clearServersForTesting();
    ResourceRegistry.restoreForTesting(snapshot);
  });

  test("every revision is announced without importing the readers", async () => {
    await request("resources/subscribe", { uri: WEB });
    await request("resources/subscribe", { uri: COMPOSE });
    show("first");
    await prototypeWebNotificationsSettled();
    show("second");
    await prototypeWebNotificationsSettled();
    expect(updatedUris().sort()).toEqual([COMPOSE, COMPOSE, WEB, WEB]);
    expect(lazy.attempts()).toBe(0);
  });

  test("a read answers the load error, and reads the announced revision once the readers load", async () => {
    await request("resources/subscribe", { uri: WEB });
    show("first");
    await prototypeWebNotificationsSettled();
    expect(updatedUris()).toEqual([WEB]);

    const failed = request("resources/read", { uri: WEB });
    await expect(failed).rejects.toBeInstanceOf(ActionableError);
    await expect(failed).rejects.toThrow(
      `Failed to load the prototype resources module: ${LAZY_IMPORT_FAILURE}`,
    );

    lazy.recover();
    const read = (await request("resources/read", { uri: WEB })) as {
      contents: { uri: string; _meta: Record<string, unknown> }[];
    };
    expect(read.contents[0]).toMatchObject({ uri: WEB, _meta: { revision: 1 } });
    expect(lazy.attempts()).toBe(2);
  });
});
