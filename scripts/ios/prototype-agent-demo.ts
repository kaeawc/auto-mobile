#!/usr/bin/env bun
/**
 * Prototype host driver for the iOS simulator prototype agent (ios/prototype-agent).
 *
 *   bun scripts/ios/prototype-agent-demo.ts launch <udid> <bundleId> [--test-hooks]   relaunch the app with the agent injected
 *   bun scripts/ios/prototype-agent-demo.ts tap <nodeId>              simulate_tap (needs --test-hooks); prints the reply and the prototype_events it caused
 *   bun scripts/ios/prototype-agent-demo.ts floating                  floating card over a live app
 *   bun scripts/ios/prototype-agent-demo.ts sheet                     bottom sheet with a text field
 *   bun scripts/ios/prototype-agent-demo.ts status | dismiss | events
 *
 * Stdout carries only machine-readable output: each command prints its reply as ONE compact JSON
 * line, which scripts/ios/prototype-agent-smoke.sh parses. Human-facing logs (the agent handshake)
 * go to stderr. The `events` command streams `event {json}` lines and is for interactive use.
 *
 * Specs go through the same validator as the Android path. `launch`
 * passes a host-chosen port and a fresh auth token to the agent (#10566) and saves both to
 * scratch/prototype-agent/session.json for the other commands.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectPrototypeAgent,
  createPrototypeAgentLaunchConfig,
  NodePrototypeAgentConnector,
  type PrototypeAgentClient,
  type PrototypeAgentMessage,
} from "../../src/features/prototype/ios/prototypeAgentClient";
import type { PrototypeSpec } from "../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../src/features/prototype/prototypeValidation";
import { defaultIdGenerator } from "../../src/utils/IdGenerator";

const PORT = Number(process.env.AUTOMOBILE_PROTOTYPE_PORT ?? 8771);
const REPO = join(import.meta.dir, "..", "..");
const AGENT_DIR = join(REPO, "scratch", "prototype-agent");
/** Port and per-launch token written by `launch` and read by every other command. */
const SESSION_FILE = join(AGENT_DIR, "session.json");

async function openAgent(): Promise<PrototypeAgentClient> {
  let session: { port: number; token: string };
  try {
    session = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as { port: number; token: string };
  } catch (error) {
    throw new Error(
      `No prototype agent session at ${SESSION_FILE}; run the launch command first.`,
      {
        cause: error,
      },
    );
  }
  const agent = await connectPrototypeAgent({
    ...session,
    connector: new NodePrototypeAgentConnector(),
  });
  // stderr: stdout is reserved for the command's JSON reply.
  console.error("agent", JSON.stringify(agent.handshake));
  return agent;
}

/** Resolves when `done` matches an event; rejects when the agent goes away. */
function waitForEvent(
  agent: PrototypeAgentClient,
  done: (event: Record<string, unknown>) => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    agent.onClosed(reject);
    agent.onEvent((event) => {
      console.log("event", JSON.stringify(event));
      if (done(event)) {
        resolve();
      }
    });
  });
}

function validated(spec: unknown): PrototypeSpec {
  const result = validatePrototypeSpec(spec);
  if (!result.success) {
    throw new Error(`Invalid spec at ${result.error.path}: ${result.error.message}`);
  }
  return spec as PrototypeSpec;
}

const floatingSpec = () =>
  validated({
    id: "floating-demo",
    window: { placement: { type: "floating", gravity: "bottomCenter", offset: { x: 0, y: 0 } } },
    state: { likes: 0, liked: false },
    root: {
      type: "column",
      testTag: "floating-card",
      style: {
        background: "#F21C1C1E",
        cornerRadius: 20,
        padding: { top: 16, bottom: 16, start: 20, end: 20 },
        spacing: 10,
      },
      children: [
        {
          type: "text",
          text: "Agent-authored prototype on iOS",
          style: { color: "#FFFFFFFF", textSize: 17, fontWeight: 600 },
        },
        {
          type: "text",
          text: "The app underneath stays live outside this card.",
          style: { color: "#B3FFFFFF", textSize: 13 },
        },
        {
          type: "row",
          style: { spacing: 12 },
          children: [
            {
              type: "row",
              testTag: "like-button",
              onTap: [
                { type: "setState", key: "liked", value: true },
                { type: "emit", name: "liked" },
              ],
              style: {
                background: "#FF0A84FF",
                cornerRadius: 12,
                padding: { top: 8, bottom: 8, start: 14, end: 14 },
                spacing: 6,
              },
              children: [
                { type: "icon", name: "favorite", style: { color: "#FFFFFFFF", textSize: 15 } },
                { type: "text", text: "Like", style: { color: "#FFFFFFFF", textSize: 15 } },
              ],
            },
            {
              type: "text",
              testTag: "liked-label",
              visibleWhen: { key: "liked", equals: true },
              text: "Liked ✓",
              style: { color: "#FF30D158", textSize: 15, padding: { top: 8 } },
            },
            {
              type: "text",
              testTag: "close-button",
              text: "Close",
              onTap: [{ type: "dismiss" }],
              style: { color: "#FFFFFFFF", textSize: 15, padding: { top: 8, start: 8 } },
            },
          ],
        },
      ],
    },
  });

