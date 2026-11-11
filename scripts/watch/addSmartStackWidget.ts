#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ActionableError, toActionableError } from "../../src/models/ActionableError";
import { WebSocketWatchRunnerClient } from "../../src/features/watch/WatchRunnerClient";
import { addWatchSmartStackWidget } from "../../src/features/watch/WatchSmartStackWidget";
import {
  withCliSessionIdleHold,
  type CliIdleWindowDeclarer,
} from "../../src/features/watch/WatchSessionIdleHold";
import { DaemonClient } from "../../src/daemon/client/client";
import {
  CLI_KEEPER_LIVENESS_OWNER_KIND,
  CLI_SESSION_LIVENESS_POLICY,
  DAEMON_HEARTBEAT_METHOD,
  getCliSessionIdleTimeoutMs,
} from "../../src/daemon/wire/constants";
import { defaultTimer } from "../../src/utils/SystemTimer";

const HEARTBEAT_TIMEOUT_MS = 5_000;

/** Declares the session's CLI idle window over one daemon connection. */
function daemonIdleWindowDeclarer(client: DaemonClient, sessionId: string): CliIdleWindowDeclarer {
  return {
    declareIdleWindow: async (idleTimeoutMs) => {
      await client.connect();
      await client.callDaemonMethod(
        DAEMON_HEARTBEAT_METHOD,
        {
          sessionId,
          livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
          livenessOwnerKind: CLI_KEEPER_LIVENESS_OWNER_KIND,
          idleTimeoutMs,
        },
        { timeoutMs: HEARTBEAT_TIMEOUT_MS },
      );
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      app: { type: "string" },
      widget: { type: "string" },
      steps: { type: "string" },
      attempts: { type: "string" },
      "retry-delay-ms": { type: "string" },
      "session-uuid": { type: "string" },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !values.app || !values.widget) {
    throw new ActionableError(
      "Usage: --port <1-65535> --app <name> --widget <name> [--steps <0-100>] [--attempts <1-5>] [--retry-delay-ms <0-120000>] [--session-uuid <uuid>]",
    );
  }
  const options = {
    appName: values.app,
    widgetName: values.widget,
    maxAttempts: values.attempts === undefined ? undefined : Number(values.attempts),
    retryDelayMs:
      values["retry-delay-ms"] === undefined ? undefined : Number(values["retry-delay-ms"]),
    galleryStepsFromBottom: values.steps === undefined ? undefined : Number(values.steps),
  };
  const client = new WebSocketWatchRunnerClient(`ws://127.0.0.1:${port}/ws`);
  const sessionId = values["session-uuid"];
  const daemon = sessionId === undefined ? undefined : new DaemonClient();
  try {
    const add = () => addWatchSmartStackWidget(client, options);
    // The runner WebSocket makes no daemon tool call, so hold the session's idle clock (#17992).
    const result =
      daemon && sessionId
        ? await withCliSessionIdleHold(
            daemonIdleWindowDeclarer(daemon, sessionId),
            defaultTimer,
            add,
            {
              baseIdleTimeoutMs: getCliSessionIdleTimeoutMs(),
            },
          )
        : await add();
    console.log(JSON.stringify(result));
    process.exitCode = result.success ? 0 : 1;
  } finally {
    client.close();
    await daemon?.close();
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.log(
      JSON.stringify({
        success: false,
        reason: toActionableError(error, "Smart Stack command failed").message,
      }),
    );
    process.exitCode = 1;
  });
}
