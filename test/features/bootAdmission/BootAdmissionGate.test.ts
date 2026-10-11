import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOOT_CAPACITY_GATE_ENV,
  BootAdmissionLedger,
  IOS_SIM_CAPACITY_GATE_ENV,
  isBootCapacityGateEnabled,
  type BootCapacityReporter,
} from "../../../src/features/bootAdmission/BootAdmissionGate";
import {
  CommandAndroidCapacitySource,
  isEmulatorQemuProcess,
} from "../../../src/features/bootAdmission/AndroidCapacitySource";
import {
  createBootAdmissionGates,
  describeBootCapacity,
} from "../../../src/features/bootAdmission/sharedBootAdmissionGates";
import { parsePsSnapshot } from "../../../src/features/iosSimFleet/psSnapshot";
import { testOverrides } from "../../../src/utils/testOverrides";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const GIB = 1024 ** 3;

describe("isBootCapacityGateEnabled (#11181)", () => {
  test("is on by default for both platforms", () => {
    expect(isBootCapacityGateEnabled("android", {})).toBe(true);
    expect(isBootCapacityGateEnabled("ios", {})).toBe(true);
  });

  test("exact 0 on the shared switch opts both platforms out", () => {
    const env = { [BOOT_CAPACITY_GATE_ENV]: "0" };
    expect(isBootCapacityGateEnabled("android", env)).toBe(false);
    expect(isBootCapacityGateEnabled("ios", env)).toBe(false);
    expect(isBootCapacityGateEnabled("android", { [BOOT_CAPACITY_GATE_ENV]: "1" })).toBe(true);
  });

  test("the iOS override wins for iOS only", () => {
    expect(isBootCapacityGateEnabled("ios", { [IOS_SIM_CAPACITY_GATE_ENV]: "0" })).toBe(false);
    expect(isBootCapacityGateEnabled("android", { [IOS_SIM_CAPACITY_GATE_ENV]: "0" })).toBe(true);
    expect(
      isBootCapacityGateEnabled("ios", {
        [BOOT_CAPACITY_GATE_ENV]: "0",
        [IOS_SIM_CAPACITY_GATE_ENV]: "1",
      }),
    ).toBe(true);
    // Any other value defers to the shared switch.
    expect(isBootCapacityGateEnabled("ios", { [IOS_SIM_CAPACITY_GATE_ENV]: "yes" })).toBe(true);
  });
});

