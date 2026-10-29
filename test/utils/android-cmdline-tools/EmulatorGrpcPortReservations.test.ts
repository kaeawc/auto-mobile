import { beforeEach, describe, expect, test } from "bun:test";
import {
  DefaultEmulatorPortReservations,
  resetEmulatorLaunchReservations,
} from "../../../src/utils/android-cmdline-tools/EmulatorPortReservations";
import {
  EMULATOR_GRPC_PORT_FIRST,
  EMULATOR_GRPC_PORT_LAST,
} from "../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcPorts";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakePortAvailabilityChecker } from "../../fakes/FakePortAvailabilityChecker";
import { FakeTimer } from "../../fakes/FakeTimer";

function reservationsWithHostPorts(hostPorts: FakePortAvailabilityChecker) {
  return new DefaultEmulatorPortReservations({
    timer: () => new FakeTimer(),
    adbFactory: () => new FakeAdbClientFactory(),
    hostPortAvailabilityChecker: () => hostPorts,
  });
}

describe("DefaultEmulatorPortReservations.reserveEmulatorGrpcPort", () => {
  beforeEach(() => {
    resetEmulatorLaunchReservations();
  });

  test("leases the emulator's default gRPC port when the host has it free", async () => {
    const lease = await reservationsWithHostPorts(
      new FakePortAvailabilityChecker(),
    ).reserveEmulatorGrpcPort();
    expect(lease.port).toBe(EMULATOR_GRPC_PORT_FIRST);
  });

  test("skips a port another process holds on the host", async () => {
    const reservations = reservationsWithHostPorts(
      new FakePortAvailabilityChecker(new Set([EMULATOR_GRPC_PORT_FIRST])),
    );
    const lease = await reservations.reserveEmulatorGrpcPort();
    expect(lease.port).toBe(EMULATOR_GRPC_PORT_FIRST + 1);
  });

  test("never hands the same port to two live launches, and frees it on release", async () => {
    const reservations = reservationsWithHostPorts(new FakePortAvailabilityChecker());
    const first = await reservations.reserveEmulatorGrpcPort();
    const second = await reservations.reserveEmulatorGrpcPort();
    expect(second.port).not.toBe(first.port);

    first.release();
    first.release();
    const third = await reservations.reserveEmulatorGrpcPort();
    expect(third.port).toBe(first.port);
  });

  test("a tracked lease is released when its emulator child is released on exit", async () => {
    const reservations = reservationsWithHostPorts(new FakePortAvailabilityChecker());
    const child = new FakeChildProcess();
    const lease = await reservations.reserveEmulatorGrpcPort();
    reservations.trackEmulatorGrpcLease(child, lease);
    expect((await reservations.reserveEmulatorGrpcPort()).port).toBe(EMULATOR_GRPC_PORT_FIRST + 1);

    reservations.releaseLaunchChild(child);
    expect((await reservations.reserveEmulatorGrpcPort()).port).toBe(EMULATOR_GRPC_PORT_FIRST);
  });

  test("fails with an actionable error when every candidate port is taken", async () => {
    const taken = new Set<number>();
    for (let port = EMULATOR_GRPC_PORT_FIRST; port <= EMULATOR_GRPC_PORT_LAST; port += 1) {
      taken.add(port);
    }
    await expect(
      reservationsWithHostPorts(new FakePortAvailabilityChecker(taken)).reserveEmulatorGrpcPort(),
    ).rejects.toThrow(`gRPC ports ${EMULATOR_GRPC_PORT_FIRST}-${EMULATOR_GRPC_PORT_LAST}`);
  });
});
