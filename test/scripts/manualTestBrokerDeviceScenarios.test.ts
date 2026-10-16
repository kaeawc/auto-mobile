import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  brokerScenarios,
  runBrokerScenario,
  type BrokerScenarioContext,
  type BrokerScenarioClient,
} from "../../scripts/manual-test/brokerScenarios";
import type {
  BrokerDeviceScenarioOps,
  PrivateDaemonControl,
  BrokerResourceSample,
} from "../../scripts/manual-test/brokerDeviceScenarios";
import { runBrokerScenarioCli } from "../../scripts/manual-test/broker-scenario";
import { BrokerDeviceLedger } from "../../scripts/manual-test/brokerDeviceLedger";
import { exampleSessionBrokerDeviceName } from "../../src/daemon/sessionBroker/deviceNaming";
import type { SessionBrokerResult } from "../../src/devices/sessionBrokerResult";
import { FakeBrokerDaemonClient } from "../helpers/FakeBrokerDaemonClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import captured from "../fixtures/session-broker/fake-lifecycle.json";

const scenarios = brokerScenarios.filter((s) => s.class === "device");
/** Logic tests only: scripted proxy, identity and native views do not prove device behavior. */
function fixture(clientCount = 2, timeoutCode = "timeout") {
  const timer = new FakeTimer();
  const files = new Map<string, string>();
  const fs = {
    exists: (path: string) => files.has(path),
    readFile: (path: string) => files.get(path)!,
    mkdir: () => {},
    appendFile: (path: string, text: string) => {
      files.set(path, (files.get(path) ?? "") + text);
    },
    writeFile: (path: string, text: string) => {
      files.set(path, text);
    },
  };
  const clients: BrokerScenarioClient[] = Array.from({ length: clientCount }, (_, i) => i).map(
    (i) => ({
      name: `client-${i}`,
      token: `secret-${i}`,
      config: {
        contractVersion: 1,
        requestId: `request-${i}`,
        device: {
          schemaVersion: 1,
          platform: "ios",
          hardware: { kind: "archetype", archetype: "phone" },
          os: { kind: "major", major: 27 },
        },
      },
    }),
  );
  const client = new FakeBrokerDaemonClient();
  const receipts = new Map<string, SessionBrokerResult>();
  const resources: BrokerResourceSample[] = [];
  const names = new Map<string, string>();
  const serials = new Map<string, string>();
  const calls: string[] = [];
  const closed = new Set<string>();
  let count = 0;
  let permitted = false;
  const fail = (c: BrokerScenarioClient, code: string, retryable = false): SessionBrokerResult => ({
    contractVersion: 1,
    requestId: c.config.requestId,
    outcome: "failed",
    sessionUuid: null,
    profile: null,
    cleanupPending: false,
    failure: { code, message: code, retryable },
  });
  const end = (requestId: string, code?: string) => {
    const old = receipts.get(requestId)!;
    const next: SessionBrokerResult = {
      ...old,
      outcome: code ? "failed" : "released",
      ...(code ? { failure: { code, message: code, retryable: false } } : {}),
      cleanupPending: false,
    };
    receipts.set(requestId, next);
    for (const r of resources) {
      if (r.sessionUuid === old.sessionUuid) {
        r.state = "destroyed";
      }
    }
    return next;
  };
  client.status = async (id) => receipts.get(id);
  client.info = async (id) => ({
    sessionId: id,
    nativeDevice: { name: names.get(id), deviceId: serials.get(id), platform: "ios" },
  });
  client.release = async (id) => {
    const old = [...receipts.values()].find((r) => r.sessionUuid === id)!;
    calls.push(`release:${old.requestId}`);
    end(old.requestId);
    return { sessionUuid: id, outcome: "released" };
  };
  client.abandon = async (id) => end(id, "session_request_abandoned");
  const deviceOps: BrokerDeviceScenarioOps = {
    totalDeviceCap: 2,
    tools: async () => [],
    bootGate: async (name, permits, action) => {
      calls.push(`permit:${name}:${permits}`);
      permitted = true;
      try {
        return await action();
      } finally {
        permitted = false;
      }
    },
    acquire: async (c, options) => {
      expect(permitted).toBe(true);
      calls.push(`acquire:${c.config.requestId}:${options.resume}`);
      if (options.resume) {
        return receipts.get(c.config.requestId)!;
      }
      if (options.disposableOwner) {
        c.config = {
          ...c.config,
          executionOwnerPid: 123,
          executionOwnerStartIdentity: "owner-start",
        };
      }
      let result: SessionBrokerResult;
      if (
        c.config.device.hardware.kind === "archetype" &&
        c.config.device.hardware.archetype === "duo"
      ) {
        result = fail(c, "capability_disabled");
      } else if (c.config.preparationTimeoutMs === 1) {
        result = fail(c, timeoutCode, true);
      } else if (resources.filter((r) => r.state === "active").length >= 2) {
        result = fail(c, "capacity_exhausted");
      } else {
        result = {
          ...structuredClone(captured.prepareSession),
          requestId: c.config.requestId,
          sessionUuid: `session-${++count}`,
        } as SessionBrokerResult;
        serials.set(
          result.sessionUuid!,
          `serial-${resources.filter((r) => r.state === "active").length}`,
        );
        resources.push({ sessionUuid: result.sessionUuid, state: "active" });
        names.set(result.sessionUuid!, exampleSessionBrokerDeviceName(String(count)));
      }
      receipts.set(c.config.requestId, result);
      closed.delete(c.name);
      return result;
    },
    observe: async (c) => {
      calls.push(`observe:${c.config.requestId}`);
      if (receipts.get(c.config.requestId)?.outcome !== "ready") {
        throw new Error("broker_session_ended");
      }
    },
    ownerKill: async (c) => {
      calls.push("owner-kill:123");
      end(c.config.requestId, "session_owner_exited");
      closed.add(c.name);
    },
    proxyClosed: async (c) => closed.has(c.name),
    close: async (c) => {
      calls.push(`close:${c.name}`);
      closed.add(c.name);
    },
    devicesView: async () => ({
      daemons: [{ alive: true }],
      devices: resources
        .filter((r) => r.state !== "destroyed")
        .map((r) => ({
          name: names.get(r.sessionUuid!)!,
          deviceId: "reused-serial",
          platform: "ios",
        })),
    }),
    resources: async () => structuredClone(resources),
  };
  const privateDaemon: PrivateDaemonControl = {
    stop: async () => {
      calls.push("stop");
    },
    start: async () => {
      calls.push("start");
    },
    crash: async () => {
      calls.push("crash");
      for (const c of clients) {
        if (receipts.get(c.config.requestId)?.outcome === "ready") {
          end(c.config.requestId, "session_owner_exited");
          closed.add(c.name);
        }
      }
    },
  };
  const ledger = new BrokerDeviceLedger({
    batchDir: "/fake-batch",
    fs,
    timer,
    tokenFor: (name) => clients.find((c) => c.name === name)!.token,
  });
  const context: BrokerScenarioContext = {
    batchDir: "/fake-batch",
    clients,
    daemonClient: client,
    prepare: async () => {
      throw new Error("Device scenarios must use proxy-session acquisition.");
    },
    ledger,
    fs,
    timer,
    ids: new FakeIdGenerator(),
    preflight: async () => true,
    probe: async () => true,
    deviceOps,
    privateDaemon,
    record: async (_op, _request, action) => action(),
  };
  return { context, calls, receipts, resources, files, deviceOps, privateDaemon, client, timer };
}

