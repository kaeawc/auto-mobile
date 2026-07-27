import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Socket } from "node:net";
import { PushSubscriptionSocketServer } from "../../src/daemon/socketServer/PushSubscriptionSocketServer";
import { DEFAULT_KEEPALIVE_CONFIG } from "../../src/daemon/socketServer/SocketServerTypes";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";

// Doc-pin for the keepalive section added by #4546: the third-party client guide's
// documented ping/pong exchange must stay true to the real
// PushSubscriptionSocketServer, or a client author implementing from the doc alone
// gets reaped at the activity timeout. The doc's literal JSON examples are parsed
// out of the markdown and driven through the real server: the documented ping shape
// is compared against what checkKeepalive actually writes, and the documented pong
// line is fed verbatim through processLine to prove it refreshes liveness.

const DOC_PATH = "docs/design-docs/mcp/daemon/client-screen-control.md";
const repoRoot = join(import.meta.dir, "../..");

async function readKeepaliveSection(): Promise<string> {
  const markdown = await readFile(join(repoRoot, DOC_PATH), "utf-8");
  const start = markdown.indexOf("### Keepalive (ping/pong)");
  const end = markdown.indexOf("### Pushed messages", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return markdown.slice(start, end);
}

/** The JSON example lines inside the section's fenced code block, in order. */
function parseExampleLines(section: string): Array<Record<string, unknown>> {
  return section
    .split("\n")
    .filter(line => line.trimStart().startsWith("{"))
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

class DocPinPushServer extends PushSubscriptionSocketServer<null, never> {
  constructor(timer: FakeTimer) {
    super("/fake/path/keepalive-doc.sock", timer, "KeepaliveDocPin");
  }

  addSubscriber(socket: FakeSocket): string {
    const subscriptionId = "keepalive-doc-1";
    this.subscribers.set(subscriptionId, {
      socket: socket as unknown as Socket,
      subscriptionId,
      lastActivity: this.timer.now(),
      filter: null,
      backfilling: false,
      drainPending: false,
    });
    return subscriptionId;
  }

  lastActivityOf(subscriptionId: string): number | undefined {
    return this.subscribers.get(subscriptionId)?.lastActivity;
  }

  triggerKeepalive(): void {
    this.checkKeepalive();
  }

  async feedLine(socket: FakeSocket, line: string): Promise<void> {
    await this.processLine(socket as unknown as Socket, line);
  }

  protected parseSubscriptionFilter(): null {
    return null;
  }

  protected matchesFilter(): boolean {
    return false;
  }

  protected createPushMessage(): unknown {
    return {};
  }
}

describe("observation stream keepalive doc (client-screen-control.md)", () => {
  test("documents the daemon's real ping shape and cadence", async () => {
    const section = await readKeepaliveSection();
    const [docPing] = parseExampleLines(section);

    const timer = new FakeTimer();
    const server = new DocPinPushServer(timer);
    const socket = new FakeSocket();
    server.addSubscriber(socket);

    timer.advanceTimersByTime(DEFAULT_KEEPALIVE_CONFIG.intervalMs);
    server.triggerKeepalive();

    const [realPing] = socket.getWrittenMessages<Record<string, unknown>>();
    expect(realPing).toBeDefined();
    // Same keys, same type discriminator; the timestamp value is clock-dependent.
    expect(Object.keys(docPing).sort()).toEqual(Object.keys(realPing).sort());
    expect(docPing.type).toBe("ping");
    expect(realPing.type).toBe("ping");
    expect(typeof docPing.timestamp).toBe("number");
    expect(typeof realPing.timestamp).toBe("number");

    // The documented cadence and activity window are the server's real config.
    expect(DEFAULT_KEEPALIVE_CONFIG.intervalMs).toBe(10_000);
    expect(DEFAULT_KEEPALIVE_CONFIG.timeoutMs).toBe(30_000);
    expect(section).toContain("**10 s**");
    expect(section).toContain("**30 s**");
  });

  test("the documented pong line, fed verbatim, refreshes liveness with no response", async () => {
    const section = await readKeepaliveSection();
    const examples = parseExampleLines(section);
    const docPong = examples.find(example => example.command === "pong");
    expect(docPong).toEqual({ command: "pong" });

    const timer = new FakeTimer();
    const server = new DocPinPushServer(timer);
    const socket = new FakeSocket();
    const subscriptionId = server.addSubscriber(socket);

    // Nearly at the reap deadline; the doc's exact pong line must refresh activity.
    timer.advanceTimersByTime(DEFAULT_KEEPALIVE_CONFIG.timeoutMs - 1_000);
    await server.feedLine(socket, JSON.stringify(docPong));
    expect(server.lastActivityOf(subscriptionId)).toBe(timer.now());

    // The doc says the daemon sends no response to a pong.
    expect(socket.getWrittenMessages()).toEqual([]);

    // And the refreshed subscriber survives the sweep that would otherwise reap it.
    timer.advanceTimersByTime(2_000);
    server.triggerKeepalive();
    expect(server.getSubscriberCount()).toBe(1);
  });
});
