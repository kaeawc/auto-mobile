import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { NativeHelperRegistry } from "../../../src/utils/nativeHelpers/NativeHelperRegistry";
import { sweepNativeHelperOrphans } from "../../../src/utils/nativeHelpers/sweepNativeHelperOrphans";
import type { NativeHelperRecord } from "../../../src/utils/nativeHelpers/NativeHelperRecordStore";
import { FakeNativeHelperRecordStore } from "../../fakes/FakeNativeHelperRecordStore";
import { FakeNativeHelperProcessControl } from "../../fakes/FakeNativeHelperProcessControl";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeLogger } from "../../fakes/FakeLogger";

function harness() {
  const store = new FakeNativeHelperRecordStore();
  const control = new FakeNativeHelperProcessControl();
  const timer = new FakeTimer();
  const logger = new FakeLogger();
  const record: NativeHelperRecord = {
    version: 1,
    kind: "adb",
    pid: 20,
    startIdentity: "helper",
    processGroup: false,
    ownerPid: 10,
    ownerStartIdentity: "owner",
    recordedAtMs: 0,
  };
  store.write(record);
  control.processes.set(20, "helper");
  control.onSignal = (pid, signal) => {
    if (signal === "SIGKILL") {
      control.processes.delete(pid);
    }
  };
  const sweep = (deadlineMs = 100) =>
    sweepNativeHelperOrphans({
      store,
      control,
      timer,
      logger,
      ownPid: 30,
      graceMs: 10,
      deadlineMs,
    });
  const registry = new NativeHelperRegistry({ store, control, timer, logger, ownPid: 30 });
  return { store, control, timer, logger, record, sweep, registry };
}

async function settle<T>(work: Promise<T>, timer: FakeTimer): Promise<T> {
  // All asynchronous production work is a Timer sleep; advance only fake time.
  for (let i = 0; i < 100; i++) {
    await Promise.resolve();
    timer.advanceTime(1);
  }
  return work;
}