describe("device scenario logic with fake proxy/native/daemon operations (no device verification)", () => {
  test.each(scenarios)(
    "$name runs only through injected operations and writes redacted evidence",
    async (scenario) => {
      const f = fixture(scenario.name === "capacity-refusal-and-replay" ? 3 : 2);
      const summary = await runBrokerScenario(scenario, f.context, { device: true });
      expect(summary.error).toBeUndefined();
      expect(summary.outcome).toBe("passed");
      const bytes = f.files.get(join("/fake-batch", "evidence", scenario.name, "summary.json"))!;
      expect(JSON.parse(bytes)).toEqual(summary);
      expect(bytes).not.toContain("secret-");
      expect(f.resources.every((r) => r.state === "destroyed")).toBe(true);
      expect(f.calls.filter((s) => s.startsWith("permit:")).length).toBe(
        f.calls.filter((s) => s.startsWith("acquire:")).length,
      );
      expect(bytes).not.toMatch(/startDevice|provisionDevice|killDevice/);
    },
  );
  test.each(["timeout", "daemon_unavailable", "provision_failed"])(
    "#12452 prep timeout accepts the documented retryable code %s and still proves no leak",
    async (code) => {
      const f = fixture(2, code);
      const summary = await runBrokerScenario(
        scenarios.find((s) => s.name === "#12452-prep-timeout")!,
        f.context,
        { device: true },
      );
      expect(summary.error).toBeUndefined();
      expect(summary.outcome).toBe("passed");
    },
  );
  test("#12452 prep timeout rejects an undocumented or non-retryable code", async () => {
    const f = fixture(2, "capacity_exhausted");
    const summary = await runBrokerScenario(
      scenarios.find((s) => s.name === "#12452-prep-timeout")!,
      f.context,
      { device: true },
    );
    expect(summary.outcome).not.toBe("passed");
  });
  test("crash restart destroys the old resource, replays terminal receipt and acquires anew", async () => {
    const f = fixture();
    const summary = await runBrokerScenario(
      scenarios.find((s) => s.name === "daemon-restart-with-live-sessions")!,
      f.context,
      { device: true, crash: true },
    );
    expect(summary.error).toBeUndefined();
    expect(f.calls).toContain("crash");
    expect(f.calls).not.toContain("stop");
    expect(f.calls.indexOf("start")).toBeGreaterThan(f.calls.indexOf("crash"));
    expect(f.calls).toContain("acquire:request-0:true");
    expect(f.resources).toHaveLength(4);
  });
  test.each([
    "flag",
    "preflight",
    "probe",
    "capability",
    "ceiling",
    "hard-ceiling",
    "previous-release",
  ])("refuses %s before acquisition", async (kind) => {
    const f = fixture();
    if (kind === "preflight") {
      f.context.preflight = async () => false;
    }
    if (kind === "probe") {
      f.context.probe = async () => false;
    }
    if (kind === "capability") {
      f.client.capabilityResults = [[]];
    }
    if (kind === "ceiling") {
      f.deviceOps.totalDeviceCap = 3;
    }
    if (kind === "previous-release") {
      f.context.ledger.info(
        "client-0",
        { session: captured.prepareSession },
        {
          sessionId: captured.prepareSession.sessionUuid,
          nativeDevice: {
            name: exampleSessionBrokerDeviceName("old"),
            deviceId: "serial",
            platform: "ios",
          },
        },
      );
    }
    const result = await runBrokerScenario(scenarios[0], f.context, {
      device: kind !== "flag",
      maxDevices: kind === "hard-ceiling" ? 5 : undefined,
    });
    expect(result.outcome).toBe("failed");
    expect(f.calls.some((c) => c.startsWith("acquire:"))).toBe(false);
  });
  test("handoff regression detects destroying resources even when inventory still contains the device", async () => {
    const f = fixture();
    f.privateDaemon.stop = async () => {
      f.resources[0].state = "destroying";
    };
    const result = await runBrokerScenario(
      scenarios.find((s) => s.name === "#12451-restart-handoff")!,
      f.context,
      { device: true },
    );
    expect(result.outcome).toBe("failed");
    expect(
      result.requests.some(
        (r) =>
          r.operation === "resource-ledger" &&
          (r.reply as BrokerResourceSample[]).some((entry) => entry.state === "destroying"),
      ),
    ).toBe(true);
    expect(f.calls).not.toContain("start");
  });
  test("dry-run avoids probes, evidence writes, acquiring, signalling and closing proxies", async () => {
    const f = fixture();
    expect(
      (await runBrokerScenario(scenarios[0], f.context, { device: true, dryRun: true })).outcome,
    ).toBe("dry-run");
    expect(f.calls).toEqual([]);
  });
});

