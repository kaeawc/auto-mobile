import { parseDevicesViewOutput } from "../../scripts/manual-test/broker-batch";
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  parseBrokerBatchArgs,
  runBrokerBatchCommand,
  type BrokerBatchCommand,
  type BrokerBatchOrchestratorDeps,
} from "../../scripts/manual-test/broker-batch";
import {
  BrokerBatchRequestIds,
  parseBrokerBatch,
  renderClientRequest,
  renderHostConfig,
} from "../../scripts/manual-test/brokerBatch";
import { BrokerDeviceLedger } from "../../scripts/manual-test/brokerDeviceLedger";
import type { SessionBrokerResult } from "../../src/devices/sessionBrokerResult";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeBrokerDaemonClient } from "../helpers/FakeBrokerDaemonClient";
import { drainUntilQuiescent, settleByFakeEvents } from "../helpers/fakeTimerStepping";
import { brokerBatchInput } from "./manualTestPrivateDaemonFixture";

function parsed(args: string[]): BrokerBatchCommand {
  const command = parseBrokerBatchArgs(args);
  if ("help" in command || "error" in command) {
    throw new Error("Expected valid command");
  }
  return command;
}
function fixture(cap = 2) {
  const batchDir = resolve("/batch");
  const timer = new FakeTimer();
  const ids = new FakeIdGenerator(["batch-id"]);
  const input = brokerBatchInput();
  input.limits.totalDeviceCap = cap;
  input.limits.sessionCap = cap;
  const batch = parseBrokerBatch(input, { maxDevices: 4 });
  const requestIds = new BrokerBatchRequestIds(ids);
  const files = new Map<string, string>();
  const logs: string[] = [];
  const commands: Array<{ argv: string[]; at: number }> = [];
  const proxyCalls: string[][] = [];
  const starts: string[] = [];
  const sessions = new Map<string, SessionBrokerResult>();
  const broker = new FakeBrokerDaemonClient();
  const clients = Object.fromEntries(
    batch.clients.map((client) => {
      const request = renderClientRequest(client, requestIds.next(client.name));
      return [
        client.name,
        {
          platform: client.platform,
          profile: request.device,
          requestId: request.requestId,
          tokenFile: `sessions/${client.name}/owner-token`,
        },
      ];
    }),
  );
  files.set(join(batchDir, "broker/clients.json"), JSON.stringify(clients));
  files.set(join(batchDir, "broker/host-config.json"), JSON.stringify(renderHostConfig(batch)));
  const fs = {
    exists: (path: string) => files.has(path),
    readFile: (path: string) => {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`Missing fake file ${path}`);
      }
      return value;
    },
    writeFile: (path: string, text: string) => {
      files.set(path, text);
    },
    mkdir: () => {},
    appendFile: (path: string, text: string) => {
      files.set(path, (files.get(path) ?? "") + text);
    },
  };
  let preflights = 0;
  const probes: unknown[] = [];
  const deps: BrokerBatchOrchestratorDeps = {
    batchDir,
    fs,
    timer,
    daemonClient: broker,
    acquisitionTimeoutMs: 1000,
    cleanupTimeoutMs: 2000,
    preflight: async () => {
      preflights++;
      return 0;
    },
    probe: async (options) => {
      probes.push(options);
      return (await broker.capabilities()).includes(options.requireCapability)
        ? { alive: true }
        : { alive: false, reason: "Missing session-broker/v1" };
    },
    spawnClient: async (argv) => {
      commands.push({ argv, at: timer.now() });
      const name = argv[argv.indexOf("--client") + 1];
      starts.push(name);
      const expected = argv[argv.indexOf("--expect") + 1];
      const session: SessionBrokerResult = {
        contractVersion: 1,
        requestId: clients[name].requestId,
        outcome: expected === "ready" ? "ready" : "failed",
        sessionUuid: expected === "ready" ? ids.next() : null,
        profile: null,
        cleanupPending: false,
        ...(expected === "ready"
          ? {}
          : {
              failure: {
                code: "capacity_exhausted",
                message: "at cap",
                retryable: true,
              },
            }),
      };
      sessions.set(name, session);
      files.set(join(batchDir, "sessions", name, "request.json"), "{}");
      files.set(join(batchDir, "sessions", name, "owner-token"), `secret-${name}`);
      files.set(join(batchDir, "sessions", name, "init.json"), JSON.stringify({ session }));
      return 0;
    },
    proxy: async (argv) => {
      proxyCalls.push(argv);
      return 0;
    },
    devicesView: async () => ({ devices: [], daemons: [{ alive: true }] }),
    isPidAlive: () => false,
    log: (text) => {
      logs.push(text);
    },
  };
  // Scripted native replies use the injected identity primitive, never real processes.
  broker.infoResults = batch.clients.slice(0, cap).map((client, index) => ({
    sessionId: `fake-${index + 1}`,
    nativeDevice: {
      name: `ambroker-${client.name}`,
      deviceId: `native-${client.name}`,
      platform: client.platform,
    },
  }));
  const run = (args: string[]) => runBrokerBatchCommand(parsed(args), deps);
  return {
    deps,
    batchDir,
    timer,
    files,
    logs,
    commands,
    proxyCalls,
    starts,
    broker,
    sessions,
    probes,
    preflights: () => preflights,
    run,
  };
}

