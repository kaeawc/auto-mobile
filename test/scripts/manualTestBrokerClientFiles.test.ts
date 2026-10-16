import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  archiveBrokerAttempt,
  nextBrokerRequest,
  persistBrokerAttempt,
  readBrokerClients,
  readBrokerIdentity,
  resolveBrokerClient,
  writeImmutableRequest,
  type BrokerClientFileDeps,
} from "../../scripts/manual-test/brokerClientFiles";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
const batch = "/batch";
const device = {
  schemaVersion: 1,
  platform: "android",
  hardware: { kind: "archetype", archetype: "phone" },
  os: { kind: "omitted" },
};
/** Keys are slash-normalized so the fake tree behaves the same with Windows path separators. */
class SlashPathMap extends Map<string, string> {
  private static key(path: string): string {
    return path.replaceAll("\\", "/");
  }
  override get(path: string) {
    return super.get(SlashPathMap.key(path));
  }
  override has(path: string) {
    return super.has(SlashPathMap.key(path));
  }
  override set(path: string, bytes: string) {
    return super.set(SlashPathMap.key(path), bytes);
  }
  override delete(path: string) {
    return super.delete(SlashPathMap.key(path));
  }
}
function fixture() {
  const files = new SlashPathMap();
  const writes: Array<{ path: string; mode?: number; flag?: string }> = [];
  const deps: BrokerClientFileDeps = {
    ids: new FakeIdGenerator(["owner-secret", "replay-id"]),
    exists: (path) =>
      files.has(path) ||
      [...files.keys()].some((file) => file.startsWith(`${path.replaceAll("\\", "/")}/`)),
    readFile: (path) => {
      if (!files.has(path)) {
        throw new Error(`Missing fake file ${path}`);
      }
      return files.get(path)!;
    },
    writeFile: (path, bytes, options) => {
      if (options?.flag === "wx" && files.has(path)) {
        throw new Error("EEXIST");
      }
      files.set(path, bytes);
      writes.push({ path, ...options });
    },
    mkdir: () => {},
    rename: (fromPath, toPath) => {
      const from = fromPath.replaceAll("\\", "/");
      const to = toPath.replaceAll("\\", "/");
      for (const [path, bytes] of [...files]) {
        if (path === from || path.startsWith(`${from}/`)) {
          files.set(to + path.slice(from.length), bytes);
          files.delete(path);
        }
      }
    },
  };
  files.set(
    join(batch, "broker/clients.json"),
    JSON.stringify({
      phone: {
        platform: "android",
        profile: device,
        requestId: "batch-seed-phone-1",
        tokenFile: "sessions/phone/owner-token",
        idleTimeoutMs: 600000,
        preparationTimeoutMs: 1000,
      },
    }),
  );
  const client = resolveBrokerClient(batch, "phone", deps);
  return { files, writes, deps, client };
}
test("resolve batch clients uses init's typed profile and rejects unknown/traversal identities", () => {
  const f = fixture();
  expect(readBrokerClients(batch, f.deps)).toEqual(["phone"]);
  expect(f.client.initial.device).toEqual(device);
  expect(f.client.batchId).toBe("batch-seed");
  expect(() => resolveBrokerClient(undefined, "phone", f.deps)).toThrow("MT_BATCH");
  expect(() => resolveBrokerClient(batch, "missing", f.deps)).toThrow("Unknown batch client");
  expect(() => resolveBrokerClient(batch, "../phone", f.deps)).toThrow("Invalid broker client");
  const clients = JSON.parse(f.files.get(join(batch, "broker/clients.json"))!);
  clients.phone.tokenFile = "../owner-token";
  f.files.set(join(batch, "broker/clients.json"), JSON.stringify(clients));
  expect(() => resolveBrokerClient(batch, "phone", f.deps)).toThrow("token file");
});
test("request bytes are immutable, exclusive and private; equivalent JSON with changed bytes is refused", () => {
  const f = fixture();
  const config = nextBrokerRequest(f.client, f.deps);
  const path = join(f.client.dir, "request.json");
  const bytes = JSON.stringify(config);
  writeImmutableRequest(path, bytes, f.deps);
  writeImmutableRequest(path, bytes, f.deps);
  expect(f.writes).toEqual([{ path, mode: 0o600, flag: "wx" }]);
  expect(() => writeImmutableRequest(path, `${bytes}\n`, f.deps)).toThrow("immutable");
  expect(() =>
    writeImmutableRequest(path, JSON.stringify({ ...config, requestId: "other" }), f.deps),
  ).toThrow("immutable");
  expect(f.files.get(path)).toBe(bytes);
});
test("persisted request and token replay byte-for-byte with ordered batch attempt IDs", () => {
  const f = fixture();
  const first = nextBrokerRequest(f.client, f.deps);
  expect(first).toMatchObject({
    requestId: "batch-seed-phone-1",
    idleTimeoutMs: 600000,
    preparationTimeoutMs: 1000,
  });
  persistBrokerAttempt(f.client, first, f.deps);
  const bytes = f.files.get(join(f.client.dir, "request.json"));
  expect(readBrokerIdentity(f.client, f.deps)).toEqual({ config: first, token: "owner-secret" });
  expect(f.writes.find(({ path }) => path.endsWith("owner-token"))).toMatchObject({
    mode: 0o600,
    flag: "wx",
  });
  const count = f.writes.length;
  persistBrokerAttempt(f.client, first, f.deps);
  expect(f.writes).toHaveLength(count);
  const second = nextBrokerRequest(f.client, f.deps);
  expect(second.requestId).toBe("batch-seed-phone-2");
  expect(() => persistBrokerAttempt(f.client, second, f.deps)).toThrow("immutable");
  f.files.set(join(f.client.dir, "in/stale.json"), "{}");
  archiveBrokerAttempt(f.client, false, f.deps);
  persistBrokerAttempt(f.client, second, f.deps);
  expect(f.files.get(join(f.client.dir, "attempts/1/execution/request.json"))).toBe(bytes);
  expect(f.files.get(join(f.client.dir, "attempts/1/execution/in/stale.json"))).toBe("{}");
  expect(f.files.has(join(f.client.dir, "in/stale.json"))).toBe(false);
  expect(f.files.get(join(f.client.dir, "owner-token"))).toBe("owner-secret");
  expect(JSON.parse(f.files.get(join(f.client.dir, "attempts.json"))!)).toEqual([
    first.requestId,
    second.requestId,
  ]);
});
test("resume archives stale inbox/evidence and preserves disposable owner and request bytes", () => {
  const f = fixture();
  const config = nextBrokerRequest(f.client, f.deps);
  persistBrokerAttempt(f.client, config, f.deps);
  const bytes = f.files.get(join(f.client.dir, "request.json"));
  f.files.set(join(f.client.dir, "owner.pid"), "123\n");
  f.files.set(join(f.client.dir, "owner-identity"), "generation");
  f.files.set(join(f.client.dir, "init.json"), "{}");
  f.files.set(join(f.client.dir, "in/old.json"), "{}");
  archiveBrokerAttempt(f.client, true, f.deps);
  expect(f.files.get(join(f.client.dir, "request.json"))).toBe(bytes);
  expect(f.files.get(join(f.client.dir, "owner.pid"))).toBe("123\n");
  expect(f.files.get(join(f.client.dir, "owner-identity"))).toBe("generation");
  expect(f.files.has(join(f.client.dir, "init.json"))).toBe(false);
  expect(f.files.get(join(f.client.dir, "attempts/1/replay-replay-id/in/old.json"))).toBe("{}");
  expect(readBrokerIdentity(f.client, f.deps).token).toBe("owner-secret");
});
test("resume refuses missing, corrupt or mismatched identity without changing files", () => {
  const f = fixture();
  expect(() => readBrokerIdentity(f.client, f.deps)).toThrow("Missing fake file");
  persistBrokerAttempt(f.client, nextBrokerRequest(f.client, f.deps), f.deps);
  f.files.set(join(f.client.dir, "attempts.json"), '["wrong-id"]');
  expect(() => readBrokerIdentity(f.client, f.deps)).toThrow("current attempt");
  f.files.set(join(f.client.dir, "owner-token"), "\n");
  expect(() => readBrokerIdentity(f.client, f.deps)).toThrow("Invalid stored owner token");
});
test("archive collisions cannot overwrite an earlier immutable request", () => {
  const f = fixture();
  persistBrokerAttempt(f.client, nextBrokerRequest(f.client, f.deps), f.deps);
  f.files.set(join(f.client.dir, "attempts/1/execution/request.json"), "prior immutable evidence");
  const current = f.files.get(join(f.client.dir, "request.json"));
  expect(() => archiveBrokerAttempt(f.client, false, f.deps)).toThrow("archive already exists");
  expect(f.files.get(join(f.client.dir, "attempts/1/execution/request.json"))).toBe(
    "prior immutable evidence",
  );
  expect(f.files.get(join(f.client.dir, "request.json"))).toBe(current);
});
