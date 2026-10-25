import { logger } from "../../../src/utils/logger";
import { SimulatorTemplatesHarness } from "../../helpers/SimulatorTemplatesHarness";
import { FakeTimer } from "../../fakes/FakeTimer";
import { templateName } from "../../../src/utils/ios-cmdline-tools/SimulatorTemplateKey";
import { getAbortSignal, runWithAbortSignal } from "../../../src/utils/AbortContext";
import { expect, spyOn, test } from "bun:test";
import { SimulatorTemplateBuilder } from "../../../src/features/iosTemplates/SimulatorTemplateBuilder";
import { SimulatorTemplateBuildHarness } from "../../helpers/SimulatorTemplateBuildHarness";
const key = {
  runtime: "ios",
  runtimeBuild: "R1",
  xcodeBuild: "X1",
  deviceType: "phone",
  profile: "none" as const,
};
test("build orders lock, profile, admission, settle and verified shutdown before publication", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  expect(await new SimulatorTemplateBuilder(fake.dependencies()).build(key)).toBe("ready");
  expect(fake.events).toEqual([
    "lock",
    "verify",
    "building",
    "create",
    "building",
    "apply",
    "admit:create",
    "boot",
    "settle",
    "shutdown",
    "verify",
    "ready",
    "release",
  ]);
});
test("capacity refusal is retryable and not failed", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  fake.refuse = true;
  expect(await new SimulatorTemplateBuilder(fake.dependencies()).build(key)).toBe("retry later");
  expect(fake.manifest?.state).toBe("stale");
  expect(fake.manifest?.failure).toBeUndefined();
  expect(fake.events).toContain("delete");
  expect(fake.events.at(-1)).toBe("release");
});
test("settle timeout deletes partial template and backs off", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  fake.settleFails = true;
  const builder = new SimulatorTemplateBuilder(fake.dependencies());
  expect(await builder.build(key)).toBe("failed");
  expect(fake.manifest?.nextAttemptAtMs).toBe(60_000);
  expect(await builder.build(key)).toBe("retry later");
  expect(fake.events.filter((event) => event === "create")).toHaveLength(1);
});
test("lock elsewhere returns without creating", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  fake.locked = true;
  expect(await new SimulatorTemplateBuilder(fake.dependencies()).build(key)).toBe(
    "building elsewhere",
  );
  expect(fake.events).toEqual(["lock"]);
});
test("abort after create deletes half template and releases lock", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  const abort = new AbortController();
  fake.afterCreate = () => abort.abort();
  expect(await new SimulatorTemplateBuilder(fake.dependencies()).build(key, abort.signal)).toBe(
    "failed",
  );
  expect(fake.events).toContain("delete");
  expect(fake.events.at(-1)).toBe("release");
});

test("abort cleanup runs outside the cancelled ambient request", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  const abort = new AbortController();
  fake.afterCreate = () => abort.abort();
  const deps = fake.dependencies();
  deps.client.deleteSimulator = async () => {
    expect(getAbortSignal()).toBeUndefined();
    fake.events.push("delete");
  };
  await runWithAbortSignal(abort.signal, () =>
    new SimulatorTemplateBuilder(deps).build(key, abort.signal),
  );
  expect(fake.events).toContain("delete");
});
test("profile application failure cannot publish a lean template", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  const deps = fake.dependencies();
  deps.profile = () => ({
    apply: async () => ({ applied: false, resources: [], labels: [], reason: "denied" }),
  });
  expect(await new SimulatorTemplateBuilder(deps).build({ ...key, profile: "minimal" })).toBe(
    "failed",
  );
  expect(fake.events).not.toContain("boot");
  expect(fake.events.at(-1)).toBe("release");
});
test("runtime build changed before background build defers without creating", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  expect(
    await new SimulatorTemplateBuilder(fake.dependencies()).build({ ...key, runtimeBuild: "old" }),
  ).toBe("retry later");
  expect(fake.events).toEqual(["lock", "release"]);
});

