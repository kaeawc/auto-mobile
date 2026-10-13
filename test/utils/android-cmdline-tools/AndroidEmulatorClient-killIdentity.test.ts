/**
 * killDevice identity + termination-primitive contract.
 *
 * Without a processStop seam, the kill remains the serial-scoped emulator console kill
 * `adb -s <serial> emu kill`. That is the termination that lets the
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
import {
  FakeEmulatorProcessStopper,
  FakeEmulatorProcessTableSource,
  FakeEmulatorProcessSignaler,
} from "../../fakes/FakeEmulatorProcessStopper";
import { AdbCommandTimeoutError } from "../../../src/utils/android-cmdline-tools/AdbClient";
import {
  EmulatorStillRunningError,
  ProcessTableEmulatorProcessStopper,
  isEmulatorStopDispatchedError,
} from "../../../src/utils/android-cmdline-tools/EmulatorProcessStop";
import { raceWithDeadline } from "../../../src/utils/raceWithDeadline";

const original: BootedDevice = {
  name: "Pixel_8",
  platform: "android",
  deviceId: "emulator-5554",
};

function processFallbackFixture(name = original.name, offline = false) {
  const adb = new FakeAdbExecutor();
  adb.setDevices(offline ? [] : [{ ...original, name }]);
  adb.setDeviceStates([{ deviceId: original.deviceId, state: offline ? "offline" : "device" }]);
  adb.setCommandResponse("emu avd name", execResult(`${name}\nOK\n`));
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const execute = adb.execute.bind(adb);
  adb.execute = async (args, options = {}) => {
    const result = await execute(args, options);
    if (args.join(" ") !== "emu kill") {
      return result;
    }
    return raceWithDeadline(new Promise<never>(() => {}), {
      timer,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      label: "emu kill",
      timeoutError: () => new AdbCommandTimeoutError("Console kill timed out"),
    });
  };
  const stopper = new FakeEmulatorProcessStopper();
  stopper.outcome = { kind: "stopped", pid: 83205, signal: "SIGTERM" };
  stopper.candidates = [
    { pid: 83205, command: "qemu-system-aarch64-headless -avd Foreign -port 5554" },
  ];
  const client = new AndroidEmulatorClient(null, null, timer, new FakeAdbClientFactory(adb));
  return { adb, client, timer, stopper, options: { timeoutMs: 30_000, processStop: { stopper } } };
}

test("bounded console kill falls back with the real AVD name and original deadline", async () => {
  const f = processFallbackFixture();
  await expect(f.client.killDevice(original, f.options)).resolves.toMatchObject(original);
  expect(f.stopper.stopCalls).toEqual([
    [
      { serial: original.deviceId, avdName: original.name },
      { deadlineMs: 30_000, signal: undefined },
    ],
  ]);
  expect(f.timer.now()).toBe(10_000);
  expect(emuKillArgv(f.adb)).toHaveLength(1);
});

test("mute discovery uses a real requested name without spending the console kill bound", async () => {
  const f = processFallbackFixture("Unknown (emulator-5554)");
  await expect(f.client.killDevice(original, f.options)).resolves.toMatchObject(original);
  expect(emuKillArgv(f.adb)).toEqual([]);
  expect(f.stopper.stopCalls[0][0]).toEqual({ serial: original.deviceId, avdName: original.name });
});

test("process-table mismatch uses serial-reuse refusal", async () => {
  const f = processFallbackFixture();
  f.stopper.outcome = { kind: "identity-mismatch", pid: 83205, runningAvdName: "Replacement" };
  await expect(f.client.killDevice(original, f.options)).rejects.toThrow(
    "refusing to kill its replacement (AVD 'Replacement')",
  );
});

test("a named discovery replacement never reaches the process stopper", async () => {
  const f = processFallbackFixture("Replacement");
  await expect(f.client.killDevice(original, f.options)).rejects.toThrow("identity changed");
  expect(f.stopper.stopCalls).toEqual([]);
  expect(emuKillArgv(f.adb)).toEqual([]);
});

for (const offline of [false, true]) {
  test(`forced ${offline ? "offline" : "online"} stop uses the pooled expected name after console timeout`, async () => {
    const f = processFallbackFixture("Unknown (emulator-5554)", offline);
    const target = { ...original, name: "Unknown (emulator-5554)" };
    await expect(
      f.client.killDevice(target, {
        ...f.options,
        force: true,
        processStop: { stopper: f.stopper, expectedAvdName: original.name },
      }),
    ).resolves.toMatchObject({ deviceId: original.deviceId });
    expect(f.stopper.stopCalls[0][0]).toEqual({
      serial: original.deviceId,
      avdName: original.name,
    });
    expect(emuKillArgv(f.adb)).toHaveLength(1);
  });
}

test("forced nameless stop describes candidates without authorizing a process signal", async () => {
  const f = processFallbackFixture();
  await expect(
    f.client.killDevice(
      { ...original, name: "Unknown (emulator-5554)" },
      { ...f.options, force: true },
    ),
  ).rejects.toThrow(/83205[\s\S]*-avd Foreign -port 5554/);
  expect(f.stopper.stopCalls).toEqual([]);
});

test("still-running outcome exposes a typed error with pid, serial and AVD", async () => {
  const f = processFallbackFixture();
  f.stopper.outcome = {
    kind: "still-running",
    signalled: true,
    pid: 83205,
    command: "qemu-system-aarch64 -avd Pixel_8 -port 5554",
  };
  const result = await f.client.killDevice(original, f.options).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(EmulatorStillRunningError);
  expect(result).toMatchObject({ pid: 83205, serial: original.deviceId, avdName: original.name });
});

test("caller abort never enters process fallback", async () => {
  const f = processFallbackFixture();
  const abort = new AbortController();
  abort.abort(new Error("caller cancelled"));
  await expect(
    f.client.killDevice(original, { ...f.options, signal: abort.signal }),
  ).rejects.toThrow("caller cancelled");
  expect(f.stopper.stopCalls).toEqual([]);
});

test("caller abort during console kill propagates unchanged without process fallback", async () => {
  const f = processFallbackFixture();
  const abort = new AbortController();
  const reason = new Error("caller cancelled console kill");
  f.timer.setTimeout(() => abort.abort(reason), 100);
  await expect(f.client.killDevice(original, { ...f.options, signal: abort.signal })).rejects.toBe(
    reason,
  );
  expect(emuKillArgv(f.adb)).toHaveLength(1);
  expect(f.stopper.stopCalls).toEqual([]);
  expect(f.stopper.describeCalls).toEqual([]);
});

test("non-timeout console failure never enters process fallback", async () => {
  const f = processFallbackFixture();
  const execute = f.adb.execute.bind(f.adb);
  f.adb.execute = async (args, options) => {
    if (args.join(" ") === "emu kill") {
      throw new Error("console rejected command");
    }
    return execute(args, options);
  };
  await expect(f.client.killDevice(original, f.options)).rejects.toThrow(
    "console rejected command",
  );
  expect(f.stopper.stopCalls).toEqual([]);
});

test("unidentified process retains the console timeout type and supplies manual process escape", async () => {
  const f = processFallbackFixture();
  f.stopper.outcome = { kind: "unidentified", identity: { kind: "absent" } };
  const error = await f.client.killDevice(original, f.options).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AdbCommandTimeoutError);
  expect((error as Error).message).toContain("Console kill timed out");
  expect((error as Error).message).toContain(
    "The process table has no emulator candidate with this explicit port.",
  );
  expect(isEmulatorStopDispatchedError(error)).toBe(true);
  expect(f.stopper.describeCalls).toEqual([]);
});

test("unidentified mute discovery retains a could-not-name-itself refusal and sends no console kill", async () => {
  const f = processFallbackFixture("Unknown (emulator-5554)");
  f.stopper.outcome = {
    kind: "unidentified",
    identity: { kind: "unreadable", detail: "ps unavailable" },
  };
  f.stopper.candidates = [];
  await expect(f.client.killDevice(original, f.options)).rejects.toThrow(
    /could not name itself[\s\S]*The process table could not be read[\s\S]*ps -axo/,
  );
  expect(emuKillArgv(f.adb)).toEqual([]);
});

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

// `force` (#6864) carries the caller's "act on whatever occupies this serial"
// contract down to the platform kill. It bypasses ONLY the duplicate name
// comparison -- the deviceTools layer has already decided not to establish an
// identity -- and leaves serial selection and the `emu kill` primitive exactly
// as they are.
test("force kills a discovered replacement AVD on the expected serial", async () => {
  const { client, adb, factory } = fixture({ ...original, name: "Pixel_9" });
  // The checked target comes back under the placeholder: a forced discovery is
  // serial-only, so no runtime was asked to name itself. That is the honest
  // answer, and downstream both `isSameBootedDeviceIdentity` and
  // `isConfirmedDeviceReplacement` read the placeholder as no information
  // rather than as an identity.
  await expect(client.killDevice(original, { force: true })).resolves.toMatchObject({
    deviceId: "emulator-5554",
    name: "Unknown (emulator-5554)",
  });
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(true);
  expect(factory.getCalls().at(-1)?.device?.deviceId).toBe(original.deviceId);
  expectNoTransportOrRebootCommand(adb.getExecutedArgv());
});

test("force kills when both the requested and the discovered name are the placeholder", async () => {
  const placeholder: BootedDevice = {
    ...original,
    name: "Unknown (emulator-5554)",
  };
  const { client, adb } = fixture(placeholder);
  await expect(client.killDevice(placeholder, { force: true })).resolves.toMatchObject({
    deviceId: "emulator-5554",
  });
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(true);
});

test("force kills when the request carries a pooled label the discovery cannot confirm", async () => {
  // The teardown path rewrites the target's name to the pooled AVD label before
  // the kill, so a wedged console produces label-vs-placeholder here.
  const { client, adb } = fixture({ ...original, name: "Unknown (emulator-5554)" });
  await expect(client.killDevice(original, { force: true })).resolves.toMatchObject({
    deviceId: "emulator-5554",
  });
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(true);
});

test("force still refuses when the expected emulator is no longer running", async () => {
  // Serial selection is not an identity check: with nothing on the serial there
  // is nothing for "kill whatever occupies this serial" to act on.
  const { client, adb } = fixture({ ...original, deviceId: "emulator-5556" });
  await expect(client.killDevice(original, { force: true })).rejects.toThrow("is not running");
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(false);
});

test("force does not cross platforms", async () => {
  const { client, adb } = fixture(original);
  await expect(
    client.killDevice({ ...original, platform: "ios" } as BootedDevice, { force: true }),
  ).rejects.toThrow("identity");
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(false);
});

test("an unforced kill is unchanged by the new option", async () => {
  const { client, adb } = fixture({ ...original, name: "Pixel_9" });
  await expect(client.killDevice(original, { force: false })).rejects.toThrow("identity");
  expect(adb.getExecutedCommands().some((command) => command.endsWith("emu kill"))).toBe(false);
});

/**
 * The per-emulator AVD-name probe budget inside
 * `getBootedDevicesWithDiagnostics`. A wedged console spends all of it and
 * answers nothing.
 */
