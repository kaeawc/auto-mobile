import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BindingRegistrySchemaUnsupportedError } from "../../../../src/daemon/sessionBroker/provisioning/BindingRegistrySchemaUnsupportedError";
import {
  BrokerDeviceAcquisition,
  type BrokerDeviceAcquisitionSessions,
} from "../../../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
import {
  DefaultManagedSpecResolver,
  BindingReconciler,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import { computeBindingScopeKey } from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { buildBrokerProvisionRequest } from "../../../helpers/provisionRequestFixture";
import { type BrokerProvisionRequest } from "../../../../src/daemon/sessionBroker/provisioning/provisionRequest";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../registry/fixtures/reconcilerFakes";

const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IOS_17 = "com.apple.CoreSimulator.SimRuntime.iOS-17-5";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const TOKEN = "proxy-token";
const DAEMON_PID = 4242;

function configFor(
  overrides: { runnerIncarnation?: string; runtime?: string; idleTimeoutMs?: number } = {},
): BrokerProvisionRequest {
  return buildBrokerProvisionRequest({
    contractVersion: 1,
    managedHostScope: "host-a",
    runnerNamespace: "ns",
    runnerIncarnation: overrides.runnerIncarnation ?? "inc-1",
    localBindingCapacity: 1,
    ...(overrides.idleTimeoutMs ? { idleTimeoutMs: overrides.idleTimeoutMs } : {}),
    requests: [
      {
        bindingIndex: 0,
        role: "app",
        platform: "ios",
        requestedSpec: { runtime: overrides.runtime ?? IOS_18, deviceType: IPHONE_16 },
      },
    ],
  });
}

class FakeSessions implements BrokerDeviceAcquisitionSessions {
  claimOutcome: "claimed" | "conflict" = "claimed";
  readonly claims: Array<[string, string]> = [];
  readonly adopted: Array<[string, number | undefined]> = [];
  readonly released: string[] = [];
  async claimLivenessOwnership(sessionId: string, ownerToken: string) {
    this.claims.push([sessionId, ownerToken]);
    return this.claimOutcome;
  }
  async adoptManagedExecutionLivenessPolicy(
    sessionId: string,
    options: { idleTimeoutMs?: number },
  ): Promise<void> {
    this.adopted.push([sessionId, options.idleTimeoutMs]);
  }
  async releaseSession(sessionId: string): Promise<void> {
    this.released.push(sessionId);
  }
}

describe("BrokerDeviceAcquisition", () => {
  let timer: FakeTimer;
  let registry: FakeBindingRegistry;
  let inventory: FakeInventory;
  let provisioner: FakeProvisioner;
  let deleter: FakeDeleter;
  let sessions: FakeSessions;
  let livePids: Set<number>;
  let reconciler: BindingReconciler;
  let acquisition: BrokerDeviceAcquisition;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    livePids = new Set([DAEMON_PID]);
    const isLive = (owner: { pid: number }) => livePids.has(owner.pid);
    registry = new FakeBindingRegistry(timer, isLive);
    inventory = new FakeInventory();
    provisioner = new FakeProvisioner(inventory);
    deleter = new FakeDeleter(inventory);
    sessions = new FakeSessions();
    reconciler = new BindingReconciler({
      registry,
      inventory,
      matcher: new FakeMatcher(),
      resolver: new DefaultManagedSpecResolver(),
      provisioner,
      deleter,
      claims: new FakeClaims(),
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: isLive,
    });
    acquisition = new BrokerDeviceAcquisition({
      registry: async () => registry,
      reconcile: (_registry, request) => reconciler.reconcile(request),
      sessions,
      owner: () => ({ daemonId: "daemon-1", pid: DAEMON_PID }),
      timer,
    });
  });

  /** End the previous execution the way the drain does: clear the owner, keep the device. */
  async function endExecution(config: BrokerProvisionRequest, sessionUuid: string): Promise<void> {
    await registry.releaseExecution(
      { scopeKey: computeBindingScopeKey(config), bindingIndex: 0 },
      sessionUuid,
    );
  }

  test("creates the binding's device and hands its fresh session to the caller's token", async () => {
    const config = configFor({ idleTimeoutMs: 10 * 60_000 });

    const result = await acquisition.acquire(config, { livenessOwnerToken: TOKEN });

    expect(result).toMatchObject({
      contractVersion: 1,
      outcome: "ready",
      scope: { runnerIncarnation: "inc-1", scopeKey: computeBindingScopeKey(config) },
      idleTimeoutMs: 10 * 60_000,
      bindings: [
        {
          bindingIndex: 0,
          role: "app",
          platform: "ios",
          disposition: "created",
          assignmentGeneration: 1,
          sessionUuid: "session-1",
          readiness: { mode: "automation", status: "automation_ready" },
          specFingerprint: { version: 1 },
        },
      ],
    });
    expect(sessions.claims).toEqual([["session-1", TOKEN]]);
    expect(sessions.adopted).toEqual([["session-1", 10 * 60_000]]);
    const assignment = await registry.getAssignment({
      scopeKey: computeBindingScopeKey(config),
      bindingIndex: 0,
    });
    expect(assignment?.execOwner).toMatchObject({ pid: DAEMON_PID, sessionUuid: "session-1" });
  });

  test("a later execution reuses the binding's device with a fresh session", async () => {
    const config = configFor();
    const first = await acquisition.acquire(config, { livenessOwnerToken: TOKEN });
    await endExecution(config, first.bindings[0]!.sessionUuid!);

    const second = await acquisition.acquire(config, { livenessOwnerToken: "next-token" });

    expect(second.bindings[0]).toMatchObject({ disposition: "reused", sessionUuid: "session-2" });
    expect(second.bindings[0]!.device).toEqual(first.bindings[0]!.device);
    expect(provisioner.created()).toHaveLength(1);
  });

  test("a live execution on the binding refuses a duplicate with retryable binding_in_use", async () => {
    const config = configFor();
    await acquisition.acquire(config, { livenessOwnerToken: TOKEN });

    const duplicate = await acquisition.acquire(config, { livenessOwnerToken: "dup" });

    expect(duplicate.outcome).toBe("failed");
    expect(duplicate.failure).toMatchObject({ code: "binding_in_use", retryable: true });
    expect(duplicate.bindings[0]!.sessionUuid).toBeNull();
  });

  test("a spec change replaces the device in the same binding", async () => {
    const config = configFor();
    const first = await acquisition.acquire(config, { livenessOwnerToken: TOKEN });
    await endExecution(config, first.bindings[0]!.sessionUuid!);

    const changed = await acquisition.acquire(configFor({ runtime: IOS_17 }), {
      livenessOwnerToken: TOKEN,
    });

    expect(changed.bindings[0]).toMatchObject({ disposition: "replaced", assignmentGeneration: 4 });
    expect(deleter.calls.map((call) => call.stableId)).toEqual([
      first.bindings[0]!.device!.stableId,
    ]);
  });

  test("a failed reconcile is a typed failure that holds nothing", async () => {
    provisioner.failWith = () => new Error("simctl create failed");

    const result = await acquisition.acquire(configFor(), { livenessOwnerToken: TOKEN });

    expect(result.outcome).toBe("failed");
    expect(result.failure).toMatchObject({ code: "provision_failed" });
    expect(result.bindings[0]).toMatchObject({ sessionUuid: null, disposition: null });
    expect(sessions.claims).toEqual([]);
  });

  test("a refused ownership claim backs the session out; the binding keeps its device", async () => {
    sessions.claimOutcome = "conflict";
    const config = configFor();

    const result = await acquisition.acquire(config, { livenessOwnerToken: TOKEN });

    expect(result.failure).toMatchObject({ code: "liveness_owner_conflict", retryable: true });
    expect(sessions.released).toEqual(["session-1"]);
    const assignment = await registry.getAssignment({
      scopeKey: computeBindingScopeKey(config),
      bindingIndex: 0,
    });
    expect(assignment).toMatchObject({ state: "ready", execOwner: null });
    expect(assignment?.stableDeviceId).not.toBeNull();
  });

  test("a schema refusal during the second reconcile resolves failed and backs out the first session", async () => {
    const first = configFor();
    const config = buildBrokerProvisionRequest({
      ...first,
      localBindingCapacity: 2,
      requests: [...first.requests, { ...first.requests[0]!, bindingIndex: 1 }],
    });
    const error = new BindingRegistrySchemaUnsupportedError("slots.sqlite", [
      "2099_01_01_016_future_schema",
    ]);
    const reconcile = spyOn(reconciler, "reconcile");
    reconcile.mockImplementationOnce((request) =>
      BindingReconciler.prototype.reconcile.call(reconciler, request),
    );
    reconcile.mockRejectedValueOnce(error);
    const releaseExecution = spyOn(registry, "releaseExecution");
    const releaseSession = spyOn(sessions, "releaseSession");
    try {
      const pending = acquisition.acquire(config, { livenessOwnerToken: TOKEN });
      await expect(pending).resolves.toMatchObject({
        outcome: "failed",
        failure: {
          code: "registry_schema_unsupported",
          message: error.message,
          retryable: false,
          nextAction:
            "Upgrade this daemon and every daemon sharing the registry to the build that migrated it, restarting older daemons; nothing was changed.",
        },
      });
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(sessions.claims).toEqual([["session-1", TOKEN]]);
      expect(releaseSession).toHaveBeenCalledWith("session-1");
      expect(releaseExecution).toHaveBeenCalledWith(
        { scopeKey: computeBindingScopeKey(config), bindingIndex: 0 },
        "session-1",
      );
      const result = await pending;
      expect(result.bindings[0]?.sessionUuid).toBeNull();
      expect(result.bindings[1]).toMatchObject({
        bindingIndex: 1,
        sessionUuid: null,
        failure: result.failure,
      });
    } finally {
      acquisition.close();
      reconcile.mockRestore();
      releaseExecution.mockRestore();
      releaseSession.mockRestore();
    }
  });

  test("an unrelated reconcile error still rejects unchanged", async () => {
    const error = new Error("unexpected reconcile failure");
    const reconcile = spyOn(reconciler, "reconcile").mockRejectedValueOnce(error);
    try {
      await expect(acquisition.acquire(configFor(), { livenessOwnerToken: TOKEN })).rejects.toBe(
        error,
      );
    } finally {
      acquisition.close();
      reconcile.mockRestore();
    }
  });

  test("a cancelled acquisition releases the session it prepared", async () => {
    const abort = new AbortController();
    provisioner.beforeReturn = async () => {
      abort.abort();
    };

    const result = await acquisition.acquire(configFor(), {
      livenessOwnerToken: TOKEN,
      signal: abort.signal,
    });

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("cancelled");
    expect(sessions.released).toEqual(["session-1"]);
  });
});
