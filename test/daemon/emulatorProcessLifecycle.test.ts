import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  EmulatorProcessLifecycle,
  EmulatorProcessOutputTail,
  type EmulatorProcessLifecyclePoolPort,
} from "../../src/daemon/emulatorProcessLifecycle";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

const deviceId = "emulator-5554";
const booted = { deviceId, name: "Pixel", platform: "android" as const };

async function flushUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Condition did not settle within 100 microtasks");
}

function child(): ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null } {
  const process = new EventEmitter() as ChildProcess & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  process.exitCode = null;
  process.signalCode = null;
  process.stdout = null;
  process.stderr = null;
  process.kill = () => true;
  return process;
}

function pooled(): PooledDevice {
  return {
    id: deviceId,
    name: "Pixel",
    platform: "android",
    status: "idle",
    sessionId: null,
    lastUsedAt: 0,
    assignmentCount: 0,
    errorCount: 0,
    incarnation: 1,
  };
}

function harness() {
  const timer = new FakeTimer();
  const processes = new Map<string, ChildProcess>();
  const outputs = new Map<string, EmulatorProcessOutputTail>();
  const devices = new Map<string, PooledDevice>();
  const calls: string[] = [];
  const settlements: Array<[string | undefined, "not-attempted" | "exhausted"]> = [];
  let reserved = false;
  let onRecord: (() => void) | undefined;
  let evictionError: Error | undefined;
  const port: EmulatorProcessLifecyclePoolPort = {
    getTimer: () => timer,
    getStartedDeviceProcesses: () => processes,
    getStartedDeviceProcessOutput: () => outputs,
    getDevices: () => devices,
    getSessionManager: () => ({ getSession: () => null }) as unknown as SessionManager,
    isReservedForShutdown: () => reserved,
    prepareSessionPreservingRecovery: () => {
      calls.push("prepare");
      return undefined;
    },
    finishSessionPreservingRecoveryPreparation: () => {
      calls.push("finish");
    },
    recordEmulatorLossIncident: async () => {
      calls.push("record");
      onRecord?.();
      return "incident";
    },
    finishEmulatorLossIncident: async (incidentId, outcome) => {
      calls.push("settle");
      settlements.push([incidentId, outcome]);
    },
    evictMissingPooledDevice: async (_device, reason) => {
      expect(reason).toBe("emulator process exited after startup (code=1, signal=null)");
      calls.push("evict");
      if (evictionError) {
        throw evictionError;
      }
    },
  };
  return {
    lifecycle: new EmulatorProcessLifecycle(port),
    timer,
    processes,
    outputs,
    devices,
    calls,
    settlements,
    throwOnEviction: (error: Error) => {
      evictionError = error;
    },
    reserve: () => {
      reserved = true;
    },
    onRecord: (callback: () => void) => {
      onRecord = callback;
    },
  };
}

