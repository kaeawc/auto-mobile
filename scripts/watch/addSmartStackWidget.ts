#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ActionableError, toActionableError } from "../../src/models/ActionableError";
import { WebSocketWatchRunnerClient } from "../../src/features/watch/WatchRunnerClient";
import { addWatchSmartStackWidget } from "../../src/features/watch/WatchSmartStackWidget";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      app: { type: "string" },
      widget: { type: "string" },
      steps: { type: "string" },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !values.app || !values.widget) {
    throw new ActionableError(
      "Usage: --port <1-65535> --app <name> --widget <name> [--steps <0-100>]",
    );
  }
  const client = new WebSocketWatchRunnerClient(`ws://127.0.0.1:${port}/ws`);
  try {
    const result = await addWatchSmartStackWidget(client, {
      appName: values.app,
      widgetName: values.widget,
      galleryStepsFromBottom: values.steps === undefined ? undefined : Number(values.steps),
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.success ? 0 : 1;
  } finally {
    client.close();
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
