import { describe, expect, test } from "bun:test";
import { DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD } from "../../src/daemon/constants";
import {
  acquireManagedSlotsThroughDaemon,
  type ManagedSlotProxyAcquisitionPorts,
} from "../../src/daemon/managedSlotProxyAcquisition";
import { parseManagedSlotConfig, type ManagedSlotConfig } from "../../src/models/managedSlotConfig";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { readyManagedSlotsResult } from "../helpers/refusalWireFixtures";

const OLD_CAPABILITIES = ["daemon/registerSession", "managed-slots/v1"];
const NEW_CAPABILITIES = [...OLD_CAPABILITIES, "managed-slots/v1.deviceFamily"];
const SESSION = "session-1";

function configFor(
  platform: "android" | "ios",
  deviceFamily?: "phone" | "tablet",
): ManagedSlotConfig {
  return parseManagedSlotConfig({
    contractVersion: 1,
    managedHostScope: "host",
    runnerNamespace: "runner",
    runnerIncarnation: "incarnation",
    localSlotCapacity: 1,
    preparationTimeoutMs: 100,
    requests: [
      {
        slotIndex: 0,
        role: "app",
        platform,
        requestedSpec: {
          runtime:
            platform === "ios"
              ? "com.apple.CoreSimulator.SimRuntime.iOS-18-0"
              : "system-images;android-34;google_apis;arm64-v8a",
          ...(deviceFamily === undefined ? {} : { deviceFamily }),
        },
      },
    ],
  });
}

function rig(options: { capabilities: readonly string[] }) {
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    options: { timeoutMs: number };
  }> = [];
  const tracked: string[][] = [];
  const held: string[] = [];
  let releases = 0;
  const ports: ManagedSlotProxyAcquisitionPorts = {
    timer: new FakeTimer(),
    livenessOwnerToken: "proxy-owner",
    ensureConnected: async () => {},
    callDaemonMethod: async (method, params, callOptions) => {
      calls.push({ method, params, options: { timeoutMs: callOptions.timeoutMs } });
      if (method === "daemon/capabilities") {
        return { capabilities: options.capabilities };
      }
      expect(method).toBe(DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD);
      return readyManagedSlotsResult(SESSION);
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
    calls,
    tracked,
    held,
    get releases() {
      return releases;
    },
    ports,
  };
}

async function acquire(config: ManagedSlotConfig, harness: ReturnType<typeof rig>) {
  const pending = acquireManagedSlotsThroughDaemon(config, harness.ports);
  await drainMicrotasks(48);
  return await pending;
}

describe("managed slot proxy deviceFamily capability", () => {
  test("forwards the owner PID but omits its proxy-only start identity", async () => {
    const harness = rig({ capabilities: OLD_CAPABILITIES });
    const base = configFor("ios");
    const config = {
      ...base,
      executionOwnerPid: 4242,
      executionOwnerStartIdentity: "linux:boot-id:12345",
    };
    expect((await acquire(config, harness)).outcome).toBe("ready");
    const call = harness.calls.find(
      (entry) => entry.method === DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
    );
    expect(call?.params.config).toEqual({
      ...base,
      executionOwnerPid: 4242,
      preparationTimeoutMs: 75,
    });
    expect(call?.params.config).not.toHaveProperty("executionOwnerStartIdentity");
    expect(config.executionOwnerStartIdentity).toBe("linux:boot-id:12345");
  });

  test.each([
    ["ios", "phone"],
    ["android", "tablet"],
  ] as const)(
    "refuses %s deviceFamily %s before acquisition on an older daemon",
    async (platform, family) => {
      const harness = rig({ capabilities: OLD_CAPABILITIES });
      const result = await acquire(configFor(platform, family), harness);
      expect(result.outcome).toBe("failed");
      expect(result.failure?.code).toBe("contract_unsupported");
      expect(result.failure?.retryable).toBe(false);
      expect(result.failure?.message).toContain("requests.0.requestedSpec.deviceFamily");
      expect(result.failure?.message).toContain("managed-slots/v1.deviceFamily");
      expect(result.failure?.message).toContain("nothing was changed");
      expect(result.failure?.nextAction).toMatch(/upgrade.*daemon/i);
      expect(result.failure?.nextAction).toMatch(/restart/i);
      expect(result.failure?.nextAction).toContain("deviceFamily");
      expect(result.slots).toEqual([]);
      expect(harness.calls.map((call) => call.method)).toEqual(["daemon/capabilities"]);
      expect(harness.tracked).toEqual([]);
      expect(harness.held).toEqual([]);
      expect(harness.releases).toBe(0);
    },
  );

  test("sends deviceFamily and holds the session when advertised", async () => {
    const harness = rig({ capabilities: NEW_CAPABILITIES });
    const config = configFor("ios", "phone");
    const result = await acquire(config, harness);
    expect(harness.calls.map((call) => call.method)).toEqual([
      "daemon/capabilities",
      DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
    ]);
    expect(harness.calls[1]?.params).toEqual({
      config: { ...config, preparationTimeoutMs: 75 },
      livenessOwnerToken: "proxy-owner",
    });
    expect(result.outcome).toBe("ready");
    expect(harness.tracked).toEqual([[SESSION]]);
    expect(harness.held).toEqual([SESSION]);
    expect(harness.releases).toBe(0);
  });

  test("base configs send identical frames to old and new daemons", async () => {
    const old = rig({ capabilities: OLD_CAPABILITIES });
    const newer = rig({ capabilities: NEW_CAPABILITIES });
    const config = configFor("ios");
    expect((await acquire(config, old)).outcome).toBe("ready");
    expect((await acquire(config, newer)).outcome).toBe("ready");
    expect(old.calls).toEqual(newer.calls);
    expect(old.calls.map((call) => call.method)).toEqual([
      "daemon/capabilities",
      DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
    ]);
  });

  test("base contract refusal wins when managed-slots/v1 is absent", async () => {
    const harness = rig({ capabilities: ["daemon/registerSession"] });
    const result = await acquire(configFor("ios", "phone"), harness);
    expect(result.failure?.code).toBe("contract_unsupported");
    expect(result.failure?.message).toBe(
      "The running daemon does not advertise managed-slots/v1; nothing was changed.",
    );
    expect(harness.calls.map((call) => call.method)).toEqual(["daemon/capabilities"]);
  });
});