describe("native helper orphan sweep", () => {
  test.each(["owner", undefined])(
    "leaves a live owner with identity %s untouched",
    async (identity) => {
      const h = harness();
      h.control.processes.set(10, identity);
      expect((await settle(h.sweep(), h.timer)).skippedLiveOwner).toBe(1);
      expect(h.control.signals).toEqual([]);
      expect(h.store.list()).toHaveLength(1);
    },
  );
  test.each(["adb", "iproxy", "ios-capture-helper"] as const)(
    "reaps %s only after grace for a dead owner",
    async (kind) => {
      const h = harness();
      h.store.write({ ...h.record, kind });
      const work = h.sweep();
      await Promise.resolve();
      expect(h.control.signals.map((s) => s.signal)).toEqual(["SIGTERM"]);
      expect((await settle(work, h.timer)).reaped).toBe(1);
      expect(h.control.signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(h.store.list()).toEqual([]);
    },
  );
  test("a recycled owner is dead", async () => {
    const h = harness();
    h.control.processes.set(10, "replacement");
    expect((await settle(h.sweep(), h.timer)).reaped).toBe(1);
  });
  test.each(["replacement", null])(
    "removes a stale helper with identity %s without signalling",
    async (identity) => {
      const h = harness();
      if (identity === null) {
        h.control.processes.delete(20);
      } else {
        h.control.processes.set(20, identity);
      }
      expect((await h.sweep()).staleRecordsRemoved).toBe(1);
      expect(h.control.signals).toEqual([]);
      expect(h.store.list()).toEqual([]);
    },
  );
  test("signals detached groups", async () => {
    const h = harness();
    h.store.write({ ...h.record, processGroup: true });
    await settle(h.sweep(), h.timer);
    expect(h.control.signals.every((s) => s.group)).toBe(true);
  });
  test.each([-1, 0, 1, 30])("never signals protected pid %s", async (pid) => {
    const h = harness();
    h.store.remove(20);
    h.store.write({ ...h.record, pid });
    h.control.processes.set(pid, "helper");
    await h.sweep();
    expect(h.control.signals).toEqual([]);
  });
  test("never reaps our matching owner", async () => {
    const h = harness();
    h.store.write({ ...h.record, ownerPid: 30 });
    h.control.processes.set(30, "owner");
    expect((await settle(h.sweep(), h.timer)).skippedLiveOwner).toBe(1);
    expect(h.control.signals).toEqual([]);
  });
  test("deadline leaves later records and prevents escalation after expiry", async () => {
    const h = harness();
    h.store.write({ ...h.record, pid: 21 });
    h.control.processes.set(21, "helper");
    await settle(h.sweep(5), h.timer);
    expect(h.control.signals).toEqual([{ pid: 20, signal: "SIGTERM", group: false }]);
    expect(h.store.list()).toHaveLength(2);
  });
  test("identity changes during grace prevent SIGKILL", async () => {
    const h = harness();
    h.control.onSignal = (pid) => h.control.processes.set(pid, "new");
    await settle(h.sweep(), h.timer);
    expect(h.control.signals.map((s) => s.signal)).toEqual(["SIGTERM"]);
  });
  test("a failing record does not stop the sweep", async () => {
    const h = harness();
    h.store.write({ ...h.record, pid: 21 });
    h.control.processes.set(21, "helper");
    h.control.onSignal = (pid, signal) => {
      if (pid === 20) {
        throw new Error("denied");
      }
      if (signal === "SIGKILL") {
        h.control.processes.delete(pid);
      }
    };
    const summary = await settle(h.sweep(), h.timer);
    expect(summary.failed).toBe(1);
    expect(summary.reaped).toBe(1);
    expect(h.logger.at("warn")).toHaveLength(1);
  });
  test("keeps a record if SIGKILL cannot stop the helper", async () => {
    const h = harness();
    h.control.onSignal = undefined;
    expect((await settle(h.sweep(), h.timer)).failed).toBe(1);
    expect(h.store.list()).toHaveLength(1);
  });
});

describe("native helper registry", () => {
  test.each([undefined, "self"])(
    "records only when both identities are readable (owner=%s)",
    (identity) => {
      const h = harness();
      h.store.remove(20);
      h.control.processes.set(30, identity);
      const child = Object.assign(new EventEmitter(), {
        pid: 20,
        exitCode: null,
        signalCode: null,
      });
      h.registry.track(child, { kind: "adb", processGroup: false });
      expect(h.store.list()).toHaveLength(identity ? 1 : 0);
      child.emit("exit");
      expect(h.store.list()).toEqual([]);
    },
  );
  test.each([undefined, 22])("does not record a missing pid or helper identity (%s)", (pid) => {
    const h = harness();
    h.store.remove(20);
    h.control.processes.set(30, "self");
    h.registry.track(Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null }), {
      kind: "adb",
      processGroup: false,
    });
    expect(h.store.list()).toEqual([]);
  });
  test("shutdown sends all TERM before any KILL and removes exited records", async () => {
    const h = harness();
    h.control.processes.set(30, "self");
    h.control.processes.set(21, "helper");
    for (const pid of [20, 21]) {
      h.registry.track(
        Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null }),
        { kind: "adb", processGroup: pid === 21 },
      );
    }
    const summary = await settle(h.registry.shutdown({ timer: h.timer, graceMs: 10 }), h.timer);
    expect(h.control.signals.map((s) => s.signal)).toEqual([
      "SIGTERM",
      "SIGTERM",
      "SIGKILL",
      "SIGKILL",
    ]);
    expect(summary.reaped).toBe(2);
    expect(h.store.list()).toEqual([]);
  });
  test("shutdown never kills a reused identity", async () => {
    const h = harness();
    h.control.processes.set(30, "self");
    h.registry.track(
      Object.assign(new EventEmitter(), { pid: 20, exitCode: null, signalCode: null }),
      { kind: "adb", processGroup: false },
    );
    h.control.onSignal = (pid) => h.control.processes.set(pid, "replacement");
    await settle(h.registry.shutdown({ timer: h.timer, graceMs: 10 }), h.timer);
    expect(h.control.signals.map((s) => s.signal)).toEqual(["SIGTERM"]);
  });
});

test("registry shutdown catches timer failures and keeps unresolved records", async () => {
  const h = harness();
  h.control.processes.set(30, "self");
  h.registry.track(
    Object.assign(new EventEmitter(), { pid: 20, exitCode: null, signalCode: null }),
    { kind: "adb", processGroup: false },
  );
  const timer = new FakeTimer();
  timer.sleep = async () => {
    throw new Error("timer unavailable");
  };
  expect((await h.registry.shutdown({ timer, graceMs: 10 })).failed).toBe(1);
  expect(h.store.list()).toHaveLength(1);
  expect(h.logger.at("warn")).toHaveLength(1);
});

