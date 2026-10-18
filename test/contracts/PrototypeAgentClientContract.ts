import { describe, expect, test } from "bun:test";
import type {
  PrototypeAgentClient,
  PrototypeAgentMessage,
} from "../../src/features/prototype/ios/prototypeAgentClient";

export const CONTRACT_AGENT_CAPABILITIES = ["show_prototype", "get_prototype_status"];

export interface PrototypeAgentClientContractHarness {
  client: PrototypeAgentClient;
  /** Answers the next request with these result fields (default: plain success). */
  answerNext(reply: { success?: boolean; error?: string; [key: string]: unknown }): void;
  /** Makes the agent push an unsolicited `prototype_event`. */
  pushEvent(event: PrototypeAgentMessage): void;
  /** Makes the agent end the connection. */
  disconnect(): void;
}

/**
 * Shared contract for every {@link PrototypeAgentClient}: the handshake is exposed, requests
 * resolve with a numbered `prototype_result` (a failed reply is a result, not a rejection),
 * unsupported request types are refused, events reach subscribers until they unsubscribe, and
 * a closed connection notifies once and refuses further requests. Run against the socket
 * client (scripted agent socket) and FakePrototypeAgentClient (issue #11868). The harness
 * agent advertises {@link CONTRACT_AGENT_CAPABILITIES}.
 */
export const runPrototypeAgentClientContract = (
  description: string,
  make: () => Promise<PrototypeAgentClientContractHarness>,
): void => {
  describe(`PrototypeAgentClient contract: ${description}`, function () {
    test("exposes the agent handshake", async function () {
      const { client } = await make();

      expect(client.handshake.capabilities).toEqual(CONTRACT_AGENT_CAPABILITIES);
      expect(typeof client.handshake.agentVersion).toBe("string");
      expect(client.handshake.protocolVersion).toBe(1);
    });

    test("resolves a request with a prototype_result carrying the reply", async function () {
      const { client, answerNext } = await make();
      answerNext({ status: "visible" });

      const result = await client.request("get_prototype_status");

      expect(result.type).toBe("prototype_result");
      expect(result.success).toBe(true);
      expect(result.status).toBe("visible");
      expect(typeof result.requestId).toBe("string");
    });

    test("numbers successive requests distinctly", async function () {
      const { client } = await make();

      const first = await client.request("show_prototype", { id: "a" });
      const second = await client.request("show_prototype", { id: "a" });

      expect(first.requestId).not.toBe(second.requestId);
    });

    test("resolves a failed reply as a result instead of rejecting", async function () {
      const { client, answerNext } = await make();
      answerNext({ success: false, error: "no such prototype" });

      const result = await client.request("get_prototype_status");

      expect(result.success).toBe(false);
      expect(result.error).toBe("no such prototype");
    });

    test("refuses a request type the agent did not advertise", async function () {
      const { client } = await make();

      await expect(client.request("simulate_tap")).rejects.toThrow(/simulate_tap/);
    });

    test("delivers events to subscribers until they unsubscribe", async function () {
      const { client, pushEvent } = await make();
      const seen: PrototypeAgentMessage[] = [];
      const unsubscribe = client.onEvent((event) => seen.push(event));

      pushEvent({ type: "prototype_event", kind: "one" });
      unsubscribe();
      pushEvent({ type: "prototype_event", kind: "two" });

      expect(seen.map((event) => event.kind)).toEqual(["one"]);
    });

    test("notifies closed listeners once when the host closes", async function () {
      const { client } = await make();
      const errors: Error[] = [];
      client.onClosed((error) => errors.push(error));

      client.close();
      client.close();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
    });

    test("notifies closed listeners when the agent disconnects", async function () {
      const { client, disconnect } = await make();
      const errors: Error[] = [];
      client.onClosed((error) => errors.push(error));

      disconnect();

      expect(errors).toHaveLength(1);
    });

    test("does not notify an unsubscribed closed listener", async function () {
      const { client } = await make();
      let calls = 0;
      client.onClosed(() => (calls += 1))();

      client.close();

      expect(calls).toBe(0);
    });

    test("rejects requests after the connection closed", async function () {
      const { client } = await make();
      client.close();

      await expect(client.request("get_prototype_status")).rejects.toThrow();
    });
  });
};