test("up gates whole acquisitions, checks preflight/capability, and accepts planned refusals", async () => {
  const f = fixture();
  expect(await f.run(["up", "--all"])).toBe(0);
  expect(f.preflights()).toBe(1);
  expect(f.probes).toEqual([{ requireCapability: "session-broker/v1" }]);
  expect(f.starts).toEqual(["a-phone", "a-tablet", "i-phone"]);
  for (const { argv } of f.commands) {
    expect(argv.slice(0, 3)).toEqual(["boot-gate", "--batch-dir", f.batchDir]);
    expect(argv[argv.indexOf("--max-concurrent") + 1]).toBe("2");
    expect(argv.slice(argv.indexOf("--"), argv.indexOf("--") + 4)).toEqual([
      "--",
      "bash",
      join(f.batchDir, "bin/proxy1"),
      "up",
    ]);
  }
  expect(f.commands.at(-1)!.argv.at(-1)).toBe("failed:capacity_exhausted");
  expect(f.broker.calls.filter((call) => call.method === "info")).toHaveLength(2);
});

test("stagger spaces starts on fake time, and ready phase joins before refusal phase", async () => {
  const f = fixture();
  const original = f.deps.spawnClient;
  f.deps.spawnClient = async (argv) => {
    const code = await original(argv);
    if (argv.at(-1) === "ready") {
      await f.timer.sleep(100);
    }
    return code;
  };
  const pending = f.run(["up", "--stagger-ms", "30"]);
  expect(await settleByFakeEvents(f.timer, pending, { description: "staggered up" })).toBe(0);
  expect(f.commands.map((row) => row.at)).toEqual([0, 30, 130]);
  const state = JSON.parse(f.files.get(join(f.batchDir, "evidence/broker-launches.json"))!);
  expect(state.launches.map((row: { durationMs: number }) => row.durationMs)).toEqual([
    100, 100, 0,
  ]);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});

