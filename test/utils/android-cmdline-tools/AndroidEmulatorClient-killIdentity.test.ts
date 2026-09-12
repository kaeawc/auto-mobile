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

test("verifies the checked transport resolves to the serial, then terminates through it", async () => {
  const { client, adb, factory } = fixture(original);
  await expect(client.killDevice(original)).resolves.toMatchObject(original);

  const argv = adb.getExecutedArgv();
  const serialCheckIndex = argv.findIndex((args) => args.join(" ") === "-t 1 get-serialno");
  const killIndex = argv.findIndex((args) => args.join(" ") === "-t 1 shell reboot -p");
  expect(serialCheckIndex).toBeGreaterThanOrEqual(0);
  expect(killIndex).toBeGreaterThan(serialCheckIndex);
  expectNoTransportScopedEmuCommand(argv);
  // Nothing reselects the emulator by its reusable serial.
  expect(argv.some((args) => args.join(" ").endsWith("emu kill"))).toBe(false);
  expect(factory.getCalls().at(-1)?.device).toBeNull();
});

test("refuses the kill when the checked transport now resolves to a different serial", async () => {
  const { client, adb } = fixture(original, "emulator-5556");
  await expect(client.killDevice(original)).rejects.toThrow("identity");
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(false);
  expectNoTransportScopedEmuCommand(adb.getExecutedArgv());
});

test("unknown expected transport permits a matching cold-boot AVD and binds to its discovered transport", async () => {
  const { client, adb } = fixture(original);
  await client.killDevice({ ...original, transportId: undefined });
  expect(adb.getExecutedArgv()).toContainEqual(["-t", "1", "get-serialno"]);
  expect(adb.getExecutedArgv()).toContainEqual(["-t", "1", "shell", "reboot", "-p"]);
  expectNoTransportScopedEmuCommand(adb.getExecutedArgv());
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(false);
});

test("matching legacy discovery without transport still allows ordinary termination", async () => {
  const legacy = { ...original, transportId: undefined };
  const { client, adb, factory } = fixture(legacy);
  await client.killDevice(legacy);
  // No discovered transport to bind to, so the legacy serial-scoped console
  // kill stays the only available primitive.
  expect(adb.getExecutedCommands()).toContain("emu kill");
  expect(adb.getExecutedCommands().some((command) => command.includes("get-serialno"))).toBe(false);
  expect(factory.getCalls().at(-1)?.device?.deviceId).toBe(original.deviceId);
});

for (const replacedBeforeDispatch of [false, true]) {
  test(`real ADB builder terminates through the checked transport; replacement=${replacedBeforeDispatch}`, async () => {
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
            } else if (
              args.slice(-2).join(" ") === "emu kill" ||
              args.slice(-3).join(" ") === "shell reboot -p"
            ) {
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
    expect(commands.filter((args) => args.slice(-2).join(" ") === "emu kill")).toEqual([]);
    expect(commands.filter((args) => args.slice(-3).join(" ") === "shell reboot -p")).toEqual(
      replacedBeforeDispatch ? [] : [["-t", "1", "shell", "reboot", "-p"]],
    );
    expectNoTransportScopedEmuCommand(commands);
    expect(replacementKilled).toBe(false);
  });
}

test("does not terminate a replacement that inherits the serial after the transport check", async () => {
  const commands: string[][] = [];
  // adb never reuses a transport id, so a replacement that inherits the serial
  // arrives on a new transport and transport 1 stops resolving.
  let transportOneSerial: string | null = "emulator-5554";
  let serialOwner: "original" | "replacement" = "original";
  let replacementTerminated = false;
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
          } else if (args[0] === "-t" && transportOneSerial === null) {
            throw new Error(`error: transport id ${args[1]} not found`);
          } else if (args.slice(-3).join(" ") === "emu avd name") {
            stdout = "Pixel_8\nOK\n";
          } else if (args.at(-1) === "get-serialno") {
            stdout = `${transportOneSerial}\n`;
            // The checked emulator exits right after the check and a different
            // emulator inherits serial emulator-5554 on a fresh transport.
            transportOneSerial = null;
            serialOwner = "replacement";
          } else if (
            args.slice(-2).join(" ") === "emu kill" ||
            args.slice(-3).join(" ") === "shell reboot -p"
          ) {
            replacementTerminated = serialOwner === "replacement";
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
  await expect(client.killDevice(original)).rejects.toThrow();
  expect(replacementTerminated).toBe(false);
  // Nothing destructive was reselected by the reusable serial.
  expect(commands.some((args) => args.slice(-2).join(" ") === "emu kill")).toBe(false);
});
