import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AndroidCtrlProxyPortForwarder,
  type AndroidCtrlProxyPortForwarderContext,
} from "../../../../src/features/observe/android/AndroidCtrlProxyPortForwarder";
import type {
  CtrlProxyForwardLease,
  ForwardLeaseReclaimResult,
} from "../../../../src/features/observe/android/CtrlProxyForwardLease";
import type { ForwardClientConnectionProbe } from "../../../../src/features/observe/android/CtrlProxyForwardClientProbe";
import { CtrlProxyForwardingLeaseConflictError } from "../../../../src/features/observe/shared/CtrlProxyForwardingLeaseConflictError";
import { resetForeignCtrlProxyForwardEvidenceForTesting } from "../../../../src/features/observe/android/foreignCtrlProxyForwardEvidence";
import { setCtrlProxyHostPortProbeForTesting } from "../../../../src/features/observe/android/ctrlProxyHostPortProbe";
import type {
  AdbExecutor,
  AdbExecuteOptions,
} from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../../src/models";
import { PortManager } from "../../../../src/utils/PortManager";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { drainUntil } from "../../../helpers/fakeTimerStepping";

/** Stateful scripted ADB fake: all operations stay in memory. */
class FakeForwardAdb implements Pick<AdbExecutor, "execute"> {
  readonly forwards = new Set<number>();
  readonly calls: Array<{ args: string[]; signal?: AbortSignal }> = [];
  readonly forwardErrors = new Map<number, Error>();
  persistAfterRemoval = false;
  onExecute?: (args: string[]) => void;

  constructor(private readonly deviceId: string) {}

  async execute(args: string[], options?: AdbExecuteOptions): Promise<ExecResult> {
    this.calls.push({ args, signal: options?.signal });
    options?.signal?.throwIfAborted();
    this.onExecute?.(args);
    options?.signal?.throwIfAborted();
    let stdout = "";
    if (args[1] === "--list") {
      stdout = [...this.forwards]
        .map((port) => `${this.deviceId} tcp:${port} tcp:${PortManager.DEVICE_PORT}`)
        .join("\n");
    } else if (args[1] === "--remove") {
      if (!this.persistAfterRemoval) {
        this.forwards.delete(Number(args[2].slice(4)));
      }
    } else {
      const port = Number(args[1].slice(4));
      const error = this.forwardErrors.get(port);
      if (error) {
        throw error;
      }
      this.forwards.add(port);
    }
    return {
      stdout,
      stderr: "",
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (value) => stdout.includes(value),
    };
  }

  removedPorts(): number[] {
    return this.calls
      .filter(({ args }) => args[1] === "--remove")
      .map(({ args }) => Number(args[2].slice(4)));
  }

  forwardedPorts(): number[] {
    return this.calls
      .filter(({ args }) => args[1].startsWith("tcp:"))
      .map(({ args }) => Number(args[1].slice(4)));
  }
}

class FakeForwardLease implements CtrlProxyForwardLease {
  readonly records = new Map<number, number>();
  readonly forgotten: number[] = [];
  readonly recorded: number[] = [];
  acquireCalls = 0;
  acquire = true;
  ownerPid: number | undefined;
  reclaim: ForwardLeaseReclaimResult | undefined;

  tryAcquire(): boolean {
    this.acquireCalls++;
    return this.acquire;
  }
  release(): void {}
  getLastOwnerPid(): number | undefined {
    return this.ownerPid;
  }
  async tryReclaimFromStaleOwner(): Promise<ForwardLeaseReclaimResult> {
    return this.reclaim ?? { acquired: false, reason: "owner is still active" };
  }
  ownsForward(port: number): boolean {
    return this.records.has(port);
  }
  recordOwnedForward(port: number): void {
    this.recorded.push(port);
    this.records.set(port, 0);
  }
  forgetOwnedForward(port: number): void {
    this.forgotten.push(port);
    this.records.delete(port);
  }
  recordedForwards(): Array<{ localPort: number; createdAt: number }> {
    return [...this.records].map(([localPort, createdAt]) => ({ localPort, createdAt }));
  }
  ownershipDirectory(): string {
    return "/fake/forward-records";
  }
}

class FakeForwardProbe implements ForwardClientConnectionProbe {
  readonly clients = new Map<number, number[]>();
  readonly calls: Array<{ port: number; signal?: AbortSignal }> = [];
  failure?: Error;
  onProbe?: () => void;

