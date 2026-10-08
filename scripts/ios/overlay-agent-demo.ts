#!/usr/bin/env bun
/**
 * Prototype host driver for the iOS simulator overlay agent (ios/overlay-agent).
 *
 *   bun scripts/ios/overlay-agent-demo.ts launch <udid> <bundleId>   relaunch the app with the agent injected
 *   bun scripts/ios/overlay-agent-demo.ts variants [--screenshot <udid>]   swipeable carousel, waits for a pick
 *   bun scripts/ios/overlay-agent-demo.ts floating                  floating card over a live app
 *   bun scripts/ios/overlay-agent-demo.ts sheet                     bottom sheet with a text field
 *   bun scripts/ios/overlay-agent-demo.ts status | dismiss | events
 *
 * Specs go through the same validator and showVariants composer as the Android path.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { OverlaySpec } from "../../src/features/overlay/overlaySpec";
import { validateOverlaySpec } from "../../src/features/overlay/overlayValidation";
import { composeVariantCarousel } from "../../src/features/overlay/overlayVariants";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";

const PORT = Number(process.env.AUTOMOBILE_OVERLAY_PORT ?? 8771);
const REPO = join(import.meta.dir, "..", "..");

type Message = Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 15_000;

interface Waiter {
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

class AgentConnection {
  private buffer = "";
  private waiters = new Map<string, Waiter>();
  private nextId = 1;
  private closedError: Error | undefined;
  onEvent: (event: Message) => void = (event) => console.log("event", JSON.stringify(event));
  /** Called once when the agent goes away, so event waits settle too. */
  onClosed: (error: Error) => void = () => {};

  private constructor(
    private readonly socket: Socket,
    private readonly timer: Timer = defaultTimer,
  ) {
    socket.setEncoding("utf8");
    // The injected app can exit or crash at any time; settle everything still waiting.
    socket.on("error", (error) =>
      this.fail(new Error(`Overlay agent connection failed: ${error.message}`)),
    );
    socket.on("close", () =>
      this.fail(new Error("Overlay agent closed the connection (app exited?)")),
    );
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(this.buffer.slice(0, newline)) as Message;
        this.buffer = this.buffer.slice(newline + 1);
        this.dispatch(message);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  static open(): Promise<AgentConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect(PORT, "127.0.0.1", () => resolve(new AgentConnection(socket)));
      socket.once("error", (error) =>
        reject(
          new Error(
            `Overlay agent is not listening on 127.0.0.1:${PORT}. Run the launch command first. (${error.message})`,
          ),
        ),
      );
    });
  }

  private dispatch(message: Message): void {
    const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
    const waiter = requestId === undefined ? undefined : this.waiters.get(requestId);
    if (waiter !== undefined && requestId !== undefined) {
      this.waiters.delete(requestId);
      this.timer.clearTimeout(waiter.timeout);
      waiter.resolve(message);
    } else if (message.type === "overlay_event") {
      this.onEvent(message);
    } else {
      console.log("unmatched", JSON.stringify(message));
    }
  }

  request(type: string, body: Message = {}): Promise<Message> {
    if (this.closedError !== undefined) {
      return Promise.reject(this.closedError);
    }
    const requestId = `r${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timeout = this.timer.setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`Overlay agent did not answer ${type} within ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      this.waiters.set(requestId, { resolve, reject, timeout });
      this.socket.write(`${JSON.stringify({ type, requestId, ...body })}\n`);
    });
  }

  private fail(error: Error): void {
    if (this.closedError !== undefined) {
      return;
    }
    this.closedError = error;
    for (const waiter of this.waiters.values()) {
      this.timer.clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
    this.onClosed(error);
  }

  close(): void {
    this.socket.end();
  }
}

function validated(spec: unknown): OverlaySpec {
  const result = validateOverlaySpec(spec);
  if (!result.success) {
    throw new Error(`Invalid spec at ${result.error.path}: ${result.error.message}`);
  }
  return spec as OverlaySpec;
}

/**
 * A variant page whose chips are live: a tap records the choice in spec state, which shows an
 * in-layout toast reading it back through `{key}` interpolation, and tells the host via `emit`.
 * Keys are per variant so each page keeps its own choice while the pager swipes.
 */
