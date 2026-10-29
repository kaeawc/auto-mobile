import { describe, expect, test } from "bun:test";
import {
  sendFaultRulesOnce,
  setFaultRulesThroughCtrlProxy,
  type CommandSocket,
  type FaultRuleDeliveryDeps,
} from "../../../scripts/ios/sdk-contract/ctrlProxyFaultRules";
import { faultRules } from "../../../scripts/ios/sdk-contract/faultSlice";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

/** A CtrlProxy socket that answers each request with the scripted `success` values in turn. */
class FakeCtrlProxySocket implements CommandSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  closed = false;

  constructor(private readonly reply: (request: Record<string, unknown>) => unknown[]) {}

  send(data: string): void {
    const request = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(request);
    for (const frame of this.reply(request)) {
      this.onmessage?.({ data: frame });
    }
  }

  close(): void {
    this.closed = true;
  }
}

function harness(successes: boolean[]) {
  const sockets: FakeCtrlProxySocket[] = [];
  const urls: string[] = [];
  const timer = new FakeTimer();
  const deps: FaultRuleDeliveryDeps = {
    timer,
    ids: new FakeIdGenerator(),
    openSocket: (url) => {
      urls.push(url);
      const success = successes.shift() ?? false;
      const socket = new FakeCtrlProxySocket((request) => [
        "not json",
        JSON.stringify({ type: "hierarchy_update" }),
        JSON.stringify({ type: "set_network_fault_rules_result", requestId: "other", success }),
        JSON.stringify({
          type: "set_network_fault_rules_result",
          requestId: request.requestId,
          success,
        }),
      ]);
      sockets.push(socket);
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
  };
  return { deps, sockets, urls, timer };
}

describe("sendFaultRulesOnce", () => {
  test("sends the rules as set_network_fault_rules and waits for its own result", async () => {
    const { deps, sockets } = harness([true]);
    const rules = faultRules("c1");
    const result = await sendFaultRulesOnce("ws://127.0.0.1:1/ws", rules, deps);
    expect(result).toEqual({ success: true });
    expect(sockets[0].sent).toEqual([
      { type: "set_network_fault_rules", requestId: "contractFaultRules-fake-1", rules },
    ]);
    expect(sockets[0].closed).toBe(true);
  });

  test("reports a socket closed before any answer", async () => {
    const timer = new FakeTimer();
    const socket = new FakeCtrlProxySocket(() => []);
    const pending = sendFaultRulesOnce("ws://x", [], {
      timer,
      ids: new FakeIdGenerator(),
      openSocket: () => socket,
    });
    socket.onclose?.();
    expect(await pending).toEqual({
      success: false,
      error: "CtrlProxy closed the socket before answering",
    });
  });

  test("times out when CtrlProxy never answers", async () => {
    const timer = new FakeTimer();
    const pending = sendFaultRulesOnce("ws://x", [], {
      timer,
      ids: new FakeIdGenerator(),
      openSocket: () => new FakeCtrlProxySocket(() => []),
    });
    timer.advanceTime(15_000);
    expect((await pending).error).toContain("within 15000 ms");
  });
});

describe("setFaultRulesThroughCtrlProxy", () => {
  test("retries while CtrlProxy reports no SDK server, then succeeds", async () => {
    const { deps, urls, timer } = harness([false, true]);
    timer.enableAutoAdvance();
    const result = await setFaultRulesThroughCtrlProxy(8770, [], deps);
    expect(result).toEqual({ success: true });
    expect(urls).toEqual(["ws://127.0.0.1:8770/ws", "ws://127.0.0.1:8770/ws"]);
  });

  test("gives up after five attempts with the last reason", async () => {
    const { deps, urls, timer } = harness([]);
    timer.enableAutoAdvance();
    const result = await setFaultRulesThroughCtrlProxy(8770, [], deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain("after 5 attempts");
    expect(urls).toHaveLength(5);
  });
});
