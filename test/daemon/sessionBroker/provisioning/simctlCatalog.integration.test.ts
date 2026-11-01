import { describe, expect, test } from "bun:test";
import { DefaultManagedSpecResolver } from "../../../../src/daemon/sessionBroker/provisioning/DefaultManagedSpecResolver";
import { SimCtlClient } from "../../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { runWithAbortSignal } from "../../../../src/utils/AbortContext";
import { raceWithDeadline } from "../../../../src/utils/raceWithDeadline";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { drainUntil } from "../../../helpers/fakeTimerStepping";

const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const spec = { runtime, deviceType };

function harness() {
  const timer = new FakeTimer();
  const reads: string[] = [];
  let failure: Error | undefined;
  let createFailure: Error | undefined;
  let gate: Promise<void> | undefined;
  const exec: NonNullable<ConstructorParameters<typeof SimCtlClient>[1]> = async (
    _file,
    args,
    { signal } = {},
  ) => {
    const command = args[1]!;
    if (command === "create") {
      if (createFailure) {
        throw createFailure;
      }
      return createExecResult("sim-udid", "");
    }
    reads.push(args[2]!);
    if (gate) {
      await raceWithDeadline(gate, { timer, signal, label: "fake catalog" });
    }
    signal?.throwIfAborted();
    if (failure) {
      throw failure;
    }
    return createExecResult(
      JSON.stringify(
        command === "list" && args[2] === "runtimes"
          ? {
              runtimes: [
                {
                  identifier: runtime,
                  version: "18.0",
                  isAvailable: true,
                  name: "iOS 18",
                  bundlePath: "",
                  runtimeRoot: "",
                  buildversion: "",
                },
              ],
            }
          : {
              devicetypes: [
                {
                  identifier: deviceType,
                  name: "iPhone 16",
                  productFamily: "iPhone",
                  modelIdentifier: "iPhone17,3",
                  minRuntimeVersion: 0,
                  maxRuntimeVersion: 0,
                  bundlePath: "",
                },
              ],
            },
      ),
      "",
    );
  };
  const client = new SimCtlClient(null, exec, { timer });
  const resolver = new DefaultManagedSpecResolver(client);
  return {
    timer,
    reads,
    client,
    resolver,
    otherClient: new SimCtlClient(null, exec, { timer }),
    failRead(error?: Error) {
      failure = error;
    },
    failCreate(error: Error) {
      createFailure = error;
    },
    block() {
      const deferred = Promise.withResolvers<void>();
      gate = deferred.promise;
      return deferred.resolve;
    },
  };
}

describe("binding resolver simctl catalog cache", () => {
  test.each([true, false])(
    "one snapshot per resolve (explicit model: %s), TTL then refresh",
    async (explicit) => {
      const h = harness();
      const requested = explicit ? spec : { runtime };
      expect((await h.resolver.resolve("ios", requested, {})).kind).toBe("resolved");
      expect(h.reads).toEqual(["runtimes", "devicetypes"]);
      h.reads.length = 0;
      h.timer.advanceTime(59_999);
      expect((await h.resolver.resolve("ios", requested, {})).kind).toBe("resolved");
      expect(h.reads).toEqual([]);
      h.timer.advanceTime(1);
      expect((await h.resolver.resolve("ios", requested, {})).kind).toBe("resolved");
      expect(h.reads).toEqual(["runtimes", "devicetypes"]);
    },
  );

  test("checkCreatable shares the cached catalog and validates on a cold read", async () => {
    const h = harness();
    const resolved = await h.resolver.resolve("ios", spec, {});
    if (resolved.kind !== "resolved") {
      throw new Error("fixture must resolve");
    }
    h.reads.length = 0;
    expect((await h.resolver.checkCreatable("ios", resolved.resolvedSpec, {})).kind).toBe(
      "creatable",
    );
    expect(h.reads).toEqual([]);
    h.timer.advanceTime(60_000);
    expect((await h.resolver.checkCreatable("ios", resolved.resolvedSpec, {})).kind).toBe(
      "creatable",
    );
    expect(h.reads).toEqual(["runtimes", "devicetypes"]);
  });

  test("invalidation fences a catalog read already in flight", async () => {
    const h = harness();
    const release = h.block();
    const first = h.resolver.resolve("ios", spec, {});
    await drainUntil(() => h.reads.length >= 2, { description: "catalog started" });
    h.failCreate(new Error("Invalid runtime"));
    await expect(h.otherClient.createSimulator("name", deviceType, runtime)).rejects.toThrow(
      "Invalid runtime",
    );
    const second = h.resolver.resolve("ios", spec, {});
    await drainUntil(() => h.reads.length >= 4, { description: "fresh catalog started" });
    release();
    expect((await first).kind).toBe("resolved");
    expect((await second).kind).toBe("resolved");
    h.reads.length = 0;
    await h.resolver.resolve("ios", spec, {});
    expect(h.reads).toEqual([]);
  });

  test("concurrent resolves share a flight; one ambient abort does not poison another waiter", async () => {
    const h = harness();
    const release = h.block();
    const caller = new AbortController();
    const first = runWithAbortSignal(caller.signal, () =>
      h.resolver.resolve("ios", { runtime }, { signal: caller.signal }),
    );
    const second = h.resolver.resolve("ios", { runtime }, {});
    await drainUntil(() => h.reads.length >= 2, { description: "catalog started" });
    caller.abort();
    release();
    expect((await first).kind).toBe("unresolved");
    expect((await second).kind).toBe("resolved");
    expect(h.reads).toEqual(["runtimes", "devicetypes"]);
    await h.resolver.resolve("ios", spec, {});
    expect(h.reads).toHaveLength(2);
  });

  test.each(["Invalid runtime", "Invalid device type"])(
    "%s create failure invalidates across clients",
    async (message) => {
      const h = harness();
      await h.resolver.resolve("ios", spec, {});
      h.failCreate(new Error(message));
      await expect(h.otherClient.createSimulator("name", deviceType, runtime)).rejects.toThrow(
        message,
      );
      h.reads.length = 0;
      await h.resolver.resolve("ios", spec, {});
      expect(h.reads).toEqual(["runtimes", "devicetypes"]);
    },
  );

  test("failed read is not cached and is read only once during the failed resolve", async () => {
    const h = harness();
    h.failRead(new Error("catalog unavailable"));
    expect((await h.resolver.resolve("ios", { runtime }, {})).kind).toBe("unresolved");
    expect(h.reads).toEqual(["runtimes", "devicetypes"]);
    h.failRead();
    h.reads.length = 0;
    expect((await h.resolver.resolve("ios", { runtime }, {})).kind).toBe("resolved");
    expect(h.reads).toEqual(["runtimes", "devicetypes"]);
  });

  test("an abandoned aborted flight cannot populate the cache", async () => {
    const h = harness();
    const release = h.block();
    const caller = new AbortController();
    const pending = h.resolver.resolve("ios", { runtime }, { signal: caller.signal });
    await drainUntil(() => h.reads.length >= 2, { description: "catalog started" });
    caller.abort();
    expect((await pending).kind).toBe("unresolved");
    release();
    h.reads.length = 0;
    expect((await h.resolver.resolve("ios", { runtime }, {})).kind).toBe("resolved");
    expect(h.reads).toEqual(["runtimes", "devicetypes"]);
  });
});
