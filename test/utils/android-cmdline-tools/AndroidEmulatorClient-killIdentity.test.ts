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

function execResult(stdout: string) {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

function fixture(observed: BootedDevice, transportSerial: string = observed.deviceId!) {
  const adb = new FakeAdbExecutor();
  adb.setDevices([observed]);
  adb.setCommandResponse("emu avd name", execResult(`${observed.name}\nOK\n`));
  adb.setCommandResponse("get-serialno", execResult(`${transportSerial}\n`));
  const factory = new FakeAdbClientFactory(adb);
  const client = new AndroidEmulatorClient(null, null, new FakeTimer(), factory);
  return { client, adb, factory };
}

/**
 * `adb emu` ignores `-t`, so no executed command may ever combine them: with a
 * second emulator attached such an invocation fails with "more than one
 * emulator detected; use -s" and the emulator survives (issue #6845).
 */
function expectNoTransportScopedEmuCommand(argv: string[][]) {
  for (const args of argv) {
    expect(args.includes("-t") && args.includes("emu")).toBe(false);
  }
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
    expectNoTransportScopedEmuCommand(adb.getExecutedArgv());
  });
}

test("verifies the checked transport still resolves to the serial, then kills with -s", async () => {
  const { client, adb, factory } = fixture(original);
  await expect(client.killDevice(original)).resolves.toMatchObject(original);

  const argv = adb.getExecutedArgv();
  const serialCheckIndex = argv.findIndex((args) => args.join(" ") === "-t 1 get-serialno");
  const killIndex = argv.findIndex((args) => args.join(" ") === "emu kill");
  expect(serialCheckIndex).toBeGreaterThanOrEqual(0);
  expect(killIndex).toBeGreaterThan(serialCheckIndex);
  expectNoTransportScopedEmuCommand(argv);
  // The kill is dispatched through a serial-scoped client so adb selects with
  // `-s <serial>` the way every other device command does.
  expect(factory.getCalls().at(-1)?.device?.deviceId).toBe(original.deviceId);
});

test("refuses the kill when the checked transport now resolves to a different serial", async () => {
  const { client, adb } = fixture(original, "emulator-5556");
  await expect(client.killDevice(original)).rejects.toThrow("identity");
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(false);
  expectNoTransportScopedEmuCommand(adb.getExecutedArgv());
});

test("unknown expected transport permits a matching cold-boot AVD and checks its discovered transport", async () => {
  const { client, adb, factory } = fixture(original);
  await client.killDevice({ ...original, transportId: undefined });
  expect(adb.getExecutedArgv()).toContainEqual(["-t", "1", "get-serialno"]);
  expect(adb.getExecutedArgv()).toContainEqual(["emu", "kill"]);
  expectNoTransportScopedEmuCommand(adb.getExecutedArgv());
  expect(factory.getCalls().at(-1)?.device?.deviceId).toBe(original.deviceId);
});

test("matching legacy discovery without transport still allows ordinary termination", async () => {
  const legacy = { ...original, transportId: undefined };
  const { client, adb, factory } = fixture(legacy);
  await client.killDevice(legacy);
  expect(adb.getExecutedCommands()).toContain("emu kill");
  expect(adb.getExecutedCommands().some((command) => command.includes("get-serialno"))).toBe(false);
  expect(factory.getCalls().at(-1)?.device?.deviceId).toBe(original.deviceId);
});

for (const replacedBeforeDispatch of [false, true]) {
  test(`real ADB builder selects the kill by serial; replacement=${replacedBeforeDispatch}`, async () => {
    const commands: string[][] = [];
    let transportSerial = "emulator-5554";
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
                // The serial was reused by a replacement emulator that also
                // inherited transport 1.
                transportSerial = "emulator-5556";
              }
            } else if (args.at(-1) === "get-serialno") {
              stdout = `${transportSerial}\n`;
            } else if (args.slice(-2).join(" ") === "emu kill") {
              replacementKilled = transportSerial !== "emulator-5554";
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
      await expect(client.killDevice(original)).rejects.toThrow("identity");
    } else {
      await expect(client.killDevice(original)).resolves.toMatchObject(original);
    }
    expect(commands.filter((args) => args.slice(-2).join(" ") === "emu kill")).toEqual(
      replacedBeforeDispatch ? [] : [["-s", "emulator-5554", "emu", "kill"]],
    );
    expectNoTransportScopedEmuCommand(commands);
    expect(replacementKilled).toBe(false);
  });
}