const AVD_NAME_PROBE_BUDGET_MS = 2000;

/**
 * Every attached emulator has a wedged console: `emu avd name` (and the
 * `getprop` fallback) burn their whole budget and then fail. FakeTimer drives
 * every stalled round trip together so concurrent probes consume one shared
 * wall-clock budget, matching the production execution shape.
 */
function wedgedConsoleFactory(attached: string[]): {
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
          const joined = args.join(" ");
          if (joined === "devices -l") {
            const stdout = `List of devices attached\n${deviceLines}`;
            return {
              stdout,
              stderr: "",
              toString: () => stdout,
              trim: () => stdout.trim(),
              includes: (part: string) => stdout.includes(part),
            };
          }
          if (joined.includes("avd name") || joined.includes("ro.boot.qemu.avd_name")) {
            await timer.sleep(AVD_NAME_PROBE_BUDGET_MS);
            throw new Error("emulator console did not respond");
          }
          return {
            stdout: "",
            stderr: "",
            toString: () => "",
            trim: () => "",
            includes: () => false,
          };
        },
        null,
        undefined,
        timer,
      ),
  };
  return { factory, commands, timer };
}

function nameProbes(commands: string[][]): string[][] {
  return commands.filter((args) => {
    const joined = args.join(" ");
    return joined.includes("avd name") || joined.includes("ro.boot.qemu.avd_name");
  });
}