  async findClientPids(port: number, signal?: AbortSignal): Promise<number[]> {
    this.calls.push({ port, signal });
    this.onProbe?.();
    signal?.throwIfAborted();
    if (this.failure) {
      throw this.failure;
    }
    return this.clients.get(port) ?? [];
  }
}

class FakeForwardContext implements AndroidCtrlProxyPortForwarderContext {
  readonly deviceId = "forwarder-device";
  readonly portAllocationId = "forwarder-allocation";
  readonly timer = new FakeTimer();
  readonly ctrlProxyForwardLease = new FakeForwardLease();
  adb = new FakeForwardAdb(this.deviceId);
  forwardClientProbe = new FakeForwardProbe();
  forwardClientProcessIsRunning = (_pid: number): boolean => false;
  closed = false;
  localPort = PortManager.allocate(this.portAllocationId);
  portForwardingSetup = false;
  forwardSetupFailure: string | undefined;
  forwardLeaseForceReleased = false;
  livePorts: ReadonlySet<number> = new Set([this.localPort]);

  constructor() {
    this.timer.setCurrentTime(10_000);
    this.timer.enableAutoAdvance();
    PortManager.setClockForTesting(this.timer);
  }

  getLiveLocalPorts(): ReadonlySet<number> {
    return this.livePorts;
  }
}

