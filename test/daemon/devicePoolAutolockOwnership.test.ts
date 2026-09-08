import { expect, spyOn, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up } from "../../src/db/migrations/2026_04_02_000_device_sessions";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../../test/fakes/FakeTimer";
import { FakeIdGenerator } from "../../test/fakes/FakeIdGenerator";
import { FakeDeviceManager } from "../../test/fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../../test/fakes/FakeInstalledAppsRepository";
import { FakeDbWriteBarrier } from "../../test/fakes/FakeDbWriteBarrier";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/utils/virtualDeviceLifecycleCoordinator";
import { FakeDeviceMatcher } from "../../test/fakes/FakeDeviceMatcher";
import { FakeDeviceUtils } from "../../test/fakes/FakeDeviceUtils";
import { DaemonState } from "../../src/daemon/daemonState";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { getDeviceSessionIdFromResult } from "../../src/server/deviceSessionResult";

async function harness() {
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: new Sqlite(":memory:") }),
  });
  await up(db as Kysely<unknown>);
  const repository = new DeviceSessionRepository(db);
  const timer = new FakeTimer();
  const barrier = new FakeDbWriteBarrier();
  const manager = new SessionManager(timer, repository, () => barrier);
  const devices = new FakeDeviceManager(
    [],
    [{ deviceId: "emulator-5554", name: "Agent A AVD", platform: "android" }],
  );
  const pool = new DevicePool(
    manager,
    "hunt-daemon",
    timer,
    new FakeInstalledAppsRepository(),
    devices,
    new DefaultRetryExecutor(timer),
    repository,
    undefined,
    undefined,
    undefined,
    undefined,
    { onLoss: false, maxAttempts: 2 },
    undefined,
    undefined,
    undefined,
    new FakeIdGenerator(),
    new InMemoryVirtualDeviceLifecycleCoordinator(timer),
  );
  await pool.initializeWithDevices(devices.bootedDevices);
  return {
    db,
    repository,
    timer,
    manager,
    devices,
    pool,
    close: async () => {
      manager.stopCleanupTimer();
      await db.destroy();
    },
  };
}

async function withAutolock(work: () => Promise<void>): Promise<void> {
  const previous = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
  process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
  try {
    await work();
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previous;
    }
  }
}

test.each(["agent-B", undefined])(
  "rejects a competing or unidentified autolock client: %s",
  async (client) => {
    await withAutolock(async () => {
      const h = await harness();
      try {
        const first = (await h.pool.autolockDevice("emulator-5554", "android", "agent-A"))!;
        const original = await h.repository.getSession(first);
        await expect(h.pool.autolockDevice("emulator-5554", "android", client)).rejects.toThrow(
          "already assigned",
        );
        expect(h.pool.getDevice("emulator-5554")?.sessionId).toBe(first);
        expect(h.manager.getSessionForDevice("emulator-5554")).toBe(first);
        expect(h.manager.getSession(first)?.assignedDevice).toBe("emulator-5554");
        expect(h.pool.resolveAutolockSessionForMcpSession("agent-A")).toBe(first);
        expect(() => h.pool.assertAutolockAccess("emulator-5554", first)).not.toThrow();
        expect(await h.repository.getSession(first)).toEqual(original);
        expect(await h.db.selectFrom("device_sessions").selectAll().execute()).toHaveLength(1);
      } finally {
        await h.close();
      }
    });
  },
);

