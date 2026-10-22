import { join } from "node:path";
import { z } from "zod";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import { errorMessage } from "../../src/utils/describeUnknownError";
import type { BrokerClientFiles } from "./brokerClientFiles";
import { readBrokerIdentity, resolveBrokerClient } from "./brokerClientFiles";
import {
  BROKER_CLEANUP_TIMEOUT_MS,
  BrokerTransportError,
  waitForBrokerRelease,
  type BrokerDaemonClient,
} from "./brokerDaemonClient";
import type { ProxySessionCommand, ProxySessionDeps } from "./proxy-session";
import type {
  SessionBrokerResult,
  SessionBrokerReleaseResult,
} from "../../src/devices/sessionBrokerResult";
import { BrokerDeviceLedger } from "./brokerDeviceLedger";

function deviceLedger(context: BrokerClientFiles, deps: ProxySessionDeps): BrokerDeviceLedger {
  return new BrokerDeviceLedger({ batchDir: context.batch, fs: deps, timer: deps.timer });
}
function readyLedger(context: BrokerClientFiles, deps: ProxySessionDeps): BrokerDeviceLedger {
  const ledger = deviceLedger(context, deps);
  const init = JSON.parse(deps.readFile(join(context.dir, "init.json")));
  const { config } = readBrokerIdentity(context, deps);
  z.object({ session: z.object({ requestId: z.literal(config.requestId) }) }).parse(init);
  ledger.acquired(context.name, init);
  return ledger;
}
function recordBrokerRelease(context: BrokerClientFiles, deps: ProxySessionDeps): void {
  const ledger = readyLedger(context, deps);
  const { config } = readBrokerIdentity(context, deps);
  const grant = ledger.entries.find(
    (entry) =>
      entry.kind === "acquired" &&
      entry.client === context.name &&
      entry.requestId === config.requestId,
  )!;
  const device = ledger.devices().find((entry) => entry.sessionUuid === grant.sessionUuid) ?? grant;
  if (!ledger.hasEvent(device, "released")) {
    ledger.record("released", device);
  }
}

