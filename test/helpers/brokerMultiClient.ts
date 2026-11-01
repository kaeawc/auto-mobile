import { expect } from "bun:test";
import { renderClientRequest } from "../../scripts/manual-test/brokerBatch";
import { DAEMON_REGISTER_SESSION_METHOD } from "../../src/daemon/wire/constants";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { handleReleaseBrokerSession } from "../../src/daemon/sessionBroker/handlers";
import { SESSION_OWNER_EXITED_CODE } from "../../src/devices/sessionBrokerResult";
import type { createFakeBrokerDaemon } from "./fakeBrokerDaemon";
export type Host = Awaited<ReturnType<typeof createFakeBrokerDaemon>>;
export interface Client {
  name: string;
  token: string;
}
export async function acquire(host: Host, client: Client, ordinal: number) {
  const config = renderClientRequest(
    { name: client.name, platform: "ios" },
    `${client.name}-${ordinal}`,
  );
  const result = await host.prepare(config, client.token);
  expect(result.failure).toBeUndefined();
  expect(result.outcome).toBe("ready");
  return {
    config,
    result,
    sessionUuid: result.sessionUuid!,
    socket: `${client.name}-socket-${ordinal}`,
  };
}

/** The wire step a proxy performs after a grant: register the session on its own socket. */
export type Grant = Awaited<ReturnType<typeof acquire>>;

export async function connect(host: Host, client: Client, grant: Grant) {
  return handleDaemonRequest(
    {
      id: `register-${grant.sessionUuid}`,
      type: "daemon_request",
      method: DAEMON_REGISTER_SESSION_METHOD,
      params: {
        sessionId: grant.sessionUuid,
        clientName: client.name,
        sessionBroker: { requestId: grant.config.requestId, livenessOwnerToken: client.token },
      },
    },
    host.state,
    { context: { socketSessionId: grant.socket } },
  );
}

export function deviceOf(host: Host, sessionUuid: string): string {
  return host.sessions.getSession(sessionUuid)!.assignedDevice!;
}

export function release(
  host: Host,
  client: Client,
  sessionUuid: string,
  reason?: typeof SESSION_OWNER_EXITED_CODE,
) {
  return handleReleaseBrokerSession(
    {
      id: `release-${sessionUuid}`,
      type: "daemon_request",
      method: "daemon/releaseBrokerSession",
      params: {
        sessionId: sessionUuid,
        livenessOwnerToken: client.token,
        ...(reason ? { reason } : {}),
      },
    },
    host.state,
  );
}
