import { expect, test } from "bun:test";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice } from "../../../src/models";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const original: BootedDevice = {
  name: "Pixel_8",
  platform: "android",
  deviceId: "emulator-5554",
  transportId: "1",
};
function fixture(observed: BootedDevice) {
  const adb = new FakeAdbExecutor();
  adb.setDevices([observed]);
  const stdout = `${observed.name}\nOK\n`;
  adb.setCommandResponse("emu avd name", {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  });
  const factory = new FakeAdbClientFactory(adb);
  const client = new AndroidEmulatorClient(null, null, new FakeTimer(), factory);
  return { client, adb, factory };
}

for (const replacement of [
  { ...original, name: "Pixel_9", transportId: "2" },
  { ...original, transportId: "2" },
  { ...original, name: "Pixel_9" },
  { ...original, transportId: undefined },
]) {
  test(`refuses replacement ${replacement.name} transport ${replacement.transportId}`, async () => {
    const { client, adb } = fixture(replacement);
    await expect(client.killDevice(original)).rejects.toThrow("identity");
    expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(false);
  });
}

test("pins termination to the checked transport rather than redispatching to its reusable serial", async () => {
  const { client, adb, factory } = fixture(original);
  await expect(client.killDevice(original)).resolves.toMatchObject(original);
  expect(adb.getExecutedCommands()).toContain("-t 1 emu kill");
  expect(factory.getCalls().at(-1)?.device).toBeNull();
});

test("unknown expected transport permits a matching cold-boot AVD and pins its discovered transport", async () => {
  const { client, adb } = fixture(original);
  await client.killDevice({ ...original, transportId: undefined });
  expect(adb.getExecutedCommands()).toContain("-t 1 emu kill");
});

test("matching legacy discovery without transport still allows ordinary termination", async () => {
  const legacy = { ...original, transportId: undefined };
  const { client, adb, factory } = fixture(legacy);
  await client.killDevice(legacy);
  expect(adb.getExecutedCommands()).toContain("emu kill");
  expect(factory.getCalls().at(-1)?.device?.deviceId).toBe(original.deviceId);
});

for (const replacedBeforeDispatch of [false, true]) {
  test(`real ADB builder uses exactly one transport selector; replacement=${replacedBeforeDispatch}`, async () => {
    const commands: string[][] = [];
    let currentTransport = "1";
    let replacementKilled = false;
    const timer = new FakeTimer();
    const factory: AdbClientFactory = {
      create: (device) =>
        new AdbClient(
          device ?? null,
          async (_file: string, args: string[], _maxBuffer?: number) => {
            commands.push(args);
            let stdout = "";
            if (args.join(" ") === "devices -l") {
              stdout = "List of devices attached\nemulator-5554 device transport_id:1\n";
            } else if (args.slice(-3).join(" ") === "emu avd name") {
              stdout = "Pixel_8\nOK\n";
              if (replacedBeforeDispatch) {
                currentTransport = "2";
              }
            } else if (args.slice(-2).join(" ") === "emu kill") {
              if (args[0] === "-t" && args[1] !== currentTransport) {
                throw new Error("transport 1 not found");
              }
              replacementKilled = replacedBeforeDispatch;
            }
            return {
              stdout,
              stderr: "",
              toString: () => stdout,
              trim: () => stdout.trim(),
              includes: (part: string) => stdout.includes(part),
            };
          },
          null,
          undefined,
          timer,
        ),
    };
    const client = new AndroidEmulatorClient(null, null, timer, factory);
    if (replacedBeforeDispatch) {
      await expect(client.killDevice(original)).rejects.toThrow("transport 1 not found");
    } else {
      await expect(client.killDevice(original)).resolves.toMatchObject(original);
    }
    expect(commands.filter((args) => args.slice(-2).join(" ") === "emu kill")).toEqual([
      ["-t", "1", "emu", "kill"],
    ]);
    expect(replacementKilled).toBe(false);
  });
}
