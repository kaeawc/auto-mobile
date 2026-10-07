import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import type { NetworkMockRuleSync } from "../../../../src/server/networkMockRules";
import { PortManager } from "../../../../src/utils/PortManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeInstalledAppsRepository } from "../../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

// Issue #10101: the host waits (bounded) for the app's report of rejected rules, and treats a
// CtrlProxy, SDK or reply that says nothing as "sent, not confirmed" rather than as a failure.

const rules: NetworkMockRuleSync[] = [
  {
    mockId: "mock-1",
    host: "api.example.com",
    path: "/items/{id}",
    method: "*",
    limit: null,
    remaining: null,
    statusCode: 500,
    responseHeaders: {},
    responseBody: "",
    contentType: "application/json",
  },
];

const withReport = [
  "full_command_set_v1",
  "request_id_echo_v1",
  "set_network_mock_rules",
  "network_mock_rules_report_v1",
];
const withoutReport = withReport.filter((command) => command !== "network_mock_rules_report_v1");

const clients: AndroidCtrlProxyClient[] = [];

async function harness(commands: string[]) {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const socket = new FakeWebSocket("ws://fake", "none", 0, timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "mock-rules-test", platform: "android", name: "Android", isEmulator: true },
    new FakeAdbExecutor(),
    () => socket,
    timer,
    new FakeInstalledAppsRepository(),
  );
  clients.push(client);
  await Promise.resolve();
  client["ws"] = socket as unknown as WebSocket;
  spyOn(client, "ensureConnected").mockResolvedValue(true);
  const receive = (frame: object) => client["handleWebSocketMessage"](JSON.stringify(frame));
  await receive({ type: "connected", supportedCommands: commands });
  const sent: Record<string, unknown>[] = [];
  spyOn(socket, "send").mockImplementation((data) => {
    sent.push(JSON.parse(String(data)));
  });
  return { client, timer, receive, sent };
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  PortManager.setPortAvailabilityCheckerForTesting(null);
});

async function settleTurns(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve();
  }
}

describe("AndroidCtrlProxyClient.pushNetworkMockRules (#10101)", () => {
  test("sends the rules with a requestId and returns the rejected rules and reasons", async () => {
    const { client, receive, sent } = await harness(withReport);

    const pending = client.pushNetworkMockRules(rules);
    await settleTurns();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "set_network_mock_rules", rules });
    expect(sent[0].requestId).toBeString();
    await receive({
      type: "set_network_mock_rules_result",
      requestId: sent[0].requestId,
      success: true,
      rejectedMockIds: ["mock-1"],
      rejectedReasons: { "mock-1": "invalid regex: Illegal repetition" },
    });

    expect(await pending).toEqual({
      delivered: true,
      report: {
        status: "reported",
        rejected: [{ mockId: "mock-1", reason: "invalid regex: Illegal repetition" }],
      },
    });
    expect(client["requestManager"].getPendingCount()).toBe(0);
  });

  test("an empty rejection list means every rule was installed", async () => {
    const { client, receive, sent } = await harness(withReport);

    const pending = client.pushNetworkMockRules(rules);
    await settleTurns();
    await receive({
      type: "set_network_mock_rules_result",
      requestId: sent[0].requestId,
      success: true,
      rejectedMockIds: [],
      rejectedReasons: {},
    });

    expect(await pending).toEqual({
      delivered: true,
      report: { status: "reported", rejected: [] },
    });
  });

  test("a reply without the rejection fields (an SDK that does not report) is unconfirmed", async () => {
    const { client, receive, sent } = await harness(withReport);

    const pending = client.pushNetworkMockRules(rules);
    await settleTurns();
    await receive({
      type: "set_network_mock_rules_result",
      requestId: sent[0].requestId,
      success: true,
      rejectedMockIds: null,
      rejectedReasons: null,
    });

    expect(await pending).toEqual({ delivered: true, report: { status: "unconfirmed" } });
  });

  test("a failed broadcast on the device is an undelivered push", async () => {
    const { client, receive, sent } = await harness(withReport);

    const pending = client.pushNetworkMockRules(rules);
    await settleTurns();
    await receive({
      type: "set_network_mock_rules_result",
      requestId: sent[0].requestId,
      success: false,
      error: "Failed to broadcast network mock rules: boom",
    });

    expect(await pending).toEqual({
      delivered: false,
      error: "Failed to broadcast network mock rules: boom",
    });
  });

  test("no reply within the bound is unconfirmed, not a failure", async () => {
    const { client, timer, sent } = await harness(withReport);

    const pending = client.pushNetworkMockRules(rules, 3000);
    await settleTurns();
    expect(sent).toHaveLength(1);
    timer.advanceTime(3000);

    expect(await pending).toEqual({ delivered: true, report: { status: "unconfirmed" } });
  });

  test("an older CtrlProxy without the capability gets the plain push and is not waited for", async () => {
    const { client, sent } = await harness(withoutReport);

    const result = await client.pushNetworkMockRules(rules);

    expect(result).toEqual({ delivered: true, report: { status: "unconfirmed" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "set_network_mock_rules", rules });
    expect(sent[0]).not.toHaveProperty("requestId");
  });

  test("a reply for a different request does not settle the push", async () => {
    const { client, receive, sent, timer } = await harness(withReport);

    const pending = client.pushNetworkMockRules(rules, 3000);
    await settleTurns();
    await receive({
      type: "set_network_mock_rules_result",
      requestId: "someone-else",
      success: true,
      rejectedMockIds: ["mock-1"],
    });
    timer.advanceTime(3000);

    expect(await pending).toEqual({ delivered: true, report: { status: "unconfirmed" } });
    expect(sent[0].requestId).not.toBe("someone-else");
  });
});