test("attempts escalate with FakeTimer and reset after a successful retry", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  fake.settleFails = true;
  const deps = fake.dependencies();
  const builder = new SimulatorTemplateBuilder(deps);
  for (const [attempt, delay] of [
    [1, 60_000],
    [2, 120_000],
    [3, 240_000],
  ]) {
    expect(await builder.build(key)).toBe("failed");
    expect(fake.manifest?.attempt).toBe(attempt);
    expect(fake.manifest?.nextAttemptAtMs).toBe(deps.timer.now() + delay);
    expect(await builder.build(key)).toBe("retry later");
    (deps.timer as FakeTimer).advanceTime(delay);
  }
  fake.settleFails = false;
  expect(await builder.build(key)).toBe("ready");
  expect(fake.manifest?.attempt).toBe(0);
});
test("capacity precheck skips without creating a failed manifest", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  const deps = fake.dependencies();
  deps.hasSpareCapacity = async () => false;
  expect(await new SimulatorTemplateBuilder(deps).build(key)).toBe("retry later");
  expect(fake.manifest).toBeUndefined();
  expect(fake.events).toEqual(["lock", "release"]);
});
test("untracked shutdown template is preserved while building our own template", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  fake.rows.push({
    udid: "foreign",
    name: templateName(key),
    state: "Shutdown",
    isAvailable: true,
  });
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(await new SimulatorTemplateBuilder(fake.dependencies()).build(key)).toBe("ready");
    expect(fake.deleted).not.toContain("foreign");
    expect(fake.events).toContain("create");
    expect(warning).toHaveBeenCalledWith(
      "leaving untracked template simulator foreign (Shutdown); not owned by this manifest, remove with the ios-templates clean command",
    );
  } finally {
    warning.mockRestore();
  }
});
for (const created of [false, true]) {
  test(`aborted create with empty recorded UDID preserves foreign template (created=${created})`, async () => {
    const fake = new SimulatorTemplateBuildHarness();
    fake.rows.push({
      udid: "foreign",
      name: templateName(key),
      state: "Shutdown",
      isAvailable: true,
    });
    const deps = fake.dependencies();
    deps.client.createSimulator = async () => {
      if (created) {
        fake.rows.push({
          udid: "ours",
          name: templateName(key),
          state: "Shutdown",
          isAvailable: true,
        });
      }
      throw new Error("create aborted before returning UDID");
    };
    expect(await new SimulatorTemplateBuilder(deps).build(key)).toBe("failed");
    expect(fake.deleted).not.toContain("foreign");
    expect(fake.deleted).toEqual(created ? ["ours"] : []);
  });
}
for (const manifestState of ["ready", "stale"] as const) {
  for (const state of ["Booted", "Booting", "Shutting Down"]) {
    test(`${manifestState} manifest with ${state} simulator defers without deleting or creating`, async () => {
      const fake = new SimulatorTemplateBuildHarness();
      const ready = new SimulatorTemplatesHarness();
      ready.ready();
      fake.manifest = { ...ready.manifest!, state: manifestState };
      fake.present = true;
      fake.name = templateName(key);
      fake.state = state;
      expect(await new SimulatorTemplateBuilder(fake.dependencies()).build(key)).toBe(
        "retry later",
      );
      expect(fake.deleted).toEqual([]);
      expect(fake.events).not.toContain("shutdown");
      expect(fake.events).not.toContain("create");
    });
  }
}
for (const sharedStore of [true, false]) {
  test(`two daemons preserve ready peer template (shared store=${sharedStore})`, async () => {
    const host = new SimulatorTemplateBuildHarness();
    const daemonA = host.dependencies();
    const daemonB = host.dependencies();
    // One host inventory and lock; the legacy daemon has its own empty store.
    daemonB.client = daemonA.client;
    daemonB.lock = daemonA.lock;
    if (!sharedStore) {
      daemonB.store = new SimulatorTemplateBuildHarness().dependencies().store;
    }
    expect(await new SimulatorTemplateBuilder(daemonA).build(key)).toBe("ready");
    const peerUdid = host.manifest!.udid;
    if (!sharedStore) {
      host.rows.push({
        udid: peerUdid,
        name: templateName(key),
        state: "Shutdown",
        isAvailable: true,
      });
      host.present = false;
      host.udid = "22222222-2222-2222-2222-222222222222";
    }
    host.events.length = 0;
    expect(await new SimulatorTemplateBuilder(daemonB).build(key)).toBe("ready");
    expect(host.deleted).toEqual([]);
    expect(host.deleted).not.toContain(peerUdid);
    expect(host.events.includes("create")).toBe(!sharedStore);
    expect(
      Object.values((await daemonB.client.listSimulators()).devices)
        .flat()
        .some((row) => row.udid === peerUdid),
    ).toBe(true);
  });
}

