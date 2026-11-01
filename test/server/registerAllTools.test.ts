import { beforeAll, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerMcpTools } from "../../src/server/index";
import { initializeCliTools } from "../../src/cli/cliToolRegistration";
import { registerAllTools } from "../../src/server/registerAllTools";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import committedDefinitions from "../../schemas/tool-definitions.json";
import { toolStructured } from "../helpers/toolResponse";
import type { BootedDevice } from "../../src/models";
import before from "../fixtures/tool-registration/registered-tool-names.json";

isolateToolRegistry();

/** Names registered by one entry point, in registration order, starting from an empty registry. */
function registeredNames(register: () => void): string[] {
  ToolRegistry.clearToolsForTesting();
  register();
  return ToolRegistry.getEveryRegisteredTool().map((tool) => tool.name);
}

const sorted = (names: readonly string[]): string[] => [...names].sort();

describe("registerAllTools entry points (#11829)", () => {
  const after: Record<string, string[]> = {};

  beforeAll(() => {
    after.serverDaemon = registeredNames(() => registerMcpTools(true));
    after.serverStdio = registeredNames(() => registerMcpTools(false));
    after.cli = registeredNames(() => initializeCliTools());
    after.generator = registeredNames(() => registerAllTools({ daemonMode: true }));
    after.measurementScripts = registeredNames(() =>
      registerAllTools({ daemonMode: true, includeDoctor: true }),
    );
  });

  test("the daemon server registers the same tools in the same order as before", () => {
    expect(after.serverDaemon).toEqual(before.serverDaemon);
  });

  test("the stdio server registers the same tools in the same order as before", () => {
    expect(after.serverStdio).toEqual(before.serverStdio);
  });

  test("the CLI registers the same tool set as before", () => {
    expect(sorted(after.cli)).toEqual(sorted(before.cli));
  });

  test("the tool-definition generator registers the same tool set as before and covers the committed definitions", () => {
    const registered = new Set(after.generator);
    expect(sorted(after.generator)).toEqual(sorted(before.serverDaemon));
    expect(committedDefinitions.map((tool) => tool.name).filter((n) => !registered.has(n))).toEqual(
      [],
    );
  });

  test("the benchmark and context scripts now cover every group the old ten-group list had", () => {
    const registered = new Set(after.measurementScripts);
    expect(before.measurementScripts.filter((name) => !registered.has(name))).toEqual([]);
    expect(sorted(after.measurementScripts)).toEqual(sorted(before.cli.concat("setToolEnabled")));
  });
});

test("registerAllTools forwards the Keystore reset factory to the app handler", async () => {
  const device: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
  const devices: BootedDevice[] = [];
  const calls: unknown[] = [];
  registerAllTools({
    daemonMode: false,
    keystoreReset: (resolvedDevice) => {
      devices.push(resolvedDevice);
      return {
        async resetKeystore(...args) {
          calls.push(args);
          return {
            schemaVersion: 1,
            capability: "storage.keystore",
            outcome: "ok",
            bridgeAvailable: true,
            status: "deleted",
            deletedCount: 1,
          };
        },
      };
    },
  });
  expect(devices).toEqual([]);
  const response = await ToolRegistry.getTool("resetKeychain")!.deviceAwareHandler!(device, {
    deviceId: device.deviceId,
    appId: "com.example",
    scope: "login",
    alias: "token",
  });
  expect(devices).toEqual([device]);
  expect(devices[0]).toBe(device);
  expect(calls).toEqual([["com.example", "login", "token"]]);
  expect(toolStructured(response)).toMatchObject({
    success: true,
    deletedCount: 1,
    platform: "android",
  });
});

test("resetKeychain on iOS never resolves the Android Keystore factory", async () => {
  const device: BootedDevice = {
    name: "iPhone",
    deviceId: "A1B2C3D4-0000-4000-8000-000000000001",
    platform: "ios",
  };
  let factoryCalls = 0;
  registerAllTools({
    daemonMode: false,
    keystoreReset: () => {
      factoryCalls += 1;
      throw new Error("Keystore backend is Android-only");
    },
  });
  // Without confirm the iOS path refuses before running simctl, proving it was reached.
  await expect(
    ToolRegistry.getTool("resetKeychain")!.deviceAwareHandler!(device, {
      deviceId: device.deviceId,
      appId: "com.example",
    }),
  ).rejects.toThrow(/explicit confirmation/);
  expect(factoryCalls).toBe(0);
});
