import { describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../../src/daemon/client";
import { DAEMON_VERSION } from "../../../src/daemon/constants";
import { SessionRecoveryIdentityLossError } from "../../../src/daemon/sessionManager";
import { declaresDeviceSessionInvalid } from "../../../src/server/deviceSessionResult";
import { shapeToolCallError } from "../../../src/server/shapeToolCallError";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../../fakes/FakeDaemonManager";

const target = { platform: "android", stableDeviceId: "stable-1", deviceId: "emulator-5554" };

type Reason = ConstructorParameters<typeof SessionRecoveryIdentityLossError>[2];
const REASONS: Reason[] = [
  "target-absent",
  "target-busy",
  "identity-continuity-lost",
  "owned-by-other-daemon",
];

function identityLossResult(reason: Reason) {
  const error = new SessionRecoveryIdentityLossError(
    "dead-session",
    target as never,
    reason,
    reason === "owned-by-other-daemon" ? { deviceId: "emulator-5554", ownerPid: 4242 } : undefined,
  );
  return shapeToolCallError(error, { toolName: "tapOn", source: "MCP" });
}

/** The error object of a typed result, wherever the serializer nests it. */
function typedFields(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  try {
    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const nested = parsed.error;
    return nested !== null && typeof nested === "object"
      ? (nested as Record<string, unknown>)
      : parsed;
  } catch {
    return {};
  }
}

describe("a persisted session lost to recovery identity loss is a terminal-session refusal", () => {
  // The error's own message says "The persisted session is terminal", and
  // terminalSessionRefusalFields (#11098) is the contract every terminal-session refusal shares:
  // retryable false + nextAction acquire_new_session.
  test.each(REASONS)("%s carries the terminal-session fields on the MCP wire", (reason) => {
    const fields = typedFields(identityLossResult(reason));
    expect(fields.retryable).toBe(false);
    expect(fields.nextAction).toBe("acquire_new_session");
  });

  test.each(REASONS)("%s is recognised by declaresDeviceSessionInvalid", (reason) => {
    expect(declaresDeviceSessionInvalid(identityLossResult(reason))).toBe(true);
  });

  test("owned-by-other-daemon does not reuse the retryable acquisition code for a dead UUID", () => {
    // device_owned_by_other_daemon is a `wait` refusal for runners (refusal-wire expectations:
    // retryable true, retryAfterMs 2000). The terminal recovery variant reuses the code but is not
    // retryable under the same UUID, and carries no nextAction to override the code, so a runner
    // that classifies by code waits on a session that can never come back.
    const fields = typedFields(identityLossResult("owned-by-other-daemon"));
    const classifiedAsWait = fields.code === "device_owned_by_other_daemon" && !fields.nextAction;
    expect(classifiedAsWait).toBe(false);
  });
});

describe("a connection does not adopt a session an identity-loss error result names", () => {
  test("the dead UUID is not replayed on the next sessionless call", async () => {
    const lost = identityLossResult("target-absent");
    const client = new FakeDaemonClient({
      toolResultFor: (toolName) => (toolName === "tapOn" ? lost : undefined),
    });
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: manager,
      autoStartDaemon: false,
    });
    try {
      const refused = await proxy.callTool("tapOn", { sessionUuid: "dead-session" });
      expect(refused.isError).toBe(true);
      await proxy.callTool("observe", {});
      const observe = client.callToolCalls.find((call) => call.toolName === "observe");
      expect(observe?.params.sessionUuid).toBeUndefined();
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });
});
