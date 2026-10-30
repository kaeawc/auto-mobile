import { beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeEmulatorGrpcPortRegistry } from "../../fakes/FakeEmulatorGrpcPortRegistry";
import {
  FileEmulatorGrpcPortRegistry,
  type EmulatorGrpcPortRegistry,
} from "../../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorGrpcPortRegistry";
import { FakeLockFileSystem } from "../../fakes/FakeLockFileSystem";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { parseLockContent } from "../../../src/utils/fileLock";
import { logger } from "../../../src/utils/logger";

function reservationsWithHostPorts(
  hostPorts: FakePortAvailabilityChecker,
  registry: EmulatorGrpcPortRegistry = new FakeEmulatorGrpcPortRegistry(),
) {
  const deps = {
    timer: () => new FakeTimer(),
    adbFactory: () => new FakeAdbClientFactory(),
    hostPortAvailabilityChecker: () => hostPorts,
    grpcPortRegistry: registry,
  };
  return new DefaultEmulatorPortReservations(deps);
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

  test("separate daemon views share claims even while neither emulator has bound", async () => {
    const store = new FakeEmulatorGrpcPortRegistry();
    const first = await reservationsWithHostPorts(
      new FakePortAvailabilityChecker(),
      store.view(),
    ).reserveEmulatorGrpcPort();
    // Simulate another daemon's independent module state during the boot window.
    resetEmulatorLaunchReservations();
    const second = await reservationsWithHostPorts(
      new FakePortAvailabilityChecker(),
      store.view(),
    ).reserveEmulatorGrpcPort();
    expect([first.port, second.port]).toEqual([8554, 8555]);
  });

  test("checks host availability after claiming and releases a bind-busy claim", async () => {
    const registry = new FakeEmulatorGrpcPortRegistry();
    const lease = await reservationsWithHostPorts(
      new FakePortAvailabilityChecker(new Set([8554])),
      registry,
    ).reserveEmulatorGrpcPort();
    expect(registry.claims).toEqual([8554, 8555]);
    expect(lease.port).toBe(8555);
    expect(registry.view().claim(8554)?.port).toBe(8554);
  });

  test("skips a registry I/O failure and continues scanning", async () => {
    const registry = new FakeEmulatorGrpcPortRegistry();
    const error = new Error("read-only lease file");
    registry.failures.set(8554, error);
    const warn = spyOn(logger, "warn");
    try {
      const lease = await reservationsWithHostPorts(
        new FakePortAvailabilityChecker(),
        registry,
      ).reserveEmulatorGrpcPort();
      expect(lease.port).toBe(8555);
      expect(warn).toHaveBeenCalledWith("Could not claim emulator gRPC port 8554", error);
    } finally {
      warn.mockRestore();
    }
  });

  test("registry exhaustion throws a typed actionable error without probing held ports", async () => {
    const registry = new FakeEmulatorGrpcPortRegistry();
    for (let port = EMULATOR_GRPC_PORT_FIRST; port <= EMULATOR_GRPC_PORT_LAST; port++) {
      registry.claim(port);
    }
    const checker = new FakePortAvailabilityChecker();
    await expect(
      reservationsWithHostPorts(checker, registry).reserveEmulatorGrpcPort(),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(checker.checkedPorts).toEqual([]);
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

  test("reset releases a tracked lease even when its child never exits", async () => {
    const registry = new FakeEmulatorGrpcPortRegistry();
    const reservations = reservationsWithHostPorts(new FakePortAvailabilityChecker(), registry);
    const lease = await reservations.reserveEmulatorGrpcPort();
    expect(lease.port).toBe(8554);
    reservations.trackEmulatorGrpcLease(new FakeChildProcess(), lease);

    resetEmulatorLaunchReservations();

    const fresh = reservationsWithHostPorts(new FakePortAvailabilityChecker(), registry);
    expect((await fresh.reserveEmulatorGrpcPort()).port).toBe(8554);
    expect(registry.releasedPorts).toEqual([8554]);
    resetEmulatorLaunchReservations();
    expect(registry.releasedPorts).toEqual([8554]);
  });

  test("fails with an actionable error when every candidate port is taken", async () => {
    const taken = new Set<number>();
    for (let port = EMULATOR_GRPC_PORT_FIRST; port <= EMULATOR_GRPC_PORT_LAST; port += 1) {
      taken.add(port);
    }
    await expect(
      reservationsWithHostPorts(new FakePortAvailabilityChecker(taken)).reserveEmulatorGrpcPort(),
    ).rejects.toThrow(`gRPC ports ${EMULATOR_GRPC_PORT_FIRST}-${EMULATOR_GRPC_PORT_LAST}`);
    await expect(
      reservationsWithHostPorts(new FakePortAvailabilityChecker(taken)).reserveEmulatorGrpcPort(),
    ).rejects.toBeInstanceOf(ActionableError);
  });
});

describe("FileEmulatorGrpcPortRegistry", () => {
  function harness() {
    const timer = new FakeTimer();
    const files = new FakeLockFileSystem(() => timer.now());
    const alive = new Set([101, 102, process.pid]);
    const ids = new FakeIdGenerator();
    const directory = "/shared-adb/emulator-grpc";
    const view = () =>
      new FileEmulatorGrpcPortRegistry({
        directory: () => directory,
        ensureDirectory: (path) => files.mkdir(path),
        fileSystem: files.view(),
        isProcessRunning: (pid) => alive.has(pid),
        idGenerator: ids,
        now: () => timer.now(),
      });
    return { files, alive, directory, view };
  }

  test("reset releases every tracked file-backed lock without child exit", async () => {
    const { files, directory, view } = harness();
    const reservations = reservationsWithHostPorts(new FakePortAvailabilityChecker(), view());
    for (const port of [8554, 8555]) {
      const lease = await reservations.reserveEmulatorGrpcPort();
      expect(lease.port).toBe(port);
      reservations.trackEmulatorGrpcLease(new FakeChildProcess(), lease);
      expect(files.exists(`${directory}/${port}.lock`)).toBe(true);
    }

    resetEmulatorLaunchReservations();

    expect(files.exists(`${directory}/8554.lock`)).toBe(false);
    expect(files.exists(`${directory}/8555.lock`)).toBe(false);
    const fresh = reservationsWithHostPorts(new FakePortAvailabilityChecker(), view());
    expect((await fresh.reserveEmulatorGrpcPort()).port).toBe(8554);
  });

  test("reservation instances sharing a directory get consecutive ports across module resets", async () => {
    const { view } = harness();
    const first = await reservationsWithHostPorts(
      new FakePortAvailabilityChecker(),
      view(),
    ).reserveEmulatorGrpcPort();
    resetEmulatorLaunchReservations();
    const second = await reservationsWithHostPorts(
      new FakePortAvailabilityChecker(),
      view(),
    ).reserveEmulatorGrpcPort();
    expect([first.port, second.port]).toEqual([8554, 8555]);
  });

  test("records the owner PID and launch time using the existing lock format", () => {
    const { files, directory, view } = harness();
    expect(view().claim(8554, { pid: 101, launchedAt: 1234 })?.port).toBe(8554);
    const owner = parseLockContent(files.readText(`${directory}/8554.lock`));
    expect(owner.pid).toBe(101);
    expect(owner.metadata).toBe("1234");
    expect(owner.token).toBeDefined();
  });

  test("reclaims a dead owner's lease and an old release cannot remove its replacement", () => {
    const { alive, view } = harness();
    const first = view().claim(8554, { pid: 101, launchedAt: 10 });
    expect(first).toBeDefined();
    expect(view().claim(8554, { pid: 102, launchedAt: 20 })).toBeUndefined();
    alive.delete(101);
    const second = view().claim(8554, { pid: 102, launchedAt: 30 });
    expect(second?.port).toBe(8554);
    first?.release();
    expect(view().claim(8554, { pid: 102, launchedAt: 40 })).toBeUndefined();
  });

  test("release is idempotent and allows the next claim even for the same PID", () => {
    const { view } = harness();
    const registry = view();
    const owner = { pid: 101, launchedAt: 10 };
    const first = registry.claim(8554, owner);
    expect(first).toBeDefined();
    first?.release();
    const second = view().claim(8554, owner);
    expect(second?.port).toBe(8554);
    first?.release();
    expect(registry.claim(8554, owner)).toBeUndefined();
    second?.release();
    expect(registry.claim(8554, owner)?.port).toBe(8554);
  });

  test("directory errors skip each candidate and end in the typed exhaustion error", async () => {
    const error = new Error("EACCES: lease directory");
    const registry = new FileEmulatorGrpcPortRegistry({
      directory: () => "/unwritable",
      ensureDirectory: () => {
        throw error;
      },
    });
    const checker = new FakePortAvailabilityChecker();
    await expect(
      reservationsWithHostPorts(checker, registry).reserveEmulatorGrpcPort(),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(checker.checkedPorts).toEqual([]);
  });

  test("an unreadable lease is skipped with a warning containing the underlying I/O error", async () => {
    const { files, directory, view } = harness();
    view().claim(8554, { pid: 101, launchedAt: 10 });
    files.failure = (op, path) =>
      op === "readText" && path === `${directory}/8554.lock` ? "EACCES" : undefined;
    const warn = spyOn(logger, "warn");
    try {
      const lease = await reservationsWithHostPorts(
        new FakePortAvailabilityChecker(),
        view(),
      ).reserveEmulatorGrpcPort();
      expect(lease.port).toBe(8555);
      expect(warn).toHaveBeenCalledWith(
        "Could not claim emulator gRPC port 8554",
        expect.objectContaining({ code: "EACCES" }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
