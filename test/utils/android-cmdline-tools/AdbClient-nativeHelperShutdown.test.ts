import { describe, expect, spyOn, test, afterEach, mock } from "bun:test";
import type { ChildProcess } from "node:child_process";
import {
  AdbClient,
  terminateActiveAdbProcesses,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { HostProcessExecutor } from "../../../src/utils/HostCommandExecutor";
import { NativeHelperRegistry } from "../../../src/utils/nativeHelpers/NativeHelperRegistry";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeNativeHelperRecordStore } from "../../fakes/FakeNativeHelperRecordStore";
import { FakeNativeHelperProcessControl } from "../../fakes/FakeNativeHelperProcessControl";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeLogger } from "../../fakes/FakeLogger";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";

afterEach(() => mock.restore());

// Pinned pids: FakeChildProcess's process-wide pid counter can reach the real
// runner pid when many files share one Bun process (Windows, #17466), and the
// shutdown path never signals its own pid.
const OWN_PID = 30;

function fakeChild(timer: FakeTimer, pid: number): FakeChildProcess {
  const child = new FakeChildProcess(timer);
  child.pid = pid;
  return child;
}

function terminate(timer: FakeTimer, ownPid: number = OWN_PID) {
  return terminateActiveAdbProcesses({ timer, graceMs: 10, ownPid });
}

function harness() {
  const timer = new FakeTimer();
  const store = new FakeNativeHelperRecordStore();
  const control = new FakeNativeHelperProcessControl();
  control.processes.set(OWN_PID, "owner");
  const registry = new NativeHelperRegistry({
    timer,
    store,
    control,
    ownPid: OWN_PID,
    logger: new FakeLogger(),
  });
  const host = new FakeHostCommandExecutor();
  function client(child: FakeChildProcess) {
    control.processes.set(child.pid!, "helper");
    return new AdbClient(null, () => host.executeCommand("adb"), {
      spawnFn: () => {
        // Spawn acknowledgement is asynchronous, as with a real child, without a host timer.
        queueMicrotask(() => child.emit("spawn"));
        return child as ChildProcess;
      },
      timer,
      nativeHelperRegistry: registry,
    });
  }
  return { timer, store, control, registry, client, host };
}

async function advance<T>(work: Promise<T>, timer: FakeTimer): Promise<T> {
  for (let i = 0; i < 100; i++) {
    await Promise.resolve();
    timer.advanceTime(1);
  }
  return work;
}

describe("host adb native helper shutdown", () => {
  test("tracks long-lived spawns and shuts down children across client instances", async () => {
    const h = harness();
    const children = [fakeChild(h.timer, 101), fakeChild(h.timer, 102)];
    const signals: string[] = [];
    const spies = [spyOn(children[0]!, "kill"), spyOn(children[1]!, "kill")];
    for (const [index, child] of children.entries()) {
      spies[index]!.mockImplementation((signal) => {
        signals.push(`${index}:${signal}`);
        if (signal === "SIGKILL" || index === 0) {
          child.simulateExit(0, typeof signal === "string" ? signal : null);
        }
        return true;
      });
    }
    try {
      await h.client(children[0]!).spawn(["shell", "getevent"]);
      await h.client(children[1]!).spawn(["exec-out", "screenrecord"]);
      expect(h.store.list().map((r) => [r.kind, r.processGroup])).toEqual([
        ["adb", false],
        ["adb", false],
      ]);
      const summary = await advance(terminate(h.timer), h.timer);
      expect(signals).toEqual(["0:SIGTERM", "1:SIGTERM", "1:SIGKILL"]);
      expect(summary).toEqual({ terminated: 2, failed: 0 });
      expect(h.store.list()).toEqual([]);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
  test("retains a cancelled child for shutdown until it actually exits", async () => {
    const h = harness();
    const child = fakeChild(h.timer, 103);
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const kill = spyOn(child, "kill").mockImplementation((signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        child.simulateExit(0, "SIGKILL");
      }
      return true;
    });
    try {
      const controller = new AbortController();
      await h.client(child).spawn(["shell", "getevent"], { signal: controller.signal });
      controller.abort();
      await advance(terminate(h.timer), h.timer);
      expect(signals).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
    } finally {
      kill.mockRestore();
    }
  });
  test("one-shot exec uses live-child cleanup but writes no durable record", async () => {
    const h = harness();
    const child = fakeChild(h.timer, 104);
    let resolveResult: (() => void) | undefined;
    const result = new Promise<Awaited<ReturnType<FakeHostCommandExecutor["executeCommand"]>>>(
      (resolve) => {
        resolveResult = () => {
          void h.host.executeCommand("adb").then(resolve);
        };
      },
    );
    const host: HostProcessExecutor = {
      executeCommand: (...args) => h.host.executeCommand(...args),
      spawn: () => child as ChildProcess,
      executeCommandWithChild: () => ({ child: child as ChildProcess, result }),
    };
    const client = new AdbClient(null, () => h.host.executeCommand("adb"), {
      timer: h.timer,
      hostProcessExecutor: host,
      nativeHelperRegistry: h.registry,
    });
    // Exercise the production child-returning exec path with an injected host executor.
    Reflect.set(client, "isTestMode", false);
    const pending = client.execute(["get-state"], { noRetry: true });
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    expect(h.store.list()).toEqual([]);
    const cleanup = terminate(h.timer);
    h.timer.advanceTime(0);
    resolveResult?.();
    await advance(cleanup, h.timer);
    await pending;
    expect(child.killed).toBe(true);
    expect(h.store.list()).toEqual([]);
  });
  test("never signals a child whose pid is the injected own pid", async () => {
    const h = harness();
    const self = fakeChild(h.timer, 105);
    const sibling = fakeChild(h.timer, 106);
    const signals: string[] = [];
    const spies = [spyOn(self, "kill"), spyOn(sibling, "kill")];
    for (const [index, child] of [self, sibling].entries()) {
      spies[index]!.mockImplementation((signal) => {
        signals.push(`${child.pid}:${signal}`);
        child.simulateExit(null, typeof signal === "string" ? signal : null);
        return true;
      });
    }
    try {
      await h.client(self).spawn(["shell", "getevent"]);
      await h.client(sibling).spawn(["exec-out", "screenrecord"]);
      const summary = await advance(terminate(h.timer, 105), h.timer);
      expect(signals).toEqual(["106:SIGTERM"]);
      // The own-pid child is skipped, not terminated or failed: it stays tracked.
      expect(summary).toEqual({ terminated: 1, failed: 0 });
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
      // Let the skipped child exit so the shared tracker does not carry it into later tests.
      self.simulateExit(0);
      h.timer.advanceTime(0);
    }
  });
  test("defaults the own pid to the real process pid", async () => {
    const h = harness();
    const self = fakeChild(h.timer, process.pid);
    const kill = spyOn(self, "kill");
    try {
      await h.client(self).spawn(["shell", "getevent"]);
      const summary = await advance(
        terminateActiveAdbProcesses({ timer: h.timer, graceMs: 10 }),
        h.timer,
      );
      expect(kill).not.toHaveBeenCalled();
      expect(summary).toEqual({ terminated: 0, failed: 0 });
    } finally {
      kill.mockRestore();
      self.simulateExit(0);
      h.timer.advanceTime(0);
    }
  });
});
