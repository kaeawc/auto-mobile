import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createMcpServer } from "../../src/server";
import { createIosDoctorDependencies } from "../../src/doctor/checks/ios";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { SessionToolBindingStore } from "../../src/server/sessionToolBindingStore";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { createFakeDeviceManager } from "../daemon/helpers/inputSocketHarness";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import type { BootedDevice, SomePlatform } from "../../src/models";

/*
 * The stateless daemon endpoint builds one createMcpServer per request (#4678). Each server must
 * leave the registries as it found them, and building one must not rebuild every tool schema.
 */
describe("stateless createMcpServer", () => {
  isolateToolRegistry();

  beforeAll(() => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([]));
    // Pay the one-time production registration outside the 100 ms test budget.
    createMcpServer({ stateless: true });
    ToolRegistry.clearServersForTesting();
    ResourceRegistry.clearServersForTesting();
  });

  afterAll(() => PlatformDeviceManagerFactory.reset());

  test("a server closed before it ever connects is not left tracked", async () => {
    const servers = Array.from({ length: 5 }, () => createMcpServer({ stateless: true }));
    expect(ToolRegistry.trackedServerCountsForTesting()).toEqual({ notified: 0, ephemeral: 5 });
    expect(ResourceRegistry.trackedServerCountsForTesting()).toEqual({ notified: 0, ephemeral: 5 });

    for (const server of servers) {
      await server.close();
    }

    expect(ToolRegistry.trackedServerCountsForTesting()).toEqual({ notified: 0, ephemeral: 0 });
    expect(ResourceRegistry.trackedServerCountsForTesting()).toEqual({ notified: 0, ephemeral: 0 });
  });

  test("a connected server is untracked on close and never notified before then", async () => {
    const server = createMcpServer({ stateless: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const received: string[] = [];
    clientSide.onmessage = (message) => {
      received.push((message as { method?: string }).method ?? "response");
    };
    await clientSide.start();
    await server.connect(serverSide as never);

    ToolRegistry.notifyToolListChanged();
    void ResourceRegistry.notifyResourceListChanged();
    expect(received).toEqual([]);

    await server.close();

    expect(ToolRegistry.trackedServerCountsForTesting()).toEqual({ notified: 0, ephemeral: 0 });
    expect(ResourceRegistry.trackedServerCountsForTesting()).toEqual({ notified: 0, ephemeral: 0 });
  });

  test("a stateful server is still tracked for notification", async () => {
    const server = createMcpServer();
    expect(ToolRegistry.trackedServerCountsForTesting()).toEqual({ notified: 1, ephemeral: 0 });
    expect(ResourceRegistry.trackedServerCountsForTesting()).toEqual({ notified: 1, ephemeral: 0 });
    ToolRegistry.untrackServer(server);
    ResourceRegistry.untrackServer(server);
  });

  describe("with the tool-schema cache warmed", () => {
    // An earlier test's notifyToolListChanged() clears the schema cache; rebuilding every tool
    // schema costs ~100 ms, so pay it outside the test it is only the baseline for.
    beforeAll(() => {
      ToolRegistry.getToolDefinitions();
    });

    test("repeated createMcpServer calls do not rebuild tool schemas", async () => {
      ToolRegistry.getToolDefinitions();
      const built = ToolRegistry.schemaBuildCountForTesting();
      expect(built).toBeGreaterThan(0);

      for (let i = 0; i < 3; i++) {
        await createMcpServer({ stateless: true }).close();
        ToolRegistry.getToolDefinitions();
      }

      expect(ToolRegistry.schemaBuildCountForTesting()).toBe(built);
    });
  });

  test("a removed tool is registered again by the next createMcpServer", async () => {
    ToolRegistry.removeToolForTesting("observe");
    expect(ToolRegistry.getTool("observe")).toBeUndefined();

    await createMcpServer({ stateless: true }).close();

    expect(ToolRegistry.getTool("observe")).toBeDefined();
  });

  test("repeated createMcpServer calls do not re-register resources or probe devices (#13068)", async () => {
    // Registering resources used to start a booted-device discovery (adb + simctl) on every
    // stateless request; with real devices that cost ~10-20 ms per daemon-bound call.
    class ProbeCountingDeviceUtils extends FakeDeviceUtils {
      probes = 0;
      override async getBootedDevices(platform: SomePlatform): Promise<BootedDevice[]> {
        this.probes++;
        return super.getBootedDevices(platform);
      }
    }
    const deviceUtils = new ProbeCountingDeviceUtils();
    PlatformDeviceManagerFactory.setInstance(deviceUtils);
    const iosDependencies = createIosDoctorDependencies();
    try {
      await createMcpServer({ stateless: true, iosDependencies }).close();
      const afterFirst = deviceUtils.probes;

      for (let i = 0; i < 3; i++) {
        await createMcpServer({ stateless: true, iosDependencies }).close();
      }

      expect(deviceUtils.probes).toBe(afterFirst);
      expect(ResourceRegistry.getResource("automobile:apps")).toBeDefined();
    } finally {
      PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([]));
    }
  });

  test("cleared resources are registered again by the next createMcpServer", async () => {
    ResourceRegistry.clearResources();
    expect(ResourceRegistry.getResource("automobile:apps")).toBeUndefined();

    await createMcpServer({ stateless: true }).close();

    expect(ResourceRegistry.getResource("automobile:apps")).toBeDefined();
  });

  test("a server closed before it connects detaches its binding from a shared store", async () => {
    const store = new SessionToolBindingStore();
    const server = createMcpServer({ stateless: true, sessionToolBindingStore: store });
    expect(store.attachedCountForTesting).toBe(1);

    await server.close();

    expect(store.attachedCountForTesting).toBe(0);
  });
});
