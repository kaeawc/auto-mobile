import { beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "child_process";
import {
  DefaultEmulatorPortReservations,
  resetEmulatorLaunchReservations,
  type EmulatorDeviceIdSnapshot,
} from "../../../src/utils/android-cmdline-tools/EmulatorPortReservations";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakePortAvailabilityChecker } from "../../fakes/FakePortAvailabilityChecker";
import { FakeTimer } from "../../fakes/FakeTimer";

const fakeChild = (exitCode: number | null = null): ChildProcess =>
  ({ exitCode, signalCode: null }) as unknown as ChildProcess;

const completeSnapshot = (...deviceIds: string[]): EmulatorDeviceIdSnapshot => ({
  deviceIds: new Set(deviceIds),
  isComplete: true,
});

describe("DefaultEmulatorPortReservations", () => {
  let timer: FakeTimer;
  let hostPorts: FakePortAvailabilityChecker;
  let reservations: DefaultEmulatorPortReservations;

  beforeEach(() => {
    resetEmulatorLaunchReservations();
    timer = new FakeTimer();
    hostPorts = new FakePortAvailabilityChecker();
    reservations = new DefaultEmulatorPortReservations({
      timer: () => timer,
      adbFactory: () => new FakeAdbClientFactory(),
      hostPortAvailabilityChecker: () => hostPorts,
    });
  });

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