// The force flag is worthless if the discovery that precedes it spends the
// caller's whole deadline on the very probes force exists to skip: with three
// wedged consoles the sequential enrichment alone costs 6s, so a 5s forced
// teardown never reaches `emu kill`
// ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review).
test("a forced kill dispatches within its deadline with several wedged consoles", async () => {
  const { factory, commands, timer } = wedgedConsoleFactory([
    "emulator-5554",
    "emulator-5556",
    "emulator-5558",
  ]);
  const client = new AndroidEmulatorClient(null, null, timer, factory);
  const startedAt = timer.now();

  await client.killDevice(original, { force: true });

  expect(nameProbes(commands)).toEqual([]);
  expect(timer.now() - startedAt).toBeLessThan(5000);
  expect(commands.filter((args) => args.slice(-2).join(" ") === "emu kill")).toEqual([
    ["-s", "emulator-5554", "emu", "kill"],
  ]);
});

test("an unforced kill still enriches discovery with the AVD-name probe", async () => {
  const { factory, commands, timer } = wedgedConsoleFactory([
    "emulator-5554",
    "emulator-5556",
    "emulator-5558",
  ]);
  const client = new AndroidEmulatorClient(null, null, timer, factory);
  const startedAt = timer.now();

  const kill = client.killDevice(original);
  for (let turn = 0; turn < 20 && nameProbes(commands).length < 3; turn++) {
    await Promise.resolve();
  }
  expect(nameProbes(commands).length).toBe(3);
  timer.advanceTime(AVD_NAME_PROBE_BUDGET_MS);

  await expect(kill).rejects.toThrow(/identity|could not name itself/);
  expect(nameProbes(commands).length).toBe(3);
  expect(timer.now() - startedAt).toBe(AVD_NAME_PROBE_BUDGET_MS);
  expect(commands.some((args) => args.slice(-2).join(" ") === "emu kill")).toBe(false);
});

