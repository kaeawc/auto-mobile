import { beforeEach, describe, expect, test } from "bun:test";
import {
  DefaultEmulatorPortReservations,
  resolveExcludedEmulatorConsolePorts,
  resetEmulatorLaunchReservations,
  type EmulatorDeviceIdSnapshot,
} from "../../../src/utils/android-cmdline-tools/EmulatorPortReservations";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakePortAvailabilityChecker } from "../../fakes/FakePortAvailabilityChecker";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { EmulatorConsolePortExcludedError } from "../../../src/utils/android-cmdline-tools/EmulatorConsolePortExcludedError";

const fakeChild = (exitCode: number | null = null): FakeChildProcess => {
  const child = new FakeChildProcess();
  child.exitCode = exitCode;
  return child;
};

const completeSnapshot = (...deviceIds: string[]): EmulatorDeviceIdSnapshot => ({
  deviceIds: new Set(deviceIds),
  isComplete: true,
});

describe("DefaultEmulatorPortReservations", () => {
  let timer: FakeTimer;
  let hostPorts: FakePortAvailabilityChecker;
  let reservations: DefaultEmulatorPortReservations;
  let excludedPorts: Set<number>;

  beforeEach(() => {
    resetEmulatorLaunchReservations();
    timer = new FakeTimer();
    hostPorts = new FakePortAvailabilityChecker();
    excludedPorts = new Set();
    reservations = new DefaultEmulatorPortReservations({
      timer: () => timer,
      adbFactory: () => new FakeAdbClientFactory(),
      hostPortAvailabilityChecker: () => hostPorts,
      excludedConsolePorts: () => new Set(excludedPorts),
    });
  });

  test("skips excluded console ports without probing their port pair", async () => {
    excludedPorts.add(5554);
    const args: string[] = [];
    const reservation = await reservations.addReservedEmulatorPort(args, "A", completeSnapshot());
    expect(reservation?.deviceId).toBe("emulator-5556");
    expect(args).toEqual(["-port", "5556"]);
    expect(hostPorts.checkedPorts).toEqual([5556, 5557]);
  });

  test.each([
    { args: ["-port", "5554"], expectedDeviceId: undefined },
    { args: ["-ports", "5554,6000"], expectedDeviceId: undefined },
    { args: ["-port=5554"], expectedDeviceId: undefined },
    { args: ["-ports=5554,6000"], expectedDeviceId: undefined },
    { args: [], expectedDeviceId: "emulator-5554" },
  ])(
    "rejects excluded explicit ports before host probes: %j",
    async ({ args, expectedDeviceId }) => {
      excludedPorts.add(5554);
      const launch = reservations.addReservedEmulatorPort(
        [...args],
        "A",
        undefined,
        expectedDeviceId,
      );
      await expect(launch).rejects.toBeInstanceOf(EmulatorConsolePortExcludedError);
      await expect(launch).rejects.toMatchObject({
        code: "emulator_console_port_excluded",
        consolePort: 5554,
        message: expect.stringContaining("AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS"),
      });
      expect(hostPorts.checkedPorts).toEqual([]);
    },
  );

  test("reports excluded ports when no console port can be allocated", async () => {
    for (let port = 5554; port <= 5682; port += 2) {
      excludedPorts.add(port);
    }
    await expect(reservations.addReservedEmulatorPort([], "A", completeSnapshot())).rejects.toThrow(
      /all console ports.*excluded.*5554.*5682.*AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS/,
    );
    expect(hostPorts.checkedPorts).toEqual([]);
  });

  test("resolves exclusions lazily for each allocation and assertion", async () => {
    await reservations.addReservedEmulatorPort([], "A", completeSnapshot());
    excludedPorts.add(5556);
    const next = await reservations.addReservedEmulatorPort([], "B", completeSnapshot());
    expect(next?.deviceId).toBe("emulator-5558");
    await expect(
      reservations.addReservedEmulatorPort(["-port", "5556"], "C", undefined),
    ).rejects.toMatchObject({ code: "emulator_console_port_excluded", consolePort: 5556 });
  });

  test.each([{ args: [] }, { args: ["-port", "5556"] }])(
    "invalid configuration fails at launch resolution rather than construction: %j",
    async ({ args }) => {
      const configured = new DefaultEmulatorPortReservations({
        timer: () => timer,
        adbFactory: () => new FakeAdbClientFactory(),
        hostPortAvailabilityChecker: () => hostPorts,
        excludedConsolePorts: () =>
          resolveExcludedEmulatorConsolePorts({
            AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS: "bad-entry",
          }),
      });
      await expect(
        configured.addReservedEmulatorPort([...args], "A", completeSnapshot()),
      ).rejects.toThrow("AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS has invalid entry 'bad-entry'");
      expect(hostPorts.checkedPorts).toEqual([]);
    },
  );

  test.each([undefined, { deviceIds: new Set<string>(), isComplete: false }])(
    "refuses unpinned launches with exclusions when the device snapshot is incomplete: %j",
    async (snapshot) => {
      excludedPorts.add(5554);
      await expect(reservations.addReservedEmulatorPort([], "A", snapshot)).rejects.toThrow(
        "AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS",
      );
      expect(hostPorts.checkedPorts).toEqual([]);
    },
  );

  test("allocates the first free console port and appends it to the launch arguments", async () => {
    const args: string[] = [];

    const reservation = await reservations.addReservedEmulatorPort(
      args,
      "Pixel_9",
      completeSnapshot(),
    );

    expect(reservation?.deviceId).toBe("emulator-5554");
    expect(args).toEqual(["-port", "5554"]);
  });

  test("skips ports seen on attached devices, held by other launches, or taken on the host", async () => {
    hostPorts = new FakePortAvailabilityChecker(new Set([5558]));
    reservations = new DefaultEmulatorPortReservations({
      timer: () => timer,
      adbFactory: () => new FakeAdbClientFactory(),
      hostPortAvailabilityChecker: () => hostPorts,
    });
    const snapshot = completeSnapshot("emulator-5554");

    const first = await reservations.addReservedEmulatorPort([], "A", snapshot);
    const second = await reservations.addReservedEmulatorPort([], "B", snapshot);
    const third = await reservations.addReservedEmulatorPort([], "C", snapshot);

    expect([first?.deviceId, second?.deviceId, third?.deviceId]).toEqual([
      "emulator-5556",
      "emulator-5560",
      "emulator-5562",
    ]);
  });

  test("rejects an explicitly configured port that another launch already reserved", async () => {
    await reservations.addReservedEmulatorPort(["-port", "5560"], "A", undefined);

    await expect(
      reservations.addReservedEmulatorPort(["-port", "5560"], "B", undefined),
    ).rejects.toThrow("console port 5560 is already in use");
  });

  test("a released launch keeps its port unavailable until the terminal TTL expires", async () => {
    const snapshot = completeSnapshot();
    const reservation = await reservations.addReservedEmulatorPort([], "A", snapshot);
    const child = fakeChild();
    reservations.recordReservedEmulatorDeviceId(child, reservation!);
    expect(reservations.findLiveReservationAwaitingAdb("A", [])).toBe("emulator-5554");

    reservations.releaseLaunchChild(child);
    const whileTerminal = await reservations.addReservedEmulatorPort([], "B", snapshot);
    expect(whileTerminal?.deviceId).toBe("emulator-5556");

    timer.advanceTime(30_001);
    const afterTtl = await reservations.addReservedEmulatorPort([], "C", snapshot);
    expect(afterTtl?.deviceId).toBe("emulator-5554");
  });

  test("only a live reservation-less child counts as an AVD coming up", () => {
    const live = fakeChild();
    const exited = fakeChild(1);
    reservations.trackUnreservedLaunch(live, "Live");
    reservations.trackUnreservedLaunch(exited, "Gone");

    expect(reservations.hasLiveUnreservedLaunch("Live")).toBe(true);
    expect(reservations.hasLiveUnreservedLaunch("Gone")).toBe(false);
    reservations.releaseLaunchChild(live);
    expect(reservations.hasLiveUnreservedLaunch("Live")).toBe(false);
  });

  test("the in-flight claim is shared by every reservations instance in the process", () => {
    const other = new DefaultEmulatorPortReservations({
      timer: () => timer,
      adbFactory: () => new FakeAdbClientFactory(),
      hostPortAvailabilityChecker: () => hostPorts,
    });

    reservations.claimInFlightLaunch("Pixel_9");
    expect(other.hasInFlightLaunch("Pixel_9")).toBe(true);
    other.releaseInFlightLaunch("Pixel_9");
    expect(reservations.hasInFlightLaunch("Pixel_9")).toBe(false);
  });
});