/** batch.json records canonical socket paths, independent of which wrapper invoked us. */
export function brokerSocketPath(deps: ProxySessionDeps): string {
  if (!deps.env.MT_BATCH) {
    throw new Error("Broker operations require MT_BATCH.");
  }
  const manifest = z
    .object({
      broker: z.object({ daemon: z.literal(1) }),
      specs: z.array(z.object({ index: z.number(), socketPath: z.string().min(1) })),
    })
    .parse(JSON.parse(deps.readFile(join(deps.env.MT_BATCH, "batch.json"))));
  const spec = manifest.specs.find((entry) => entry.index === manifest.broker.daemon);
  if (!spec) {
    throw new Error("Batch has no broker daemon socket.");
  }
  return spec.socketPath;
}
export function brokerClient(deps: ProxySessionDeps): BrokerDaemonClient | undefined {
  return deps.brokerDaemonClient ?? deps.createBrokerDaemonClient?.(brokerSocketPath(deps));
}
export async function liveBrokerStatus(
  context: BrokerClientFiles,
  deps: ProxySessionDeps,
): Promise<unknown> {
  if (!deps.exists(join(context.dir, "request.json"))) {
    return null;
  }
  try {
    const client = brokerClient(deps);
    if (!client) {
      return null;
    }
    const { config, token } = readBrokerIdentity(context, deps);
    return (await client.status(config.requestId, token)) ?? null;
  } catch (error) {
    deps.log(`Live broker status unavailable: ${errorMessage(error)}`);
    return { unavailable: true, error: errorMessage(error) };
  }
}
function grantedSession(context: BrokerClientFiles, deps: ProxySessionDeps): string {
  const init = z
    .object({ session: z.object({ sessionUuid: z.string().min(1) }) })
    .parse(JSON.parse(deps.readFile(join(context.dir, "init.json"))));
  return init.session.sessionUuid;
}
/** What a never-granted client (refused, pending, or no init.json yet) can truthfully report. */
function ungrantedReport(
  context: BrokerClientFiles,
  deps: ProxySessionDeps,
): Record<string, unknown> | undefined {
  const path = join(context.dir, "init.json");
  if (!deps.exists(path)) {
    return { outcome: "nothing_to_release", reason: "not_ready", sessionOutcome: null };
  }
  const init = z
    .object({
      session: z
        .object({
          outcome: z.string().optional(),
          sessionUuid: z.string().nullable().optional(),
          failure: z.object({ code: z.string().optional() }).passthrough().nullish(),
        })
        .passthrough()
        .nullable()
        .optional(),
    })
    .passthrough()
    .parse(JSON.parse(deps.readFile(path)));
  const session = init.session;
  if (session?.outcome === "ready" && typeof session.sessionUuid === "string") {
    return undefined;
  }
  return {
    outcome: "nothing_to_release",
    reason: "not_ready",
    sessionOutcome: session?.outcome ?? null,
    ...(session?.failure?.code ? { failureCode: session.failure.code } : {}),
  };
}
export async function closeBrokerSession(
  context: BrokerClientFiles,
  deps: ProxySessionDeps,
): Promise<void> {
  const client = brokerClient(deps);
  if (!client) {
    throw new Error("Broker daemon client unavailable; cannot confirm release.");
  }
  const { config, token } = readBrokerIdentity(context, deps);
  const init = z
    .object({
      session: z.object({
        outcome: z.string(),
        sessionUuid: z.string().nullable(),
      }),
    })
    .parse(JSON.parse(deps.readFile(join(context.dir, "init.json"))));
  const refused = init.session.outcome === "failed" && init.session.sessionUuid === null;
  // A refused attempt (e.g. daemon_unavailable) may have no daemon receipt at all, and a failed
  // receipt never becomes released: settle immediately instead of waiting out the cleanup budget.
  const missingReceipt: SessionBrokerResult = {
    contractVersion: 1,
    requestId: config.requestId,
    outcome: "failed",
    sessionUuid: null,
    profile: null,
    cleanupPending: false,
  };
  let release: SessionBrokerResult;
  try {
    release = await waitForBrokerRelease({
      client,
      requestId: config.requestId,
      token,
      timer: deps.timer,
      requireReleased: !refused,
      allowFailed: true,
      missingReceipt: refused ? missingReceipt : undefined,
      log: deps.log,
    });
  } catch (error) {
    if (!refused) {
      throw error;
    }
    deps.log(`Broker status unavailable for refused attempt: ${errorMessage(error)}`);
    release = missingReceipt;
  }
  if (
    refused
      ? release.outcome !== "failed" || release.sessionUuid !== null
      : release.sessionUuid !== grantedSession(context, deps) ||
        !["released", "failed"].includes(release.outcome)
  ) {
    throw new Error("Close release status session mismatch.");
  }
  const path = join(context.dir, "closed.json");
  // The driver publishes closed.json just after its close response. Join that publication
  // before adding the receipt, so the driver's write cannot overwrite release evidence.
  const evidenceDeadline = deps.timer.now() + 5000;
  await raceWithDeadline(
    async () => {
      while (!deps.exists(path) && deps.timer.now() < evidenceDeadline) {
        await deps.timer.sleep(50);
      }
      if (!deps.exists(path)) {
        throw new Error("Driver did not publish close evidence.");
      }
    },
    { timer: deps.timer, timeoutMs: 5000, label: "Driver close evidence" },
  );
  const closed = z.record(z.unknown()).parse(JSON.parse(deps.readFile(path)));
  deps.writeJson(path, {
    ...closed,
    release: release === missingReceipt ? { ...release, receiptMissing: true } : release,
  });
  if (!refused) {
    recordBrokerRelease(context, deps);
  }
  await settleBrokerDriver(context, deps);
}
export const BROKER_DRIVER_EXIT_GRACE_MS = 5000;
/**
 * The driver publishes closed.json before it exits, and a resumed driver can outlive close. Join
 * its exit so the next up/serve never sees "Previous attempt driver is alive". A driver that does
 * not exit is signalled only when its recorded start identity still matches.
 */