for (const state of ["ready", "building", "failed", "stale"] as const) {
  test(`manifest-owned ${state} template can still be rebuilt when ready is missing`, async () => {
    const fake = new SimulatorTemplateBuildHarness();
    const ready = new SimulatorTemplatesHarness();
    ready.ready();
    fake.manifest = { ...ready.manifest!, state };
    fake.present = state !== "ready";
    fake.name = templateName(key);
    const ownedUdid = fake.manifest.udid;
    expect(await new SimulatorTemplateBuilder(fake.dependencies()).build(key)).toBe("ready");
    if (state !== "ready") {
      expect(fake.deleted).toContain(ownedUdid);
    }
    expect(fake.events).toContain("create");
  });
}

for (const manifestState of ["building", "failed"] as const) {
  for (const state of ["Booted", "Booting", "Shutting Down"]) {
    test(`${manifestState} manifest with ${state} simulator shuts down then deletes and rebuilds`, async () => {
      const fake = new SimulatorTemplateBuildHarness();
      const previous = new SimulatorTemplatesHarness();
      previous.ready();
      fake.manifest = { ...previous.manifest!, state: manifestState };
      const ownedUdid = fake.manifest.udid;
      fake.rows.push({ udid: ownedUdid, name: templateName(key), state, isAvailable: true });
      // A rebuild gets a different UDID and a fresh Shutdown inventory row.
      fake.udid = "22222222-2222-2222-2222-222222222222";
      const deps = fake.dependencies();
      const shutdown = deps.client.shutdownSimulator;
      deps.client.shutdownSimulator = async (udid, signal) => {
        expect(udid).toBe(fake.events.includes("create") ? fake.udid : ownedUdid);
        await shutdown(udid, signal);
      };
      expect(await new SimulatorTemplateBuilder(deps).build(key)).toBe("ready");
      expect(
        fake.events.filter((event) => ["shutdown", "delete", "create"].includes(event)),
      ).toEqual(["shutdown", "delete", "create", "shutdown"]);
      expect(fake.deleted).toEqual([ownedUdid]);
      expect(fake.manifest?.state).toBe("ready");
      expect(fake.manifest?.udid).toBe(fake.udid);
    });
  }
}

test("interrupted builder shutdown failure warns and still deletes and rebuilds", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  const previous = new SimulatorTemplatesHarness();
  previous.ready();
  fake.manifest = { ...previous.manifest!, state: "building" };
  const ownedUdid = fake.manifest.udid;
  fake.rows.push({ udid: ownedUdid, name: templateName(key), state: "Booted", isAvailable: true });
  fake.udid = "22222222-2222-2222-2222-222222222222";
  const deps = fake.dependencies();
  const shutdown = deps.client.shutdownSimulator;
  const error = new Error("shutdown unavailable");
  deps.client.shutdownSimulator = async (udid, signal) => {
    if (udid === ownedUdid) {
      fake.events.push("shutdown");
      throw error;
    }
    await shutdown(udid, signal);
  };
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(await new SimulatorTemplateBuilder(deps).build(key)).toBe("ready");
    expect(fake.deleted).toEqual([ownedUdid]);
    expect(fake.events.indexOf("shutdown")).toBeLessThan(fake.events.indexOf("delete"));
    expect(warning).toHaveBeenCalledWith(
      `Could not shut down interrupted template ${ownedUdid}: shutdown unavailable`,
      error,
    );
  } finally {
    warning.mockRestore();
  }
});