// An emulator whose adb transport dropped is listed `offline`, which the
// booted-device discovery filters out. "Missing from the online list" is not
// "not running": the process keeps running and holding its AVD (#10074).
function offlineFixture(states: Array<{ deviceId: string; state: string }>) {
  const adb = new FakeAdbExecutor();
  adb.setDevices([]);
  adb.setDeviceStates(states);
  const client = new AndroidEmulatorClient(
    null,
    null,
    new FakeTimer(),
    new FakeAdbClientFactory(adb),
  );
  return { client, adb };
}

const offlineEmulator = [{ deviceId: "emulator-5554", state: "offline" }];

function emuKillArgv(adb: FakeAdbExecutor): string[][] {
  return adb.getExecutedArgv().filter((args) => args.slice(-2).join(" ") === "emu kill");
}

test("an unforced kill of an offline emulator is not reported as not running and sends no kill", async () => {
  const { client, adb } = offlineFixture(offlineEmulator);

  const failure = await client.killDevice(original).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  expect(message).not.toContain("is not running");
  expect(message).toContain("emulator-5554");
  expect(message).toContain("'offline'");
  expect(message).toContain("force");
  expect(emuKillArgv(adb)).toEqual([]);
});

test("a forced kill of an offline emulator dispatches the serial-scoped console kill", async () => {
  const { client, adb } = offlineFixture(offlineEmulator);

  await expect(client.killDevice(original, { force: true })).resolves.toMatchObject(original);

  expect(emuKillArgv(adb)).toHaveLength(1);
  expectNoTransportOrRebootCommand(adb.getExecutedArgv());
});

test("a serial that is in neither the online list nor the adb states is still not running", async () => {
  const { client, adb } = offlineFixture([{ deviceId: "emulator-5556", state: "offline" }]);

  await expect(client.killDevice(original)).rejects.toThrow("is not running");
  await expect(client.killDevice(original, { force: true })).rejects.toThrow("is not running");
  expect(emuKillArgv(adb)).toEqual([]);
});

test("an unreadable adb state list fails the kill instead of reporting the emulator stopped", async () => {
  const { client, adb } = offlineFixture(offlineEmulator);
  adb.getDeviceStates = async () => {
    throw new Error("adb server unreachable");
  };

  const failure = await client.killDevice(original).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("adb server unreachable");
  expect((failure as Error).message).not.toContain("is not running");
  expect(emuKillArgv(adb)).toEqual([]);
});

test("a kill asks for the adb states in the mode that rejects a missing adb executable", async () => {
  // A vanished adb answering "no devices" would read as "not running" and let the caller retire
  // ownership of an emulator that is alive (#11643).
  const { client, adb } = offlineFixture(offlineEmulator);
  const asked: Array<boolean | undefined> = [];
  adb.getDeviceStates = async (options?: { throwOnMissingAdb?: boolean }) => {
    asked.push(options?.throwOnMissingAdb);
    throw new Error("ADB executable is unavailable");
  };

  const failure = await client.killDevice(original).catch((error: unknown) => error);

  expect(asked).toEqual([true]);
  expect((failure as Error).message).toContain("ADB executable is unavailable");
  expect((failure as Error).message).not.toContain("is not running");
});

