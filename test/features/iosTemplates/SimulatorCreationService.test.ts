import { getPerfTracker, runWithPerfTracker } from "../../../src/utils/PerfContext";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { expect, test } from "bun:test";
import { SimulatorCreationService } from "../../../src/features/iosTemplates/SimulatorCreationService";
import { SimulatorTemplatesHarness } from "../../helpers/SimulatorTemplatesHarness";

test("disabled flag touches only plain create", async () => {
  const fake = new SimulatorTemplatesHarness();
  const service = new SimulatorCreationService(
    fake.client,
    () => false,
    () => {
      throw new Error("template dependencies resolved while off");
    },
  );
  expect(await service.create(fake.request)).toEqual({ udid: "created", source: "create" });
  expect(fake.events).toEqual(["create:work"]);
});
test("ready shutdown template clones with a new UDID", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  expect(await fake.service().create(fake.request)).toEqual({ udid: "cloned", source: "clone" });
  expect(fake.events).toEqual([
    "clone:11111111-1111-1111-1111-111111111111:work",
    "relocate:11111111-1111-1111-1111-111111111111:cloned",
  ]);
});
test("a clone whose relocation fails is deleted and falls back to plain create", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  fake.relocateFails = true;
  const template = Object.values((await fake.client.listSimulators()).devices).flat()[0]!;
  const clone = { ...template, udid: "cloned", name: "work" };
  const clonedRows = { devices: { ios: [template, clone] } };
  const clonePlainly = fake.client.cloneSimulator;
  fake.client.cloneSimulator = async (udid, name, signal) => {
    const created = await clonePlainly(udid, name, signal);
    fake.rows = clonedRows;
    return created;
  };
  expect(await fake.service().create(fake.request)).toEqual({ udid: "created", source: "create" });
  expect(fake.events).toEqual([
    "clone:11111111-1111-1111-1111-111111111111:work",
    "relocate:11111111-1111-1111-1111-111111111111:cloned",
    "delete:cloned",
    "create:work",
  ]);
  expect(fake.manifest?.state).toBe("ready");
});
test("second consecutive clone failure invalidates and creates", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  fake.cloneFails = true;
  const service = fake.service();
  expect((await service.create(fake.request)).source).toBe("create");
  expect(fake.manifest?.state).toBe("ready");
  expect((await service.create(fake.request)).source).toBe("create");
  expect(fake.manifest?.state).toBe("stale");
  expect(fake.events).toContain("create:work");
  fake.finishBuild();
});
test("concurrent misses request one background build per key", async () => {
  const fake = new SimulatorTemplatesHarness();
  const service = fake.service();
  await Promise.all(Array.from({ length: 8 }, () => service.create(fake.request)));
  expect(fake.builds).toBe(1);
  await service.create({ ...fake.request, deviceType: "tablet" });
  expect(fake.builds).toBe(2);
  fake.finishBuild();
});
test("changed Xcode uses a separate key without foreground deletion", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  fake.xcode = "new";
  await fake.service().create(fake.request);
  expect(fake.events).not.toContain("delete:11111111-1111-1111-1111-111111111111");
  expect(fake.builds).toBe(1);
  fake.finishBuild();
});
for (const state of ["building", "failed", "stale"] as const) {
  test(`${state} templates use plain create and request a build`, async () => {
    const fake = new SimulatorTemplatesHarness();
    fake.ready();
    fake.manifest!.state = state;
    expect((await fake.service().create(fake.request)).source).toBe("create");
    expect(fake.builds).toBe(1);
    expect(fake.events).not.toContain("clone:11111111-1111-1111-1111-111111111111:work");
    fake.finishBuild();
  });
}
test("failed template backoff suppresses background build", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  fake.manifest!.state = "failed";
  fake.manifest!.nextAttemptAtMs = 100;
  expect((await fake.service().create(fake.request)).source).toBe("create");
  expect(fake.builds).toBe(0);
});
test("runtime build change preserves the old template in the foreground", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  fake.manifest!.runtimeBuild = "old";
  fake.manifest!.key.runtimeBuild = "old";
  await fake.service().create(fake.request);
  expect(fake.events).not.toContain("delete:11111111-1111-1111-1111-111111111111");
  expect(fake.builds).toBe(1);
  fake.finishBuild();
});
test("ready template that is no longer shutdown is never cloned", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  const rows = await fake.client.listSimulators();
  Object.values(rows.devices).flat()[0]!.state = "Booted";
  fake.rows = rows;
  expect((await fake.service().create(fake.request)).source).toBe("create");
  expect(fake.manifest?.state).toBe("ready");
  expect(fake.events).toEqual(["create:work"]);
  expect(fake.builds).toBe(0);
});

test("retry starts a background build once the deadline has passed", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  if (!fake.manifest) {
    throw new Error("fixture");
  }
  fake.manifest.state = "failed";
  fake.manifest.nextAttemptAtMs = 100;
  const service = fake.service();
  await service.create(fake.request);
  expect(fake.builds).toBe(0);
  fake.timer.advanceTime(101);
  await service.create(fake.request);
  expect(fake.builds).toBe(1);
  fake.finishBuild();
});

