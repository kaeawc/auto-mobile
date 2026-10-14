import { describe, expect, test } from "bun:test";
import { DaemonHandshakeMismatchError } from "../../src/daemon/client";
import { DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD } from "../../src/daemon/constants";
import {
  DaemonBuildMismatchError,
  DaemonVersionMismatchError,
} from "../../src/daemon/daemonMcpProxy";
import {
  acquireManagedSlotsThroughDaemon,
  type ManagedSlotProxyAcquisitionPorts,
} from "../../src/daemon/managedSlotProxyAcquisition";
import { parseManagedSlotConfig } from "../../src/models/managedSlotConfig";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { readyManagedSlotsResult } from "../helpers/refusalWireFixtures";

const CONFIG = parseManagedSlotConfig({
  contractVersion: 1,
  managedHostScope: "host",
  runnerNamespace: "runner",
  runnerIncarnation: "inc",
  localSlotCapacity: 1,
  preparationTimeoutMs: 100,
  requests: [{ slotIndex: 0, role: "app", platform: "ios", requestedSpec: { runtime: "ios-18" } }],
});

function rig(capabilities: readonly string[], probeError?: Error) {
  const calls: Array<{ method: string; params: Record<string, unknown>; timeoutMs: number }> = [];
  const tracked: string[][] = [];
  const held: string[] = [];
  let releases = 0;
  const ports: ManagedSlotProxyAcquisitionPorts = {
    timer: new FakeTimer(),
    livenessOwnerToken: "proxy-owner",
    ensureConnected: async () => {},
    callDaemonMethod: async (method, params, options) => {
      calls.push({ method, params, timeoutMs: options.timeoutMs });
      if (method === "daemon/capabilities") {
        if (probeError) {
          throw probeError;
        }
        return { capabilities };
      }
      expect(method).toBe(DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD);
      return readyManagedSlotsResult("session-1");
    },
    trackAcquiredSessions: (ids) => {
      tracked.push([...ids]);
    },
    holdSession: async (id) => {
      held.push(id);
    },
    releaseHeldSessions: async () => {
      releases++;
    },
  };
  return {
    ports,
    calls,
    tracked,
    held,
    get releases() {
      return releases;
    },
  };
}

async function acquire(harness: ReturnType<typeof rig>) {
  const pending = acquireManagedSlotsThroughDaemon(CONFIG, harness.ports);
  await drainMicrotasks(48);
  return await pending;
}

