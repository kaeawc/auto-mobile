import { afterEach, describe, expect, test } from "bun:test";
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
});

describe("CommandAndroidCapacitySource", () => {
  const PS = [
    "  101     1 3145728  80.0 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -netdelay none -avd Pixel_9",
    "  102   101   20480   0.1 /sdk/emulator/crashpad_handler --database=/tmp",
    "  103     1 2097152  40.0 /opt/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64-headless -avd Tablet",
    "  104     1    4096   0.0 /usr/bin/grep qemu-system-aarch64",
    "  105     1    4096   0.0 /bin/zsh",
  ].join("\n");

  test("identifies emulator qemu processes by executable name", () => {
    expect(
      isEmulatorQemuProcess({
        command: "/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd X",
      }),
    ).toBe(true);
    expect(isEmulatorQemuProcess({ command: "/usr/bin/grep qemu-system-aarch64" })).toBe(false);
    expect(isEmulatorQemuProcess({ command: "/sdk/emulator/emulator -avd X" })).toBe(false);
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
      emulatorProcessRssBytes: [3145728 * 1024, 2097152 * 1024],
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
