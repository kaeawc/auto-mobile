import { createExecResult } from "../../../../src/utils/execResult";
import { concreteCtrlProxyClient } from "../../../helpers/concreteCtrlProxyClient";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import {
  FileCtrlProxyForwardLease,
  ctrlProxyOwnedForwardFileName,
} from "../../../../src/features/observe/android/CtrlProxyForwardLease";
import { DefaultForeignCtrlProxyForwardEvidence } from "../../../../src/features/observe/android/foreignCtrlProxyForwardEvidence";
import { setCtrlProxyHostPortProbeForTesting } from "../../../../src/features/observe/android/ctrlProxyHostPortProbe";
import {
  deviceIncarnationToken,
  notifyDeviceIdentityReplaced,
  setDeviceIncarnationResolver,
} from "../../../../src/utils/deviceIncarnation";
import { PortManager } from "../../../../src/utils/PortManager";
import type { BootedDevice } from "../../../../src/models";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createSuccessWebSocketFactory } from "../../../fakes/FakeWebSocket";
import { drainUntil, settleByFakeEvents } from "../../../helpers/fakeTimerStepping";
import { useScratchRoot } from "../../../helpers/scratchRoot";

const device: BootedDevice = { deviceId: "emulator-5556", name: "Pixel", platform: "android" };