function card(id: string, title: string, body: string, background: string, accent: string) {
  const choice = `${id}_choice`;
  const toast = `${id}_toast`;
  return {
    type: "column" as const,
    style: {
      width: "fill" as const,
      height: "fill" as const,
      background,
      padding: { top: 120, start: 24, end: 24, bottom: 24 },
      spacing: 16,
    },
    children: [
      {
        type: "text" as const,
        text: title,
        style: { textSize: 34, fontWeight: 700, color: accent },
      },
      { type: "text" as const, text: body, style: { textSize: 17, color: "#FF8E8E93" } },
      {
        type: "row" as const,
        style: { spacing: 12 },
        children: ["One", "Two", "Three"].map((label) => ({
          type: "text" as const,
          text: label,
          testTag: `${id}-chip-${label.toLowerCase()}`,
          onTap: [
            { type: "setState" as const, key: choice, value: label },
            { type: "setState" as const, key: toast, value: true },
            { type: "emit" as const, name: "chip", payload: { variant: id, label } },
          ],
          style: {
            background: accent,
            color: "#FFFFFFFF",
            cornerRadius: 18,
            padding: { top: 8, bottom: 8, start: 16, end: 16 },
          },
        })),
      },
      {
        type: "row" as const,
        testTag: `${id}-toast`,
        visibleWhen: { key: toast, equals: true },
        // Tapping the toast hides it again; there is no timer vocabulary for auto-dismiss.
        onTap: [{ type: "setState" as const, key: toast, value: false }],
        style: {
          background: "#E6202124",
          cornerRadius: 12,
          padding: { top: 12, bottom: 12, start: 16, end: 16 },
          spacing: 8,
        },
        children: [
          { type: "icon" as const, name: "check" as const, style: { color: accent, textSize: 17 } },
          {
            type: "text" as const,
            text: `You picked {${choice}}`,
            style: { color: "#FFFFFFFF", textSize: 15 },
          },
        ],
      },
    ],
  };
}

function screenshotBase64(udid: string): string {
  const path = join(REPO, "scratch", "overlay-agent", "variant-screenshot.png");
  const shot = spawnSync("xcrun", ["simctl", "io", udid, "screenshot", path]);
  if (shot.status !== 0) {
    throw new Error(`simctl screenshot failed: ${shot.stderr.toString()}`);
  }
  return readFileSync(path).toString("base64");
}

async function variants(agent: AgentConnection, screenshotUdid?: string): Promise<void> {
  const list: Array<Record<string, unknown>> = [
    {
      label: "Calm",
      spec: card("calm", "Good morning", "A quieter home screen.", "#FFF2F7F2", "#FF2E7D32"),
    },
    {
      label: "Bold",
      spec: card("bold", "Hey there!", "Big type, loud color.", "#FFFFF3E0", "#FFE65100"),
    },
    {
      label: "Night",
      spec: card("night", "Evening", "Dark variant for comparison.", "#FF101418", "#FF90CAF9"),
    },
  ];
  if (screenshotUdid !== undefined) {
    const upload = await agent.request("put_overlay_asset", {
      id: "current-screen",
      mimeType: "image/png",
      dataBase64: screenshotBase64(screenshotUdid),
    });
    console.log("asset", JSON.stringify(upload));
    list.push({ label: "Current", image: { asset: "current-screen", contentScale: "fit" } });
  }
  const spec = composeVariantCarousel({ id: "variants-demo", variants: list });
  console.log("show", JSON.stringify(await agent.request("show_overlay", { spec })));
  console.log("Swipe or tap ◀ ▶ in the simulator, then tap ✓ to pick. Waiting...");
  await new Promise<void>((resolve, reject) => {
    agent.onClosed = reject;
    agent.onEvent = (event) => {
      console.log("event", JSON.stringify(event));
      if ((event.kind === "emit" && event.name === "selected") || event.kind === "dismissed") {
        resolve();
      }
    };
  });
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
          text: "Agent-authored overlay on iOS",
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

function launch(udid: string, bundleId: string): void {
  const dylib = join(REPO, "scratch", "overlay-agent", "AutoMobileOverlayAgent.dylib");
  const result = spawnSync(
    "xcrun",
    ["simctl", "launch", "--terminate-running-process", udid, bundleId],
    {
      env: {
        ...process.env,
        SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: dylib,
        SIMCTL_CHILD_AUTOMOBILE_OVERLAY_PORT: String(PORT),
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
    launch(udid, bundleId);
    return;
  }
  const agent = await AgentConnection.open();
  try {
    switch (command) {
      case "variants": {
        const flag = rest.indexOf("--screenshot");
        await variants(agent, flag >= 0 ? rest[flag + 1] : undefined);
        break;
      }
      case "floating":
        console.log(JSON.stringify(await agent.request("show_overlay", { spec: floatingSpec() })));
        break;
      case "sheet":
        console.log(JSON.stringify(await agent.request("show_overlay", { spec: sheetSpec() })));
        break;
      case "dismiss":
        console.log(JSON.stringify(await agent.request("dismiss_overlay", { all: true })));
        break;
      case "events":
        console.log("Listening for overlay events (Ctrl-C to stop)...");
        await new Promise<void>((_resolve, reject) => {
          agent.onClosed = reject;
        });
        break;
      default:
        console.log(JSON.stringify(await agent.request("get_overlay_status"), null, 2));
    }
  } finally {
    agent.close();
  }
}

await main();