describe("BootAdmissionLedger", () => {
  test("counts admissions not yet visible and forgets released ones", () => {
    const ledger = new BootAdmissionLedger(new FakeTimer());
    const first = ledger.admit();
    const second = ledger.admit("SIM-B");
    expect(ledger.inFlightCount(new Set())).toBe(2);
    // A visible device is counted by the listing, not twice by the ledger.
    expect(ledger.inFlightCount(new Set(["SIM-B"]))).toBe(1);
    first.release();
    second.release();
    expect(ledger.inFlightCount(new Set())).toBe(0);
  });

  test("a handed-off admission ends when its device is listed or its window passes", () => {
    const timer = new FakeTimer();
    const ledger = new BootAdmissionLedger(timer);
    ledger.admit().handOff("emulator-5554", 1_000);
    ledger.admit().handOff("emulator-5556", 1_000);
    expect(ledger.inFlightCount(new Set())).toBe(2);

    expect(ledger.inFlightCount(new Set(["emulator-5554"]))).toBe(1);
    // Gone for good: it does not come back if the device later leaves the listing.
    expect(ledger.inFlightCount(new Set())).toBe(1);

    timer.advanceTime(1_000);
    expect(ledger.inFlightCount(new Set())).toBe(0);
  });

  // #11537: a window used to keep only the boots in flight when it opened.
  test("an open sample window keeps every boot that ends inside it, whenever it was admitted", () => {
    const ledger = new BootAdmissionLedger(new FakeTimer());
    const window = ledger.beginSample();
    ledger.admit("SIM-A").release();
    ledger.admit().handOff("emulator-5554", 1_000);
    // Another listing shows the handed-off emulator: it leaves the ledger, not the window.
    expect(ledger.inFlightCount(new Set(["emulator-5554"]))).toBe(0);
    window.close();
    ledger.admit("SIM-C").release(); // ended after the sample returned: not this window's

    expect(ledger.inFlightCount(new Set(), undefined, window)).toBe(2);
    // A boot the sample's own listing shows, or the boot's own target, takes no second slot.
    expect(ledger.inFlightCount(new Set(["SIM-A"]), undefined, window)).toBe(1);
    expect(ledger.inFlightCount(new Set(), "SIM-A", window)).toBe(1);
    expect(ledger.inFlightCount(new Set())).toBe(0);
  });

  // The boot deadline bounds how long an UNLISTED boot is trusted; a listed emulator is running.
  test("a handed-off boot a listing showed outlives its boot deadline in an older open sample", () => {
    const timer = new FakeTimer();
    const ledger = new BootAdmissionLedger(timer);
    ledger.admit().handOff("emulator-5554", 1_000);
    ledger.admit().handOff("emulator-5556", 1_000);
    const window = ledger.beginSample();
    expect(ledger.inFlightCount(new Set(["emulator-5554"]))).toBe(1);
    timer.advanceTime(1_000);
    window.close();

    // 5554 was seen listed; 5556 never was and its deadline passed, as for any unlisted boot.
    expect(ledger.inFlightCount(new Set(), undefined, window)).toBe(1);
    expect(ledger.inFlightCount(new Set(["emulator-5554"]), undefined, window)).toBe(0);
  });

  // #11564: a boot is one of the listed processes only when the listing shows its own pid.
  test("splits in-flight boots by whether the listing shows the process they were handed off with", () => {
    const ledger = new BootAdmissionLedger(new FakeTimer());
    const running = ledger.admit();
    running.handOff("emulator-5554", 1_000, 501);
    const launcherOnly = ledger.admit();
    launcherOnly.handOff("emulator-5556", 1_000, 502);
    ledger.admit().handOff("emulator-5558", 1_000); // no pid known
    ledger.admit(); // never launched
    const window = ledger.beginSample();
    // Both leave the ledger inside the window and keep the pid they had.
    running.release();
    launcherOnly.release();
    window.close();
    const listedProcessIds = new Set([501, 900]);

    expect(ledger.inFlight(new Set(), undefined, window, listedProcessIds)).toEqual({
      count: 4,
      withListedProcess: 1,
      listedWithoutProcess: 0,
    });
    expect(
      ledger.inFlight(new Set(["emulator-5554"]), undefined, window, listedProcessIds),
    ).toEqual({ count: 3, withListedProcess: 0, listedWithoutProcess: 0 });
    // Without listed process ids no boot is matched to a process.
    expect(ledger.inFlight(new Set(), undefined, window)).toEqual({
      count: 4,
      withListedProcess: 0,
      listedWithoutProcess: 0,
    });
  });

  // #11588: the device listing can show a boot the (older) process listing has no process for.
  test("reports listed boots whose own process the process listing does not show", () => {
    const ledger = new BootAdmissionLedger(new FakeTimer());
    ledger.admit().handOff("emulator-5554", 1_000, 501); // listed, process listed
    ledger.admit().handOff("emulator-5556", 1_000, 502); // listed, process not listed
    ledger.admit().handOff("emulator-5558", 1_000); // listed, no pid known
    const endedInWindow = ledger.admit();
    endedInWindow.handOff("emulator-5560", 1_000, 504);
    ledger.admit().handOff("emulator-5562", 1_000, 505); // not listed
    const window = ledger.beginSample();
    endedInWindow.release();
    window.close();
    const listed = new Set(["emulator-5554", "emulator-5556", "emulator-5558", "emulator-5560"]);

    expect(ledger.inFlight(listed, undefined, window, new Set([501, 900]))).toEqual({
      count: 1,
      withListedProcess: 0,
      listedWithoutProcess: 3,
    });
    // The listed entries left the ledger with that count: a later sample starts after their
    // processes did, so its process listing shows them and nothing is added for them.
    expect(ledger.inFlight(listed, undefined, undefined, new Set([900]))).toEqual({
      count: 1,
      withListedProcess: 0,
      listedWithoutProcess: 0,
    });
  });

  test("a repeated hand-off keeps the process id and serial the first one gave", () => {
    const ledger = new BootAdmissionLedger(new FakeTimer());
    const admission = ledger.admit();
    admission.handOff("emulator-5554", 1_000, 501);
    admission.handOff(undefined, 1_000);

    expect(ledger.inFlight(new Set(), undefined, undefined, new Set([501]))).toEqual({
      count: 1,
      withListedProcess: 1,
      listedWithoutProcess: 0,
    });
    expect(ledger.inFlightCount(new Set(["emulator-5554"]))).toBe(0);
    // Gone from the ledger: a late hand-off does not bring it back.
    admission.handOff("emulator-5554", 1_000, 501);
    expect(ledger.inFlightCount(new Set())).toBe(0);
  });
});

