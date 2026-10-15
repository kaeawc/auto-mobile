import { join, resolve } from "node:path";
import captured from "../fixtures/session-broker/fake-lifecycle.json";
import { beforeAll, expect, test } from "bun:test";
import {
  brokerScenarios,
  runBrokerScenario,
  type BrokerScenario,
} from "../../scripts/manual-test/brokerScenarios";
import { runBrokerScenarioCli } from "../../scripts/manual-test/broker-scenario";
import { createFrameBrokerDaemonClient } from "../../scripts/manual-test/brokerDaemonClient";
import { createFakeBrokerScenarioContext } from "../helpers/fakeBrokerScenarioContext";
import { createFakeBrokerDaemon } from "../helpers/fakeBrokerDaemon";
import type { FrameConnection } from "../../scripts/manual-test/frameWire";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

beforeAll(async () => {
  // Warm SQLite migrations and the SDK once, outside the per-test budget.
  const host = await createFakeBrokerDaemon();
  try {
    const receipt = await host.prepare(
      {
        contractVersion: 1,
        requestId: "warm",
        device: {
          schemaVersion: 1,
          platform: "ios",
          hardware: { kind: "omitted" },
          os: { kind: "omitted" },
        },
      },
      "warm-token",
    );
    await host.client.release(receipt.sessionUuid!, "warm-token");
    await host.controls.tools((await host.client.status("warm", "warm-token"))!);
  } finally {
    await host.close();
  }
});
function evidence() {
  const files = new Map<string, string>();
  return {
    files,
    mkdir: () => {},
    writeFile: (path: string, text: string) => {
      files.set(path, text);
    },
  };
}
test.each(brokerScenarios)(
  "fake scenario $name exercises the real broker",
  async (scenario: BrokerScenario) => {
    const fs = evidence();
    const harness = await createFakeBrokerScenarioContext(scenario, "/fake-batch", fs);
    try {
      const summary = await runBrokerScenario(scenario, harness.context);
      expect(summary.error).toBeUndefined();
      expect(summary.outcome).toBe("passed");
      expect(summary.requests.length).toBeGreaterThan(0);
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
      const bytes = fs.files.get(
        join(resolve("/fake-batch"), "evidence", scenario.name, "summary.json"),
      )!;
      expect(JSON.parse(bytes)).toEqual(summary);
      for (const { token } of harness.context.clients) {
        expect(bytes).not.toContain(token);
      }
      expect((await harness.host.controls.inventory()).devices).toEqual([]);
      expect(
        (await harness.host.store.listResources()).every((row) => row.state === "destroyed"),
      ).toBe(true);
    } finally {
      await harness.close();
    }
  },
);

