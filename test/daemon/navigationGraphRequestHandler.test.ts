import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import {
  createNavigationGraphRequestHandler,
  convertSummaryToStreamData,
  type NavigationGraphSummaryExporter,
} from "../../src/daemon/navigationGraphRequestHandler";
import { ActionableError } from "../../src/models/ActionableError";
import type { NavigationGraphSummary } from "../../src/utils/interfaces/NavigationGraph";
import { logger } from "../../src/utils/logger";
import { DeviceDataStreamSocketServer, type NavigationGraphStreamData } from "../../src/daemon/deviceDataStreamSocketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { Socket } from "node:net";

const EMPTY_SUMMARY: NavigationGraphSummary = {
  appId: null,
  nodes: [],
  edges: [],
  currentScreen: null,
};

const POPULATED_SUMMARY: NavigationGraphSummary = {
  appId: "com.example.app",
  nodes: [{ id: 1, screenName: "Home", visitCount: 3 }],
  edges: [{ id: 1, from: "Home", to: "Settings", toolName: "tapOn", traversalCount: 2 }],
  currentScreen: "Home",
};

class FakeExporter implements NavigationGraphSummaryExporter {
  public exportAllCalls = 0;
  public exportForAppCalls: Array<string | null> = [];

  constructor(
    private readonly result:
      | { kind: "resolve"; summary: NavigationGraphSummary }
      | { kind: "reject"; error: unknown }
  ) {}

  async exportGraphSummary(): Promise<NavigationGraphSummary> {
    this.exportAllCalls++;
    return this.settle();
  }

  async exportGraphSummaryForApp(appId: string | null): Promise<NavigationGraphSummary> {
    this.exportForAppCalls.push(appId);
    return this.settle();
  }

  private async settle(): Promise<NavigationGraphSummary> {
    if (this.result.kind === "reject") {
      throw this.result.error;
    }
    return this.result.summary;
  }
}

/** Minimal test double exposing processLine so the wired handler can be exercised end-to-end. */
class TestableServer extends DeviceDataStreamSocketServer {
  constructor(timer: FakeTimer) {
    super("/fake/path/nav-handler.sock", timer);
  }

  async processLineForTest(socket: FakeSocket, line: string): Promise<void> {
    await this.processLine(socket as unknown as Socket, line);
  }
}

describe("createNavigationGraphRequestHandler", () => {
  let warnSpy: ReturnType<typeof spyOn<typeof logger, "warn">>;

  beforeEach(() => {
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    warnSpy.mockClear();
  });

  it("rethrows an ActionableError when the export fails, instead of swallowing to null", async () => {
    const exporter = new FakeExporter({ kind: "reject", error: new Error("boom") });
    const handler = createNavigationGraphRequestHandler(exporter);

    const call = handler(null);
    await expect(call).rejects.toBeInstanceOf(ActionableError);
    await expect(call).rejects.toThrow(/Failed to export navigation graph on request: boom/);
  });

  it("keeps the warn log for traceability when the export fails", async () => {
    const exporter = new FakeExporter({ kind: "reject", error: new Error("boom") });
    const handler = createNavigationGraphRequestHandler(exporter);

    await expect(handler(null)).rejects.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("Failed to export navigation graph on request");
  });

  it("returns a non-null empty graph on the no-app / empty-graph success path", async () => {
    const exporter = new FakeExporter({ kind: "resolve", summary: EMPTY_SUMMARY });
    const handler = createNavigationGraphRequestHandler(exporter);

    const result = await handler(null);
    expect(result).not.toBeNull();
    expect(result?.appId).toBeNull();
    expect(result?.nodes).toHaveLength(0);
    expect(result?.edges).toHaveLength(0);
    expect(exporter.exportAllCalls).toBe(1);
  });

  it("routes to exportGraphSummaryForApp when an appId is supplied", async () => {
    const exporter = new FakeExporter({ kind: "resolve", summary: POPULATED_SUMMARY });
    const handler = createNavigationGraphRequestHandler(exporter);

    const result = await handler("com.example.app");
    expect(result?.appId).toBe("com.example.app");
    expect(exporter.exportForAppCalls).toEqual(["com.example.app"]);
    expect(exporter.exportAllCalls).toBe(0);
  });

  describe("wired into the stream server (issue #4918)", () => {
    let server: TestableServer;

    beforeEach(() => {
      server = new TestableServer(new FakeTimer());
    });

    it("emits a typed error frame (not a silent success ack) when the export fails", async () => {
      server.setOnNavigationGraphRequested(
        createNavigationGraphRequestHandler(new FakeExporter({ kind: "reject", error: new Error("db down") }))
      );
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({ id: "req-err", command: "request_navigation_graph" })
      );

      const msgs = socket.getWrittenMessages<{ id?: string; type: string; success?: boolean; error?: string }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("req-err");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toContain("db down");
    });

    it("emits a navigation_update for the empty-graph success path (distinct from failure)", async () => {
      server.setOnNavigationGraphRequested(
        createNavigationGraphRequestHandler(new FakeExporter({ kind: "resolve", summary: EMPTY_SUMMARY }))
      );
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({ id: "req-empty", command: "request_navigation_graph" })
      );

      const msgs = socket.getWrittenMessages<{ id?: string; type: string; navigationGraph?: NavigationGraphStreamData }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("navigation_update");
      expect(msgs[0].id).toBe("req-empty");
      expect(msgs[0].navigationGraph?.appId).toBeNull();
      expect(msgs[0].navigationGraph?.nodes).toHaveLength(0);
    });

    it("serializes the error frame so an unknown-frame-tolerant decoder handles it without throwing", async () => {
      server.setOnNavigationGraphRequested(
        createNavigationGraphRequestHandler(new FakeExporter({ kind: "reject", error: new Error("db down") }))
      );
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({ id: "req-decode", command: "request_navigation_graph" })
      );

      // Round-trip the raw wire bytes exactly as a client would receive them.
      const rawLine = socket.getWrittenDataString().trim();
      const decoded = JSON.parse(rawLine) as { type: string; success?: boolean; error?: string; id?: string };

      // Mirror the desktop client's `when (type) { ... else -> ignore }` dispatch: every known
      // frame type routes, and any unrecognized type is silently ignored rather than throwing.
      const decode = (frame: { type: string }): string => {
        switch (frame.type) {
          case "navigation_update":
            return "handled-navigation";
          case "error":
            return "handled-error";
          default:
            return "ignored-unknown";
        }
      };

      expect(decoded.type).toBe("error");
      expect(decode(decoded)).toBe("handled-error");
      // A future/unknown frame type must not throw in the same decoder.
      expect(decode({ type: "some_future_frame" })).toBe("ignored-unknown");
    });
  });
});

describe("convertSummaryToStreamData", () => {
  it("preserves node and edge fields and current screen", () => {
    const streamData = convertSummaryToStreamData(POPULATED_SUMMARY);
    expect(streamData.appId).toBe("com.example.app");
    expect(streamData.currentScreen).toBe("Home");
    expect(streamData.nodes[0]).toMatchObject({ id: 1, screenName: "Home", visitCount: 3 });
    expect(streamData.edges[0]).toMatchObject({ from: "Home", to: "Settings", toolName: "tapOn", traversalCount: 2 });
  });
});