describe("CommandAndroidCapacitySource", () => {
  // A real `ps -axo pid=,ppid=,rss=,pcpu=,command=` capture with one emulator running, booted
  // by the daemon in it (see the fixture README).
  const PS = readFileSync(
    join(
      import.meta.dir,
      "../../fixtures/android-boot-admission/ps-snapshot-one-running-emulator.txt",
    ),
    "utf8",
  );
  const QEMU_PID = 67978;
  const DAEMON_PID = 61847;
  const captured = parsePsSnapshot(PS);
  const commandOf = (pid: number): string =>
    captured.rows.find((row) => row.pid === pid)?.command ?? "";

  test("the captured listing parses whole, command lines with spaces included", () => {
    expect(captured.skipped).toBe(0);
    expect(captured.rows.map((row) => row.pid)).toEqual([
      1,
      347,
      383,
      10400,
      DAEMON_PID,
      QEMU_PID,
      68082,
      68734,
    ]);
    // A path with spaces and ` --` arguments is kept verbatim to the end of the line.
    expect(commandOf(10400)).toStartWith(
      "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/",
    );
    expect(commandOf(10400)).toEndWith("--annotation=ver=154.0.8037.93 --handshake-fd=5");
    expect(commandOf(QEMU_PID)).toBe(
      "/Users/dev/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless -avd amslot-039fd12f-0-g1-5e7e5f80 -no-window -port 5554",
    );
  });

  test("identifies the emulator's qemu process and none of its helpers", () => {
    expect(captured.rows.filter(isEmulatorQemuProcess).map((row) => row.pid)).toEqual([QEMU_PID]);
    // The emulator's crashpad handler names the qemu pid, and netsimd is the qemu process's child.
    expect(isEmulatorQemuProcess({ command: commandOf(68082) })).toBe(false);
    expect(isEmulatorQemuProcess({ command: commandOf(68734) })).toBe(false);
    expect(isEmulatorQemuProcess({ command: "/usr/bin/grep qemu-system-aarch64" })).toBe(false);
    expect(isEmulatorQemuProcess({ command: "/sdk/emulator/emulator -avd X" })).toBe(false);
  });

  // #11588: `ps` does not quote, and the executable was taken to end at the first " -".
  test("identifies the qemu process when the SDK path has spaces or a ' -' in it", () => {
    const sdk = "/Users/dev/Library/Android/sdk";
    const under = (directory: string): { command: string } => ({
      command: commandOf(QEMU_PID).replace(sdk, `${directory}/sdk`),
    });

    expect(isEmulatorQemuProcess(under("/Users/dev/My Tools/Android"))).toBe(true);
    expect(isEmulatorQemuProcess(under("/Users/dev/OneDrive - Work/Android"))).toBe(true);
    expect(isEmulatorQemuProcess(under("/opt/android -sdk"))).toBe(true);
    // Launched with no arguments at all: the command line ends at the executable.
    expect(
      isEmulatorQemuProcess({
        command: `${under("/Users/dev/OneDrive - Work/Android").command.split(" -avd")[0]}`,
      }),
    ).toBe(true);
  });

  test("samples adb serials, qemu RSS and host totals", async () => {
    const executor = new FakeHostCommandExecutor();
    executor.setCommandResponse("ps", {
      stdout: PS,
      stderr: "",
      toString: () => PS,
      trim: () => PS.trim(),
      includes: (value: string) => PS.includes(value),
    });
    const source = new CommandAndroidCapacitySource(async () => ["emulator-5554"], executor, {
      totalMemoryBytes: () => 32 * GIB,
      cpuCount: () => 8,
    });

    expect(await source.sample()).toEqual({
      emulatorSerials: ["emulator-5554"],
      emulatorProcessRssBytes: [5947792 * 1024],
      // The qemu process is the launcher the daemon spawned: its parent is the daemon itself.
      emulatorProcessIds: [{ pid: QEMU_PID, ppid: DAEMON_PID }],
      host: { totalMemoryBytes: 32 * GIB, cpuCount: 8 },
      errors: [],
    });
  });

  test("reports unreadable sources as errors instead of an empty fleet", async () => {
    const executor = new FakeHostCommandExecutor();
    executor.executeCommand = async () => {
      throw new Error("ps: command not found");
    };
    const source = new CommandAndroidCapacitySource(
      async () => {
        throw new Error("adb unavailable");
      },
      executor,
      { totalMemoryBytes: () => 16 * GIB, cpuCount: () => 4 },
    );

    const sample = await source.sample();

    expect(sample.emulatorSerials).toEqual([]);
    expect(sample.emulatorProcessRssBytes).toBeUndefined();
    expect(sample.errors).toEqual(["adb: adb unavailable", "ps: ps: command not found"]);
    // #11236: the gate must be able to tell "adb failed" from "no emulators".
    expect(sample.serialListingFailed).toBe(true);
  });
});