test("down closes in reverse launch order, joining each receipt before the next close", async () => {
  const f = fixture();
  expect(await f.run(["up"])).toBe(0);
  f.broker.statusResults = [...f.sessions.values()]
    .filter((session) => session.outcome === "ready")
    .map((session) => ({ ...session, outcome: "released" }));
  f.deps.proxy = async (argv) => {
    f.proxyCalls.push(argv);
    await f.timer.sleep(100);
    return 0;
  };
  const down = f.run(["down"]);
  await drainUntilQuiescent(f.timer);
  expect(f.proxyCalls).toEqual([["close", "--client", "i-phone"]]);
  expect(await settleByFakeEvents(f.timer, down, { description: "reverse close" })).toBe(0);
  expect(f.proxyCalls.map((argv) => argv.at(-1))).toEqual(["i-phone", "a-tablet", "a-phone"]);
  expect(f.logs.at(-1)).toContain("0 unverified grant(s) of 2");
  const ledger = new BrokerDeviceLedger({ batchDir: f.batchDir, fs: f.deps.fs, timer: f.timer });
  expect(ledger.devices().every((row) => ledger.hasEvent(row, "absent"))).toBe(true);
});

test.each(["preflight", "capability"])("%s refusal prevents any spawn", async (kind: string) => {
  const f = fixture();
  if (kind === "preflight") {
    f.deps.preflight = async () => 1;
  } else {
    f.broker.capabilityResults = [[]];
  }
  expect(await f.run(["up"])).toBe(2);
  expect(f.commands).toHaveLength(0);
  expect(f.logs.join("\n")).toContain(
    kind === "preflight" ? "preflight --strict" : "session-broker/v1",
  );
});

test("a hung acquisition is bounded, recorded, and prevents refusal launches", async () => {
  const f = fixture();
  f.deps.spawnClient = (argv) => {
    f.commands.push({ argv, at: f.timer.now() });
    return new Promise(() => {});
  };
  expect(
    await settleByFakeEvents(f.timer, f.run(["up"]), { description: "acquisition deadline" }),
  ).toBe(2);
  expect(f.timer.now()).toBe(1000);
  expect(f.commands).toHaveLength(2);
  expect(f.logs.join("\n")).toContain("timed out after 1000ms");
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});

test("hung closes have bounded cleanup waits", async () => {
  const f = fixture(0);
  expect(await f.run(["up"])).toBe(0);
  f.deps.proxy = async () => new Promise(() => {});
  expect(
    await settleByFakeEvents(f.timer, f.run(["down"]), { description: "close deadlines" }),
  ).toBe(2);
  expect(f.timer.now()).toBe(6000);
  expect(f.logs.filter((line) => line.includes("timed out"))).toHaveLength(3);
});

test("down reports leaks when release is confirmed but the native device persists", async () => {
  const f = fixture(1);
  expect(await f.run(["up"])).toBe(0);
  const session = f.sessions.get("a-phone")!;
  f.broker.statusResults = [{ ...session, outcome: "released" }];
  f.deps.devicesView = async () => ({
    devices: [{ name: "ambroker-a-phone", deviceId: "native-a-phone", platform: "android" }],
    daemons: [{ alive: true }],
  });
  expect(await settleByFakeEvents(f.timer, f.run(["down"]), { description: "leak deadline" })).toBe(
    2,
  );
  expect(f.logs.join("\n")).toContain("1 unverified grant(s)");
  expect(f.files.get(join(f.batchDir, "evidence/ledger.jsonl"))).toContain('"kind":"leaked"');
});

test("report contains outcomes, failures, devices, durations and comparisons without tokens", async () => {
  const f = fixture();
  expect(await f.run(["up"])).toBe(0);
  expect(await f.run(["report"])).toBe(0);
  const bytes = f.files.get(join(f.batchDir, "evidence/broker-report.json"))!;
  const report = JSON.parse(bytes);
  expect(report.clients[0]).toMatchObject({
    client: "a-phone",
    outcome: "ready",
    expected: "ready",
    matchesExpected: true,
    acquisitionDurationMs: 0,
    devices: [{ name: "ambroker-a-phone" }],
  });
  expect(report.clients[2]).toMatchObject({
    outcome: "failed",
    failure: { code: "capacity_exhausted", retryable: true },
    matchesExpected: true,
    sessionUuid: null,
    devices: [],
  });
  expect(report.ledger.summary).toEqual({
    grants: 2,
    devices: 2,
    released: 0,
    absent: 0,
    pooled: 0,
  });
  expect(bytes + f.logs.join("\n")).not.toContain("secret-");
});

