import { join } from "node:path";
import { z } from "zod";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import { errorMessage } from "../../src/utils/describeUnknownError";
import type { BrokerClientFiles } from "./brokerClientFiles";
import { readBrokerIdentity, resolveBrokerClient } from "./brokerClientFiles";
import {
  BROKER_CLEANUP_TIMEOUT_MS,
  waitForBrokerRelease,
  type BrokerDaemonClient,
} from "./brokerDaemonClient";
import type { ProxySessionCommand, ProxySessionDeps } from "./proxy-session";

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
export async function closeBrokerSession(
  context: BrokerClientFiles,
  deps: ProxySessionDeps,
): Promise<void> {
  const client = brokerClient(deps);
  if (!client) {
    throw new Error("Broker daemon client unavailable; cannot confirm release.");
  }
  const { config, token } = readBrokerIdentity(context, deps);
  const release = await waitForBrokerRelease({
    client,
    requestId: config.requestId,
    token,
    timer: deps.timer,
    requireReleased: true,
  });
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
  deps.writeJson(path, { ...closed, release });
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
  const sessionUuid = grantedSession(context, deps);
  if (command.op === "info") {
    const info = await client.info(sessionUuid);
    deps.writeJson(join(context.dir, "info.json"), info);
    await deps.flush(`${JSON.stringify(info)}\n`);
    return 0;
  }
  // The release RPC and all following status calls share one cleanup budget.
  const receipt = await raceWithDeadline(
    async () => {
      const deadline = deps.timer.now() + BROKER_CLEANUP_TIMEOUT_MS;
      const result = await client.release(sessionUuid, token);
      if (result.outcome !== "unknown_session") {
        const status = await waitForBrokerRelease({
          client,
          requestId: config.requestId,
          token,
          timer: deps.timer,
          timeoutMs: Math.max(1, deadline - deps.timer.now()),
        });
        return { ...result, cleanupPending: status.cleanupPending, status };
      }
      return result;
    },
    { timer: deps.timer, timeoutMs: BROKER_CLEANUP_TIMEOUT_MS, label: "Broker release" },
  );
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
