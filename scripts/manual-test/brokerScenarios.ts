import {
  brokerDeviceScenarios,
  type BrokerDeviceScenarioOps,
  type PrivateDaemonControl,
} from "./brokerDeviceScenarios";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { SessionConfig } from "../../src/models/sessionConfig";
import {
  assertSessionOwnerIdentity,
  parseSessionConfig,
  SessionConfigError,
} from "../../src/models/sessionConfig";
import type { SessionBrokerResult } from "../../src/models/sessionBrokerResult";
import { errorMessage } from "../../src/utils/describeUnknownError";
import type { IdGenerator } from "../../src/utils/IdGenerator";
import type { Timer } from "../../src/utils/SystemTimer";
import type { BrokerDaemonClient } from "./brokerDaemonClient";
import {
  assertReleasedAndAbsent,
  ledgerDevice,
  type BrokerDeviceLedger,
  type BrokerLedgerFs,
  type LedgerDevicesView,
} from "./brokerDeviceLedger";

export interface BrokerScenarioClient {
  name: string;
  config: SessionConfig;
  token: string;
}
/** Only fake-native controls live here; device scenarios use the common context below. */
export interface BrokerScenarioFakeControls {
  prepared(): readonly string[];
  inventory(): Promise<LedgerDevicesView>;
  pausePreparation(): { entered: Promise<void>; joined(): boolean };
  catalogUnavailable(value: boolean): void;
  tool(name: string, sessionUuid?: string): Promise<void>;
  rebind(sessionUuid: string, requestId: string, token: string): Promise<unknown>;
  tools(result: SessionBrokerResult): Promise<readonly string[]>;
  recover(): Promise<void>;
  cleanup(): Promise<void>;
}
export interface BrokerScenarioContext {
  batchDir: string;
  clients: readonly BrokerScenarioClient[];
  daemonClient: BrokerDaemonClient;
  prepare(config: SessionConfig, token: string): Promise<SessionBrokerResult>;
  ledger: BrokerDeviceLedger;
  timer: Timer;
  ids: IdGenerator;
  fs: Pick<BrokerLedgerFs, "mkdir"> & { writeFile(path: string, text: string): void };
  /** Must verify a private, already-running batch; must never start a daemon. */
  preflight(): Promise<boolean>;
  probe(): Promise<boolean>;
  fake?: BrokerScenarioFakeControls;
  deviceOps?: BrokerDeviceScenarioOps;
  privateDaemon?: PrivateDaemonControl;
  maxDevices?: number;
  crash?: boolean;
  record<T>(operation: string, request: unknown, action: () => Promise<T>): Promise<T>;
}
export interface BrokerScenario {
  name: string;
  class: "fake" | "device";
  /** Capacity required by the isolated fake host. */
  capacity: number;
  deviceOnlyAssertions: readonly string[];
  run(context: BrokerScenarioContext): Promise<void>;
  /** Device entries provide their private-batch context; fake entries use the memory host. */
  createContext?(
    batchDir: string,
    fs: BrokerScenarioContext["fs"],
  ): Promise<{ context: BrokerScenarioContext; close(): Promise<void> }>;
}
function fake(ctx: BrokerScenarioContext): BrokerScenarioFakeControls {
  assert(ctx.fake, "Fake scenarios require the real broker with a fake native port.");
  return ctx.fake;
}
function client(ctx: BrokerScenarioContext, index = 0): BrokerScenarioClient {
  const value = ctx.clients[index];
  assert(value, "Scenario requires more clients.");
  return value;
}
async function prepare(ctx: BrokerScenarioContext, c: BrokerScenarioClient) {
  const result = await ctx.record(
    "prepareSession",
    { config: c.config, livenessOwnerToken: c.token },
    () => ctx.prepare(c.config, c.token),
  );
  if (result.outcome === "ready") {
    ctx.ledger.acquired(c.name, { session: result });
    const info = await ctx.record("sessionInfo", { sessionUuid: result.sessionUuid }, () =>
      ctx.daemonClient.info(session(result)),
    );
    ctx.ledger.info(c.name, { session: result }, info);
  }
  return result;
}
function session(result: SessionBrokerResult): string {
  assert.equal(result.outcome, "ready");
  assert(result.sessionUuid);
  return result.sessionUuid;
}
function fresh(ctx: BrokerScenarioContext, c: BrokerScenarioClient): BrokerScenarioClient {
  return { ...c, config: { ...c.config, requestId: ctx.ids.next() } };
}
function status(ctx: BrokerScenarioContext, c: BrokerScenarioClient) {
  return ctx.record(
    "sessionRequestStatus",
    { requestId: c.config.requestId, livenessOwnerToken: c.token },
    () => ctx.daemonClient.status(c.config.requestId, c.token),
  );
}
function abandon(ctx: BrokerScenarioContext, c: BrokerScenarioClient) {
  return ctx.record(
    "abandonSessionRequest",
    { requestId: c.config.requestId, livenessOwnerToken: c.token },
    () => ctx.daemonClient.abandon(c.config.requestId, c.token),
  );
}
async function release(
  ctx: BrokerScenarioContext,
  c: BrokerScenarioClient,
  result: SessionBrokerResult,
) {
  const receipt = await ctx.record(
    "releaseBrokerSession",
    { sessionUuid: session(result), livenessOwnerToken: c.token },
    () => ctx.daemonClient.release(session(result), c.token),
  );
  assert.equal(receipt.outcome, "released");
  const current = await status(ctx, c);
  assert.equal(current?.outcome, "released");
  assert.equal(current.cleanupPending, false);
  if (ctx.fake) {
    await recordAbsence(ctx, result.sessionUuid!);
  }
}
async function recordAbsence(ctx: BrokerScenarioContext, sessionUuid: string) {
  const row = ctx.ledger.devices().find((entry) => entry.sessionUuid === sessionUuid);
  assert(row?.device, "Released grant must have a ledger device.");
  const view = await ctx.record("inventory", { sessionUuid }, () => fake(ctx).inventory());
  assert(!view.devices.some((device) => device.name === row.device!.name));
  if (!ctx.ledger.hasEvent(row, "released")) {
    ctx.ledger.record("released", row);
  }
  if (!ctx.ledger.hasEvent(row, "absent")) {
    ctx.ledger.record("absent", row);
  }
}
async function capacity(ctx: BrokerScenarioContext) {
  const control = fake(ctx);
  const results = await Promise.all(ctx.clients.map((c) => prepare(ctx, c)));
  const ready = results.filter((r) => r.outcome === "ready");
  assert.equal(ready.length, ctx.clients.length - 1);
  const refusedIndex = results.findIndex((r) => r.failure?.code === "capacity_exhausted");
  assert(refusedIndex >= 0);
  const refused = client(ctx, refusedIndex);
  const refusal = results[refusedIndex];
  assert.equal(refusal.outcome, "failed");
  assert.equal(refusal.failure?.retryable, false);
  assert.deepEqual(
    await ctx.record("tools/list", { outcome: refusal.outcome }, () => control.tools(refusal)),
    [],
  );
  assert.equal(ctx.ledger.entries.filter((r) => r.client === refused.name).length, 0);
  assert.equal(control.prepared().length, ready.length);
  for (const [index, result] of results.entries()) {
    if (result.outcome === "ready") {
      await release(ctx, client(ctx, index), result);
    }
  }
  assert.deepEqual(await prepare(ctx, refused), refusal);
  assert.equal(control.prepared().length, ready.length);
  const retry = fresh(ctx, refused);
  const successor = await prepare(ctx, retry);
  session(successor);
  assert.equal(control.prepared().length, ready.length + 1);
  await release(ctx, retry, successor);
}
async function releaseDestroy(ctx: BrokerScenarioContext) {
  const c = client(ctx);
  const first = await prepare(ctx, c);
  const oldSession = session(first);
  const oldDevice = ctx.ledger.devices()[0].device;
  await ctx.record("tool-before-release", { sessionUuid: oldSession }, () =>
    fake(ctx).tool("observe", oldSession),
  );
  await release(ctx, c, first);
  await assertReleasedAndAbsent({
    ledger: ctx.ledger,
    daemonClient: ctx.daemonClient,
    timer: ctx.timer,
    budgetMs: 1000,
    devicesView: () => fake(ctx).inventory(),
  });
  assert(oldDevice);
  assert.equal(ledgerDevice(oldDevice, ctx.ledger), undefined);
  assert.equal((await fake(ctx).inventory()).devices.length, 0);
  await assert.rejects(
    ctx.record("tool-after-release", { sessionUuid: oldSession }, () =>
      fake(ctx).tool("observe", oldSession),
    ),
    /requires a live session/,
  );
  const next = fresh(ctx, c);
  const successor = await prepare(ctx, next);
  assert.notEqual(session(successor), oldSession);
  assert.notDeepEqual(ctx.ledger.devices().at(-1)?.device, oldDevice);
  await release(ctx, next, successor);
}
async function ownerAbandon(ctx: BrokerScenarioContext) {
  const control = fake(ctx);
  const c = client(ctx);
  const pause = control.pausePreparation();
  const pending = prepare(ctx, c);
  await pause.entered;
  const receipt = await abandon(ctx, c);
  assert.equal(receipt.failure?.code, "session_request_abandoned");
  await pending;
  assert(pause.joined(), "Cancellation must join the in-flight fake preparation.");
  await ctx.record("recover", {}, () => control.recover());
  const settled = await status(ctx, c);
  assert.equal(settled?.cleanupPending, false);
  assert.deepEqual(await prepare(ctx, c), settled);
  assert.equal(control.prepared().length, 1);
  assert.equal((await control.inventory()).devices.length, 0);
  const unknown = fresh(ctx, c);
  const unknownReceipt = await abandon(ctx, unknown);
  assert.equal(unknownReceipt.failure?.code, "session_request_abandoned");
  assert.deepEqual(await prepare(ctx, unknown), unknownReceipt);
  assert.equal(control.prepared().length, 1);
  const live = fresh(ctx, c);
  const grant = await prepare(ctx, live);
  await abandon(ctx, live);
  await ctx.record("recover", {}, () => control.recover());
  await assert.rejects(
    ctx.record("tool-after-abandon", { sessionUuid: session(grant) }, () =>
      control.tool("observe", session(grant)),
    ),
    /requires a live session/,
  );
  assert.equal((await status(ctx, live))?.cleanupPending, false);
  await recordAbsence(ctx, session(grant));
  assert.equal((await control.inventory()).devices.length, 0);
}
async function isolation(ctx: BrokerScenarioContext) {
  const a = client(ctx),
    b = client(ctx, 1);
  const ga = await prepare(ctx, a),
    gb = await prepare(ctx, b);
  const foreign = { ...b, token: a.token };
  await assert.rejects(status(ctx, foreign), /belongs to another liveness owner/);
  await assert.rejects(
    ctx.record("foreign-release", { sessionUuid: session(gb), livenessOwnerToken: a.token }, () =>
      ctx.daemonClient.release(session(gb), a.token),
    ),
    /belongs to another liveness owner/,
  );
  // Wrong-token ownership throws before the handler can return session_ownership_lost.
  await assert.rejects(
    ctx.record(
      "wrong-token-rebind",
      { sessionUuid: session(gb), requestId: b.config.requestId, livenessOwnerToken: a.token },
      () => fake(ctx).rebind(session(gb), b.config.requestId, a.token),
    ),
    /belongs to another liveness owner/,
  );
  const rebound = await ctx.record(
    "mismatched-session-rebind",
    { sessionUuid: session(gb), requestId: a.config.requestId, livenessOwnerToken: a.token },
    () => fake(ctx).rebind(session(gb), a.config.requestId, a.token),
  );
  assert.deepEqual(rebound && (rebound as { code?: string }).code, "session_ownership_lost");
  assert.equal(await fake(ctx).rebind(session(gb), b.config.requestId, b.token), undefined);
  for (const name of ["startDevice", "provisionDevice", "killDevice"]) {
    await assert.rejects(
      ctx.record("generic-tool", { name, sessionUuid: session(ga) }, () =>
        fake(ctx).tool(name, session(ga)),
      ),
      /owns device lifecycle/,
    );
  }
  await fake(ctx).tool("observe", session(gb));
  assert.equal((await status(ctx, b))?.outcome, "ready");
  await release(ctx, a, ga);
  await release(ctx, b, gb);
}
async function retryableFailure(ctx: BrokerScenarioContext) {
  const c = client(ctx);
  fake(ctx).catalogUnavailable(true);
  const unavailable = await prepare(ctx, c);
  assert.equal(unavailable.failure?.code, "catalog_unavailable");
  assert.equal(unavailable.failure?.retryable, true);
  fake(ctx).catalogUnavailable(false);
  assert.deepEqual(await prepare(ctx, c), unavailable);
  const unknown = fresh(ctx, c);
  await assert.rejects(
    ctx.record(
      "parseSessionConfig-unknown-archetype",
      { config: unknown.config, archetype: "unknown-hardware" },
      async () =>
        parseSessionConfig({
          ...unknown.config,
          device: {
            ...unknown.config.device,
            hardware: { kind: "archetype", archetype: "unknown-hardware" },
          },
        }),
    ),
    SessionConfigError,
  );
  // Unknown archetypes fail config validation before admission. Also exercise a typed
  // non-retryable broker receipt with the currently disabled Duo archetype.
  unknown.config = {
    ...unknown.config,
    device: {
      ...unknown.config.device,
      platform: "ios",
      hardware: { kind: "archetype", archetype: "duo" },
    },
  };
  const refused = await prepare(ctx, unknown);
  assert.equal(refused.outcome, "failed");
  assert.equal(refused.failure?.retryable, false);
  assert.equal(refused.failure?.code, "capability_disabled");
  assert.deepEqual(await status(ctx, unknown), refused);
  assert.equal(fake(ctx).prepared().length, 0);
  const next = fresh(ctx, c);
  await release(ctx, next, await prepare(ctx, next));
}
async function pidReuse(ctx: BrokerScenarioContext) {
  const c = client(ctx);
  const config = { ...c.config, executionOwnerPid: 101, executionOwnerStartIdentity: "old-start" };
  const compare = (pid: number, identity: string) =>
    pid === 101 && identity === "live-start" ? ("same" as const) : ("different" as const);
  await assert.rejects(
    ctx.record("assertSessionOwnerIdentity", { config }, async () =>
      assertSessionOwnerIdentity(config, compare),
    ),
    /PID was reused/,
  );
  assert.equal(fake(ctx).prepared().length, 0);
  config.executionOwnerStartIdentity = "live-start";
  assert.equal(
    await ctx.record("assertSessionOwnerIdentity", { config }, async () =>
      assertSessionOwnerIdentity(config, compare),
    ),
    "same",
  );
  const positive = { ...c, config };
  await release(ctx, positive, await prepare(ctx, positive));
}
export const brokerScenarios: readonly BrokerScenario[] = [
  {
    name: "capacity-refusal-and-replay",
    class: "fake",
    capacity: 1,
    deviceOnlyAssertions: [],
    run: capacity,
  },
  {
    name: "release-destroy-verification",
    class: "fake",
    capacity: 1,
    deviceOnlyAssertions: [
      "Native inventory destruction",
      "Old proxy connection returns broker_session_ended",
    ],
    run: releaseDestroy,
  },
  {
    name: "owner-death-and-abandon",
    class: "fake",
    capacity: 1,
    deviceOnlyAssertions: [
      "Execution owner death shuts down proxy",
      "Old proxy connection returns broker_session_ended",
    ],
    run: ownerAbandon,
  },
  {
    name: "cross-client-isolation",
    class: "fake",
    capacity: 2,
    deviceOnlyAssertions: ["Cross-client device tool call through a bound wire connection"],
    run: isolation,
  },
  {
    name: "#12452-retryable-prep-failure",
    class: "fake",
    capacity: 1,
    deviceOnlyAssertions: ["Native preparation timeout"],
    run: retryableFailure,
  },
  {
    name: "#12491-pid-reuse-fencing",
    class: "fake",
    capacity: 1,
    deviceOnlyAssertions: ["Live OS process identity and owner death"],
    run: pidReuse,
  },
  ...brokerDeviceScenarios,
];
export interface BrokerScenarioSummary {
  name: string;
  class: BrokerScenario["class"];
  dryRun: boolean;
  outcome: "passed" | "failed" | "dry-run";
  error?: string;
  startedAt: number;
  durationMs: number;
  requests: Array<{
    operation: string;
    request: unknown;
    reply?: unknown;
    error?: string;
    startedAt: number;
    durationMs: number;
  }>;
  ledgerDeltas: unknown[];
  deviceOnlyAssertions: readonly string[];
}
/** All I/O is injected; even failures and dry runs produce a redacted summary. */
export async function runBrokerScenario(
  scenario: BrokerScenario,
  context: BrokerScenarioContext,
  options: { dryRun?: boolean; device?: boolean; maxDevices?: number; crash?: boolean } = {},
): Promise<BrokerScenarioSummary> {
  const startedAt = context.timer.now();
  const firstRow = context.ledger.entries.length;
  const summary: BrokerScenarioSummary = {
    name: scenario.name,
    class: scenario.class,
    dryRun: !!options.dryRun,
    outcome: "failed",
    startedAt,
    durationMs: 0,
    requests: [],
    ledgerDeltas: [],
    deviceOnlyAssertions: scenario.deviceOnlyAssertions,
  };
  let running = false;
  const ctx: BrokerScenarioContext = {
    ...context,
    maxDevices: options.maxDevices ?? context.maxDevices ?? 2,
    crash: options.crash ?? context.crash ?? false,
    record: async (operation, request, action) => {
      const row: BrokerScenarioSummary["requests"][number] = {
        operation,
        request: structuredClone(request),
        startedAt: ctx.timer.now(),
        durationMs: 0,
      };
      summary.requests.push(row);
      try {
        const result = await action();
        row.reply = structuredClone(result);
        return result;
      } catch (error) {
        row.error = errorMessage(error);
        throw error;
      } finally {
        row.durationMs = ctx.timer.now() - row.startedAt;
      }
    },
  };
  try {
    if (scenario.class === "device") {
      assert(
        Number.isInteger(ctx.maxDevices) && ctx.maxDevices! >= 1 && ctx.maxDevices! <= 4,
        "--max-devices must be an integer from 1 to 4.",
      );
      if (ctx.deviceOps) {
        assert(
          Number.isInteger(ctx.deviceOps.totalDeviceCap) &&
            ctx.deviceOps.totalDeviceCap >= 1 &&
            ctx.deviceOps.totalDeviceCap <= ctx.maxDevices!,
          "Batch capacity exceeds --max-devices.",
        );
      }
      assert(options.device, "Device scenarios require --device.");
      assert(
        !ctx.crash || scenario.name === "daemon-restart-with-live-sessions",
        "--crash requires daemon-restart-with-live-sessions.",
      );
      assert(
        await ctx.preflight(),
        "Device scenarios require an already-running private broker batch (preflight).",
      );
      assert(await ctx.probe(), "Private broker capability probe failed.");
      assert(
        (await ctx.daemonClient.capabilities()).includes("session-broker/v1"),
        "Private daemon lacks session-broker/v1.",
      );
    }
    if (!options.dryRun) {
      if (scenario.class === "device" && ctx.deviceOps) {
        // Refuse a new scenario until all earlier batch grants have authoritative receipts.
        for (const row of ctx.ledger.devices()) {
          assert(
            ctx.ledger.hasEvent(row, "released") && ctx.ledger.hasEvent(row, "absent"),
            "Previous scenario has an unverified release receipt/absence.",
          );
        }
      }
      running = true;
      await scenario.run(ctx);
    }
    summary.outcome = options.dryRun ? "dry-run" : "passed";
  } catch (error) {
    summary.error = errorMessage(error);
  } finally {
    try {
      if (!options.dryRun && (scenario.class === "fake" || running)) {
        if (scenario.class === "device" && ctx.deviceOps) {
          const cleanupErrors: string[] = [];
          for (const c of [...ctx.clients].reverse()) {
            try {
              await ctx.record("proxy/close", { client: c.name }, () => ctx.deviceOps!.close(c));
            } catch (error) {
              // Continue closing sibling proxies; report every failure in the redacted summary.
              cleanupErrors.push(errorMessage(error));
            }
          }
          assert.equal(cleanupErrors.length, 0, cleanupErrors.join("; "));
          for (const row of ctx.ledger.devices()) {
            assert(
              ctx.ledger.hasEvent(row, "absent"),
              "Scenario left an unverified release receipt/absence.",
            );
          }
        } else {
          await ctx.fake?.cleanup();
        }
      }
    } catch (error) {
      summary.outcome = "failed";
      summary.error = summary.error
        ? `${summary.error}; cleanup: ${errorMessage(error)}`
        : errorMessage(error);
    }
    summary.durationMs = ctx.timer.now() - startedAt;
    summary.ledgerDeltas = ctx.ledger.entries.slice(firstRow);
    // Replace literal and JSON-escaped token values, including tokens embedded in errors.
    let text = JSON.stringify(summary, null, 2);
    for (const { token } of ctx.clients) {
      if (token) {
        text = text.replaceAll(JSON.stringify(token).slice(1, -1), "[REDACTED]");
      }
    }
    // Registry names may contain # but are trusted; a caller-supplied name never becomes a path.
    assert(/^[a-z0-9#-]+$/.test(scenario.name), "Unsafe scenario evidence name.");
    const directory = join(ctx.batchDir, "evidence", scenario.name);
    ctx.fs.mkdir(directory);
    ctx.fs.writeFile(join(directory, "summary.json"), `${text}\n`);
    return JSON.parse(text) as BrokerScenarioSummary;
  }
}