test("errors and report fields redact stored tokens, including JSON-escaped tokens", async () => {
  const f = fixture();
  const path = join(f.batchDir, "sessions/a-phone/owner-token");
  f.files.set(path, 'secret-"\\token');
  f.deps.spawnClient = async () => {
    throw new Error(f.files.get(path));
  };
  expect(await f.run(["up"])).toBe(2);
  expect(f.logs.join("\n")).toContain("[REDACTED]");
  expect(f.logs.join("\n")).not.toContain("secret-");
});

test("status delegates to the shared proxy-session status --all table", async () => {
  const f = fixture();
  expect(await f.run(["status"])).toBe(0);
  expect(f.proxyCalls).toEqual([["status", "--all"]]);
  expect(f.commands).toHaveLength(0);
});

test("explicit client selection replans capacity and leaves other clients untouched", async () => {
  const f = fixture(1);
  f.broker.infoResults = [
    {
      sessionId: "fake-1",
      nativeDevice: {
        name: "ambroker-i-phone",
        deviceId: "native-i-phone",
        platform: "ios",
      },
    },
  ];
  expect(await f.run(["up", "--clients", "i-phone"])).toBe(0);
  expect(f.starts).toEqual(["i-phone"]);
  expect(f.commands[0].argv.at(-1)).toBe("ready");
});

test("default and hard host ceilings refuse before preflight or launch", async () => {
  const f = fixture(3);
  expect(await f.run(["up"])).toBe(2);
  expect(f.preflights()).toBe(0);
  expect(f.logs.join("\n")).toContain("totalDeviceCap");
  expect(f.commands).toHaveLength(0);
  expect(parseBrokerBatchArgs(["up", "--max-devices", "5"])).toHaveProperty("error");
});

test.each(
  [
    ["up", "--clients", "a-phone", "--all"],
    ["up", "--clients", "a-phone,a-phone"],
    ["up", "--clients", "../foreign"],
    ["up", "--stagger-ms", "-1"],
    ["up", "--stagger-ms", "2147483648"],
    ["status", "--all"],
    ["up", "--unknown"],
  ].map((args) => ({ args })),
)("invalid flags %j are usage errors", ({ args }) => {
  expect(parseBrokerBatchArgs(args)).toHaveProperty("error");
});

test.each(["preflight", "probe"])("a hung %s is bounded before launch", async (kind: string) => {
  const f = fixture();
  if (kind === "preflight") {
    f.deps.preflight = async () => new Promise(() => {});
  } else {
    f.deps.probe = async () => new Promise(() => {});
  }
  expect(
    await settleByFakeEvents(f.timer, f.run(["up"]), { description: "startup deadline" }),
  ).toBe(2);
  expect(f.timer.now()).toBe(kind === "preflight" ? 30_000 : 5000);
  expect(f.commands).toHaveLength(0);
});

test("a hung inventory cannot escape the release and absence budget", async () => {
  const f = fixture(1);
  expect(await f.run(["up"])).toBe(0);
  f.broker.statusResults = [{ ...f.sessions.get("a-phone")!, outcome: "released" }];
  f.deps.devicesView = async () => new Promise(() => {});
  expect(
    await settleByFakeEvents(f.timer, f.run(["down"]), { description: "inventory deadline" }),
  ).toBe(2);
  expect(f.timer.now()).toBe(2000);
  expect(f.logs.join("\n")).toContain("1 unverified grant(s)");
});

