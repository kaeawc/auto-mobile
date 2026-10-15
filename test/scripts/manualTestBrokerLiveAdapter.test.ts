import { beforeAll, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import {
  assertPrivateBrokerBatch,
  createBrokerLiveContext,
} from "../../scripts/manual-test/brokerLiveAdapter";
import { createProxySessionDeps } from "../../scripts/manual-test/proxy-session";
import { derivePrivateDaemonBatch } from "../../scripts/manual-test/privateDaemonEnv";
import {
  renderClientRequest,
  renderHostConfig,
  parseBrokerBatch,
} from "../../scripts/manual-test/brokerBatch";
import { runBrokerScenario, brokerScenarios } from "../../scripts/manual-test/brokerScenarios";
import { FakeBrokerDaemonClient } from "../helpers/FakeBrokerDaemonClient";
import { createFakeBrokerDaemon } from "../helpers/fakeBrokerDaemon";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import {
  brokerBatchInput,
  fixture as daemonFixture,
  options as baseOptions,
} from "./manualTestPrivateDaemonFixture";
import { isSessionBrokerDeviceName } from "../../src/daemon/sessionBroker/deviceNaming";

beforeAll(async () => {
  const host = await createFakeBrokerDaemon();
  await host.close();
});
function fixture() {
  const f = daemonFixture();
  const batchDir = baseOptions.batchDir;
  const options = { ...baseOptions, count: 1 };
  const specs = derivePrivateDaemonBatch(options);
  f.files.set(
    join(batchDir, "batch.json"),
    JSON.stringify({
      options,
      specs,
      broker: { daemon: 1, hostConfig: "broker/host-config.json" },
    }),
  );
  const batch = parseBrokerBatch(brokerBatchInput());
  f.files.set(join(batchDir, "broker/host-config.json"), JSON.stringify(renderHostConfig(batch)));
  f.files.set(
    join(batchDir, "broker/clients.json"),
    JSON.stringify(
      Object.fromEntries(
        batch.clients.map((c) => {
          const request = renderClientRequest(c, `batch-${c.name}-1`);
          return [
            c.name,
            {
              platform: c.platform,
              profile: request.device,
              requestId: request.requestId,
              tokenFile: `sessions/${c.name}/owner-token`,
            },
          ];
        }),
      ),
    ),
  );
  const client = new FakeBrokerDaemonClient();
  const proxy = {
    ...createProxySessionDeps(),
    ...f.deps,
    pid: 1,
    ids: new FakeIdGenerator(),
    mkdir: () => {},
    rename: (from: string, to: string) => {
      f.files.set(to, f.files.get(from)!);
      f.files.delete(from);
    },
    appendFile: (path: string, text: string) => {
      f.files.set(path, (f.files.get(path) ?? "") + text);
    },
    probeDaemonSocket: async () => ({ alive: true }),
    brokerDaemonClient: client,
    writeJson: (path: string, data: unknown) => {
      f.files.set(path, JSON.stringify(data));
    },
  };
  const calls: string[][] = [];
  const deps = {
    daemon: f.deps,
    proxy,
    daemonClient: client,
    proxyCommand: async (argv: string[]) => {
      calls.push(argv);
      return { code: 0, output: "" };
    },
    devicesView: async () => ({ devices: [], daemons: [{ alive: true }] }),
  };
  return {
    ...f,
    batchDir,
    specs,
    client,
    calls,
    deps,
    evidence: { mkdir: proxy.mkdir, writeFile: proxy.writeFile },
  };
}
test("private batch validation refuses resident paths, ports, excessive caps and pooling before I/O", () => {
  const f = fixture();
  expect(assertPrivateBrokerBatch(f.batchDir, f.deps.daemon).host.limits.totalDeviceCap).toBe(2);
  for (const path of [resolve("/home/fake/.auto-mobile"), "/tmp/auto-mobile-daemon-501.sock"]) {
    expect(() => assertPrivateBrokerBatch(path, f.deps.daemon)).toThrow();
  }
  const original = f.files.get(join(f.batchDir, "batch.json"))!;
  for (const patch of [{ basePort: 3000 }, { auxRoot: "/home/fake/.auto-mobile" }]) {
    const manifest = JSON.parse(original);
    Object.assign(manifest.options, patch);
    manifest.specs = derivePrivateDaemonBatch(manifest.options);
    f.files.set(join(f.batchDir, "batch.json"), JSON.stringify(manifest));
    expect(() => assertPrivateBrokerBatch(f.batchDir, f.deps.daemon)).toThrow();
  }
  f.files.set(join(f.batchDir, "batch.json"), original);
  expect(() => assertPrivateBrokerBatch(f.batchDir, f.deps.daemon, 1)).toThrow("capacity");
  expect(() => assertPrivateBrokerBatch(f.batchDir, f.deps.daemon, 5)).toThrow("1 to 4");
  const host = JSON.parse(f.files.get(join(f.batchDir, "broker/host-config.json"))!);
  host.reuseCleanDevices = true;
  f.files.set(join(f.batchDir, "broker/host-config.json"), JSON.stringify(host));
  expect(() => assertPrivateBrokerBatch(f.batchDir, f.deps.daemon)).toThrow("reuseCleanDevices");
  expect(f.calls).toEqual([]);
  expect(f.launches).toEqual([]);
});
test("adapter reports resource state unavailable and never calls prepare without an owned proxy", async () => {
  const f = fixture();
  const harness = await createBrokerLiveContext(f.batchDir, f.evidence, {}, f.deps);
  expect(await harness.context.deviceOps!.resources()).toEqual({
    unavailable: expect.stringContaining("No read-only broker"),
  });
  expect(await harness.context.deviceOps!.devicesView()).toEqual({
    devices: [],
    daemons: [{ alive: true }],
  });
  await expect(harness.context.prepare(harness.context.clients[0].config, "token")).rejects.toThrow(
    "owned proxy",
  );
  expect(f.client.calls).toEqual([]);
  await harness.close();
  expect(f.calls).toEqual([]);
});
test("adapter preserves actual request/token, holds boot permit, observes explicit session, closes only owned clients", async () => {
  const f = fixture();
  const c = "a-phone";
  const initial = renderClientRequest({ name: c, platform: "android" }, `batch-${c}-2`);
  const grant = {
    contractVersion: 1,
    requestId: initial.requestId,
    outcome: "ready",
    sessionUuid: "session-1",
    profile: null,
    cleanupPending: false,
  };
  let permit = false;
  f.deps.daemon.bootLock = {
    tryAcquire: () => {
      permit = true;
      return true;
    },
    release: () => {
      permit = false;
    },
  };
  f.client.infoResults = [
    {
      sessionId: "session-1",
      nativeDevice: { name: "amslot-12345678-0-g1-abc", deviceId: "serial", platform: "android" },
    },
  ];
  expect(isSessionBrokerDeviceName("amslot-12345678-0-g1-abc")).toBe(true);
  f.deps.proxyCommand = async (argv) => {
    f.calls.push(argv);
    if (argv[0] === "up") {
      expect(permit).toBe(true);
      f.files.set(join(f.batchDir, "sessions", c, "request.json"), JSON.stringify(initial));
      f.files.set(
        join(f.batchDir, "sessions", c, "attempts.json"),
        JSON.stringify([initial.requestId]),
      );
      f.files.set(join(f.batchDir, "sessions", c, "owner-token"), "secret-token");
      f.files.set(join(f.batchDir, "sessions", c, "init.json"), JSON.stringify({ session: grant }));
    }
    return { code: 0, output: JSON.stringify({ ok: true, result: {} }) };
  };
  const harness = await createBrokerLiveContext(f.batchDir, f.evidence, { clients: [c] }, f.deps);
  const ctx = harness.context,
    ops = ctx.deviceOps!,
    client = ctx.clients[0];
  expect(
    await ops.bootGate(c, 2, () => ops.acquire(client, { disposableOwner: false, resume: false })),
  ).toEqual(grant);
  expect(permit).toBe(false);
  expect(client.config.requestId).toBe(initial.requestId);
  expect(client.token).toBe("secret-token");
  await ops.observe(client);
  expect(f.calls[1]).toEqual([
    "call",
    "observe",
    JSON.stringify({ sessionUuid: "session-1" }),
    "--client",
    c,
  ]);
  ctx.fs.writeFile("/redacted", '"secret-token"');
  expect(f.files.get("/redacted")).toBe('"[REDACTED]"');
  await harness.close();
  expect(f.calls.at(-1)).toEqual(["close", "--client", c]);
  expect(f.calls.filter((args) => args[0] === "close")).toHaveLength(1);
});
test("real in-memory broker release keeps destruction assertions not-verifiable with unavailable samples", async () => {
  const f = fixture();
  const host = await createFakeBrokerDaemon({ capacity: 2 });
  const harness = await createBrokerLiveContext(
    f.batchDir,
    f.evidence,
    {},
    { ...f.deps, daemonClient: host.client },
  );
  const ctx = harness.context;
  const clients = ctx.clients.map((c) => ({
    ...c,
    token: `token-${c.name}`,
    config: renderClientRequest({ name: c.name, platform: "ios" }, c.config.requestId),
  }));
  const ops = ctx.deviceOps!;
  ops.bootGate = async (_name, _permits, action) => action();
  ops.acquire = (c) => host.prepare(c.config, c.token);
  ops.observe = async (c) => {
    if ((await host.client.status(c.config.requestId, c.token))?.outcome !== "ready") {
      throw new Error("broker_session_ended");
    }
  };
  ops.close = async () => {};
  ops.devicesView = host.controls.inventory;
  const scenario = brokerScenarios.find(
    (s) => s.name === "release-destroy-verification" && s.class === "device",
  )!;
  const context = {
    ...ctx,
    clients,
    timer: host.timer,
    ids: host.ids,
    preflight: async () => true,
  };
  try {
    const summary = await runBrokerScenario(scenario, context, { device: true });
    expect(summary.outcome).toBe("passed");
    expect(summary.assertions).toContainEqual({
      assertion: "resource destruction",
      status: "not-verifiable",
      reason: expect.any(String),
    });
    expect(
      ctx.ledger
        .devices()
        .every((d) => ctx.ledger.hasEvent(d, "released") && ctx.ledger.hasEvent(d, "absent")),
    ).toBe(true);
  } finally {
    await host.close();
  }
});

test("production proxy command adapter runs up/tools/close through fake process and file seams", async () => {
  const f = fixture();
  const name = "a-phone",
    dir = join(f.batchDir, "sessions", name);
  f.files.set(f.specs[0].pidFilePath, JSON.stringify({ pid: 987 }));
  f.deps.proxy.isPidAlive = () => true;
  f.deps.proxy.spawnServe = (command) => {
    const config = JSON.parse(f.files.get(join(dir, "request.json"))!);
    f.files.set(
      join(dir, "init.json"),
      JSON.stringify({
        ok: true,
        session: {
          contractVersion: 1,
          requestId: config.requestId,
          outcome: "ready",
          sessionUuid: "live-fake-session",
          profile: null,
          cleanupPending: false,
        },
      }),
    );
    expect(command.client).toBe(name);
    return 12345;
  };
  f.deps.proxy.writeJson = (path, data) => {
    f.files.set(path, JSON.stringify(data));
    if (dirname(path) === join(dir, "in")) {
      const request = data as { op: string; id: string };
      f.files.set(
        join(dir, "out", `${request.id}.json`),
        JSON.stringify({ ok: true, result: { tools: [] } }),
      );
      if (request.op === "close") {
        f.files.set(join(dir, "closed.json"), JSON.stringify({ reason: "closed" }));
      }
    }
  };
  f.client.infoResults = [
    { nativeDevice: { name: "ambroker-fake", deviceId: "serial", platform: "android" } },
  ];
  const harness = await createBrokerLiveContext(
    f.batchDir,
    f.evidence,
    { clients: [name] },
    { ...f.deps, proxyCommand: undefined },
  );
  const c = harness.context.clients[0];
  const grant = await harness.context.deviceOps!.acquire(c, {
    disposableOwner: false,
    resume: false,
  });
  expect(grant.outcome).toBe("ready");
  expect(await harness.context.deviceOps!.tools!(c)).toEqual([]);
  f.client.statusResults = [{ ...grant, outcome: "released" }];
  await harness.close();
  expect(f.files.get(join(dir, "closed.json"))).toContain('"outcome":"released"');
  expect(f.launches).toEqual([]);
});

test("adapter refuses tampered resident socket/data paths and unresolved prior grants before proxy operations", async () => {
  for (const change of ["socket", "data", "not-broker", "unreleased"]) {
    const f = fixture();
    const path = join(f.batchDir, "batch.json");
    const manifest = JSON.parse(f.files.get(path)!);
    if (change === "socket") {
      manifest.specs[0].socketPath = "/tmp/auto-mobile-daemon-501.sock";
    }
    if (change === "data") {
      manifest.specs[0].env.AUTOMOBILE_DATA_DIR = "/home/fake/.auto-mobile";
    }
    if (change === "not-broker") {
      delete manifest.broker;
    }
    f.files.set(path, JSON.stringify(manifest));
    if (change === "unreleased") {
      f.files.set(
        join(f.batchDir, "evidence/ledger.jsonl"),
        JSON.stringify({
          batchDir: f.batchDir,
          at: 0,
          kind: "acquired",
          client: "a-phone",
          requestId: "old-request",
          sessionUuid: "old-session",
        }) + "\n",
      );
    }
    await expect(createBrokerLiveContext(f.batchDir, f.evidence, {}, f.deps)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(f.client.calls).toEqual([]);
    expect(f.launches).toEqual([]);
  }
});
