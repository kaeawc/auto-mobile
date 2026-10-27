import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeMcpServer } from "../fakes/FakeMcpServer";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { ListChangedBroadcaster } from "../../src/daemon/listChangedBroadcast";

const URI = "automobile:devices/booted";

async function subscribe(server: FakeMcpServer, uri: string): Promise<void> {
  await server.server.handlersBySchema.get("resources/subscribe")!({ params: { uri } });
}

function methods(server: FakeMcpServer): string[] {
  return server.server.notifications.map((n) => n.method);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("device resource notifications do not wait on one slow session", () => {
  let slow: FakeMcpServer;
  let healthy: FakeMcpServer;
  let release: PromiseWithResolvers<void>;

  beforeEach(async () => {
    ResourceRegistry.clearServersForTesting();
    ResourceRegistry.clearResources();
    ListChangedBroadcaster.clearForTesting();
    ResourceRegistry.register(URI, "Booted", "d", "application/json", async () => ({
      uri: URI,
      mimeType: "application/json",
      text: "{}",
    }));
    slow = new FakeMcpServer();
    healthy = new FakeMcpServer();
    release = Promise.withResolvers<void>();
    slow.server.notificationGate = release.promise;
    ResourceRegistry.registerWithServer(slow);
    ResourceRegistry.registerWithServer(healthy);
    await subscribe(slow, URI);
    await subscribe(healthy, URI);
  });

  afterEach(() => {
    release.resolve();
    ResourceRegistry.clearServersForTesting();
    ResourceRegistry.clearResources();
    ListChangedBroadcaster.clearForTesting();
  });

  test("resources/updated reaches a healthy session while a sibling's delivery is pending", async () => {
    const pending = ResourceRegistry.notifyResourceUpdated(URI);
    await flushMicrotasks();
    expect(methods(healthy)).toEqual(["notifications/resources/updated"]);
    release.resolve();
    await pending;
  });

  test("resources/list_changed reaches a healthy session while a sibling's delivery is pending", async () => {
    const pending = ResourceRegistry.notifyResourceListChanged();
    await flushMicrotasks();
    expect(methods(healthy)).toEqual(["notifications/resources/list_changed"]);
    release.resolve();
    await pending;
  });

  test("the daemon socket list_changed push is not held behind a pending session delivery", async () => {
    const pushed: string[] = [];
    ListChangedBroadcaster.subscribe((kind) => pushed.push(kind));
    const pending = ResourceRegistry.notifyResourceListChanged();
    await flushMicrotasks();
    expect(pushed).toEqual(["resources"]);
    release.resolve();
    await pending;
  });
});