test("an exit-zero outcome mismatch fails up and is shown in the report", async () => {
  const f = fixture();
  const original = f.deps.spawnClient;
  f.deps.spawnClient = async (argv) => {
    const code = await original(argv);
    if (argv.at(-1) !== "ready") {
      const name = argv[argv.indexOf("--client") + 1];
      f.files.set(
        join(f.batchDir, "sessions", name, "init.json"),
        JSON.stringify({
          session: {
            ...f.sessions.get(name),
            failure: { code: "timeout", retryable: true },
          },
        }),
      );
    }
    return code;
  };
  expect(await f.run(["up"])).toBe(2);
  expect(await f.run(["report"])).toBe(0);
  const report = JSON.parse(f.files.get(join(f.batchDir, "evidence/broker-report.json"))!);
  expect(report.clients[2]).toMatchObject({
    actual: "failed:timeout",
    matchesExpected: false,
    failure: { code: "timeout", retryable: true },
  });
});

test("report also redacts tokens embedded in ledger identities", async () => {
  const f = fixture(1);
  f.broker.infoResults = [
    {
      sessionId: "fake-1",
      nativeDevice: {
        name: "ambroker-secret-a-phone",
        deviceId: "native-a-phone",
        platform: "android",
      },
    },
  ];
  expect(await f.run(["up"])).toBe(0);
  expect(await f.run(["report"])).toBe(0);
  expect(f.files.get(join(f.batchDir, "evidence/broker-report.json"))).toContain("[REDACTED]");
  expect(
    f.files.get(join(f.batchDir, "evidence/broker-report.json")) + f.logs.join("\n"),
  ).not.toContain("secret-a-phone");
});

test("up refuses live recorded drivers and unknown client names before preflight", async () => {
  const f = fixture();
  f.files.set(join(f.batchDir, "sessions/a-phone/driver.pid"), "1234");
  f.deps.isPidAlive = () => true;
  expect(await f.run(["up"])).toBe(2);
  expect(f.preflights()).toBe(0);
  expect(f.commands).toHaveLength(0);
  expect(await f.run(["up", "--clients", "unknown"])).toBe(2);
});

test("a ready grant without native identity never passes down's absence check", async () => {
  const f = fixture(1);
  f.broker.infoResults = [new Error("identity unavailable")];
  expect(await f.run(["up"])).toBe(2);
  expect(await f.run(["down"])).toBe(2);
  expect(f.proxyCalls).toEqual([["close", "--client", "a-phone"]]);
  expect(f.logs.join("\n")).toContain("Native device identity missing");
});

test("an explicit ceiling permits three ready acquisitions while retaining a cap of three", async () => {
  const f = fixture(3);
  expect(await f.run(["up", "--max-devices", "4"])).toBe(0);
  expect(f.commands).toHaveLength(3);
  expect(f.commands.every(({ argv }) => argv[argv.indexOf("--max-concurrent") + 1] === "3")).toBe(
    true,
  );
});

test("malformed client metadata returns a usage error without leaking parser input", async () => {
  const f = fixture();
  f.files.set(join(f.batchDir, "broker/clients.json"), "secret-credential invalid json");
  expect(await f.run(["report"])).toBe(2);
  expect(f.logs.join("\n")).not.toContain("secret-credential");
});

test("down recovers an info-less grant only with a settled release receipt", async () => {
  const f = fixture(1);
  f.broker.infoResults = [new Error("identity unavailable")];
  expect(await f.run(["up"])).toBe(2);
  f.broker.statusResults = [
    { ...f.sessions.get("a-phone")!, outcome: "released", cleanupPending: false },
  ];
  expect(await f.run(["down"])).toBe(0);
  const rows = f.files
    .get(join(f.batchDir, "evidence/ledger.jsonl"))!
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows).toContainEqual(
    expect.objectContaining({ kind: "released", absence: "not-verifiable" }),
  );
  expect(rows.some((row) => row.kind === "absent")).toBe(false);
});
test.each([false, true])("up rechecks pooling using recorded allowReuse=%s", async (allowReuse) => {
  const f = fixture(1);
  f.files.set(join(f.batchDir, "batch.json"), JSON.stringify({ broker: { allowReuse } }));
  const path = join(f.batchDir, "broker/host-config.json");
  const config = JSON.parse(f.files.get(path)!);
  config.reuseCleanDevices = true;
  config.limits.idlePoolCap = 1;
  f.files.set(path, JSON.stringify(config));
  expect(await f.run(["up"])).toBe(allowReuse ? 0 : 2);
  expect(f.preflights()).toBe(allowReuse ? 1 : 0);
});

