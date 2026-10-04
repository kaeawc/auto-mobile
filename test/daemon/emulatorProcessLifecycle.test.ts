import { describe, expect, spyOn, test } from "bun:test";
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
import { logger } from "../../src/utils/logger";

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
  const evictionIncidents: Array<string | undefined> = [];
  let reserved = false;
  let onRecord: (() => void | Promise<void>) | undefined;
  let removeOnEviction = false;
  let recordCount = 0;
  let evictionError: Error | undefined;
  let onEvict: (() => Promise<void>) | undefined;
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
      const incidentId = ++recordCount === 1 ? "incident" : `incident-${recordCount}`;
      await onRecord?.();
      return incidentId;
    },
    finishEmulatorLossIncident: async (incidentId, outcome) => {
      calls.push("settle");
      settlements.push([incidentId, outcome]);
    },
    evictMissingPooledDevice: async (device, reason, _recover, incidentId) => {
      expect(reason).toBe("emulator process exited after startup (code=1, signal=null)");
      calls.push("evict");
      evictionIncidents.push(incidentId);
      if (onEvict) {
        await onEvict();
      }
      if (evictionError) {
        throw evictionError;
      }
      if (removeOnEviction) {
        devices.delete(device.id);
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
    evictionIncidents,
    removeOnEviction: () => {
      removeOnEviction = true;
    },
    onEvict: (callback: () => Promise<void>) => {
      onEvict = callback;
    },
    throwOnEviction: (error: Error) => {
      evictionError = error;
    },
    reserve: () => {
      reserved = true;
    },
    onRecord: (callback: () => void | Promise<void>) => {
      onRecord = callback;
    },
  };
}