test.each(["before TERM", "during grace"])(
  "registry keeps a running helper whose identity becomes unreadable %s",
  async (when) => {
    const h = harness();
    h.control.processes.set(30, "self");
    h.registry.track(
      Object.assign(new EventEmitter(), { pid: 20, exitCode: null, signalCode: null }),
      { kind: "adb", processGroup: false },
    );
    if (when === "before TERM") {
      h.control.processes.set(20, undefined);
    } else {
      h.control.onSignal = (pid) => h.control.processes.set(pid, undefined);
    }
    expect(
      (await settle(h.registry.shutdown({ timer: h.timer, graceMs: 10 }), h.timer)).failed,
    ).toBe(1);
    expect(h.control.signals.map((s) => s.signal)).toEqual(
      when === "before TERM" ? [] : ["SIGTERM"],
    );
    expect(h.store.list()).toHaveLength(1);
  },
);

test.each(["darwin-utc:now", "other:now", "darwin:changed"])(
  "incomparable owner identity %s retains helpers",
  async (identity) => {
    const h = harness();
    h.control.incomparableIdentities.add(identity);
    h.store.write({ ...h.record, ownerStartIdentity: "darwin:old" });
    h.control.processes.set(10, identity);
    expect((await settle(h.sweep(), h.timer)).skippedLiveOwner).toBe(1);
    expect(h.control.signals).toEqual([]);
    expect(h.store.list()).toHaveLength(1);
  },
);

test("different comparable owner generation permits cleanup", async () => {
  const h = harness();
  h.store.write({ ...h.record, ownerStartIdentity: "linux:old" });
  h.control.processes.set(10, "linux:new");
  expect((await settle(h.sweep(), h.timer)).reaped).toBe(1);
});

test.each([undefined, "other:helper", "darwin:new"])(
  "unverifiable running helper %s is retained before TERM",
  async (identity) => {
    const h = harness();
    if (identity !== undefined) {
      h.control.incomparableIdentities.add(identity);
    }
    h.store.write({ ...h.record, startIdentity: "darwin:old" });
    h.control.processes.set(20, identity);
    expect((await h.sweep()).failed).toBe(1);
    expect(h.control.signals).toEqual([]);
    expect(h.store.list()).toHaveLength(1);
    expect(h.logger.at("warn")).toHaveLength(1);
  },
);

test.each([undefined, "other:helper"])(
  "sweep retains unverifiable identity %s after TERM",
  async (identity) => {
    const h = harness();
    if (identity !== undefined) {
      h.control.incomparableIdentities.add(identity);
    }
    h.control.onSignal = (pid) => h.control.processes.set(pid, identity);
    expect((await settle(h.sweep(), h.timer)).failed).toBe(1);
    expect(h.control.signals.map((s) => s.signal)).toEqual(["SIGTERM"]);
    expect(h.store.list()).toHaveLength(1);
    expect(h.logger.at("warn")).toHaveLength(1);
  },
);

test.each(["before TERM", "during grace"])(
  "registry retains incomparable identity %s",
  async (when) => {
    const h = harness();
    h.control.incomparableIdentities.add("other:helper");
    h.control.processes.set(30, "self");
    h.registry.track(
      Object.assign(new EventEmitter(), { pid: 20, exitCode: null, signalCode: null }),
      { kind: "adb", processGroup: false },
    );
    if (when === "before TERM") {
      h.control.processes.set(20, "other:helper");
    } else {
      h.control.onSignal = (pid) => h.control.processes.set(pid, "other:helper");
    }
    expect((await settle(h.registry.shutdown({ graceMs: 10 }), h.timer)).failed).toBe(1);
    expect(h.control.signals.map((s) => s.signal)).toEqual(
      when === "before TERM" ? [] : ["SIGTERM"],
    );
    expect(h.store.list()).toHaveLength(1);
  },
);

test("sweep does not remove a rewritten record after helper exit", async () => {
  const h = harness();
  h.control.onSignal = (pid) => {
    h.control.processes.delete(pid);
    h.store.write({ ...h.record, startIdentity: "replacement" });
  };
  expect((await h.sweep()).reaped).toBe(1);
  expect(h.store.list()[0]?.startIdentity).toBe("replacement");
});

test("registry exit does not remove a rewritten stored record", () => {
  const h = harness();
  h.control.processes.set(30, "self");
  const child = Object.assign(new EventEmitter(), { pid: 20, exitCode: null, signalCode: null });
  h.registry.track(child, { kind: "adb", processGroup: false });
  h.store.write({ ...h.record, startIdentity: "replacement" });
  child.emit("exit");
  expect(h.store.list()[0]?.startIdentity).toBe("replacement");
});