describe("device scenario safety and failure logic with fakes", () => {
  test.each(["shared-native", "wrong-profile", "dead-connection"])(
    "parallel acquisition detects %s",
    async (kind) => {
      const f = fixture();
      if (kind === "shared-native") {
        f.client.info = async (id) => ({
          sessionId: id,
          nativeDevice: {
            name: exampleSessionBrokerDeviceName("shared"),
            deviceId: "shared-serial",
            platform: "ios",
          },
        });
      }
      if (kind === "wrong-profile") {
        const acquire = f.deviceOps.acquire;
        f.deviceOps.acquire = async (...args) => {
          const result = await acquire(...args);
          return {
            ...result,
            profile: result.profile ? { ...result.profile, archetype: "tablet" } : null,
          };
        };
      }
      if (kind === "dead-connection") {
        f.deviceOps.observe = async () => {
          throw new Error("connection died");
        };
      }
      const result = await runBrokerScenario(scenarios[0], f.context, { device: true });
      expect(result.outcome).toBe("failed");
      expect(result.error).toContain(
        kind === "shared-native" ? "2" : kind === "wrong-profile" ? "phone" : "connection died",
      );
    },
  );
  test("no cleanup operations run after a failed preflight or missing device opt-in", async () => {
    for (const device of [false, true]) {
      const f = fixture();
      f.context.preflight = async () => false;
      expect((await runBrokerScenario(scenarios[0], f.context, { device })).outcome).toBe("failed");
      expect(f.calls).toEqual([]);
    }
  });
  test("release waits for its authoritative receipt before attempting the successor", async () => {
    const f = fixture();
    const status = f.client.status;
    let pending = true;
    let polled!: () => void;
    const entered = new Promise<void>((resolve) => {
      polled = resolve;
    });
    f.client.status = async (...args) => {
      const value = await status(...args);
      if (value?.outcome === "released" && pending) {
        polled();
        return { ...value, cleanupPending: true };
      }
      return value;
    };
    const run = runBrokerScenario(
      scenarios.find((s) => s.name === "release-destroy-verification")!,
      f.context,
      { device: true },
    );
    await entered;
    expect(f.calls.filter((s) => s.startsWith("acquire:"))).toHaveLength(1);
    pending = false;
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    await f.timer.advanceTimeAsync(100, async () => {
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
    });
    expect((await run).outcome).toBe("passed");
    expect(f.calls.filter((s) => s.startsWith("acquire:"))).toHaveLength(2);
  });
  test("crash recovery rejects a changed terminal replay", async () => {
    const f = fixture();
    const acquire = f.deviceOps.acquire;
    f.deviceOps.acquire = async (c, options) => {
      const result = await acquire(c, options);
      return options.resume ? { ...result, cleanupPending: true } : result;
    };
    const result = await runBrokerScenario(
      scenarios.find((s) => s.name === "daemon-restart-with-live-sessions")!,
      f.context,
      { device: true, crash: true },
    );
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("Original request replay");
    expect(f.calls.filter((s) => s.startsWith("acquire:") && !s.endsWith("true"))).toHaveLength(2);
  });
  test.each(["release-destroy-verification", "owner-death-and-abandon"])(
    "%s requires broker_session_ended from the old connection",
    async (name) => {
      const f = fixture();
      f.deviceOps.observe = async () => {};
      const result = await runBrokerScenario(
        scenarios.find((s) => s.name === name)!,
        f.context,
        { device: true },
      );
      expect(result.outcome).toBe("failed");
      expect(result.error).toContain("Missing expected rejection");
    },
  );
  test("parallel-acquire fails when one client's release ends a sibling's grant", async () => {
    const f = fixture();
    const release = f.client.release;
    f.client.release = async (id, token) => {
      const receipt = await release(id, token);
      for (const [requestId, other] of f.receipts) {
        if (other.sessionUuid !== id) {
          f.receipts.set(requestId, { ...other, outcome: "released" });
        }
      }
      return receipt;
    };
    const result = await runBrokerScenario(
      scenarios.find((s) => s.name === "parallel-acquire")!,
      f.context,
      { device: true },
    );
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/broker_session_ended|lost its grant/);
  });
  test("multi-client-crash-isolation fails when the owner death also ends the sibling", async () => {
    const f = fixture();
    const kill = f.deviceOps.ownerKill;
    f.deviceOps.ownerKill = async (c) => {
      await kill(c);
      for (const [requestId, receipt] of f.receipts) {
        f.receipts.set(requestId, { ...receipt, outcome: "failed" });
      }
    };
    const result = await runBrokerScenario(
      scenarios.find((s) => s.name === "multi-client-crash-isolation")!,
      f.context,
      { device: true },
    );
    expect(result.outcome).toBe("failed");
  });
  test("evidence redacts tokens embedded in operation errors", async () => {
    const f = fixture();
    f.deviceOps.observe = async () => {
      throw new Error(`failed ${f.context.clients[0].token}`);
    };
    const result = await runBrokerScenario(scenarios[0], f.context, { device: true });
    expect(result.error).toContain("failed [REDACTED]");
    expect(JSON.stringify(result)).not.toContain("secret-");
  });
});

