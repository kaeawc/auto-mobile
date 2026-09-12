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

test("verifies the checked transport resolves to the serial, then terminates through the console kill", async () => {
  const { client, adb, factory } = fixture(original);
  await expect(client.killDevice(original)).resolves.toMatchObject(original);

  const argv = adb.getExecutedArgv();
  const serialCheckIndex = argv.findIndex((args) => args.join(" ") === "-t 1 get-serialno");
  const killIndex = argv.findIndex((args) => args.join(" ") === "emu kill");
  expect(serialCheckIndex).toBeGreaterThanOrEqual(0);
  // The serial-scoped console kill runs only after the transport check confirms
  // identity, with no awaited work between, so the verified serial cannot be
  // freed and re-inherited in the gap.
  expect(killIndex).toBeGreaterThan(serialCheckIndex);
  expectNoTransportScopedEmuCommand(argv);
  // The kill is dispatched serial-scoped (`-s <serial>`), never `-t`, so two
  // attached emulators never collapse the console selection (#6845).
  expect(factory.getCalls().at(-1)?.device?.deviceId).toBe(original.deviceId);
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
  expectNoTransportScopedEmuCommand(adb.getExecutedArgv());
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(true);
});

test("terminates through the graceful console kill so the quick-boot snapshot is saved (#6849)", async () => {
  // A guest `shell reboot -p` powers the OS off without letting the emulator
  // write its quick-boot snapshot, so the next quick-boot of the AVD resumes
  // into a halted guest that never comes adb-online. killDevice must use the
  // emulator console `emu kill`, which saves the snapshot on exit.
  const { client, adb } = fixture(original);
  await expect(client.killDevice(original)).resolves.toMatchObject(original);
  expect(adb.getExecutedCommands().some((command) => command.includes("reboot -p"))).toBe(false);
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(true);
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
  test(`real ADB builder terminates through the serial-scoped console kill; replacement=${replacedBeforeDispatch}`, async () => {
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
    // The console kill is the snapshot-saving primitive (#6849); it runs only
    // on the success path, serial-scoped, and never over a transport (#6845).
    expect(commands.filter((args) => args.slice(-2).join(" ") === "emu kill")).toEqual(
      replacedBeforeDispatch ? [] : [["-s", "emulator-5554", "emu", "kill"]],
    );
    expect(commands.filter((args) => args.slice(-3).join(" ") === "shell reboot -p")).toEqual([]);
    expectNoTransportScopedEmuCommand(commands);
    expect(replacementKilled).toBe(false);
  });
}

test("refuses the kill when the checked transport has gone before the serial-scoped console kill", async () => {
  const commands: string[][] = [];
  // The checked emulator exits after the device-list snapshot but before the
  // transport check. adb never reuses a transport id, so a replacement that
  // inherits serial emulator-5554 arrives on a fresh transport and transport 1
  // stops resolving — the get-serialno check on transport 1 fails and the kill
  // is refused, so the serial-scoped `emu kill` never selects the replacement.
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
          } else if (args[0] === "-t" && args[1] === "1" && args.at(-1) === "get-serialno") {
            throw new Error("error: transport id 1 not found");
          } else if (args.slice(-3).join(" ") === "emu avd name") {
            stdout = "Pixel_8\nOK\n";
          } else if (args.slice(-2).join(" ") === "emu kill") {
            // serial emulator-5554 now belongs to the replacement; reaching here
            // would terminate it.
            replacementTerminated = true;
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