describe("EmulatorProcessLifecycle", () => {
  test("startup and bind tracks record one incident and share it for both evictions", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());
    const process = child();
    await h.lifecycle.trackStartedDeviceProcess(booted, process);
    await h.lifecycle.trackStartedDeviceProcess(booted, process);
    expect(process.listenerCount("exit")).toBe(2);

    process.exitCode = 1;
    process.emit("exit", 1, null);
    await flushUntil(() => h.calls.filter((call) => call === "finish").length === 2);

    expect(h.calls.filter((call) => call === "record")).toHaveLength(1);
    expect(h.evictionIncidents).toEqual(["incident", "incident"]);
  });

  test("bind during a pending incident write still rejects and evicts the dead device", async () => {
    const h = harness();
    const write = Promise.withResolvers<void>();
    h.onRecord(() => write.promise);
    h.removeOnEviction();
    h.devices.set(deviceId, pooled());
    const process = child();
    await h.lifecycle.trackStartedDeviceProcess(booted, process);
    process.exitCode = 1;
    process.emit("exit", 1, null);
    await flushUntil(() => h.calls.includes("record"));

    const binding = h.lifecycle.trackStartedDeviceProcess(booted, process);
    const result = binding.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(process.listenerCount("exit")).toBe(1);
    expect(h.devices.has(deviceId)).toBe(true);
    expect(h.calls.filter((call) => call === "prepare")).toHaveLength(2);
    expect(h.evictionIncidents).toEqual([]);
    write.resolve();
    expect(await result).toBeInstanceOf(Error);
    expect(String(await result)).toContain("exited before process tracking completed");
    await flushUntil(() => h.calls.filter((call) => call === "finish").length === 2);

    expect(h.devices.has(deviceId)).toBe(false);
    expect(h.calls.filter((call) => call === "record")).toHaveLength(1);
    expect(h.evictionIncidents).toEqual(["incident"]);
  });

  test("a second track after a settled pass rejects and records its own incident", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());
    const process = child();
    await h.lifecycle.trackStartedDeviceProcess(booted, process);
    process.exitCode = 1;
    process.emit("exit", 1, null);
    await flushUntil(() => h.calls.includes("finish"));

    await expect(h.lifecycle.trackStartedDeviceProcess(booted, process)).rejects.toThrow(
      "exited before process tracking completed",
    );

    expect(h.calls.filter((call) => call === "record")).toHaveLength(2);
    expect(h.evictionIncidents).toEqual(["incident", "incident-2"]);
  });

  test("a track overlapping recovery shares the written incident until the recorder settles", async () => {
    const h = harness();
    const eviction = Promise.withResolvers<void>();
    h.onEvict(() => eviction.promise);
    h.devices.set(deviceId, pooled());
    const process = child();
    await h.lifecycle.trackStartedDeviceProcess(booted, process);
    process.exitCode = 1;
    process.emit("exit", 1, null);
    await flushUntil(() => h.evictionIncidents.length === 1);
    const binding = h.lifecycle
      .trackStartedDeviceProcess(booted, process)
      .catch((error: unknown) => error);
    await flushUntil(() => h.evictionIncidents.length === 2);
    expect(h.calls.filter((call) => call === "record")).toHaveLength(1);
    expect(h.evictionIncidents).toEqual(["incident", "incident"]);
    eviction.resolve();
    expect(await binding).toBeInstanceOf(Error);
    await flushUntil(() => h.calls.filter((call) => call === "finish").length === 2);
  });

  test("only the recorder's write is wedged: bind evicts and rejects at the shared deadline", async () => {
    const h = harness();
    const write = Promise.withResolvers<void>();
    h.onRecord(() =>
      h.calls.filter((call) => call === "record").length === 1 ? write.promise : undefined,
    );
    h.removeOnEviction();
    h.devices.set(deviceId, pooled());
    const process = child();
    const warnings = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await h.lifecycle.trackStartedDeviceProcess(booted, process);
      process.exitCode = 1;
      process.emit("exit", 1, null);
      await flushUntil(() => h.calls.includes("record"));
      let settled = false;
      const binding = h.lifecycle
        .trackStartedDeviceProcess(booted, process)
        .catch((error: unknown) => {
          settled = true;
          return error;
        });
      h.timer.advanceTime(999);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(h.devices.has(deviceId)).toBe(true);
      h.timer.advanceTime(1);
      await flushUntil(() => settled);
      expect(String(await binding)).toContain("exited before process tracking completed");
      expect(h.devices.has(deviceId)).toBe(false);
      expect(h.evictionIncidents).toEqual([undefined]);
      expect(h.calls.filter((call) => call === "finish")).toHaveLength(1);
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(warnings).toHaveBeenCalledWith(
        expect.stringContaining("Timed out waiting for shared emulator-loss incident"),
      );
      write.resolve();
      await flushUntil(() => h.calls.filter((call) => call === "finish").length === 2);
      expect(h.calls.filter((call) => call === "record")).toHaveLength(1);
      expect(h.evictionIncidents).toEqual([undefined]);
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(h.timer.getPendingTimeouts()).toEqual([]);
    } finally {
      write.resolve();
      warnings.mockRestore();
    }
  });

  test("a failed recorder pass clears sharing for a later track", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());
    h.throwOnEviction(new Error("eviction failed"));
    const process = child();
    process.exitCode = 1;
    await expect(h.lifecycle.trackStartedDeviceProcess(booted, process)).rejects.toThrow(
      "eviction failed",
    );
    await expect(h.lifecycle.trackStartedDeviceProcess(booted, process)).rejects.toThrow(
      "eviction failed",
    );
    expect(h.evictionIncidents).toEqual(["incident", "incident-2"]);
  });

  test("different children at the same serial each record their own incident", async () => {
    const h = harness();
    for (let index = 0; index < 2; index += 1) {
      h.devices.set(deviceId, pooled());
      const process = child();
      await h.lifecycle.trackStartedDeviceProcess(booted, process);
      await h.lifecycle.trackStartedDeviceProcess(booted, process);
      process.exitCode = 1;
      process.emit("exit", 1, null);
      await flushUntil(
        () => h.calls.filter((call) => call === "finish").length === (index + 1) * 2,
      );
    }

    expect(h.calls.filter((call) => call === "record")).toHaveLength(2);
    expect(h.evictionIncidents).toEqual(["incident", "incident", "incident-2", "incident-2"]);
  });

  test("a failed shared incident write is logged once while both handlers finish cleanup", async () => {
    const h = harness();
    const write = Promise.withResolvers<void>();
    const failure = new Error("incident store unavailable");
    const warnings = spyOn(logger, "warn").mockImplementation(() => {});
    h.onRecord(() => write.promise);
    h.devices.set(deviceId, pooled());
    const process = child();
    try {
      await h.lifecycle.trackStartedDeviceProcess(booted, process);
      process.exitCode = 1;
      process.emit("exit", 1, null);
      await flushUntil(() => h.calls.includes("record"));
      const binding = h.lifecycle.trackStartedDeviceProcess(booted, process);
      const result = binding.then(
        () => undefined,
        (error: unknown) => error,
      );
      write.reject(failure);
      expect(await result).toBeInstanceOf(Error);
      expect(String(await result)).toContain("exited before process tracking completed");
      await flushUntil(() => h.calls.filter((call) => call === "finish").length === 2);

      expect(h.calls.filter((call) => call === "record")).toHaveLength(1);
      expect(h.evictionIncidents).toEqual([undefined, undefined]);
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(warnings).toHaveBeenCalledWith(
        expect.stringContaining("Failed to record emulator-loss incident"),
        failure,
      );
    } finally {
      warnings.mockRestore();
    }
  });

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