test("device scenario refuses until explicit flag, private preflight and capability probes pass", async () => {
  const fs = evidence();
  const harness = await createFakeBrokerScenarioContext(brokerScenarios[0], "/fake-batch", fs);
  let calls = 0;
  const scenario: BrokerScenario = {
    name: "future-device",
    class: "device",
    capacity: 1,
    deviceOnlyAssertions: [],
    run: async () => {
      calls++;
    },
  };
  try {
    expect((await runBrokerScenario(scenario, harness.context)).error).toContain("--device");
    expect((await runBrokerScenario(scenario, harness.context, { device: true })).error).toContain(
      "preflight",
    );
    const privateContext = { ...harness.context, preflight: async () => true };
    expect((await runBrokerScenario(scenario, privateContext, { device: true })).error).toContain(
      "capability probe",
    );
    const probed = {
      ...privateContext,
      probe: async () => true,
      daemonClient: { ...harness.context.daemonClient, capabilities: async () => [] },
    };
    expect((await runBrokerScenario(scenario, probed, { device: true })).error).toContain(
      "session-broker/v1",
    );
    expect(calls).toBe(0);
    const valid = { ...privateContext, probe: async () => true };
    expect((await runBrokerScenario(scenario, valid, { device: true, dryRun: true })).outcome).toBe(
      "dry-run",
    );
    expect(calls).toBe(0);
    expect((await runBrokerScenario(scenario, valid, { device: true })).outcome).toBe("passed");
    expect(calls).toBe(1);
  } finally {
    await harness.close();
  }
});
test("fake dry run writes a plan without allocating; failures redact tokens in replies and errors", async () => {
  const fs = evidence();
  const harness = await createFakeBrokerScenarioContext(brokerScenarios[0], "/fake-batch", fs);
  try {
    const dry = await runBrokerScenario(brokerScenarios[0], harness.context, { dryRun: true });
    expect(dry.outcome).toBe("dry-run");
    expect(harness.host.devices.prepared).toEqual([]);
    const token = 'private-"token\\value';
    const clients = harness.context.clients.map((c) => ({ ...c, token }));
    const bad: BrokerScenario = {
      name: "failure",
      class: "fake",
      capacity: 1,
      deviceOnlyAssertions: [],
      run: async (ctx) => {
        await ctx.record("reply", { token }, async () => ({ token }));
        await ctx.record("error", {}, async () => {
          throw new Error(`secret ${token}`);
        });
      },
    };
    const result = await runBrokerScenario(bad, { ...harness.context, clients });
    expect(result.outcome).toBe("failed");
    expect(result.requests[0].reply).toEqual({ token: "[REDACTED]" });
    expect(result.error).toBe("secret [REDACTED]");
  } finally {
    await harness.close();
  }
});
test("CLI lists fake scenarios, shows help, and refuses invalid arguments without a daemon", async () => {
  const output: string[] = [];
  expect(await runBrokerScenarioCli(["list"], {}, (line) => output.push(line))).toBe(0);
  expect(output.join("\n")).toContain("capacity-refusal-and-replay\tfake");
  expect(await runBrokerScenarioCli(["--help"], {}, (line) => output.push(line))).toBe(0);
  for (const argv of [
    ["run", "missing"],
    ["run", brokerScenarios[0].name],
    ["run", brokerScenarios[0].name, "--batch-dir"],
    ["run", brokerScenarios[0].name, "--wat"],
  ]) {
    expect(await runBrokerScenarioCli(argv, {}, () => {})).toBe(2);
  }
});

/** Feed actual broker replies through the production frame client's envelope parsers. */
class ReplyConnection implements FrameConnection {
  data: (chunk: Buffer) => void = () => {};
  constructor(private readonly reply: unknown) {}
  write(text: string) {
    this.data(
      Buffer.from(
        `${JSON.stringify({ id: JSON.parse(text).id, success: true, result: this.reply })}\n`,
      ),
    );
  }
  onData(fn: (chunk: Buffer) => void) {
    this.data = fn;
  }
  onClose() {}
  end() {}
  destroy() {}
}
test("real in-memory broker status and release replies pass the frame parsers", async () => {
  const harness = await createFakeBrokerScenarioContext(
    brokerScenarios[0],
    "/fake-batch",
    evidence(),
  );
  const c = harness.context.clients[0];
  let reply: unknown;
  const wire = createFrameBrokerDaemonClient({
    socketPath: "memory-only",
    timer: new FakeTimer(),
    ids: new FakeIdGenerator(),
    connect: async () => new ReplyConnection(reply),
  });
  try {
    const ready = await harness.host.prepare(c.config, c.token);
    expect(ready).toEqual(captured.prepareSession);
    expect(await harness.host.client.status(c.config.requestId, c.token)).toEqual(captured.status);
    const other = harness.context.clients[1];
    expect(await harness.host.prepare(other.config, other.token)).toEqual(captured.refusal);
    expect(await harness.host.controls.tools(captured.refusal as typeof ready)).toEqual([]);
    reply = captured.status;
    expect(await wire.status(c.config.requestId, c.token)).toEqual(ready);
    reply = await harness.host.client.release(ready.sessionUuid!, c.token);
    expect(reply).toEqual(captured.release);
    expect(await wire.release(ready.sessionUuid!, c.token)).toEqual(reply);
    reply = await harness.host.client.status(c.config.requestId, c.token);
    expect(reply).toEqual(captured.releasedStatus);
    expect(await wire.status(c.config.requestId, c.token)).toEqual(reply);
    reply = { ...(reply as object), requestId: "wrong" };
    await expect(wire.status(c.config.requestId, c.token)).rejects.toThrow(
      "Invalid broker result envelope",
    );
  } finally {
    await harness.close();
  }
});