test("a foreign name at the manifest UDID is never cloned", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  const rows = await fake.client.listSimulators();
  for (const row of Object.values(rows.devices).flat()) {
    row.name = "my-simulator";
  }
  fake.rows = rows;
  expect((await fake.service().create(fake.request)).source).toBe("create");
  expect(fake.events.some((event) => event.startsWith("clone:"))).toBe(false);
  fake.finishBuild();
});
test("failed clone removes only new matching UDIDs before fallback creation", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  const rows = await fake.client.listSimulators();
  rows.devices.ios?.push({ udid: "existing", name: "work", state: "Shutdown", isAvailable: true });
  fake.rows = rows;
  fake.client.cloneSimulator = async () => {
    rows.devices.ios?.push({ udid: "partial", name: "work", state: "Shutdown", isAvailable: true });
    throw new Error("partial clone");
  };
  await fake.service().create(fake.request);
  expect(fake.events).toEqual(["delete:partial", "create:work"]);
  fake.finishBuild();
});
test("shutdown cancels the detached background flight and waits for its cleanup", async () => {
  const fake = new SimulatorTemplatesHarness();
  let signal: AbortSignal | undefined;
  let cleaned = false;
  const requestTracker = new NoOpPerformanceTracker();
  // Build an explicit lifetime fake; no request signal owns the background work.
  const service = new SimulatorCreationService(
    fake.client,
    () => true,
    () => ({
      client: fake.client,
      store: fake.store,
      timer: fake.timer,
      profile: () => "none",
      xcode: { readBuild: async () => "X1" },
      lock: { acquire: async () => undefined, acquireName: async () => undefined },
      relocator: fake.relocator,
      builder: {
        build: async (_key, active) => {
          expect(getPerfTracker()).not.toBe(requestTracker);
          signal = active;
          await new Promise<void>((resolve) =>
            active?.addEventListener(
              "abort",
              () => {
                cleaned = true;
                resolve();
              },
              { once: true },
            ),
          );
        },
      },
    }),
  );
  await runWithPerfTracker(requestTracker, () => service.create(fake.request));
  expect(signal?.aborted).toBe(false);
  await service.stop();
  expect(cleaned).toBe(true);
  expect(signal?.aborted).toBe(true);
});
test("failed partial-clone deletion refuses duplicate fallback creation", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  const rows = await fake.client.listSimulators();
  fake.rows = rows;
  fake.client.cloneSimulator = async () => {
    rows.devices.ios?.push({ udid: "partial", name: "work", state: "Shutdown", isAvailable: true });
    throw new Error("partial clone");
  };
  fake.client.deleteSimulator = async () => {
    throw new Error("still exists");
  };
  await expect(fake.service().create(fake.request)).rejects.toThrow("partial simulator clone");
  expect(fake.events).not.toContain("create:work");
});

test("successful clone resets consecutive failures", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  const service = fake.service();
  fake.cloneFails = true;
  await service.create(fake.request);
  expect(fake.manifest?.state).toBe("ready");
  fake.cloneFails = false;
  expect((await service.create(fake.request)).source).toBe("clone");
  fake.cloneFails = true;
  await service.create(fake.request);
  expect(fake.manifest?.state).toBe("ready");
  await service.create(fake.request);
  expect(fake.manifest?.state).toBe("stale");
  fake.finishBuild();
});
for (const condition of ["missing", "renamed", "Booted"]) {
  test(`template ${condition} after clone failure preserves only an in-use template`, async () => {
    const fake = new SimulatorTemplatesHarness();
    fake.ready();
    const rows = await fake.client.listSimulators();
    fake.client.cloneSimulator = async () => {
      if (condition === "missing") {
        fake.rows = { devices: {} };
      } else {
        const row = Object.values(rows.devices).flat()[0]!;
        if (condition === "renamed") {
          row.name = "foreign";
        } else {
          row.state = condition;
        }
        fake.rows = rows;
      }
      throw new Error("clone failed");
    };
    expect((await fake.service().create(fake.request)).source).toBe("create");
    expect(fake.manifest?.state).toBe(condition === "Booted" ? "ready" : "stale");
    fake.finishBuild();
  });
}

test("aborted clone cleans its partial simulator and preserves a healthy template", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  const rows = await fake.client.listSimulators();
  fake.rows = rows;
  const abort = new AbortController();
  fake.client.cloneSimulator = async () => {
    rows.devices.ios?.push({ udid: "partial", name: "work", state: "Shutdown", isAvailable: true });
    abort.abort();
    abort.signal.throwIfAborted();
    return "unreachable";
  };
  await expect(fake.service().create({ ...fake.request, signal: abort.signal })).rejects.toThrow();
  expect(fake.events).toEqual(["delete:partial"]);
  expect(fake.manifest?.state).toBe("ready");
});

test("two consecutive aborted clones do not consume the failure budget", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  const service = fake.service();
  const clone = fake.client.cloneSimulator;
  for (let attempt = 0; attempt < 2; attempt++) {
    const abort = new AbortController();
    fake.client.cloneSimulator = async () => {
      abort.abort();
      abort.signal.throwIfAborted();
      return "unreachable";
    };
    await expect(service.create({ ...fake.request, signal: abort.signal })).rejects.toThrow();
    expect(fake.manifest?.state).toBe("ready");
  }
  fake.client.cloneSimulator = clone;
  fake.cloneFails = true;
  await service.create(fake.request);
  expect(fake.manifest?.state).toBe("ready");
  expect(fake.events.some((event) => event.startsWith("delete:"))).toBe(false);
});

test("marking a template stale clears its previous clone failures", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  const service = fake.service();
  fake.cloneFails = true;
  await service.create(fake.request);
  fake.rows = { devices: {} };
  await service.create(fake.request);
  expect(fake.manifest?.state).toBe("stale");
  fake.rows = undefined;
  fake.ready();
  await service.create(fake.request);
  expect(fake.manifest?.state).toBe("ready");
  fake.finishBuild();
});