test("same MCP client reuses its live autolock without rotating ownership", async () => {
  await withAutolock(async () => {
    const h = await harness();
    try {
      const first = (await h.pool.autolockDevice("emulator-5554", "android", "agent-A"))!;
      const original = await h.repository.getSession(first);
      h.timer.advanceTime(1000);
      expect(await h.pool.autolockDevice("emulator-5554", "android", "agent-A")).toBe(first);
      expect(h.pool.getDevice("emulator-5554")?.assignmentCount).toBe(1);
      expect(h.manager.getSessionForDevice("emulator-5554")).toBe(first);
      expect(h.pool.resolveAutolockSessionForMcpSession("agent-A")).toBe(first);
      expect(h.manager.getDeviceReadiness(first)).toBe("automationReady");
      const row = await h.repository.getSession(first);
      expect(row?.mcp_session_id).toBe(original?.mcp_session_id);
      expect(row?.autolock_enabled).toBe(1);
      expect(row?.last_used_at_ms).toBe(h.timer.now());
      expect(await h.db.selectFrom("device_sessions").selectAll().execute()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});

test("concurrent clients cannot both acquire the same autolock", async () => {
  await withAutolock(async () => {
    const h = await harness();
    try {
      const results = await Promise.allSettled([
        h.pool.autolockDevice("emulator-5554", "android", "agent-A"),
        h.pool.autolockDevice("emulator-5554", "android", "agent-B"),
      ]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(h.manager.getActiveSessionCount()).toBe(1);
      expect(await h.db.selectFrom("device_sessions").selectAll().execute()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});

test("does not return a reused UUID released during activity persistence", async () => {
  await withAutolock(async () => {
    const h = await harness();
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const recordActivity = h.repository.recordActivity.bind(h.repository);
    const activity = spyOn(h.repository, "recordActivity");
    try {
      const first = (await h.pool.autolockDevice("emulator-5554", "android", "agent-A"))!;
      activity.mockImplementationOnce(async (id, update) => {
        started.resolve();
        await finished.promise;
        await recordActivity(id, update);
      });
      const reacquiring = h.pool
        .autolockDevice("emulator-5554", "android", "agent-A")
        .catch((error: unknown) => error);
      await started.promise;
      await h.manager.releaseSession(first);
      await h.pool.releaseDevice("emulator-5554", first);
      finished.resolve();
      expect(await reacquiring).toMatchObject({
        message: "Device 'emulator-5554' was released during autolock acquisition.",
      });
      expect(h.manager.getSession(first)).toBeNull();
      expect(h.pool.getDevice("emulator-5554")?.sessionId).toBeNull();
      expect((await h.repository.getSession(first))?.status).toBe("released");
    } finally {
      finished.resolve();
      activity.mockRestore();
      await h.close();
    }
  });
});

test("same-client reuse cannot bypass the fresh-start ownership guard", async () => {
  await withAutolock(async () => {
    const h = await harness();
    try {
      const first = (await h.pool.autolockDevice("emulator-5554", "android", "agent-A"))!;
      await expect(
        h.pool.autolockDevice("emulator-5554", "android", "agent-A", {
          name: "Agent A AVD",
          platform: "android",
          isRunning: false,
          source: "local",
        }),
      ).rejects.toThrow("Freshly started device");
      expect(h.pool.getDevice("emulator-5554")?.sessionId).toBe(first);
    } finally {
      await h.close();
    }
  });
});

test("registered getAndroid preserves its caller's UUID and rejects a different client", async () => {
  await withAutolock(async () => {
    const h = await harness();
    const matcher = new FakeDeviceMatcher();
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("android", h.devices.bootedDevices);
    matcher.setBootedResult(h.devices.bootedDevices[0]);
    DaemonState.getInstance().initialize(h.manager, h.pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deviceUtils,
      deviceMatcherFactory: () => matcher,
      ensureCtrlProxyReady: async () => {},
      notifyResourcesChanged: async () => {},
      timer: h.timer,
      idGenerator: new FakeIdGenerator(),
      lifecycleCoordinator: new InMemoryVirtualDeviceLifecycleCoordinator(h.timer),
    });
    registerDeviceTools();
    try {
      const handler = ToolRegistry.getTool("getAndroid")!.handler;
      const args = { deviceId: "emulator-5554", __mcpSessionId: "agent-A" };
      const first = getDeviceSessionIdFromResult(await handler(args));
      expect(first).toBeDefined();
      expect(getDeviceSessionIdFromResult(await handler(args))).toBe(first);
      await expect(handler({ ...args, __mcpSessionId: "agent-B" })).rejects.toThrow(
        "already assigned",
      );
      expect(h.pool.getDevice("emulator-5554")?.sessionId).toBe(first);
      expect(h.manager.getActiveSessionCount()).toBe(1);
    } finally {
      resetDeviceToolsDependencies();
      DaemonState.getInstance().reset();
      ToolRegistry.clearTools();
      await h.close();
    }
  });
});