describe("shared boot admission gates", () => {
  afterEach(() => {
    testOverrides.bootAdmissionGatesDisabled = true;
  });

  test("builds both gates by default and none when opted out", () => {
    testOverrides.bootAdmissionGatesDisabled = false;
    const timer = new FakeTimer();
    const gates = createBootAdmissionGates({ env: {}, timer, hostPlatform: "darwin" });
    expect(gates.android).toBeDefined();
    expect(gates.ios).toBeDefined();

    const optedOut = createBootAdmissionGates({
      env: { [BOOT_CAPACITY_GATE_ENV]: "0" },
      timer,
      hostPlatform: "darwin",
    });
    expect(optedOut.android).toBeUndefined();
    expect(optedOut.ios).toBeUndefined();
  });

  test("the iOS gate exists only on darwin (#11209)", () => {
    testOverrides.bootAdmissionGatesDisabled = false;
    const timer = new FakeTimer();
    for (const hostPlatform of ["linux", "win32"] as const) {
      const gates = createBootAdmissionGates({ env: {}, timer, hostPlatform });
      expect(gates.android).toBeDefined();
      expect(gates.ios).toBeUndefined();
    }
  });

  test("the unit-test override keeps every gate off", () => {
    testOverrides.bootAdmissionGatesDisabled = true;
    const gates = createBootAdmissionGates({ env: {}, timer: new FakeTimer() });
    expect(gates.android).toBeUndefined();
    expect(gates.ios).toBeUndefined();
  });

  test("describeBootCapacity reports gated platforms and drops a failed one", async () => {
    const android: BootCapacityReporter = {
      describeCapacity: async () => ({ limit: 2, booted: 1, inFlight: 1 }),
    };
    const ios: BootCapacityReporter = {
      describeCapacity: async () => {
        throw new Error("simctl hung");
      },
    };

    expect(
      await describeBootCapacity(["android", "ios"], { android, ios }, new FakeTimer()),
    ).toEqual({
      android: { limit: 2, booted: 1, inFlight: 1 },
    });
    expect(await describeBootCapacity(["ios"], { android, ios }, new FakeTimer())).toBeUndefined();
    expect(await describeBootCapacity(["android"], {}, new FakeTimer())).toBeUndefined();
  });
});
