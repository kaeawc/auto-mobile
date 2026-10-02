import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";

const displayOutput = loadDuoEnumerate();
const device: BootedDevice = {
  deviceId: "94286FD0-9F21-4A9F-BEE4-8DCCF668EE01",
  name: "Selected simulator",
  platform: "ios",
};
const explicitId = "ABFEAEEF-F0A9-410B-B840-74F386477713";
const bundleId = "com.example.app";

class RecordingExecutor {
  readonly calls: Array<{ file: string; args: string[] }> = [];

  readonly execute = async (file: string, args: string[]): Promise<ExecResult> => {
    this.calls.push({ file, args: [...args] });
    expect(args).not.toContain("booted");
    const stdout =
      args[1] === "io" ? displayOutput : args[1] === "listapps" ? "[]" : `${bundleId}: 123`;
    return createExecResult(stdout, "");
  };
}

interface TargetedMethod {
  name: string;
  invoke(client: SimCtlClient, deviceId?: string): Promise<unknown>;
  argv(deviceId: string): string[];
}

const methods: TargetedMethod[] = [
  {
    name: "listAppsOrThrow",
    invoke: (client, id) => client.listAppsOrThrow(id),
    argv: (id) => ["listapps", id, "--all"],
  },
  {
    name: "launchApp",
    invoke: (client, id) => client.launchApp(bundleId, undefined, id),
    argv: (id) => ["launch", id, bundleId],
  },
  {
    name: "terminateApp",
    invoke: (client, id) => client.terminateApp(bundleId, id),
    argv: (id) => ["terminate", id, bundleId],
  },
  {
    name: "installApp",
    invoke: (client, id) => client.installApp("/fixture/Test App.app", id),
    argv: (id) => ["install", id, "/fixture/Test App.app"],
  },
  {
    name: "uninstallApp",
    invoke: (client, id) => client.uninstallApp(bundleId, id),
    argv: (id) => ["uninstall", id, bundleId],
  },
  {
    name: "getScreenSize",
    invoke: (client, id) => client.getScreenSize(id),
    argv: (id) => ["io", id, "enumerate"],
  },
  {
    name: "setAppearance",
    invoke: (client, id) => client.setAppearance("dark", id),
    argv: (id) => ["ui", id, "appearance", "dark"],
  },
];

async function expectRefusal(method: TargetedMethod, client: SimCtlClient, id?: string) {
  if (method.name === "launchApp") {
    const result = await method.invoke(client, id);
    expect(result).toEqual({
      success: false,
      error:
        "No simulator is selected. Bind a device when constructing SimCtlClient or pass a deviceId. " +
        "Use a simulator UDID from xcrun simctl list devices or the listDevices tool.",
    });
  } else {
    const result = method.invoke(client, id);
    await expect(result).rejects.toBeInstanceOf(ActionableError);
    await expect(result).rejects.toThrow("No simulator is selected");
    await expect(result).rejects.toThrow("constructing SimCtlClient");
    await expect(result).rejects.toThrow("deviceId");
    await expect(result).rejects.toThrow("UDID");
    await expect(result).rejects.toThrow("listDevices");
  }
}

for (const method of methods) {
  describe(method.name, () => {
    test("refuses an unbound client without executing or discovering any simulator", async () => {
      // Refusal is independent of how many simulators are booted; no device-list parser is involved.
      const executor = new RecordingExecutor();
      const client = new SimCtlClient(null, executor.execute, new FakeTimer());
      await expectRefusal(method, client);
      expect(executor.calls).toEqual([]);
    });

    test("preserves the bound device command byte for byte", async () => {
      const executor = new RecordingExecutor();
      await method.invoke(new SimCtlClient(device, executor.execute, new FakeTimer()));
      expect(executor.calls).toEqual([
        { file: "xcrun", args: ["simctl", ...method.argv(device.deviceId)] },
      ]);
    });

    for (const binding of [null, device]) {
      test(`uses the explicit UDID ${binding ? "over the binding" : "without a binding"}`, async () => {
        const executor = new RecordingExecutor();
        await method.invoke(
          new SimCtlClient(binding, executor.execute, new FakeTimer()),
          explicitId,
        );
        expect(executor.calls).toEqual([
          { file: "xcrun", args: ["simctl", ...method.argv(explicitId)] },
        ]);
      });
    }

    for (const binding of [device, { ...device, deviceId: "booted" }]) {
      test(`refuses the alias in ${binding.deviceId === "booted" ? "the binding" : "an explicit argument"}`, async () => {
        const executor = new RecordingExecutor();
        const client = new SimCtlClient(binding, executor.execute, new FakeTimer());
        await expectRefusal(method, client, binding.deviceId === "booted" ? undefined : "booted");
        expect(executor.calls).toEqual([]);
      });
    }
  });
}
