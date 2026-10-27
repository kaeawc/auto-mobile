import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import {
  AMBIGUOUS_DEVICE_ELICITATION_TIMEOUT_MS,
  ambiguousDeviceCandidates,
  declaresFormElicitation,
} from "../../src/server/ambiguousDeviceElicitation";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

const CANDIDATES = [
  { deviceId: "emulator-5554", platform: "android" },
  { deviceId: "emulator-5556", platform: "android" },
];

const AMBIGUOUS_RESULT = {
  isError: true,
  content: [
    {
      type: "text",
      text: JSON.stringify({
        success: false,
        error: "Multiple devices (code ambiguous_device_target)",
        code: "ambiguous_device_target",
        candidates: CANDIDATES,
        retryable: false,
      }),
    },
  ],
};

const OK_RESULT = { content: [{ type: "text", text: "tapped" }] };

type Answer = { action: "accept" | "decline" | "cancel"; content?: Record<string, string> };

interface Harness {
  client: Client;
  daemon: FakeDaemonClient;
  timer: FakeTimer;
  asked: PromiseWithResolvers<unknown>;
  release(): void;
  close(): Promise<void>;
}

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;
const open: Harness[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

async function connect(
  capabilities: Record<string, unknown>,
  answer: Answer | "never",
): Promise<Harness> {
  isAvailableSpy ??= spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  const daemon = new FakeDaemonClient({
    toolResultFor: (_tool, params) => (params.deviceId ? OK_RESULT : AMBIGUOUS_RESULT),
  });
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  const timer = new FakeTimer();
  const { server, proxy } = createProxyMcpServer({
    proxyConfig: { clientFactory: () => daemon, daemonManager: manager, autoStartDaemon: false },
    ambiguousDeviceElicitation: { timer },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "elicitation-client", version: "0.0.1" }, { capabilities });
  const asked = Promise.withResolvers<unknown>();
  const gate = Promise.withResolvers<void>();
  if (capabilities.elicitation) {
    client.setRequestHandler("elicitation/create", async (request) => {
      asked.resolve(request.params);
      if (answer === "never") {
        await gate.promise;
        return { action: "cancel" };
      }
      return answer;
    });
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const harness: Harness = {
    client,
    daemon,
    timer,
    asked,
    release: () => gate.resolve(),
    close: async () => {
      gate.resolve();
      await client.close();
      await server.close();
      await proxy.close();
    },
  };
  open.push(harness);
  return harness;
}

const call = (harness: Harness, args: Record<string, unknown> = {}) =>
  harness.client.callTool({ name: "tapOn", arguments: args });

function refusalCode(result: { content?: unknown }): unknown {
  const first = (result.content as Array<{ text?: string }>)[0];
  return JSON.parse(first?.text ?? "{}").code;
}

describe("ambiguous deviceId elicitation (#13945)", () => {
  // The SDK builds its handlers and validators on first use; that one-time cost belongs to the
  // process, not to the first timed test.
  beforeAll(async () => {
    const warm = await connect({ elicitation: { form: {} } }, { action: "cancel" });
    await call(warm);
  });

  test("a client that declared elicitation chooses a device and the call proceeds on it", async () => {
    const h = await connect(
      { elicitation: { form: {} } },
      {
        action: "accept",
        content: { deviceId: "emulator-5556" },
      },
    );

    const result = await call(h);

    expect(result.isError).toBeFalsy();
    expect(h.daemon.callToolCalls.map((c) => c.params.deviceId)).toEqual([
      undefined,
      "emulator-5556",
    ]);
    const params = (await h.asked.promise) as {
      mode: string;
      requestedSchema: {
        properties: { deviceId: { oneOf: Array<{ const: string; title: string }> } };
      };
    };
    expect(params.mode).toBe("form");
    expect(params.requestedSchema.properties.deviceId.oneOf).toEqual([
      { const: "emulator-5554", title: "emulator-5554 (android)" },
      { const: "emulator-5556", title: "emulator-5556 (android)" },
    ]);
  });

  test("a bare elicitation capability counts as form support", async () => {
    const h = await connect(
      { elicitation: {} },
      {
        action: "accept",
        content: { deviceId: "emulator-5554" },
      },
    );

    expect((await call(h)).isError).toBeFalsy();
    expect(h.daemon.callToolCalls[1]?.params.deviceId).toBe("emulator-5554");
  });

  for (const action of ["decline", "cancel"] as const) {
    test(`${action} returns the typed refusal unchanged and does not retry`, async () => {
      const h = await connect({ elicitation: { form: {} } }, { action });

      const result = await call(h);

      expect(result.isError).toBe(true);
      expect(refusalCode(result)).toBe("ambiguous_device_target");
      expect(h.daemon.callToolCalls).toHaveLength(1);
    });
  }

  test("an answer naming a device that was not offered is refused as ambiguous", async () => {
    const h = await connect(
      { elicitation: { form: {} } },
      {
        action: "accept",
        content: { deviceId: "emulator-9999" },
      },
    );

    const result = await call(h);

    expect(refusalCode(result)).toBe("ambiguous_device_target");
    expect(h.daemon.callToolCalls).toHaveLength(1);
  });

  test("an unanswered question times out on the injected timer into the typed refusal", async () => {
    const h = await connect({ elicitation: { form: {} } }, "never");

    const pending = call(h);
    await h.asked.promise;
    h.timer.advanceTime(AMBIGUOUS_DEVICE_ELICITATION_TIMEOUT_MS);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(refusalCode(result)).toBe("ambiguous_device_target");
    expect(h.daemon.callToolCalls).toHaveLength(1);
  });

  test("a client without the elicitation capability is never asked", async () => {
    const h = await connect({}, { action: "accept", content: { deviceId: "emulator-5554" } });

    const result = await call(h);

    expect(refusalCode(result)).toBe("ambiguous_device_target");
    expect(h.daemon.callToolCalls).toHaveLength(1);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a URL-only elicitation declaration is not asked for a device list", async () => {
    const h = await connect({ elicitation: { url: {} } }, { action: "cancel" });

    const result = await call(h);

    expect(refusalCode(result)).toBe("ambiguous_device_target");
    expect(h.daemon.callToolCalls).toHaveLength(1);
  });

  test("capability is per connection: only the declaring client is asked", async () => {
    const declaring = await connect(
      { elicitation: { form: {} } },
      {
        action: "accept",
        content: { deviceId: "emulator-5554" },
      },
    );
    const silent = await connect({}, { action: "accept", content: { deviceId: "emulator-5554" } });

    expect((await call(silent)).isError).toBe(true);
    expect((await call(declaring)).isError).toBeFalsy();
  });

  test("a call that already names a deviceId is not asked", async () => {
    const h = await connect({ elicitation: { form: {} } }, { action: "cancel" });

    const result = await call(h, { deviceId: "emulator-5554" });

    expect(result.isError).toBeFalsy();
    expect(h.daemon.callToolCalls).toHaveLength(1);
  });
});

describe("ambiguousDeviceCandidates", () => {
  test("reads the typed refusal's candidates", () => {
    expect(ambiguousDeviceCandidates(AMBIGUOUS_RESULT)).toEqual(CANDIDATES);
  });

  test("ignores other results and a single candidate", () => {
    expect(ambiguousDeviceCandidates(OK_RESULT)).toBeUndefined();
    expect(
      ambiguousDeviceCandidates({
        isError: true,
        content: [{ type: "text", text: "plain text mentioning ambiguous_device_target" }],
      }),
    ).toBeUndefined();
    expect(
      ambiguousDeviceCandidates({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ code: "ambiguous_device_target", candidates: [CANDIDATES[0]] }),
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("declaresFormElicitation", () => {
  test("form and bare declarations count; url-only and none do not", () => {
    expect(declaresFormElicitation({ elicitation: { form: {} } })).toBe(true);
    expect(declaresFormElicitation({ elicitation: {} })).toBe(true);
    expect(declaresFormElicitation({ elicitation: { url: {} } })).toBe(false);
    expect(declaresFormElicitation({})).toBe(false);
    expect(declaresFormElicitation(undefined)).toBe(false);
  });
});
