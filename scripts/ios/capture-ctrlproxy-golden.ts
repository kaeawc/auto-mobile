#!/usr/bin/env bun
/**
 * Capture golden iOS CtrlProxy exchanges from a runner you started yourself
 * (issue #5837). See docs/design-docs/plat/ios/ctrlproxy-golden-replay.md.
 *
 * Usage:
 *   AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR=<dir> bun scripts/ios/capture-ctrlproxy-golden.ts \
 *     --udid <simulator udid> --port <runner port> --bundle <bundle id> [--fresh] [--tap <label> ...]
 *
 * With `--fresh` the app is terminated and a SpringBoard hierarchy is requested
 * first, which clears the runner's cached SDK hierarchy so the next capture
 * pairs the XCUITest tree with a freshly fetched SDK tree. After each tap,
 * `--fresh` also goes Home, requests a SpringBoard hierarchy and relaunches
 * (which resumes the same screen) before capturing, for the same reason. `SIMCTL_CHILD_*`
 * variables in the environment reach the launched app.
 *
 * Launches `--bundle` with simctl, records one hierarchy, then for each `--tap`
 * label taps the centre of the first node whose text or accessibility label
 * equals it and records the hierarchy that follows. The client talks to the
 * runner directly (no daemon, no runner management), so start the runner first.
 */

import { parseArgs } from "node:util";
import { execFileSync, spawnSync } from "node:child_process";
import { defaultWebSocketFactory } from "../../src/features/observe/DeviceServiceClient";
import { IOS_CTRL_PROXY_RECORD_DIR_ENV } from "../../src/features/observe/ios/CtrlProxyExchangeRecorder";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import type { CtrlProxyNode } from "../../src/features/observe/ios/types";
import { defaultTimer } from "../../src/utils/SystemTimer";

const SETTLE_MS = 1500;

function children(node: CtrlProxyNode): CtrlProxyNode[] {
  if (!node.node) {
    return [];
  }
  return Array.isArray(node.node) ? node.node : [node.node];
}

function findByLabel(root: CtrlProxyNode, label: string): CtrlProxyNode | null {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.shift() as CtrlProxyNode;
    if ((node.text === label || node.contentDesc === label) && node.bounds) {
      return node;
    }
    stack.push(...children(node));
  }
  return null;
}

async function settle(): Promise<void> {
  await defaultTimer.sleep(SETTLE_MS);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      udid: { type: "string" },
      port: { type: "string" },
      bundle: { type: "string" },
      tap: { type: "string", multiple: true },
      fresh: { type: "boolean", default: false },
    },
  });
  if (!values.udid || !values.port || !values.bundle) {
    throw new Error("--udid, --port and --bundle are required");
  }
  if (!process.env[IOS_CTRL_PROXY_RECORD_DIR_ENV]?.trim()) {
    throw new Error(`${IOS_CTRL_PROXY_RECORD_DIR_ENV} must name the capture directory`);
  }

  const client = IOSCtrlProxyClient.createForTesting(
    { deviceId: values.udid, platform: "ios", name: "golden-capture" },
    Number(values.port),
    defaultWebSocketFactory,
    defaultTimer,
  );
  const bundle = values.bundle;
  const udid = values.udid;
  // simctl passes SIMCTL_CHILD_* to the app; request_launch_app then makes the
  // runner target it (activate is a no-op for a foreground app). Without the
  // second step the runner keeps targeting the previously launched app.
  const launch = async (): Promise<void> => {
    execFileSync("xcrun", ["simctl", "launch", udid, bundle], { stdio: "inherit" });
    await settle();
    await client.requestLaunchApp(bundle);
  };
  try {
    if (values.fresh) {
      // Exit code 3 when the app is not running is fine: SpringBoard is foreground either way.
      spawnSync("xcrun", ["simctl", "terminate", values.udid, values.bundle], { stdio: "inherit" });
      await settle();
      await client.requestHierarchySync();
    }
    await launch();
    await settle();
    let synced = await client.requestHierarchySync();
    for (const label of values.tap ?? []) {
      const target = synced ? findByLabel(synced.hierarchy.hierarchy, label) : null;
      if (!target?.bounds) {
        throw new Error(`No node labelled "${label}" in the current hierarchy`);
      }
      const { left, top, right, bottom } = target.bounds;
      const result = await client.requestTapCoordinates(
        Math.round((left + right) / 2),
        Math.round((top + bottom) / 2),
      );
      console.log(`tap "${label}": success=${String(result.success)}`);
      await settle();
      if (values.fresh) {
        await client.requestPressHome();
        await settle();
        await client.requestHierarchySync();
        await launch();
        await settle();
      }
      synced = await client.requestHierarchySync();
    }
    console.log(`captured into ${process.env[IOS_CTRL_PROXY_RECORD_DIR_ENV]}`);
  } finally {
    await client.close();
  }
}

await main();
