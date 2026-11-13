#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ActionableError, toActionableError } from "../../src/models/ActionableError";
import { WebSocketWatchRunnerClient } from "../../src/features/watch/WatchRunnerClient";
import { addWatchSmartStackWidget } from "../../src/features/watch/WatchSmartStackWidget";
import {
  daemonCliIdleWindowDeclarer,
  withCliSessionIdleHold,
} from "../../src/features/watch/WatchSessionIdleHold";
import { DaemonClient } from "../../src/daemon/client/client";
import { getCliSessionIdleTimeoutMs } from "../../src/daemon/wire/constants";
import { defaultIdGenerator } from "../../src/utils/IdGenerator";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { IOS_SIMULATOR_UUID_PATTERN } from "../../src/utils/ios-cmdline-tools/iosDeviceType";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      app: { type: "string" },
      widget: { type: "string" },
      "host-bundle-id": { type: "string" },
      "widget-kind": { type: "string" },
      steps: { type: "string" },
      attempts: { type: "string" },
      "retry-delay-ms": { type: "string" },
      "session-uuid": { type: "string" },
      udid: { type: "string" },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !values.app || !values.widget) {
    throw new ActionableError(
      "Usage: --port <1-65535> --app <name> --widget <name> [--host-bundle-id <id> --widget-kind <kind>] [--steps <0-100>] [--attempts <1-5>] [--retry-delay-ms <0-120000>] [--session-uuid <uuid>] [--udid <simulator UDID>]",
    );
  }
  const udid = values.udid;
  if (udid !== undefined && !IOS_SIMULATOR_UUID_PATTERN.test(udid)) {
    throw new ActionableError("--udid must be a simulator UUID (8-4-4-4-12 hexadecimal digits).");
  }
  const options = {
    appName: values.app,
    widgetName: values.widget,
    hostBundleId: values["host-bundle-id"],
    widgetKind: values["widget-kind"],
    maxAttempts: values.attempts === undefined ? undefined : Number(values.attempts),
    retryDelayMs:
      values["retry-delay-ms"] === undefined ? undefined : Number(values["retry-delay-ms"]),
    galleryStepsFromBottom: values.steps === undefined ? undefined : Number(values.steps),
  };
  const client = new WebSocketWatchRunnerClient(`ws://127.0.0.1:${port}/ws`);
  const sessionId = values["session-uuid"];
  const daemon = sessionId === undefined ? undefined : new DaemonClient();
  try {
    const add = () =>
      addWatchSmartStackWidget(client, options, {
        relaunchClockface:
          udid === undefined
            ? undefined
            : () => new SimCtlClient().terminateApp("com.apple.clockface", udid),
      });
    // The runner WebSocket makes no daemon tool call, so hold the session's idle clock (#17992).
    const result =
      daemon && sessionId
        ? await withCliSessionIdleHold(
            daemonCliIdleWindowDeclarer(daemon, sessionId, defaultIdGenerator.next()),
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
