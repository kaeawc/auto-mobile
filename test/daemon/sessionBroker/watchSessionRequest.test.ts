import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import { ManagedDevicePort } from "../../../src/daemon/sessionBroker/managedDevicePort";
import type { ManagedDevicePortDependencies } from "../../../src/daemon/sessionBroker/managedDevicePort";
import type { BindingsResult } from "../../../src/daemon/sessionBroker/provisioning/acquisitionResult";
import type { BrokerExecutionReleaseResult } from "../../../src/daemon/sessionBroker/provisioning/executionRelease";
import type { BrokerProvisionRequest } from "../../../src/daemon/sessionBroker/provisioning/provisionRequest";
import {
  computeBindingScopeKey,
  type BindingScopeIdentity,
} from "../../../src/daemon/sessionBroker/registry/bindingRegistry";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { parseTimingReceipt } from "../../../src/daemon/sessionBroker/timingSchema";
import { adaptWatchSessionDeviceCatalog } from "../../../src/devices/sessionCatalog";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import type {
  SessionDeviceCatalog,
  SessionDeviceRequirement,
} from "../../../src/devices/sessionRequirements";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { WATCH_DEVICE_TYPE, WATCH_RUNTIME, WATCH_RUNTIME_ID } from "../../fakes/FakeWatchSimctl";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";

// A client session request for an Apple Watch (#15882) through the broker and the managed device
// port: admission against the watch catalog, part 2's watch binding request, the receipt with the
// booted readiness, the shared device limit, and the release reset in the iOS reuse mode.

const SCOPE: BindingScopeIdentity = {
  managedHostScope: "broker-host",
  runnerNamespace: "private-session-broker",
  runnerIncarnation: "persistent-pool-v1",
};
const SCOPE_KEY = computeBindingScopeKey(SCOPE);
const OWNER = { daemonId: "broker-daemon", pid: 101, processGenerationToken: "gen" };
const SPEC = { runtime: WATCH_RUNTIME_ID, deviceType: WATCH_DEVICE_TYPE.identifier };
const WATCH_REQUEST: SessionDeviceRequirement = {
  schemaVersion: 1,
  platform: "watchos",
  spec: SPEC,
};
const IOS_REQUEST: SessionDeviceRequirement = {
  schemaVersion: 1,
  platform: "ios",
  hardware: { kind: "omitted" },
  os: { kind: "omitted" },
};
const WATCH_PROFILE = { platform: "watchos", metadataState: "current", ...SPEC } as const;

function config(requestId: string, device = WATCH_REQUEST): SessionConfig {
  return { contractVersion: 1, requestId, device };
}

function watchCatalog(): SessionDeviceCatalog {
  return adaptWatchSessionDeviceCatalog({
    runtimes: [WATCH_RUNTIME],
    deviceTypes: [WATCH_DEVICE_TYPE],
  });
}

function released(sessionId: string): BrokerExecutionReleaseResult {
  return {
    sessionId,
    outcome: "reusable_for_this_binding",
    settlement: "confirmed",
    alreadyReleased: false,
    cancellationRequested: 0,
    releaseForced: false,
    device: "device",
    bindings: [],
    bindingFailures: [],
  };
}