for (const timeoutMs of [30_000, 12_000]) {
  test(`hung console returns a typed process outcome before the ${timeoutMs}ms deadline`, async () => {
    const f = processFallbackFixture();
    const table = new FakeEmulatorProcessTableSource();
    table.rows = [{ pid: 83205, ppid: 1, command: "qemu-system-aarch64 -avd Pixel_8 -port 5554" }];
    const signaler = new FakeEmulatorProcessSignaler();
    signaler.exitOn = undefined;
    const stopper = new ProcessTableEmulatorProcessStopper(table, signaler, f.timer);
    const result = await f.client
      .killDevice(original, { timeoutMs, processStop: { stopper } })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(result).toBeInstanceOf(EmulatorStillRunningError);
    expect(result).toMatchObject({ pid: 83205 });
    expect(f.timer.now()).toBeLessThan(timeoutMs);
    const consoleMs = Math.min(10_000, timeoutMs / 3);
    const termMs = Math.min(15_000, timeoutMs - consoleMs - 2000 - 1000);
    expect(f.timer.now()).toBe(consoleMs + termMs + 1000);
    expect(f.timer.getSleepHistory().reduce((a, b) => a + b, 0)).toBe(termMs + 1000);
    expect(signaler.signals).toEqual([
      { pid: 83205, signal: "SIGTERM" },
      { pid: 83205, signal: "SIGKILL" },
    ]);
  });
}

test("without processStop, two placeholders preserve the original refusal byte for byte", async () => {
  const placeholder = { ...original, name: "Unknown (emulator-5554)" };
  const f = fixture(placeholder);
  const result = await f.client.killDevice(placeholder).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe(
    "Refusing to kill 'emulator-5554': the emulator could not name itself, so this daemon cannot tell it apart from a replacement that took the serial. Resolve its AVD name and retry, or stop it by hand with `adb -s emulator-5554 emu kill`.",
  );
  expect(emuKillArgv(f.adb)).toEqual([]);
});

test("without processStop, an adb error survives a concurrent caller abort unchanged", async () => {
  const f = fixture(original);
  const abort = new AbortController();
  const adbError = new Error("adb's own failure");
  const execute = f.adb.execute.bind(f.adb);
  f.adb.execute = async (args, options) => {
    if (args.join(" ") === "emu kill") {
      abort.abort(new Error("caller abort"));
      throw adbError;
    }
    return execute(args, options);
  };
  await expect(f.client.killDevice(original, { signal: abort.signal })).rejects.toBe(adbError);
});

for (const identity of [
  { kind: "absent" } as const,
  { kind: "unreadable", detail: "ps unavailable" } as const,
]) {
  test(`mute process refusal distinguishes ${identity.kind}`, async () => {
    const f = processFallbackFixture("Unknown (emulator-5554)");
    f.stopper.outcome = { kind: "unidentified", identity };
    const result = await f.client.killDevice(original, f.options).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((result as Error).message).toContain(
      identity.kind === "absent"
        ? "The process table has no emulator candidate with this explicit port."
        : "The process table could not be read.",
    );
    expect(isEmulatorStopDispatchedError(result)).toBe(false);
    expect(emuKillArgv(f.adb)).toEqual([]);
    expect(f.stopper.describeCalls).toEqual([]);
  });
}

for (const signalled of [false, true]) {
  for (const consoleDispatched of [false, true]) {
    test(`still-running signalled=${signalled}, consoleDispatched=${consoleDispatched} preserves dispatch classification`, async () => {
      const f = processFallbackFixture(
        consoleDispatched ? original.name : "Unknown (emulator-5554)",
      );
      f.stopper.outcome = {
        kind: "still-running",
        signalled,
        pid: 83205,
        command: "qemu-system-aarch64 -avd Pixel_8 -port 5554",
      };
      const result = await f.client.killDevice(original, f.options).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(isEmulatorStopDispatchedError(result)).toBe(signalled || consoleDispatched);
      expect((result as Error).message).toContain("83205");
      expect((result as Error).message).toContain("-avd Pixel_8 -port 5554");
      if (!signalled) {
        expect((result as Error).message).toContain("no signal could be delivered");
        expect((result as Error).message).toMatch(/deadline spent|permission denied/);
      }
      expect(emuKillArgv(f.adb)).toHaveLength(consoleDispatched ? 1 : 0);
    });
  }
}
