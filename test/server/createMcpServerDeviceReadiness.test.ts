import { afterEach, beforeAll, expect, test } from "bun:test";
import { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import { createMcpServer } from "../../src/server/index";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const original = ToolRegistry.getCollaboratorsForTesting().deviceReadiness;

async function compose(options: Parameters<typeof createMcpServer>[0]): Promise<void> {
  PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager());
  try {
    await createMcpServer(options).close();
  } finally {
    PlatformDeviceManagerFactory.reset();
  }
}

beforeAll(async () => {
  // Pay cold schema/SDK initialization outside the per-test timing budget.
  await compose({ daemonMode: true });
});

afterEach(() => {
  ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: original });
});

/**
 * An embedded direct-mode consumer that calls createMcpServer() without a readiness still gets
 * one, so setActiveDevice and device tools do not throw "Inject device readiness" (#14843).
 */
test("an embedded direct-mode server without a readiness installs one", async () => {
  ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: undefined });
  await compose({});
  expect(ToolRegistry.hasDeviceReadiness()).toBe(true);
  expect(ToolRegistry.getDeviceReadiness()).toBeInstanceOf(DeviceReadiness);
});

test("a readiness already installed by the process is kept", async () => {
  const installed = DeviceReadiness.createInstance();
  ToolRegistry.setDeviceReadiness(installed);
  await compose({});
  expect(ToolRegistry.getDeviceReadiness()).toBe(installed);
});

test("a daemon-mode server leaves readiness to the daemon composition root", async () => {
  ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: undefined });
  await compose({ daemonMode: true });
  expect(ToolRegistry.hasDeviceReadiness()).toBe(false);
});