describe("managed slot proxy compatibility", () => {
  test.each([
    ...(["daemonNewer", "autoStartDisabled", "nonNumeric", "restartMismatch"] as const).map(
      (reason) =>
        new DaemonVersionMismatchError({
          clientVersion: "0.0.70",
          daemonVersion:
            reason === "daemonNewer" ? "0.0.71" : reason === "nonNumeric" ? "dev" : "0.0.68",
          reason,
          detail: "version differs at connect",
          clientBuild: { buildId: "new", entryScript: "/new" },
          daemonBuild: { buildId: "old", entryScript: "/old" },
        }),
    ),
    ...(["autoStartDisabled", "restartMismatch"] as const).map(
      (reason) =>
        new DaemonBuildMismatchError({
          client: { buildId: "new", entryScript: "/new" },
          daemon: { buildId: "old", entryScript: "/old" },
          reason,
          detail: "build differs at connect",
        }),
    ),
  ])("a connect-time $name ($reason) is terminal before any daemon call", async (error) => {
    const harness = rig(["managed-slots/v1"]);
    harness.ports.ensureConnected = async () => {
      throw error;
    };
    const result = await acquire(harness);
    expect(result).toMatchObject({
      outcome: "failed",
      slots: [],
      failure: { code: "contract_unsupported", retryable: false },
    });
    expect(result.failure?.message).toContain(error.reason);
    expect(result.failure?.message).toContain(error.message);
    expect(result.failure?.nextAction).toBe(
      "Restart the daemon from this client's installation (`auto-mobile --daemon restart`) so frontend and daemon match; nothing was changed.",
    );
    expect(harness.calls).toEqual([]);
    expect(harness.tracked).toEqual([]);
    expect(harness.held).toEqual([]);
    expect(harness.releases).toBe(0);
  });

  test.each([
    new DaemonVersionMismatchError({
      clientVersion: "0.0.70",
      daemonVersion: "0.0.68",
      reason: "cooldown",
      detail: "restart is in cooldown",
      retryAfterMs: 100,
      clientBuild: { buildId: "new", entryScript: "/new" },
      daemonBuild: { buildId: "old", entryScript: "/old" },
    }),
    new DaemonBuildMismatchError({
      client: { buildId: "new", entryScript: "/new" },
      daemon: { buildId: "old", entryScript: "/old" },
      reason: "cooldown",
      detail: "restart is in cooldown",
      retryAfterMs: 100,
    }),
  ])("a connect-time $name cooldown remains retryable", async (error) => {
    const harness = rig(["managed-slots/v1"]);
    harness.ports.ensureConnected = async () => {
      throw error;
    };
    const result = await acquire(harness);
    expect(result).toMatchObject({
      outcome: "failed",
      slots: [],
      failure: { code: "daemon_unavailable", retryable: true },
    });
    expect(result.failure?.message).toContain(error.message);
    expect(harness.calls).toEqual([]);
    expect(harness.tracked).toEqual([]);
    expect(harness.held).toEqual([]);
    expect(harness.releases).toBe(0);
  });

  test.each(["version", "build"] as const)(
    "a %s handshake mismatch is terminal before acquisition",
    async (reason) => {
      const error = new DaemonHandshakeMismatchError(
        {
          code: "daemon_identity_mismatch",
          phase: "daemon-preflight",
          executionStarted: false,
          reason,
          daemon: { version: "0.0.68", build: { buildId: "old", entryScript: "/old" } },
          client: { clientVersion: "0.0.70", clientBuildId: "new", clientEntryScript: "/new" },
        },
        `daemon ${reason} mismatch`,
      );
      const harness = rig(["managed-slots/v1"], error);
      const result = await acquire(harness);
      expect(result).toMatchObject({
        outcome: "failed",
        slots: [],
        failure: { code: "contract_unsupported", retryable: false },
      });
      expect(result.failure?.message).toContain(reason);
      expect(result.failure?.message).toContain(error.message);
      expect(result.failure?.nextAction).toBe(
        "Restart the daemon from this client's installation (`auto-mobile --daemon restart`) so frontend and daemon match; nothing was changed.",
      );
      expect(harness.calls.map(({ method }) => method)).toEqual(["daemon/capabilities"]);
      expect(harness.tracked).toEqual([]);
      expect(harness.held).toEqual([]);
      expect(harness.releases).toBe(0);
    },
  );

  test("an unknown future contract alone refuses before acquisition", async () => {
    const harness = rig(["managed-slots/v2"]);
    const result = await acquire(harness);
    expect(result).toMatchObject({
      outcome: "failed",
      slots: [],
      failure: { code: "contract_unsupported", retryable: false },
    });
    expect(result.failure?.message).toContain("managed-slots/v1");
    expect(harness.calls.map(({ method }) => method)).toEqual(["daemon/capabilities"]);
    expect(harness.tracked).toEqual([]);
    expect(harness.held).toEqual([]);
    expect(harness.releases).toBe(0);
  });

  test("v1 plus unknown capability tokens sends the identical acquisition frame", async () => {
    const base = rig(["managed-slots/v1"]);
    const future = rig(["managed-slots/v1", "managed-slots/v2", "future/unknown"]);
    expect((await acquire(base)).outcome).toBe("ready");
    expect((await acquire(future)).outcome).toBe("ready");
    expect(future.calls).toEqual(base.calls);
    expect(future.calls).toEqual([
      { method: "daemon/capabilities", params: {}, timeoutMs: 100 },
      {
        method: DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
        params: {
          config: { ...CONFIG, preparationTimeoutMs: 75 },
          livenessOwnerToken: "proxy-owner",
        },
        timeoutMs: 100,
      },
    ]);
    expect(future.tracked).toEqual([["session-1"]]);
    expect(future.held).toEqual(["session-1"]);
  });

  // contractVersion: 2 is already pinned before other validation in managedSlotConfig.test.ts.
});
