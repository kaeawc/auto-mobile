import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_BOUND_SESSION_PARAM, DAEMON_VERSION } from "../../src/daemon/constants";
import { withRoutedSessionMeta } from "../../src/server/routedSessionMeta";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolAnswer = (name: string, params: Record<string, unknown>) => ToolResult | undefined;

const ok: ToolResult = { content: [{ type: "text", text: "ok" }] };

function acquired(sessionUuid: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ runtime: { session: { sessionUuid } } }) }],
  };
}

let restoreAvailability: () => void;
let proxies: DaemonMcpProxy[];

beforeEach(() => {
  const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  restoreAvailability = () => available.mockRestore();
  proxies = [];
});

afterEach(async () => {
  for (const proxy of proxies) {
    await proxy.close();
  }
  restoreAvailability();
});

function connect(answer: ToolAnswer): { proxy: DaemonMcpProxy; client: FakeDaemonClient } {
  const client = new FakeDaemonClient({ toolResult: ok, toolResultFor: answer });
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  const proxy = new DaemonMcpProxy({
    clientFactory: () => client,
    daemonManager: manager,
    autoStartDaemon: false,
    timer: new FakeTimer(),
  });
  proxies.push(proxy);
  return { proxy, client };
}

/** The session the proxy forwards a sessionless call under: its binding, if it has one. */
async function sessionOfUntargetedCall(
  proxy: DaemonMcpProxy,
  client: FakeDaemonClient,
): Promise<unknown> {
  await proxy.callTool("pressButton", { button: "home" });
  return client.callToolCalls.at(-1)?.params.sessionUuid;
}

describe("DaemonMcpProxy never binds a session a failed call merely named (#11344)", () => {
  const throwsWhenNamingTheirs: ToolAnswer = (name, params) => {
    if (name === "getAndroid") {
      return acquired("mine");
    }
    if (params.sessionUuid === "theirs") {
      throw new Error("Invalid parameters for tool tapOn");
    }
    return undefined;
  };

  test("a thrown failure naming a session leaves an unbound connection unbound", async () => {
    const { proxy, client } = connect(throwsWhenNamingTheirs);

    await expect(proxy.callTool("tapOn", { sessionUuid: "theirs" })).rejects.toThrow(
      "Invalid parameters",
    );

    expect(await sessionOfUntargetedCall(proxy, client)).toBeUndefined();
  });

  test("a thrown failure naming another session keeps the connection on its own session", async () => {
    const { proxy, client } = connect(throwsWhenNamingTheirs);
    await proxy.callTool("getAndroid", {});

    await expect(proxy.callTool("tapOn", { sessionUuid: "theirs" })).rejects.toThrow(
      "Invalid parameters",
    );

    expect(await sessionOfUntargetedCall(proxy, client)).toBe("mine");
  });

  test("an error result binds the named session only when the daemon echoes it as admitted", async () => {
    const refused = connect((name) =>
      name === "tapOn"
        ? { content: [{ type: "text", text: "refused" }], isError: true }
        : undefined,
    );
    await refused.proxy.callTool("tapOn", { sessionUuid: "named" });
    expect(await sessionOfUntargetedCall(refused.proxy, refused.client)).toBeUndefined();

    const admitted = connect((name) =>
      name === "tapOn"
        ? withRoutedSessionMeta(
            { content: [{ type: "text", text: "no match" }], isError: true },
            "named",
          )
        : undefined,
    );
    await admitted.proxy.callTool("tapOn", { sessionUuid: "named" });
    expect(await sessionOfUntargetedCall(admitted.proxy, admitted.client)).toBe("named");
  });

  test("an error result echoing a different session than the one named binds nothing", async () => {
    const { proxy, client } = connect((name) =>
      name === "tapOn"
        ? withRoutedSessionMeta({ content: [{ type: "text", text: "no" }], isError: true }, "other")
        : undefined,
    );

    await proxy.callTool("tapOn", { sessionUuid: "named" });

    expect(await sessionOfUntargetedCall(proxy, client)).toBeUndefined();
  });
});

describe("an explicit sessionUuid never moves the connection's default (#11347)", () => {
  /** Two acquisitions in order, a setActiveDevice selection, and the raw params of every call. */
  function twoDevices(): {
    proxy: DaemonMcpProxy;
    client: FakeDaemonClient;
    rawParams: Array<Record<string, unknown>>;
  } {
    const minted = ["first", "second"];
    const rawParams: Array<Record<string, unknown>> = [];
    const connection = connect((name, params) => {
      rawParams.push(params);
      if (name === "getAndroid") {
        return acquired(minted.shift() ?? "extra");
      }
      if (name === "setActiveDevice") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ deviceId: "emulator-5554", sessionUuid: "first" }),
            },
          ],
        };
      }
      return undefined;
    });
    return { ...connection, rawParams };
  }

  test("naming another held session targets that call and leaves the binding alone", async () => {
    const { proxy, client, rawParams } = twoDevices();
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getAndroid", {});

    await proxy.callTool("tapOn", { sessionUuid: "first", text: "Go" });

    // The call is forwarded under the session it named, with the binding carried beside it so
    // the daemon socket keeps its route.
    expect(rawParams.at(-1)).toMatchObject({
      sessionUuid: "first",
      [DAEMON_BOUND_SESSION_PARAM]: "second",
    });
    expect(await sessionOfUntargetedCall(proxy, client)).toBe("second");
  });

  test("setActiveDevice moves the binding, and a later explicit call does not move it back", async () => {
    const { proxy, client } = twoDevices();
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getAndroid", {});

    await proxy.callTool("setActiveDevice", { deviceId: "emulator-5554" });
    expect(await sessionOfUntargetedCall(proxy, client)).toBe("first");

    await proxy.callTool("tapOn", { sessionUuid: "second", text: "Go" });
    expect(await sessionOfUntargetedCall(proxy, client)).toBe("first");
  });

  test("a connection with no binding adopts the first session it names", async () => {
    const { proxy, client, rawParams } = twoDevices();

    await proxy.callTool("tapOn", { sessionUuid: "named", text: "Go" });

    expect(rawParams.at(-1)).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
    expect(await sessionOfUntargetedCall(proxy, client)).toBe("named");
  });
});