describe("device scenario CLI routing with injected fake contexts", () => {
  test("--device selects the native release variant and its redacted evidence", async () => {
    const f = fixture();
    const logs: string[] = [];
    expect(
      await runBrokerScenarioCli(
        ["run", "release-destroy-verification", "--device", "--max-devices", "2"],
        { MT_BATCH: "/fake-batch" },
        (text) => {
          logs.push(text);
        },
        async () => ({ context: f.context, close: async () => {} }),
      ),
    ).toBe(0);
    expect(JSON.parse(logs[0]).class).toBe("device");
    expect(f.calls.some((c) => c.startsWith("permit:"))).toBe(true);
  });
  test.each([
    ["daemon-restart-with-live-sessions"],
    ["parallel-acquire", "--device", "--max-devices", "5"],
    ["parallel-acquire", "--device", "--crash"],
    ["parallel-acquire", "--device", "--device"],
    ["daemon-restart-with-live-sessions", "--crash"],
  ])("rejects invalid device invocation %j before constructing a context", async (...args) => {
    let constructed = false;
    expect(
      await runBrokerScenarioCli(
        ["run", ...args],
        { MT_BATCH: "/fake-batch" },
        () => {},
        async () => {
          constructed = true;
          const f = fixture();
          return { context: f.context, close: async () => {} };
        },
      ),
    ).toBe(2);
    expect(constructed).toBe(false);
  });
});
