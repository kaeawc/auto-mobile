import { strict as assert } from "node:assert";
import { osSelectorMatchesVersion } from "../../src/devices/sessionRequirements/version";
import type { SessionBrokerResult } from "../../src/models/sessionBrokerResult";
import { BROKER_CLEANUP_TIMEOUT_MS } from "./brokerDaemonClient";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import type { LedgerDevicesView } from "./brokerDeviceLedger";
import type {
  BrokerScenario,
  BrokerScenarioClient,
  BrokerScenarioContext,
} from "./brokerScenarios";

export type { PrivateDaemonControl } from "./privateDaemonControl";
export interface BrokerResourceSample {
  sessionUuid: string | null;
  state: string;
}
/** Proxy operations retain the original connection; observe must not silently reconnect/acquire. */
export type BrokerResourceSamples = readonly BrokerResourceSample[] | { unavailable: string };
export interface BrokerDeviceScenarioOps {
  totalDeviceCap: number;
  acquire(
    client: BrokerScenarioClient,
    options: { disposableOwner: boolean; resume: boolean },
  ): Promise<SessionBrokerResult>;
  /** Hold the existing boot-gate permit across the entire acquisition, including failed attempts. */
  bootGate<T>(client: string, permits: number, action: () => Promise<T>): Promise<T>;
  observe(client: BrokerScenarioClient): Promise<void>;
  ownerKill(client: BrokerScenarioClient): Promise<void>;
  proxyClosed(client: BrokerScenarioClient): Promise<boolean>;
  close(client: BrokerScenarioClient): Promise<void>;
  devicesView(): Promise<LedgerDevicesView>;
  /** Authoritative resource ledger sample, including destroying/destroyed rows. */
  resources(): Promise<BrokerResourceSamples>;
  tools?(client: BrokerScenarioClient): Promise<readonly unknown[]>;
}
function ops(ctx: BrokerScenarioContext): BrokerDeviceScenarioOps {
  assert(ctx.deviceOps, "Device scenario requires injected proxy-session operations.");
  return ctx.deviceOps;
}
function first(ctx: BrokerScenarioContext): BrokerScenarioClient {
  assert(ctx.clients[0], "Device scenario needs a batch client.");
  return ctx.clients[0];
}
function uuid(result: SessionBrokerResult): string {
  assert.equal(result.outcome, "ready");
  assert(result.sessionUuid);
  return result.sessionUuid;
}
async function acquire(
  ctx: BrokerScenarioContext,
  c: BrokerScenarioClient,
  disposableOwner = false,
  resume = false,
) {
  const control = ops(ctx);
  const result = await ctx.record(
    "proxy/up",
    { client: c.name, config: c.config, disposableOwner, resume },
    () =>
      control.bootGate(c.name, Math.min(control.totalDeviceCap, ctx.maxDevices ?? 2), () =>
        control.acquire(c, { disposableOwner, resume }),
      ),
  );
  assert.equal(
    result.requestId,
    c.config.requestId,
    "Proxy must retain its actual persisted request identity.",
  );
  if (result.outcome === "ready") {
    ctx.ledger.acquired(c.name, { session: result });
    const info = await ctx.record("sessionInfo", { sessionUuid: uuid(result) }, () =>
      ctx.daemonClient.info(uuid(result)),
    );
    ctx.ledger.info(c.name, { session: result }, info);
  }
  return result;
}
async function observe(ctx: BrokerScenarioContext, c: BrokerScenarioClient) {
  await ctx.record("proxy/observe", { client: c.name }, () => ops(ctx).observe(c));
}
async function status(ctx: BrokerScenarioContext, c: BrokerScenarioClient) {
  return ctx.record(
    "sessionRequestStatus",
    { requestId: c.config.requestId, livenessOwnerToken: c.token },
    () => ctx.daemonClient.status(c.config.requestId, c.token),
  );
}
async function poll<T>(
  ctx: BrokerScenarioContext,
  label: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  let active = true;
  try {
    return await raceWithDeadline(
      async () => {
        while (active) {
          const value = await read();
          if (done(value)) {
            return value;
          }
          await ctx.timer.sleep(100);
        }
        throw new Error(`${label} exceeded cleanup budget.`);
      },
      { timer: ctx.timer, timeoutMs: BROKER_CLEANUP_TIMEOUT_MS, label },
    );
  } finally {
    active = false;
  }
}
async function sample(ctx: BrokerScenarioContext) {
  return ctx.record("resource-ledger", {}, () => ops(ctx).resources());
}
function resourceRows(
  ctx: BrokerScenarioContext,
  samples: BrokerResourceSamples,
  assertion: string,
) {
  if ("unavailable" in samples) {
    ctx.assertions?.push({ assertion, status: "not-verifiable", reason: samples.unavailable });
    return undefined;
  }
  return samples;
}
async function absent(ctx: BrokerScenarioContext, result: SessionBrokerResult) {
  const row = ctx.ledger.devices().find((entry) => entry.sessionUuid === result.sessionUuid);
  assert(row?.device, "Native absence requires a ready ledger binding.");
  await poll(
    ctx,
    "Native destruction",
    async () => {
      const view = await ctx.record("devices", {}, () => ops(ctx).devicesView());
      const resources = resourceRows(ctx, await sample(ctx), "resource destruction");
      return (
        view.daemons.length > 0 &&
        view.daemons.every((d) => d.alive && !d.error) &&
        !view.devices.some(
          (d) => d.platform === row.device!.platform && d.name === row.device!.name,
        ) &&
        (resources === undefined ||
          (resources.some((r) => r.sessionUuid === result.sessionUuid && r.state === "destroyed") &&
            !resources.some(
              (r) => r.sessionUuid === result.sessionUuid && r.state !== "destroyed",
            )))
      );
    },
    Boolean,
  );
  if (!ctx.ledger.hasEvent(row, "released")) {
    ctx.ledger.record("released", row);
  }
  if (!ctx.ledger.hasEvent(row, "absent")) {
    ctx.ledger.record("absent", row);
  }
}
async function release(
  ctx: BrokerScenarioContext,
  c: BrokerScenarioClient,
  result: SessionBrokerResult,
) {
  const receipt = await ctx.record(
    "releaseBrokerSession",
    { sessionUuid: uuid(result), livenessOwnerToken: c.token },
    () => ctx.daemonClient.release(uuid(result), c.token),
  );
  assert(["released", "cleanup_pending"].includes(receipt.outcome));
  assert.equal(receipt.sessionUuid, result.sessionUuid);
  await poll(
    ctx,
    "Release receipt",
    () => status(ctx, c),
    (r) => r?.outcome === "released" && r.sessionUuid === result.sessionUuid && !r.cleanupPending,
  );
  await absent(ctx, result);
}
async function terminal(
  ctx: BrokerScenarioContext,
  c: BrokerScenarioClient,
  result: SessionBrokerResult,
  code: string,
) {
  const receipt = await poll(
    ctx,
    "Terminal owner receipt",
    () => status(ctx, c),
    (r) => r?.failure?.code === code && !r.cleanupPending,
  );
  assert.equal(receipt?.outcome, "failed");
  assert.equal(receipt?.requestId, c.config.requestId);
  assert.equal(receipt?.sessionUuid, result.sessionUuid);
  await absent(ctx, result);
  return receipt;
}
function successor(ctx: BrokerScenarioContext, c: BrokerScenarioClient): BrokerScenarioClient {
  return {
    ...c,
    config: {
      ...c.config,
      requestId: ctx.ids.next(),
      executionOwnerPid: undefined,
      executionOwnerStartIdentity: undefined,
    },
  };
}
async function ended(ctx: BrokerScenarioContext, c: BrokerScenarioClient) {
  await assert.rejects(() => observe(ctx, c), /broker_session_ended/);
}
function profile(c: BrokerScenarioClient, result: SessionBrokerResult) {
  assert.equal(result.profile?.platform, c.config.device.platform);
  const p = result.profile!;
  const hardware = c.config.device.hardware;
  if (hardware.kind === "archetype") {
    assert.equal(p.archetype, hardware.archetype);
  }
  const os = c.config.device.os;
  if (os.kind !== "omitted") {
    assert(
      p.osVersion && osSelectorMatchesVersion(os, p.osVersion),
      "Resolved OS does not match the request.",
    );
  }
  if (hardware.kind === "model-type" && p.platform === "ios") {
    assert.deepEqual(p.modelType, hardware.modelType);
  }
  if (hardware.kind === "exact-model" && p.platform === "ios") {
    const model = hardware.model;
    if (model.namespace === "product-model") {
      assert.equal(p.modelIdentifier, model.value);
    }
    if (model.namespace === "simulator-device-type") {
      assert.equal(p.simulatorDeviceTypeIdentifier, model.value);
    }
  }
}
/** Join every acquisition before cleanup, including a sibling that outlives a failed launch. */
async function acquireTogether(
  ctx: BrokerScenarioContext,
  clients: readonly BrokerScenarioClient[],
) {
  const outcomes = await Promise.allSettled(clients.map((c) => acquire(ctx, c)));
  return outcomes.map((outcome) => {
    if (outcome.status === "rejected") {
      throw outcome.reason;
    }
    return outcome.value;
  });
}
async function parallel(ctx: BrokerScenarioContext) {
  assert(ctx.clients.length >= 2, "parallel-acquire needs at least two clients.");
  assert(ctx.clients.length <= ops(ctx).totalDeviceCap, "Parallel clients exceed batch capacity.");
  const results = await acquireTogether(ctx, ctx.clients);
  assert.equal(new Set(results.map(uuid)).size, results.length);
  const rows = results.map((r) =>
    ctx.ledger.devices().find((row) => row.sessionUuid === r.sessionUuid)!,
  );
  assert.equal(
    new Set(rows.map((r) => JSON.stringify([r.device?.platform, r.device?.name]))).size,
    results.length,
  );
  assert.equal(
    new Set(rows.map((r) => JSON.stringify([r.device?.platform, r.device?.deviceId]))).size,
    results.length,
    "Concurrent sessions share a native serial/UDID.",
  );
  for (const [i, c] of ctx.clients.entries()) {
    profile(c, results[i]);
    await observe(ctx, c);
  }
  for (const [i, c] of ctx.clients.entries()) {
    await release(ctx, c, results[i]);
  }
}
async function releaseDestroy(ctx: BrokerScenarioContext) {
  const c = first(ctx),
    result = await acquire(ctx, c);
  await observe(ctx, c);
  const old = ctx.ledger.devices().find((r) => r.sessionUuid === uuid(result))!;
  await release(ctx, c, result);
  await ended(ctx, c);
  await ops(ctx).close(c);
  const next = successor(ctx, c),
    grant = await acquire(ctx, next);
  assert.notEqual(uuid(grant), uuid(result));
  const native = ctx.ledger.devices().find((r) => r.sessionUuid === uuid(grant))!;
  assert.notEqual(
    native.device?.name,
    old.device?.name,
    "Serial reuse is allowed; native identity reuse is not.",
  );
  await release(ctx, next, grant);
}
async function ownerDeath(ctx: BrokerScenarioContext) {
  const c = first(ctx),
    grant = await acquire(ctx, c, true);
  assert(
    c.config.executionOwnerPid && c.config.executionOwnerStartIdentity,
    "Disposable owner must have a recorded start identity.",
  );
  await ctx.record("proxy/owner-kill", { client: c.name }, () => ops(ctx).ownerKill(c));
  await poll(ctx, "Proxy self-shutdown", () => ops(ctx).proxyClosed(c), Boolean);
  await terminal(ctx, c, grant, "session_owner_exited");
  return { c, grant };
}
async function ownerAbandon(ctx: BrokerScenarioContext) {
  const { c } = await ownerDeath(ctx);
  const next = successor(ctx, c),
    grant = await acquire(ctx, next);
  const receipt = await ctx.record(
    "abandonSessionRequest",
    { requestId: next.config.requestId, livenessOwnerToken: next.token },
    () => ctx.daemonClient.abandon(next.config.requestId, next.token),
  );
  assert.equal(receipt.failure?.code, "session_request_abandoned");
  await terminal(ctx, next, grant, "session_request_abandoned");
  await ended(ctx, next);
}
async function restart(ctx: BrokerScenarioContext) {
  assert(ctx.privateDaemon, "Restart requires PrivateDaemonControl.");
  const clients = ctx.clients.slice(0, ops(ctx).totalDeviceCap);
  assert(clients.length > 0, "Restart needs a batch client.");
  const grants = await acquireTogether(ctx, clients);
  const old = grants.map((grant) =>
    ctx.ledger.devices().find((r) => r.sessionUuid === uuid(grant))!,
  );
  const check = async () => {
    const resources = resourceRows(ctx, await sample(ctx), "restart resource handoff");
    if (!resources) {
      return;
    }
    for (const grant of grants) {
      assert(
        !resources.some(
          (r) =>
            r.sessionUuid === grant.sessionUuid && ["destroying", "destroyed"].includes(r.state),
        ),
        "Live reconnecting owner's resource entered destruction.",
      );
      assert(
        resources.some((r) => r.sessionUuid === grant.sessionUuid),
        "Missing handoff resource.",
      );
    }
  };
  await check();
  await ctx.record(ctx.crash ? "private-daemon/stop --crash" : "private-daemon/stop", {}, () =>
    ctx.crash ? ctx.privateDaemon!.crash() : ctx.privateDaemon!.stop(),
  );
  if (!ctx.crash) {
    await check();
  }
  await ctx.record("private-daemon/start", {}, () => ctx.privateDaemon!.start());
  if (ctx.crash) {
    for (const [i, c] of clients.entries()) {
      const receipt = await terminal(ctx, c, grants[i], "session_owner_exited");
      await poll(ctx, "Crashed proxy closes", () => ops(ctx).proxyClosed(c), Boolean);
      assert.deepEqual(
        await acquire(ctx, c, false, true),
        receipt,
        "Original request replay must be byte-equivalent.",
      );
      await ops(ctx).close(c);
    }
    // All interrupted resources must be destroyed before any successor can consume capacity.
    for (const c of clients) {
      const next = successor(ctx, c),
        ready = await acquire(ctx, next);
      await observe(ctx, next);
      await release(ctx, next, ready);
    }
  } else {
    for (const [i, c] of clients.entries()) {
      const grant = grants[i];
      await poll(
        ctx,
        "Owner restart handoff",
        async () => {
          await check();
          return status(ctx, c);
        },
        (r) => r?.outcome === "ready" && r.sessionUuid === grant.sessionUuid,
      );
      await observe(ctx, c);
      await check();
      const view = await ctx.record("devices", {}, () => ops(ctx).devicesView());
      assert(view.daemons.length && view.daemons.every((d) => d.alive && !d.error));
      assert(
        view.devices.some(
          (d) => d.platform === old[i].device?.platform && d.name === old[i].device!.name,
        ),
      );
      ctx.ledger.info(
        c.name,
        { session: grant },
        await ctx.record("sessionInfo-after-restart", { sessionUuid: uuid(grant) }, () =>
          ctx.daemonClient.info(uuid(grant)),
        ),
      );
    }
    for (const [i, c] of clients.entries()) {
      await release(ctx, c, grants[i]);
    }
  }
}
async function timeout(ctx: BrokerScenarioContext) {
  const c = successor(ctx, first(ctx));
  c.config = { ...c.config, preparationTimeoutMs: 1 };
  const failure = await acquire(ctx, c);
  assert.equal(failure.outcome, "failed");
  assert.equal(failure.failure?.code, "timeout");
  assert.equal(failure.failure?.retryable, true);
  const settled = await poll(
    ctx,
    "Preparation timeout cleanup",
    () => status(ctx, c),
    (r) => r?.failure?.code === "timeout" && !r.cleanupPending,
  );
  assert.equal(settled?.failure?.retryable, true);
  await poll(
    ctx,
    "Preparation timeout capacity",
    () => sample(ctx),
    (samples) =>
      resourceRows(ctx, samples, "timeout resource cleanup")?.every(
        (r) => r.state === "destroyed",
      ) ?? true,
  );
  await ops(ctx).close(c);
  const control = successor(ctx, c);
  control.config = {
    ...control.config,
    device: {
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "archetype", archetype: "duo" },
      os: { kind: "omitted" },
    },
  };
  const refused = await acquire(ctx, control);
  assert.equal(refused.outcome, "failed");
  assert.equal(refused.failure?.code, "capability_disabled");
  assert.equal(refused.failure?.retryable, false);
  assert.equal(refused.cleanupPending, false);
  assert.deepEqual(await status(ctx, control), refused);
}
async function capacity(ctx: BrokerScenarioContext) {
  const cap = ops(ctx).totalDeviceCap;
  assert(ctx.clients.length > cap, "Capacity refusal requires capacity + 1 batch clients.");
  const winners = ctx.clients.slice(0, cap);
  const grants = await acquireTogether(ctx, winners);
  grants.forEach(uuid);
  const refused = ctx.clients[cap];
  const refusal = await acquire(ctx, refused);
  assert.equal(refusal.outcome, "failed");
  assert.equal(refusal.failure?.code, "capacity_exhausted");
  assert.equal(refusal.cleanupPending, false);
  assert.equal(refusal.sessionUuid, null);
  resourceRows(ctx, await sample(ctx), "capacity refusal resource allocation");
  assert(ops(ctx).tools, "Capacity refusal requires proxy tools/list.");
  assert.deepEqual(
    await ctx.record("tools/list", { client: refused.name }, () => ops(ctx).tools!(refused)),
    [],
  );
  assert(!ctx.ledger.entries.some((r) => r.requestId === refusal.requestId));
  for (const [i, c] of winners.entries()) {
    await release(ctx, c, grants[i]);
  }
  await ops(ctx).close(refused);
  assert.deepEqual(await acquire(ctx, refused, false, true), refusal);
  await ops(ctx).close(refused);
  const next = successor(ctx, refused);
  const ready = await acquire(ctx, next);
  await observe(ctx, next);
  await release(ctx, next, ready);
}
const entry = (name: string, capacity: number, run: BrokerScenario["run"]): BrokerScenario => ({
  name,
  class: "device",
  capacity,
  deviceOnlyAssertions: [],
  run,
});
export const brokerDeviceScenarios: readonly BrokerScenario[] = [
  entry("parallel-acquire", 2, parallel),
  entry("capacity-refusal-and-replay", 1, capacity),
  entry("release-destroy-verification", 1, releaseDestroy),
  entry("owner-death-and-abandon", 1, ownerAbandon),
  entry("daemon-restart-with-live-sessions", 1, restart),
  entry("#12451-restart-handoff", 1, restart),
  entry("#12452-prep-timeout", 1, timeout),
  entry("#12491-pid-reuse-positive-control", 1, async (ctx) => {
    await ownerDeath(ctx);
  }),
];