export async function settleBrokerDriver(
  context: BrokerClientFiles,
  deps: ProxySessionDeps,
): Promise<void> {
  const pidPath = join(context.dir, "driver.pid");
  const pid = deps.exists(pidPath) ? Number(deps.readFile(pidPath).trim()) : NaN;
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === deps.pid || !deps.isPidAlive(pid)) {
    return;
  }
  const waitForExit = async (ms: number): Promise<boolean> => {
    const deadline = deps.timer.now() + ms;
    while (deps.isPidAlive(pid) && deps.timer.now() < deadline) {
      await deps.timer.sleep(50);
    }
    return !deps.isPidAlive(pid);
  };
  if (await waitForExit(BROKER_DRIVER_EXIT_GRACE_MS)) {
    return;
  }
  const identityPath = join(context.dir, "driver-identity");
  const identity = deps.exists(identityPath) ? deps.readFile(identityPath) : "";
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!identity || !deps.signalPid || deps.compareOwnerIdentity?.(pid, identity) !== "same") {
      throw new Error(
        `Driver ${pid} is still alive after close and its start identity is unconfirmed; not signalling it.`,
      );
    }
    deps.signalPid(pid, signal);
    if (await waitForExit(1000)) {
      return;
    }
  }
  throw new Error(`Driver ${pid} did not exit after SIGKILL.`);
}
export async function runBrokerLifecycle(
  command: ProxySessionCommand,
  context: BrokerClientFiles,
  deps: ProxySessionDeps,
): Promise<number> {
  if (command.op === "owner-kill") {
    return killOwner(context, deps);
  }
  const { config, token: ownToken } = readBrokerIdentity(context, deps);
  let token = ownToken;
  if (command.asClient) {
    if (command.asClient === context.name) {
      throw new Error("--as-client must name another batch client.");
    }
    const other = resolveBrokerClient(context.batch, command.asClient, deps);
    token = readBrokerIdentity(other, deps).token;
    deps.log(`Isolation test: using ${other.name}'s stored owner token for ${context.name}.`);
  }
  const client = brokerClient(deps);
  if (!client) {
    throw new Error("Broker daemon client unavailable.");
  }
  if (command.op === "abandon") {
    const result = await raceWithDeadline(() => client.abandon(config.requestId, token), {
      timer: deps.timer,
      timeoutMs: BROKER_CLEANUP_TIMEOUT_MS,
      label: "Broker abandon",
    });
    await deps.flush(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const ungranted = ungrantedReport(context, deps);
  if (ungranted) {
    // Exit 2 matches close with nothing to release: a guard, not a broker response.
    deps.log(
      `Nothing to ${command.op} for ${context.name}: no ready grant (${String(ungranted.sessionOutcome ?? "no init.json")}).`,
    );
    await deps.flush(`${JSON.stringify(ungranted)}\n`);
    return 2;
  }
  const sessionUuid = grantedSession(context, deps);
  if (command.op === "info") {
    const info = await client.info(sessionUuid);
    deps.writeJson(join(context.dir, "info.json"), info);
    readyLedger(context, deps).info(
      context.name,
      JSON.parse(deps.readFile(join(context.dir, "init.json"))),
      info,
    );
    await deps.flush(`${JSON.stringify(info)}\n`);
    return 0;
  }
  // The release RPC and all following status calls share one cleanup budget.
  const receipt = await raceWithDeadline(
    async () => {
      const deadline = deps.timer.now() + BROKER_CLEANUP_TIMEOUT_MS;
      let result: SessionBrokerReleaseResult | undefined;
      while (deps.timer.now() < deadline) {
        try {
          result = await client.release(sessionUuid, token);
          break;
        } catch (error) {
          if (!(error instanceof BrokerTransportError)) {
            throw error;
          }
          // Release is idempotent; the successor can finish the predecessor's committed release.
          deps.log(`Broker release transport retry: ${errorMessage(error)}`);
          await deps.timer.sleep(Math.min(1000, Math.max(0, deadline - deps.timer.now())));
        }
      }
      if (!result) {
        throw new Error("Timed out resending broker release.");
      }
      if (result.outcome !== "unknown_session") {
        const status = await waitForBrokerRelease({
          client,
          requestId: config.requestId,
          token,
          timer: deps.timer,
          requireReleased: true,
          timeoutMs: Math.max(1, deadline - deps.timer.now()),
          log: deps.log,
        });
        if (status.sessionUuid !== sessionUuid) {
          throw new Error("Release status session mismatch.");
        }
        return {
          ...result,
          outcome: "released" as const,
          cleanupPending: status.cleanupPending,
          status,
        };
      }
      return result;
    },
    { timer: deps.timer, timeoutMs: BROKER_CLEANUP_TIMEOUT_MS, label: "Broker release" },
  );
  if (receipt.outcome === "released") {
    recordBrokerRelease(context, deps);
  }
  await deps.flush(`${JSON.stringify(receipt)}\n`);
  return receipt.outcome === "unknown_session" ? 1 : 0;
}
async function killOwner(context: BrokerClientFiles, deps: ProxySessionDeps): Promise<number> {
  const { config } = readBrokerIdentity(context, deps);
  const pid = Number(deps.readFile(join(context.dir, "owner.pid")).trim());
  const identity = deps.readFile(join(context.dir, "owner-identity"));
  const forbidden = [
    deps.pid,
    ...["driver.pid", "proxy.pid"].map((name) => {
      const path = join(context.dir, name);
      return deps.exists(path) ? Number(deps.readFile(path).trim()) : undefined;
    }),
  ];
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    forbidden.includes(pid) ||
    config.executionOwnerPid !== pid ||
    !identity ||
    config.executionOwnerStartIdentity !== identity
  ) {
    throw new Error(
      "Refusing to signal: owner.pid must record this attempt's disposable owner, never driver/proxy.",
    );
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!deps.isPidAlive(pid)) {
      break;
    }
    if (deps.compareOwnerIdentity?.(pid, identity) !== "same" || !deps.signalPid) {
      throw new Error(
        "Refusing to signal: disposable owner process start identity is unconfirmed.",
      );
    }
    deps.signalPid(pid, signal);
    const deadline = deps.timer.now() + 1000;
    while (deps.isPidAlive(pid) && deps.timer.now() < deadline) {
      await deps.timer.sleep(100);
    }
  }
  if (deps.isPidAlive(pid)) {
    throw new Error("Disposable owner did not exit after SIGKILL.");
  }
  await deps.flush(`${JSON.stringify({ ownerPid: pid, ownerAlive: false })}\n`);
  return 0;
}