describe("AndroidCtrlProxyPortForwarder", () => {
  let context: FakeForwardContext;
  let forwarder: AndroidCtrlProxyPortForwarder;

  beforeEach(() => {
    resetForeignCtrlProxyForwardEvidenceForTesting();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    setCtrlProxyHostPortProbeForTesting({ isPortFree: async () => true });
    context = new FakeForwardContext();
    forwarder = new AndroidCtrlProxyPortForwarder(context);
  });

  afterEach(() => {
    context.timer.reset();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
    setCtrlProxyHostPortProbeForTesting(null);
    resetForeignCtrlProxyForwardEvidenceForTesting();
  });

  test("active forward short-circuits only after acquiring the lease", async () => {
    context.portForwardingSetup = true;
    context.forwardSetupFailure = "previous failure";
    context.adb.forwards.add(context.localPort);
    context.adb.onExecute = () => expect(context.ctrlProxyForwardLease.acquireCalls).toBe(1);

    await forwarder.setupPortForwarding();

    expect(context.adb.calls.map(({ args }) => args)).toEqual([["forward", "--list"]]);
    expect(context.forwardSetupFailure).toBeUndefined();
    expect(context.portForwardingSetup).toBe(true);
  });

  test("lost forward is re-established and recorded after adb succeeds", async () => {
    context.portForwardingSetup = true;
    context.adb.onExecute = (args) => {
      if (args[1].startsWith("tcp:")) {
        expect(context.ctrlProxyForwardLease.recorded).toEqual([]);
      }
    };

    await forwarder.setupPortForwarding();

    expect(context.adb.forwardedPorts()).toEqual([context.localPort]);
    expect(context.ctrlProxyForwardLease.recorded).toEqual([context.localPort]);
    expect(context.portForwardingSetup).toBe(true);
  });

  test("sweep reclaims a recorded orphan and clears its quarantine and record", async () => {
    const orphan = context.localPort + 20;
    context.ctrlProxyForwardLease.records.set(orphan, 0);
    context.adb.forwards.add(orphan);
    PortManager.quarantine(orphan);

    await forwarder.sweepOrphanedCtrlProxyPortForwards();

    expect(context.adb.removedPorts()).toEqual([orphan]);
    expect(context.adb.forwards.has(orphan)).toBe(false);
    expect(context.ctrlProxyForwardLease.records.has(orphan)).toBe(false);
    expect(PortManager.isPortAvailable(orphan)).toBe(true);
    expect(context.forwardClientProbe.calls.map(({ port }) => port)).toEqual([orphan, orphan]);
    expect(context.timer.getSleepHistory()).toEqual([1_000]);
  });

  for (const recorded of [false, true]) {
    test(`sweep refuses a foreign client on a ${recorded ? "recorded" : "unrecorded"} forward`, async () => {
      const orphan = context.localPort + 20;
      context.adb.forwards.add(orphan);
      context.forwardClientProbe.clients.set(orphan, [process.pid, process.pid + 1]);
      if (recorded) {
        context.ctrlProxyForwardLease.records.set(orphan, 0);
      }

      const failure = await forwarder.sweepOrphanedCtrlProxyPortForwards().then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(CtrlProxyForwardingLeaseConflictError);
      if (!(failure instanceof CtrlProxyForwardingLeaseConflictError)) {
        throw new Error("Expected forwarding conflict");
      }
      expect(failure.ownerPid).toBe(process.pid + 1);
      expect(failure.transient).toBe(recorded);
      expect(failure.message).toContain(`tcp:${orphan}`);
      expect(context.ctrlProxyForwardLease.records.has(orphan)).toBe(false);
      expect(context.adb.removedPorts()).toEqual([]);
    });
  }

  test("unrecorded forward with no clients is reclaimed without first recording ownership", async () => {
    const orphan = context.localPort + 20;
    context.adb.forwards.add(orphan);
    context.adb.onExecute = (args) => {
      if (args[1] === "--remove") {
        expect(context.ctrlProxyForwardLease.ownsForward(orphan)).toBe(false);
      }
    };

    await forwarder.sweepOrphanedCtrlProxyPortForwards();

    expect(context.adb.removedPorts()).toEqual([orphan]);
    expect(context.ctrlProxyForwardLease.recorded).toEqual([]);
    expect(context.adb.forwards.size).toBe(0);
  });

  test("failed client probe refuses to reclaim an unrecorded forward", async () => {
    context.adb.forwards.add(context.localPort + 20);
    context.forwardClientProbe.failure = new Error("host connections unavailable");

    await expect(forwarder.sweepOrphanedCtrlProxyPortForwards()).rejects.toThrow(
      "host connections unavailable",
    );

    expect(context.adb.removedPorts()).toEqual([]);
    expect(context.ctrlProxyForwardLease.recorded).toEqual([]);
  });

  test("removal confirmation backs off for two seconds then quarantines a persistent forward", async () => {
    context.adb.forwards.add(context.localPort);
    context.ctrlProxyForwardLease.records.set(context.localPort, 0);
    context.adb.persistAfterRemoval = true;
    const startedAt = context.timer.now();

    expect(await forwarder.removeCtrlProxyPortForward(context.localPort)).toBe(false);

    expect(context.adb.removedPorts()).toEqual([context.localPort]);
    expect(context.timer.now() - startedAt).toBe(2_000);
    expect(context.timer.getSleepHistory()).toEqual([100, 200, 400, 800, 500]);
    expect(PortManager.isPortAvailable(context.localPort)).toBe(false);
    expect(context.ctrlProxyForwardLease.ownsForward(context.localPort)).toBe(true);
  });

  test("force-released lease leaves the forward and successor's record in place", async () => {
    context.adb.forwards.add(context.localPort);
    context.ctrlProxyForwardLease.records.set(context.localPort, 0);
    context.forwardLeaseForceReleased = true;

    expect(await forwarder.removeCtrlProxyPortForward(context.localPort)).toBe(false);

    expect(context.adb.removedPorts()).toEqual([]);
    expect(context.ctrlProxyForwardLease.forgotten).toEqual([]);
    expect(context.adb.forwards.has(context.localPort)).toBe(true);
  });

  test("address-in-use retry moves to the next free port and records the new port", async () => {
    const originalPort = context.localPort;
    context.adb.forwardErrors.set(
      originalPort,
      new Error("cannot bind listener: Address already in use"),
    );

    await forwarder.setupPortForwarding();

    expect(context.localPort).not.toBe(originalPort);
    expect(context.adb.forwardedPorts()).toEqual([originalPort, context.localPort]);
    expect(context.ctrlProxyForwardLease.recorded).toEqual([context.localPort]);
    expect(PortManager.getPort(context.portAllocationId)).toBe(context.localPort);
    expect(context.portForwardingSetup).toBe(true);
  });

  test("closed client short-circuits without acquiring a lease or running adb", async () => {
    context.closed = true;

    await forwarder.setupPortForwarding();
    await forwarder.ensureLocalPortAvailableForForwarding();

    expect(context.ctrlProxyForwardLease.acquireCalls).toBe(0);
    expect(context.adb.calls).toEqual([]);
  });

  test("close after port validation prevents forwarding", async () => {
    PortManager.setPortAvailabilityCheckerForTesting({
      isPortAvailable: () => {
        context.closed = true;
        return true;
      },
    });

    await forwarder.setupPortForwarding();

    expect(context.adb.forwardedPorts()).toEqual([]);
    expect(context.portForwardingSetup).toBe(false);
  });

  test("close during forward setup removes the newly recorded forward", async () => {
    context.adb.onExecute = (args) => {
      if (args[1].startsWith("tcp:")) {
        context.closed = true;
      }
    };

    await forwarder.setupPortForwarding();

    expect(context.ctrlProxyForwardLease.recorded).toEqual([context.localPort]);
    expect(context.adb.removedPorts()).toEqual([context.localPort]);
    expect(context.ctrlProxyForwardLease.records.size).toBe(0);
    expect(context.portForwardingSetup).toBe(false);
  });

  test("abort during orphan probing rethrows the abort and threads the signal", async () => {
    const controller = new AbortController();
    const aborted = new Error("caller cancelled during probe");
    context.adb.forwards.add(context.localPort + 20);
    context.forwardClientProbe.onProbe = () => controller.abort(aborted);

    await expect(forwarder.setupPortForwarding(undefined, controller.signal)).rejects.toBe(aborted);

    expect(context.adb.calls.every(({ signal }) => signal === controller.signal)).toBe(true);
    expect(context.forwardClientProbe.calls[0].signal).toBe(controller.signal);
    expect(context.adb.removedPorts()).toEqual([]);
    expect(context.forwardSetupFailure).toContain(aborted.message);
  });

  test("abort while waiting for a busy port prevents forwarding", async () => {
    const controller = new AbortController();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => false });
    const pending = forwarder.setupPortForwarding(undefined, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await drainUntil(() => context.timer.getSleepCallCount() > 0, {
      description: "busy-port wait",
    });
    controller.abort();
    await rejected;

    expect(context.adb.forwardedPorts()).toEqual([]);
    expect(context.portForwardingSetup).toBe(false);
  });

  test("adb, probe, liveness and live-port replacements are read after construction", async () => {
    const orphan = context.localPort + 20;
    const originalAdb = context.adb;
    const originalProbe = context.forwardClientProbe;
    context.adb = new FakeForwardAdb(context.deviceId);
    context.forwardClientProbe = new FakeForwardProbe();
    context.adb.forwards.add(orphan);
    context.forwardClientProbe.clients.set(orphan, [process.pid + 1]);
    context.forwardClientProcessIsRunning = () => true;
    await expect(forwarder.sweepOrphanedCtrlProxyPortForwards()).rejects.toBeInstanceOf(
      CtrlProxyForwardingLeaseConflictError,
    );
    context.forwardClientProbe = new FakeForwardProbe();
    await expect(forwarder.sweepOrphanedCtrlProxyPortForwards()).rejects.toThrow(
      "was seen connected to it and is still running",
    );
    context.forwardClientProcessIsRunning = () => false;
    await forwarder.sweepOrphanedCtrlProxyPortForwards();
    expect(originalAdb.calls).toEqual([]);
    expect(originalProbe.calls).toEqual([]);

    context.adb.forwards.add(orphan);
    context.ctrlProxyForwardLease.records.set(orphan, 0);
    context.livePorts = new Set([orphan]);
    const removals = context.adb.removedPorts().length;
    await forwarder.sweepOrphanedCtrlProxyPortForwards();
    expect(context.adb.removedPorts()).toHaveLength(removals);
    context.livePorts = new Set();
    await forwarder.sweepOrphanedCtrlProxyPortForwards();
    expect(context.adb.removedPorts()).toHaveLength(removals + 1);
  });

  test("lease conflict is checked before an already-active forward", async () => {
    context.portForwardingSetup = true;
    context.ctrlProxyForwardLease.acquire = false;
    context.ctrlProxyForwardLease.ownerPid = process.pid + 1;
    context.ctrlProxyForwardLease.reclaim = {
      acquired: false,
      ownerPid: process.pid + 1,
      ownerSocketPath: "/fake/owner.sock",
      transient: true,
      reason: "a live session is using the device",
    };

    await expect(forwarder.setupPortForwarding()).rejects.toBeInstanceOf(
      CtrlProxyForwardingLeaseConflictError,
    );

    expect(context.adb.calls).toEqual([]);
  });
});
