import { join, resolve } from "node:path";
import { z } from "zod";
import { parseSessionConfig, type SessionConfig } from "../../src/models/sessionConfig";
import type { IdGenerator } from "../../src/utils/IdGenerator";
import { BrokerBatchRequestIds, renderClientRequest } from "./brokerBatch";

export interface BrokerClientFileDeps {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, text: string, options?: { mode: number; flag: "wx" }): void;
  mkdir(path: string): void;
  rename(from: string, to: string): void;
  ids: IdGenerator;
}
const clientSchema = z.object({
  platform: z.enum(["android", "ios"]),
  profile: z.unknown(),
  requestId: z.string().min(1),
  tokenFile: z.string(),
  idleTimeoutMs: z.number().optional(),
  preparationTimeoutMs: z.number().optional(),
});
export interface BrokerClientFiles {
  name: string;
  batch: string;
  dir: string;
  initial: SessionConfig;
  batchId: string;
}
export function readBrokerClients(
  batch: string | undefined,
  deps: Pick<BrokerClientFileDeps, "readFile">,
): string[] {
  if (!batch) {
    throw new Error("--client/--all requires MT_BATCH from the batch wrapper.");
  }
  return Object.keys(
    z.record(clientSchema).parse(JSON.parse(deps.readFile(join(batch, "broker/clients.json")))),
  );
}
export function resolveBrokerClient(
  batch: string | undefined,
  name: string,
  deps: Pick<BrokerClientFileDeps, "readFile">,
): BrokerClientFiles {
  if (!batch) {
    throw new Error("--client requires MT_BATCH from the batch wrapper.");
  }
  if (!/^[a-z0-9-]{1,32}$/.test(name)) {
    throw new Error("Invalid broker client name.");
  }
  const clients = z
    .record(clientSchema)
    .parse(JSON.parse(deps.readFile(join(batch, "broker/clients.json"))));
  if (!Object.hasOwn(clients, name)) {
    throw new Error(`Unknown batch client ${name}.`);
  }
  const client = clients[name];
  const suffix = `-${name}-1`;
  if (!client.requestId.endsWith(suffix)) {
    throw new Error("Invalid initial batch request identity.");
  }
  const dir = resolve(batch, "sessions", name);
  if (resolve(batch, client.tokenFile) !== join(dir, "owner-token")) {
    throw new Error("Client token file must be inside its session directory.");
  }
  const initial = parseSessionConfig({
    contractVersion: 1,
    requestId: client.requestId,
    device: client.profile,
    ...(client.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: client.idleTimeoutMs }),
    ...(client.preparationTimeoutMs === undefined
      ? {}
      : { preparationTimeoutMs: client.preparationTimeoutMs }),
  });
  if (initial.device.platform !== client.platform) {
    throw new Error("Client platform disagrees with its profile.");
  }
  return { name, batch, dir, initial, batchId: client.requestId.slice(0, -suffix.length) };
}
export function writeImmutableRequest(
  path: string,
  bytes: string,
  deps: BrokerClientFileDeps,
): void {
  parseSessionConfig(JSON.parse(bytes));
  if (deps.exists(path)) {
    if (deps.readFile(path) !== bytes) {
      throw new Error("request.json is immutable; changed bytes refused.");
    }
    return;
  }
  deps.writeFile(path, bytes, { mode: 0o600, flag: "wx" });
}
export function readBrokerIdentity(
  client: BrokerClientFiles,
  deps: Pick<BrokerClientFileDeps, "readFile">,
): {
  config: SessionConfig;
  token: string;
} {
  const config = parseSessionConfig(JSON.parse(deps.readFile(join(client.dir, "request.json"))));
  const token = deps.readFile(join(client.dir, "owner-token"));
  if (!token || token.trim() !== token) {
    throw new Error("Invalid stored owner token.");
  }
  const attempts = z
    .array(z.string())
    .parse(JSON.parse(deps.readFile(join(client.dir, "attempts.json"))));
  if (attempts.at(-1) !== config.requestId) {
    throw new Error("Request does not match the current attempt.");
  }
  return { config, token };
}
export function nextBrokerRequest(
  client: BrokerClientFiles,
  deps: BrokerClientFileDeps,
): SessionConfig {
  const path = join(client.dir, "attempts.json");
  const attempts = deps.exists(path)
    ? z.array(z.string()).parse(JSON.parse(deps.readFile(path)))
    : [];
  const ids = new BrokerBatchRequestIds({ next: () => client.batchId });
  let requestId = "";
  for (let n = 0; n <= attempts.length; n++) {
    requestId = ids.next(client.name);
  }
  const base = renderClientRequest(
    {
      name: client.name,
      platform: client.initial.device.platform,
      hardware: client.initial.device.hardware,
      os: client.initial.device.os,
    },
    requestId,
  );
  return parseSessionConfig({ ...client.initial, ...base });
}
/** Archive completed evidence by rename. No immutable request inode is overwritten. */
export function archiveBrokerAttempt(
  client: BrokerClientFiles,
  resume: boolean,
  deps: BrokerClientFileDeps,
): void {
  const path = join(client.dir, "request.json");
  if (!deps.exists(path)) {
    return;
  }
  const attempts = z
    .array(z.string())
    .parse(JSON.parse(deps.readFile(join(client.dir, "attempts.json"))));
  const archive = join(
    client.dir,
    "attempts",
    String(attempts.length),
    resume ? `replay-${deps.ids.next()}` : "execution",
  );
  if (deps.exists(archive)) {
    throw new Error("Attempt archive already exists; refusing to overwrite evidence.");
  }
  deps.mkdir(archive);
  for (const name of [
    "request.json",
    "owner.pid",
    "owner-identity",
    "init.json",
    "driver.pid",
    "proxy.pid",
    "closed.json",
    "events.jsonl",
    "notifications.jsonl",
    "in",
    "out",
    "serve.log",
    "proxy.stderr.log",
    "host-sleep.json",
  ]) {
    if (resume && ["request.json", "owner.pid", "owner-identity"].includes(name)) {
      continue;
    }
    if (deps.exists(join(client.dir, name))) {
      deps.rename(join(client.dir, name), join(archive, name));
    }
  }
}
export function persistBrokerAttempt(
  client: BrokerClientFiles,
  config: SessionConfig,
  deps: BrokerClientFileDeps,
): void {
  deps.mkdir(client.dir);
  writeImmutableRequest(
    join(client.dir, "request.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    deps,
  );
  const tokenPath = join(client.dir, "owner-token");
  if (!deps.exists(tokenPath)) {
    deps.writeFile(tokenPath, deps.ids.next(), { mode: 0o600, flag: "wx" });
  }
  const attemptsPath = join(client.dir, "attempts.json");
  const attempts = deps.exists(attemptsPath)
    ? z.array(z.string()).parse(JSON.parse(deps.readFile(attemptsPath)))
    : [];
  if (attempts.at(-1) !== config.requestId) {
    if (attempts.includes(config.requestId)) {
      throw new Error("Use --resume to replay the current request.");
    }
    deps.writeFile(attemptsPath, `${JSON.stringify([...attempts, config.requestId], null, 2)}\n`);
  }
}