const sheetSpec = () =>
  validated({
    id: "sheet-demo",
    window: { placement: { type: "sheet", edge: "bottom", height: 260 } },
    state: { name: "" },
    root: {
      type: "column",
      style: {
        width: "fill",
        height: "fill",
        background: "#FFFFFFFF",
        cornerRadius: 24,
        padding: { top: 20, start: 20, end: 20, bottom: 20 },
        spacing: 12,
      },
      children: [
        { type: "text", text: "What should we call it?", style: { textSize: 20, fontWeight: 600 } },
        { type: "textField", testTag: "name-field", stateKey: "name", placeholder: "Name" },
        { type: "text", text: "Hello, {name}", style: { color: "#FF8E8E93" } },
        {
          type: "text",
          testTag: "submit-button",
          text: "Submit",
          onTap: [{ type: "emit", name: "submitted" }],
          style: {
            background: "#FF0A84FF",
            color: "#FFFFFFFF",
            cornerRadius: 12,
            textAlign: "center",
            width: "fill",
            padding: { top: 12, bottom: 12 },
          },
        },
      ],
    },
  });

function launch(udid: string, bundleId: string, testHooks: boolean): void {
  const dylib = join(AGENT_DIR, "AutoMobilePrototypeAgent.dylib");
  const config = createPrototypeAgentLaunchConfig(PORT, defaultIdGenerator);
  mkdirSync(AGENT_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify({ port: config.port, token: config.token }), {
    mode: 0o600,
  });
  const result = spawnSync(
    "xcrun",
    ["simctl", "launch", "--terminate-running-process", udid, bundleId],
    {
      env: {
        ...process.env,
        SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: dylib,
        ...config.simctlEnvironment,
        // Debug-only: lets the agent accept simulate_tap. Never set for ordinary launches.
        ...(testHooks ? { SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_AGENT_TEST_HOOKS: "1" } : {}),
      },
      encoding: "utf8",
    },
  );
  console.log(result.stdout.trim(), result.stderr.trim());
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main(): Promise<void> {
  const [command = "status", ...rest] = process.argv.slice(2);
  if (command === "launch") {
    const [udid, bundleId] = rest;
    if (udid === undefined || bundleId === undefined) {
      throw new Error("usage: launch <udid> <bundleId>");
    }
    launch(udid, bundleId, rest.includes("--test-hooks"));
    return;
  }
  const agent = await openAgent();
  try {
    switch (command) {
      case "floating":
        console.log(
          JSON.stringify(await agent.request("show_prototype", { spec: floatingSpec() })),
        );
        break;
      case "sheet":
        console.log(JSON.stringify(await agent.request("show_prototype", { spec: sheetSpec() })));
        break;
      case "tap": {
        const nodeId = rest[0];
        if (nodeId === undefined) {
          throw new Error("usage: tap <nodeId>");
        }
        // The agent pushes a tap's events before it replies on the same stream, so everything
        // collected by the time the reply lands belongs to this tap.
        const events: PrototypeAgentMessage[] = [];
        agent.onEvent((event) => events.push(event));
        const result = await agent.request("simulate_tap", { nodeId });
        console.log(JSON.stringify({ result, events }));
        break;
      }
      case "dismiss":
        console.log(JSON.stringify(await agent.request("dismiss_prototype", { all: true })));
        break;
      case "events":
        console.log("Listening for prototype events (Ctrl-C to stop)...");
        await waitForEvent(agent, () => false);
        break;
      default:
        console.log(JSON.stringify(await agent.request("get_prototype_status")));
    }
  } finally {
    agent.close();
  }
}

await main();
