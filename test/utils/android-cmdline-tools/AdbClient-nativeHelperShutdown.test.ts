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

function harness() {
  const timer = new FakeTimer();
  const store = new FakeNativeHelperRecordStore();
  const control = new FakeNativeHelperProcessControl();
  control.processes.set(30, "owner");
  const registry = new NativeHelperRegistry({
    timer,
    store,
    control,
    ownPid: 30,
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
    const children = [new FakeChildProcess(h.timer), new FakeChildProcess(h.timer)];
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
      const summary = await advance(
        terminateActiveAdbProcesses({ timer: h.timer, graceMs: 10 }),
        h.timer,
      );
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
    const child = new FakeChildProcess(h.timer);
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
      await advance(terminateActiveAdbProcesses({ timer: h.timer, graceMs: 10 }), h.timer);
      expect(signals).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
    } finally {
      kill.mockRestore();
    }
  });
  test("one-shot exec uses live-child cleanup but writes no durable record", async () => {
    const h = harness();
    const child = new FakeChildProcess(h.timer);
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
    const cleanup = terminateActiveAdbProcesses({ timer: h.timer, graceMs: 10 });
    h.timer.advanceTime(0);
    resolveResult?.();
    await advance(cleanup, h.timer);
    await pending;
    expect(child.killed).toBe(true);
    expect(h.store.list()).toEqual([]);
  });
});