describe("EmulatorProcessLifecycle", () => {
  test("tracks a process and evicts the current device after exit", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());
    const process = child();
    await h.lifecycle.trackStartedDeviceProcess(booted, process);
    expect(h.lifecycle.hasStartedDeviceProcess(deviceId, process)).toBe(true);
    expect(h.outputs.has(deviceId)).toBe(true);
    process.emit("exit", 1, null);
    await flushUntil(() => h.calls.includes("finish"));
    expect(h.calls).toEqual(["prepare", "record", "evict", "finish"]);
  });

  test("does not evict an explicit shutdown", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());
    h.reserve();
    const process = child();
    await h.lifecycle.trackStartedDeviceProcess(booted, process);
    process.emit("exit", 1, null);
    expect(h.calls).toEqual([]);
  });

  test("settles incident when pool ownership changes during record", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());
    h.onRecord(() => h.devices.set(deviceId, pooled()));
    const process = child();
    await h.lifecycle.trackStartedDeviceProcess(booted, process);
    process.emit("exit", 1, null);
    await flushUntil(() => h.calls.includes("finish"));
    expect(h.calls).toEqual(["prepare", "record", "settle", "finish"]);
    expect(h.settlements).toEqual([["incident", "not-attempted"]]);
  });

  test("settles incident as exhausted and rethrows when eviction fails", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());
    const originalError = new Error("eviction failed");
    h.throwOnEviction(originalError);

    await expect(h.lifecycle.evictStartedDeviceAfterProcessExit(deviceId, 1, null)).rejects.toBe(
      originalError,
    );

    expect(h.settlements).toEqual([["incident", "exhausted"]]);
    expect(h.calls).toEqual(["prepare", "record", "evict", "settle", "finish"]);
  });

  test("does not settle again when eviction succeeds", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());

    await h.lifecycle.evictStartedDeviceAfterProcessExit(deviceId, 1, null);

    expect(h.settlements).toEqual([]);
    expect(h.calls).toEqual(["prepare", "record", "evict", "finish"]);
  });

  test("stops a tracked process and clears both maps", async () => {
    const h = harness();
    const process = child();
    const signals: Array<NodeJS.Signals | undefined> = [];
    process.kill = (signal?: NodeJS.Signals | number) => {
      signals.push(signal as NodeJS.Signals | undefined);
      process.emit("exit", 0, signal ?? null);
      return true;
    };
    h.processes.set(deviceId, process);
    await h.lifecycle.stopTrackedEmulatorProcess(deviceId);
    expect(signals).toEqual(["SIGTERM"]);
    expect(h.processes.has(deviceId)).toBe(false);
    expect(h.outputs.has(deviceId)).toBe(false);
  });

  test("escalates from SIGTERM to SIGKILL and clears the exit deadline", async () => {
    const h = harness();
    const process = child();
    const signals: Array<NodeJS.Signals | undefined> = [];
    process.kill = (signal?: NodeJS.Signals | number) => {
      signals.push(signal as NodeJS.Signals | undefined);
      if (signal === "SIGKILL") {
        process.emit("exit", null, "SIGKILL");
      }
      return true;
    };
    const stopping = h.lifecycle.stopEmulatorProcess(process);
    expect(signals).toEqual(["SIGTERM"]);
    expect(h.timer.getPendingTimeoutCount()).toBe(1);
    h.timer.advanceTime(1_000);
    await stopping;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("reports a process still alive after SIGKILL and retains its lease until exit", async () => {
    const h = harness();
    const process = child();
    process.pid = 42;
    const signals: Array<NodeJS.Signals | undefined> = [];
    process.kill = (signal?: NodeJS.Signals | number) => {
      signals.push(signal as NodeJS.Signals | undefined);
      return true;
    };
    let retained: Promise<unknown> | undefined;
    const stopping = h.lifecycle.stopEmulatorProcess(process, (settlement) => {
      retained = settlement;
    });
    h.timer.advanceTime(1_000);
    await flushUntil(() => signals.length === 2);
    expect(h.timer.getPendingTimeoutCount()).toBe(1);
    h.timer.advanceTime(1_000);
    await expect(stopping).rejects.toThrow("emulator process 42 did not exit after SIGKILL");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(retained).toBeDefined();
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    let leaseSettled = false;
    void retained!.then(() => {
      leaseSettled = true;
    });
    process.emit("exit", null, "SIGKILL");
    await flushUntil(() => leaseSettled);
  });

  test("reads a completed exit and rejects tracking a process that already exited", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());
    const process = child();
    expect(h.lifecycle.getCompletedProcessExit(process)).toBeUndefined();
    process.exitCode = 1;
    expect(h.lifecycle.getCompletedProcessExit(process)).toEqual({ code: 1, signal: null });
    await expect(h.lifecycle.trackStartedDeviceProcess(booted, process)).rejects.toThrow(
      "Android emulator emulator-5554 exited before process tracking completed (code=1, signal=none)",
    );
    expect(h.calls).toEqual(["prepare", "record", "evict", "finish"]);
  });

  test("captures redacted output from stdout and stderr through stream close", async () => {
    const timer = new FakeTimer();
    const process = child();
    process.stdout = new EventEmitter() as ChildProcess["stdout"];
    process.stderr = new EventEmitter() as ChildProcess["stderr"];
    const tail = new EmulatorProcessOutputTail(process, timer);
    process.stdout!.emit("data", Buffer.from("token=private "));
    process.stderr!.emit("data", Buffer.from("emulator died\n"));
    expect(tail.snapshot()).toContain("token=[REDACTED]");
    expect(tail.snapshot()).not.toContain("private");
    const finalized = tail.finalize();
    expect(timer.getPendingTimeoutCount()).toBe(1);
    process.emit("close", 1, null);
    expect(await finalized).toContain("emulator died\n");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("DevicePool delegates through the injected emulator lifecycle factory", () => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const calls: string[] = [];
    let suppliedPort: EmulatorProcessLifecyclePoolPort | undefined;
    class RecordingLifecycle extends EmulatorProcessLifecycle {
      override hasStartedDeviceProcess(id: string): boolean {
        calls.push(id);
        return true;
      }
    }
    try {
      const pool = new DevicePool({
        sessionManager: sessions,
        daemonSessionId: "factory-test",
        timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        emulatorProcessLifecycleFactory: (port) => {
          suppliedPort = port;
          return new RecordingLifecycle(port);
        },
      });
      expect(suppliedPort?.getTimer()).toBe(timer);
      expect(pool.hasStartedDeviceProcess(deviceId, child())).toBe(true);
      expect(calls).toEqual([deviceId]);
    } finally {
      sessions.stopCleanupTimer();
    }
  });
});
