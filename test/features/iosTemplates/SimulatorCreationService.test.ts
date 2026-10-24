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
  expect(fake.events).toEqual(["clone:11111111-1111-1111-1111-111111111111:work"]);
});
test("clone failure invalidates and creates", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  fake.cloneFails = true;
  expect((await fake.service().create(fake.request)).source).toBe("create");
  expect(fake.manifest?.state).toBe("stale");
  expect(fake.events).toContain("create:work");
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
  fake.client.listSimulators = async () => ({ devices: {} });
  expect((await fake.service().create(fake.request)).source).toBe("create");
  expect(fake.manifest?.state).toBe("stale");
  fake.finishBuild();
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