test.each(["pending", "wrong-session", "wrong-request"])(
  "info-less recovery rejects %s release evidence",
  async (kind) => {
    const f = fixture(1);
    f.broker.infoResults = [new Error("identity unavailable")];
    expect(await f.run(["up"])).toBe(2);
    const session = f.sessions.get("a-phone")!;
    f.broker.statusResults = [
      {
        ...session,
        outcome: "released",
        cleanupPending: kind === "pending",
        ...(kind === "wrong-session" ? { sessionUuid: "foreign" } : {}),
        ...(kind === "wrong-request" ? { requestId: "foreign" } : {}),
      },
    ];
    expect(await f.run(["down"])).toBe(2);
    expect(f.files.get(join(f.batchDir, "evidence/ledger.jsonl"))).not.toContain(
      '"kind":"released"',
    );
  },
);

test("up reports refused native info and records a leak without granting ledger ownership", async () => {
  const f = fixture();
  f.broker.infoResults[0] = {
    sessionId: "fake-1",
    nativeDevice: { name: "personal-device", deviceId: "protected", platform: "android" },
  };
  expect(await f.run(["up", "--all"])).not.toBe(0);
  expect(f.logs.join(" ")).toContain("Native device info refused");
  const ledger = new BrokerDeviceLedger({ batchDir: f.batchDir, fs: f.deps.fs, timer: f.timer });
  expect(ledger.devices().every((row) => row.device?.name !== "personal-device")).toBe(true);
  expect(
    ledger.entries.some((row) => row.kind === "leaked" && row.device?.name === "personal-device"),
  ).toBe(true);
});

test("devices inventory output tolerates diagnostics and surfaces them when no inventory arrives", () => {
  const view = { devices: [{ name: "n", deviceId: "d", platform: "ios" as const }], daemons: [] };
  expect(parseDevicesViewOutput(0, ["note: slow probe", JSON.stringify(view)])).toEqual(view);
  let message = "";
  try {
    parseDevicesViewOutput(2, ["Private daemon command failed: daemon 1 is stopped"]);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("Private daemon command failed: daemon 1 is stopped");
  expect(message).not.toContain("JSON Parse error");
  expect(() => parseDevicesViewOutput(0, [])).toThrow("inventory unavailable");
});

test("down accepts pooled devices and report counts them", async () => {
  const f = fixture(1);
  expect(await f.run(["up"])).toBe(0);
  const session = f.sessions.get("a-phone")!;
  f.broker.statusResults = [
    {
      ...session,
      outcome: "released",
      timing: {
        reset: {
          mode: "erase",
          outcome: "clean",
          phases: {},
          reuseCount: 0,
          startedAtMs: 0,
          totalMs: 1,
        },
      },
    },
  ];
  f.deps.devicesView = async () => ({
    devices: [{ name: "ambroker-a-phone", deviceId: "native-a-phone", platform: "android" }],
    daemons: [{ alive: true }],
  });
  expect(
    await settleByFakeEvents(f.timer, f.run(["down"]), { description: "pooled release" }),
  ).toBe(0);
  expect(f.logs.join("\n")).toContain(
    "Pooled a-phone on ambroker-a-phone: clean idle device retained by the broker pool.",
  );
  expect(await f.run(["report"])).toBe(0);
  expect(
    JSON.parse(f.files.get(join(f.batchDir, "evidence/broker-report.json"))!).ledger.summary.pooled,
  ).toBe(1);
});
