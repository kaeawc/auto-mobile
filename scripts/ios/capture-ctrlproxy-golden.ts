#!/usr/bin/env bun
/**
 * Capture golden iOS CtrlProxy exchanges from a runner you started yourself
 * (issue #5837). See docs/design-docs/plat/ios/ctrlproxy-golden-replay.md.
 *
 * Usage:
 *   AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR=<dir> bun scripts/ios/capture-ctrlproxy-golden.ts \
 *     --udid <simulator udid> --port <runner port> --bundle <bundle id> [--tap <label> ...]
 *
 * Launches `--bundle` with simctl, records one hierarchy, then for each `--tap`
 * label taps the centre of the first node whose text or accessibility label
 * equals it and records the hierarchy that follows. The client talks to the
 * runner directly (no daemon, no runner management), so start the runner first.
 */

import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
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
    },
  });
  if (!values.udid || !values.port || !values.bundle) {
    throw new Error("--udid, --port and --bundle are required");
  }
  if (!process.env[IOS_CTRL_PROXY_RECORD_DIR_ENV]?.trim()) {
    throw new Error(`${IOS_CTRL_PROXY_RECORD_DIR_ENV} must name the capture directory`);
  }

  execFileSync("xcrun", ["simctl", "launch", values.udid, values.bundle], { stdio: "inherit" });
  await settle();

  const client = IOSCtrlProxyClient.createForTesting(
    { deviceId: values.udid, platform: "ios", name: "golden-capture" },
    Number(values.port),
    defaultWebSocketFactory,
    defaultTimer,
  );
  try {
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
      console.log(`tap "${label}": ${JSON.stringify(result)}`);
      await settle();
      synced = await client.requestHierarchySync();
    }
    console.log(`captured into ${process.env[IOS_CTRL_PROXY_RECORD_DIR_ENV]}`);
  } finally {
    await client.close();
  }
}

await main();