describe("a client session request for an Apple Watch", () => {
  let registry: SqliteBindingRegistry;
  let requests: BrokerProvisionRequest[];
  let resets: string[];
  let catalog: SessionDeviceCatalog | undefined;
  let sessions: CountingIdGenerator;
  let executions: Map<string, { scopeKey: string; bindingIndex: number }>;
  let watchReadiness: { mode: string; status: string };
  let recorded: string[];

  beforeAll(async () => {
    // Warm SQLite/migration setup outside the per-test budget.
    await (await openSqliteBindingRegistry({ dbPath: ":memory:" })).close();
  });

  beforeEach(async () => {
    registry = await openSqliteBindingRegistry({ dbPath: ":memory:" });
    await registry.ensureScope(SCOPE);
    requests = [];
    resets = [];
    catalog = undefined;
    sessions = new CountingIdGenerator("session");
    executions = new Map();
    watchReadiness = { mode: "none", status: "device_ready" };
    recorded = [];
  });

  afterEach(async () => {
    await registry.close();
  });

  /** Part 2's acquisition, faked: binds the requested device and reports its readiness. */
  async function acquire(request: BrokerProvisionRequest): Promise<BindingsResult> {
    requests.push(request);
    const entry = request.requests[0]!;
    const key = { scopeKey: SCOPE_KEY, bindingIndex: entry.bindingIndex };
    await registry.initBinding(key, {
      platform: entry.platform,
      role: entry.role,
      requestedSpec: entry.requestedSpec,
    });
    let assignment = (await registry.getAssignment(key))!;
    const stableId = `${entry.platform}-udid-${entry.bindingIndex}`;
    if (!assignment.stableDeviceId) {
      const bound = await registry.commitBinding(key, assignment, {
        stableDeviceId: stableId,
        deviceName: `ambroker-${entry.bindingIndex}`,
        resolvedSpec: entry.requestedSpec,
        specFingerprint: "fp",
        state: "ready",
      });
      if (bound.kind !== "committed") {
        throw new Error(bound.kind);
      }
      assignment = bound.assignment;
    }
    const sessionUuid = sessions.next();
    const claimed = await registry.claimExecution(key, assignment, { ...OWNER, sessionUuid });
    if (claimed.kind !== "claimed") {
      throw new Error(claimed.kind);
    }
    executions.set(sessionUuid, key);
    return {
      contractVersion: 1,
      scope: { ...SCOPE, scopeKey: SCOPE_KEY },
      outcome: "ready",
      bindings: [
        {
          bindingIndex: entry.bindingIndex,
          role: entry.role,
          platform: entry.platform,
          assignmentGeneration: assignment.generation,
          device: { stableId, transportId: stableId, name: `ambroker-${entry.bindingIndex}` },
          sessionUuid,
          requestedSpec: entry.requestedSpec,
          resolvedSpec: entry.requestedSpec,
          specFingerprint: { version: 1, hash: "fp" },
          disposition: "created",
          readiness:
            entry.platform === "watchos"
              ? watchReadiness
              : { mode: "automation", status: "automation_ready" },
          lifecycle: {},
        },
      ],
    };
  }

  function broker(
    options: { totalDeviceCap?: number; reuse?: boolean; watchReset?: boolean } = {},
  ): SessionBroker {
    const resetBaseline: ManagedDevicePortDependencies["resetBaseline"] = options.watchReset
      ? {
          watch: async (device, profile, assertOwned) => {
            await assertOwned();
            resets.push(`${device.platform}:${device.deviceId}:${profile.deviceType}`);
            return { outcome: "clean", mode: "erase", phases: { erase: 1 } };
          },
        }
      : undefined;
    const port = new ManagedDevicePort({
      scope: SCOPE,
      timer: new FakeTimer(),
      brokerDeviceAcquisition: { acquire },
      brokerExecutionRelease: {
        releaseExecution: async (id) => {
          const key = executions.get(id);
          if (key) {
            await registry.releaseExecution(key, id);
          }
          return released(id);
        },
      },
      registry,
      bindingJournal: {
        owner: OWNER,
        redriveBinding: async () => ({ kind: "clear", redriven: [] }),
      },
      bindMutationRecorder: (scope) => void recorded.push(scope.sessionUuid),
      ...(resetBaseline ? { resetBaseline, isCurrentReset: async () => true } : {}),
    });
    return new SessionBroker({
      store: registry.sessionBrokerStore(SCOPE_KEY, new CountingIdGenerator("resource")),
      devices: port,
      owner: OWNER,
      limits: { totalDeviceCap: options.totalDeviceCap ?? 2, sessionCap: 2, idlePoolCap: 2 },
      catalog: async (platform) =>
        platform === "watchos" ? (catalog ?? watchCatalog()) : iosCatalog(),
      defaults: () => iosDefaults(),
      reuseCleanDevices: options.reuse === true,
    });
  }

  test("resolves the exact watch profile to a watch binding and reports it booted", async () => {
    const subject = broker();
    try {
      const result = await subject.prepare(config("watch-1"), "owner");

      expect(requests.map((request) => request.requests[0])).toEqual([
        {
          bindingIndex: 1,
          role: expect.any(String),
          platform: "watchos",
          requestedSpec: SPEC,
        },
      ]);
      expect(result).toEqual({
        contractVersion: 1,
        requestId: "watch-1",
        outcome: "ready",
        sessionUuid: "session-1",
        profile: WATCH_PROFILE,
        readiness: { mode: "none", status: "device_ready" },
        cleanupPending: false,
        timing: expect.any(Object),
      });
      // The receipt replays byte-identically.
      expect(await subject.prepare(config("watch-1"), "owner")).toEqual(result);
      expect(requests).toHaveLength(1);
    } finally {
      await subject.close();
    }
  });

  test("a watch session binds no device-mutation recorder; an iOS session still does", async () => {
    const subject = broker();
    try {
      await subject.prepare(config("watch-1"), "owner");
      await subject.prepare(config("ios-1", IOS_REQUEST), "owner");
      expect(recorded).toEqual(["session-2"]);
    } finally {
      await subject.close();
    }
  });

  test.each([
    { mode: "automation", status: "automation_ready" },
    { mode: "none", status: "booting" },
  ])("a watch binding reported %j is not a ready session", async (readiness) => {
    watchReadiness = readiness;
    const subject = broker();
    try {
      expect(await subject.prepare(config("watch-1"), "owner")).toMatchObject({
        outcome: "failed",
        sessionUuid: null,
      });
    } finally {
      await subject.close();
    }
  });

  test("Android and iOS receipts and binding requests keep their shapes, with no readiness", async () => {
    const subject = broker();
    try {
      const result = await subject.prepare(config("ios-1", IOS_REQUEST), "owner");

      expect(result.outcome).toBe("ready");
      expect(Object.keys(result).sort()).toEqual([
        "cleanupPending",
        "contractVersion",
        "outcome",
        "profile",
        "requestId",
        "sessionUuid",
        "timing",
      ]);
      expect(requests[0]!.requests[0]).toEqual({
        bindingIndex: 1,
        role: expect.any(String),
        platform: "ios",
        requestedSpec: {
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
          deviceType: expect.stringContaining("com.apple.CoreSimulator.SimDeviceType."),
        },
      });
    } finally {
      await subject.close();
    }
  });

  test("an unknown device type is refused before any reservation or native work, naming the available ones", async () => {
    const subject = broker();
    try {
      const ultra = "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-2-49mm";
      const result = await subject.prepare(
        config("ultra", { ...WATCH_REQUEST, spec: { ...SPEC, deviceType: ultra } }),
        "owner",
      );

      expect(result).toMatchObject({
        outcome: "failed",
        profile: null,
        failure: { code: "unsupported_hardware", retryable: false },
      });
      expect(result.failure?.message).toContain(`Available: ${WATCH_DEVICE_TYPE.identifier}`);
      expect(requests).toEqual([]);
    } finally {
      await subject.close();
    }
  });

  test("a host without watch simulators refuses permanently; an unreadable catalog is retryable", async () => {
    const subject = broker();
    try {
      catalog = {
        platform: "watchos",
        provenance: { source: "s", revision: "not-installed", state: "not-installed" },
        runtimes: [],
        deviceTypes: [],
      };
      expect(await subject.prepare(config("linux"), "owner")).toMatchObject({
        outcome: "failed",
        failure: { code: "unsupported_hardware", retryable: false },
      });
      catalog = { ...catalog, provenance: { ...catalog.provenance, state: "unavailable" } };
      expect(await subject.prepare(config("unreadable"), "owner")).toMatchObject({
        outcome: "failed",
        failure: { code: "catalog_unavailable", retryable: true },
      });
      expect(requests).toEqual([]);
    } finally {
      await subject.close();
    }
  });

  test("the watch counts in the one shared device limit", async () => {
    const subject = broker({ totalDeviceCap: 1 });
    try {
      expect((await subject.prepare(config("ios-1", IOS_REQUEST), "owner")).outcome).toBe("ready");

      const watch = await subject.prepare(config("watch-over-cap"), "owner");

      expect(watch.outcome).toBe("failed");
      expect(watch.failure?.retryable).toBe(true);
      expect(requests.map((request) => request.requests[0]!.platform)).toEqual(["ios"]);
    } finally {
      await subject.close();
    }
  });

  test("a released watch is reset in the iOS reuse mode and reused by the next exact request", async () => {
    const subject = broker({ reuse: true, watchReset: true });
    try {
      const first = await subject.prepare(config("watch-1"), "owner");
      expect(await subject.release(first.sessionUuid!)).toMatchObject({ outcome: "released" });

      expect(resets).toEqual([`watchos:watchos-udid-1:${SPEC.deviceType}`]);
      const second = await subject.prepare(config("watch-2"), "owner");
      expect(second).toMatchObject({
        outcome: "ready",
        profile: WATCH_PROFILE,
        readiness: { mode: "none", status: "device_ready" },
        timing: { acquisition: { admission: "reuse" } },
      });
      expect(requests.map((request) => request.requests[0]!.bindingIndex)).toEqual([1, 1]);
    } finally {
      await subject.close();
    }
  });

  test("without iOS reuse a released watch is destroyed, not reset", async () => {
    const subject = broker({ watchReset: true });
    try {
      const first = await subject.prepare(config("watch-1"), "owner");
      await subject.release(first.sessionUuid!);
      expect(resets).toEqual([]);
    } finally {
      await subject.close();
    }
  });

  test("a watch timing receipt parses with its exact profile", () => {
    expect(
      parseTimingReceipt(
        JSON.stringify({
          reset: {
            mode: "erase",
            outcome: "clean",
            phases: { erase: 1 },
            reuseCount: 0,
            startedAtMs: 0,
            totalMs: 1,
          },
        }),
        JSON.stringify(WATCH_PROFILE),
      ),
    ).toMatchObject({ profile: WATCH_PROFILE });
  });
});
