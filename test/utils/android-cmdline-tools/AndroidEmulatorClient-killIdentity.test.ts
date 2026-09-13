/**
 * killDevice identity + termination-primitive contract.
 *
 * The kill is unconditionally the serial-scoped emulator console kill
 * `adb -s <serial> emu kill`. That is the only termination that lets the
 * emulator write its quick-boot snapshot on exit (#6849), and `adb emu`
 * selects only via `-s`/ANDROID_SERIAL, so serial scoping is also what keeps
 * the kill unambiguous with several emulators attached (#6845).
 *
 * Transport ids are deliberately NOT used anywhere in the kill path. The
 * former `-t <id> get-serialno` pre-check — a defense against a replacement
 * emulator inheriting the serial between the discovery snapshot and the kill —
 * has been removed by maintainer decision: it cost an extra adb round trip on
 * every teardown, and callers already confirm disappearance and incarnation.
 * Tests whose premise was that transport verification have been removed with
 * it; do not reintroduce them.
 */
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

function fixture(observed: BootedDevice) {
  const adb = new FakeAdbExecutor();
  adb.setDevices([observed]);
  adb.setCommandResponse("emu avd name", execResult(`${observed.name}\nOK\n`));
  const factory = new FakeAdbClientFactory(adb);
  const client = new AndroidEmulatorClient(null, null, new FakeTimer(), factory);
  return { client, adb, factory };
}

/**
 * No executed command may ever reach for a transport id, a transport-to-serial
 * resolution, or a guest power-off: `adb emu` ignores `-t`, and `shell reboot
 * -p` skips the quick-boot snapshot (#6849, #6845).
 */
function expectNoTransportOrRebootCommand(argv: string[][]) {
  for (const args of argv) {
    expect(args).not.toContain("-t");
    expect(args).not.toContain("get-serialno");
    expect(args).not.toContain("reboot");
  }
}

/**
 * Builds a real {@link AdbClient} over a recording executor so the assertions
 * see the exact argv adb would receive, including the `-s <serial>` prefix the
 * client adds for a device-scoped call.
 */
function recordingFactory(attached: string[]): {
  factory: AdbClientFactory;
  commands: string[][];
  timer: FakeTimer;
} {
  const commands: string[][] = [];
  const timer = new FakeTimer();
  const deviceLines = attached
    .map((serial, index) => `${serial} device transport_id:${index + 1}\n`)
    .join("");
  const factory: AdbClientFactory = {
    create: (device) =>
      new AdbClient(
        device ?? null,
        async (_file: string, args: string[], _maxBuffer?: number) => {
          commands.push(args);
          let stdout = "";
          if (args.join(" ") === "devices -l") {
            stdout = `List of devices attached\n${deviceLines}`;
          } else if (args.slice(-3).join(" ") === "emu avd name") {
            stdout = "Pixel_8\nOK\n";
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
  return { factory, commands, timer };
}

test("never issues a transport-scoped, serial-resolving or reboot command in the kill path", async () => {
  const { client, adb } = fixture(original);
  await expect(client.killDevice(original)).resolves.toMatchObject(original);
  expectNoTransportOrRebootCommand(adb.getExecutedArgv());
});

test("dispatches the kill serial-scoped through the discovered emulator", async () => {
  const { client, adb, factory } = fixture(original);
  await expect(client.killDevice(original)).resolves.toMatchObject(original);
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(true);
  // The console client is built from the discovered emulator, so AdbClient
  // prefixes `-s <serial>` — never `-t` (#6845).
  expect(factory.getCalls().at(-1)?.device?.deviceId).toBe(original.deviceId);
});

test("the real ADB builder emits exactly `-s <serial> emu kill`", async () => {
  const { factory, commands, timer } = recordingFactory(["emulator-5554"]);
  const client = new AndroidEmulatorClient(null, null, timer, factory);
  await expect(client.killDevice(original)).resolves.toMatchObject({
    deviceId: "emulator-5554",
  });
  expect(commands.filter((args) => args.slice(-2).join(" ") === "emu kill")).toEqual([
    ["-s", "emulator-5554", "emu", "kill"],
  ]);
  expectNoTransportOrRebootCommand(commands);
});

test("with two booted emulators each kill selects only its own serial", async () => {
  const { factory, commands, timer } = recordingFactory(["emulator-5554", "emulator-5556"]);
  const client = new AndroidEmulatorClient(null, null, timer, factory);

  await client.killDevice({ ...original, deviceId: "emulator-5554" });
  expect(commands.filter((args) => args.slice(-2).join(" ") === "emu kill")).toEqual([
    ["-s", "emulator-5554", "emu", "kill"],
  ]);

  await client.killDevice({ ...original, deviceId: "emulator-5556" });
  expect(commands.filter((args) => args.slice(-2).join(" ") === "emu kill")).toEqual([
    ["-s", "emulator-5554", "emu", "kill"],
    ["-s", "emulator-5556", "emu", "kill"],
  ]);
  expectNoTransportOrRebootCommand(commands);
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

test("refuses a discovered replacement AVD on the expected serial", async () => {
  const { client, adb } = fixture({ ...original, name: "Pixel_9" });
  await expect(client.killDevice(original)).rejects.toThrow("identity");
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(false);
  expectNoTransportOrRebootCommand(adb.getExecutedArgv());
});

// Two unknowns are not an equality. When the requested target's name is the
// `Unknown (<serial>)` placeholder AND the fresh discovery reports the same
// placeholder, the check above passes on nothing: neither side names an AVD, so
// a replacement emulator that also cannot name itself would be killed under the
// previous occupant's request
// ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
test("refuses when both the requested and the discovered name are the placeholder", async () => {
  const placeholder: BootedDevice = {
    ...original,
    name: "Unknown (emulator-5554)",
  };
  const { client, adb } = fixture(placeholder);
  await expect(client.killDevice(placeholder)).rejects.toThrow(/could not name itself/);
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(false);
});

test("refuses when the expected emulator is no longer running", async () => {
  const { client, adb } = fixture({ ...original, deviceId: "emulator-5556" });
  await expect(client.killDevice(original)).rejects.toThrow("is not running");
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(false);
});

test("an adb listing that still reports transport_id does not affect the kill identity", () => {
  // `adb devices -l` keeps printing a `transport_id:` column; discovery no
  // longer parses it, and the kill identity is serial + AVD name + platform.
  const { client, adb } = fixture(original);
  return (async () => {
    await expect(client.killDevice(original)).resolves.toMatchObject({
      deviceId: original.deviceId,
    });
    expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(true);
    expectNoTransportOrRebootCommand(adb.getExecutedArgv());
  })();
});