describe("Android CtrlProxy singleton incarnation", () => {
  const scratch = useScratchRoot("ctrlproxy-incarnation-");
  let previousDataDir: string | undefined;
  let previousCoordinationDir: string | undefined;
  let token: number | undefined;
  let timer: FakeTimer;
  let clients: AndroidCtrlProxyClient[];
  let forwards: Map<number, string>;
  let unblock: (() => void) | undefined;

  beforeAll(async () => {
    // Warm the file lease's shared cold path, discarding all of its state.
    // Each test still creates its own clients, lease and forward records.
    const dir = scratch.next();
    const previousCoordinationDir = process.env.AUTOMOBILE_COORDINATION_DIR;
    process.env.AUTOMOBILE_COORDINATION_DIR = dir;
    const lease = new FileCtrlProxyForwardLease("warm-up", {
      ownerSocketPath: () => undefined,
      timer: new FakeTimer(),
    });
    try {
      if (!lease.tryAcquire()) {
        throw new Error("Could not acquire isolated warm-up lease");
      }
      lease.recordOwnedForward(12345);
      lease.forgetOwnedForward(12345);
    } finally {
      lease.release();
      if (previousCoordinationDir === undefined) {
        delete process.env.AUTOMOBILE_COORDINATION_DIR;
      } else {
        process.env.AUTOMOBILE_COORDINATION_DIR = previousCoordinationDir;
      }
      rmSync(dir, { recursive: true, force: true });
    }

    // Initialize the shared constructor/close code without connecting or forwarding.
    // No client or manager state from this throwaway instance reaches a scenario.
    const warmup = AndroidCtrlProxyClient.createForTesting(
      { ...device, deviceId: "warm-up" },
      new FakeAdbExecutor(),
      {
        webSocketFactory: () => {
          throw new Error("Constructor warm-up must never connect");
        },
        timer: new FakeTimer(),
      },
    );
    await warmup.close();
  });

  beforeEach(() => {
    previousDataDir = process.env.AUTOMOBILE_DATA_DIR;
    process.env.AUTOMOBILE_DATA_DIR = scratch.next();
    previousCoordinationDir = process.env.AUTOMOBILE_COORDINATION_DIR;
    process.env.AUTOMOBILE_COORDINATION_DIR = process.env.AUTOMOBILE_DATA_DIR;
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    setCtrlProxyHostPortProbeForTesting({ isPortFree: async () => true });
    token = 1;
    setDeviceIncarnationResolver(() => token);
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    clients = [];
    forwards = new Map();
  });

  afterEach(async () => {
    unblock?.();
    unblock = undefined;
    await Promise.all(clients.map((client) => client.close()));
    AndroidCtrlProxyClient.resumeAfterDeviceStart(device.deviceId);
    AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
    expect(AndroidCtrlProxyClient.getForwardLeaseHeldDeviceIds()).toEqual([]);
    setDeviceIncarnationResolver(undefined);
    expect(deviceIncarnationToken(device.deviceId)).toBeUndefined();
    PortManager.reset();
    expect(PortManager.getAllocations().size).toBe(0);
    PortManager.setPortAvailabilityCheckerForTesting(null);
    setCtrlProxyHostPortProbeForTesting(null);
    if (previousCoordinationDir === undefined) {
      delete process.env.AUTOMOBILE_COORDINATION_DIR;
    } else {
      process.env.AUTOMOBILE_COORDINATION_DIR = previousCoordinationDir;
    }
    if (previousDataDir === undefined) {
      delete process.env.AUTOMOBILE_DATA_DIR;
    } else {
      process.env.AUTOMOBILE_DATA_DIR = previousDataDir;
    }
  });

  function adbForForwards(): FakeAdbExecutor {
    const adb = new FakeAdbExecutor();
    const execute = adb.execute.bind(adb);
    adb.execute = async (args, options) => {
      const command = args.join(" ");
      if (command === "forward --list") {
        adb.setCommandResponse(command, createExecResult([...forwards.values()].join("\n"), ""));
      } else if (args[0] === "forward" && args[1] === "--remove") {
        forwards.delete(Number(args[2]?.slice(4)));
      } else if (args[0] === "forward" && args[1]?.startsWith("tcp:")) {
        forwards.set(Number(args[1].slice(4)), `${device.deviceId} ${args[1]} ${args[2]}`);
      }
      return execute(args, options);
    };
    return adb;
  }

  function resolve(adb = adbForForwards()): AndroidCtrlProxyClient {
    const client = concreteCtrlProxyClient(
      AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory(adb)),
    );
    // getInstance is the production memoizing funnel; inject its I/O and clock before connecting.
    Reflect.set(client, "timer", timer);
    Reflect.set(client, "webSocketFactory", createSuccessWebSocketFactory(timer));
    client.forwardClientProbe = { findClientPids: async () => [process.pid] };
    clients.push(client);
    return client;
  }

  async function replaceWhileCleanupPending() {
    // Step only this scenario's probe/deadline waits; the other tests use auto-advance.
    timer = new FakeTimer();
    const oldAdb = adbForForwards();
    const old = resolve(oldAdb);
    const oldPort = PortManager.getPort(device.deviceId)!;
    // Establish the old forward through its public API before gating cleanup.
    await settleByFakeEvents(timer, old.setupPortForwarding(), {
      description: "old incarnation owns its forward before replacement",
    });
    expect(AndroidCtrlProxyClient.getForwardLeaseHeldDeviceIds()).toContain(device.deviceId);
    expect(forwards.has(oldPort)).toBe(true);
    const lease = new FileCtrlProxyForwardLease(device.deviceId);
    expect(lease.ownsForward(oldPort)).toBe(true);
    const gate = new Promise<void>((release) => {
      unblock = release;
    });
    const execute = oldAdb.execute.bind(oldAdb);
    let cleanupEntered = false;
    oldAdb.execute = async (args, options) => {
      if (args.join(" ") === "forward --list") {
        cleanupEntered = true;
        await gate;
      }
      return execute(args, options);
    };
    token = 2;
    const newAdb = adbForForwards();
    const replacement = resolve(newAdb);
    expect(replacement).not.toBe(old);
    expect(replacement.isClosed()).toBe(false);
    expect(old.isClosed()).toBe(true);
    const newPort = PortManager.getPort(device.deviceId)!;
    expect(newPort).not.toBe(oldPort);
    await drainUntil(() => cleanupEntered, { description: "old cleanup blocked on forward list" });
    return { old, replacement, newAdb, newPort, lease };
  }

  test("same serial gets a fresh client and port without a foreign verdict while old cleanup is pending", async () => {
    const { newAdb, lease } = await replaceWhileCleanupPending();
    const evidence = new DefaultForeignCtrlProxyForwardEvidence({
      adbFactory: new FakeAdbClientFactory(newAdb),
      clientProbe: { findClientPids: async () => [process.pid] },
      ownership: () => lease,
      isProcessRunning: () => true,
      timer,
    });
    expect(await evidence.read(device.deviceId)).toEqual({ kind: "none" });
  });

  test("replacement connects without a lease conflict while old incarnation cleanup is pending", async () => {
    const { replacement, newAdb, newPort, lease } = await replaceWhileCleanupPending();
    expect(
      await settleByFakeEvents(timer, replacement.waitForConnection(1, 0), {
        description: "replacement connection while old cleanup is pending",
      }),
    ).toBe(true);
    expect(newAdb.getExecutedCommands()).toContain(`forward tcp:${newPort} tcp:8765`);
    expect(replacement.isLastConnectionFailureForwardingLeaseConflict()).toBe(false);
    expect(AndroidCtrlProxyClient.getForwardLeaseHeldDeviceIds()).toEqual([device.deviceId]);
    expect(lease.ownsForward(newPort)).toBe(true);
  });

  test("old incarnation cleanup preserves the replacement's forward, port and lease", async () => {
    const { old, replacement, newPort, lease } = await replaceWhileCleanupPending();
    await settleByFakeEvents(timer, replacement.setupPortForwarding(), {
      description: "replacement forward while old cleanup is pending",
    });
    expect(forwards.has(newPort)).toBe(true);
    expect(AndroidCtrlProxyClient.getForwardLeaseHeldDeviceIds()).toEqual([device.deviceId]);
    unblock!();
    await old.close();
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBe(replacement);
    expect(PortManager.getPort(device.deviceId)).toBe(newPort);
    expect(forwards.has(newPort)).toBe(true);
    expect(lease.ownsForward(newPort)).toBe(true);
    expect(AndroidCtrlProxyClient.getForwardLeaseHeldDeviceIds()).toEqual([device.deviceId]);
    expect(replacement.isLastConnectionFailureForwardingLeaseConflict()).toBe(false);
  });

  test("unknown tokens do not mismatch; the first known token is adopted", () => {
    token = undefined;
    const first = resolve();
    token = 1;
    expect(resolve()).toBe(first);
    token = undefined;
    expect(resolve()).toBe(first);
    token = 1;
    expect(resolve()).toBe(first);
    token = 2;
    expect(resolve()).not.toBe(first);
  });

  test("removal synchronously evicts and forgets a dead device's owned forward record", async () => {
    const old = resolve();
    await old.setupPortForwarding();
    const port = PortManager.getPort(device.deviceId)!;
    const lease = new FileCtrlProxyForwardLease(device.deviceId);
    const record = join(
      lease.ownershipDirectory(),
      ctrlProxyOwnedForwardFileName(device.deviceId, port),
    );
    expect(existsSync(record)).toBe(true);
    forwards.clear();
    const eviction = AndroidCtrlProxyClient.evictAfterDeviceRemoval(device.deviceId);
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
    expect(old.isClosed()).toBe(true);
    const replacement = resolve();
    expect(replacement).not.toBe(old);
    await eviction;
    expect(existsSync(record)).toBe(false);
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBe(replacement);
  });

  test("identity replacement evicts synchronously, and absent removal is a no-op", async () => {
    await AndroidCtrlProxyClient.evictAfterDeviceRemoval(device.deviceId);
    const old = resolve();
    notifyDeviceIdentityReplaced(device.deviceId);
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
    expect(old.isClosed()).toBe(true);
  });

  test("does not evict a replacement client when concurrent restores finish out of order", async () => {
    const old = resolve();
    let firstDone!: () => void;
    let secondDone!: () => void;
    const first = new Promise<void>((done) => {
      firstDone = done;
    });
    const second = new Promise<void>((done) => {
      secondDone = done;
    });
    const close = old.close.bind(old);
    let calls = 0;
    old.close = async () => {
      await (++calls === 1 ? first : second);
      await close();
    };
    const firstRestore = AndroidCtrlProxyClient.invalidateForDeviceIncarnation(device.deviceId);
    const secondRestore = AndroidCtrlProxyClient.invalidateForDeviceIncarnation(device.deviceId);
    firstDone();
    await firstRestore;
    const replacement = resolve();
    secondDone();
    await secondRestore;
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBe(replacement);
  });

  test("retirement keeps same-serial lookup inert until a new device start", async () => {
    const old = resolve();
    AndroidCtrlProxyClient.retireForShutdown(device.deviceId);
    token = 2;
    expect(resolve()).toBe(old);
    expect(await old.ensureConnected()).toBe(false);
    await old.close();
    AndroidCtrlProxyClient.removeInstance(device.deviceId);
    const duringKill = resolve();
    expect(await duringKill.ensureConnected()).toBe(false);
    AndroidCtrlProxyClient.resumeAfterDeviceStart(device.deviceId);
    expect(resolve()).not.toBe(duringKill);
  });

  test("forward setup failure is reported until a later successful setup", async () => {
    const adb = adbForForwards();
    const client = resolve(adb);
    adb.setCommandError("forward tcp:", new Error("device not found"));
    await expect(client.setupPortForwarding()).rejects.toThrow("device not found");
    expect(client.getForwardFailureCause()).toContain("adb forward");
    Reflect.set(client, "adb", adbForForwards());
    await client.setupPortForwarding();
    expect(client.getForwardFailureCause()).toBeUndefined();
    await client.close();
    expect(client.getForwardFailureCause()).toContain("was closed");
  });
});
