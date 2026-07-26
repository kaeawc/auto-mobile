import { describe, it, expect } from "bun:test";
import { Socket } from "node:net";
import { BaseSocketServer } from "../../../src/daemon/socketServer/BaseSocketServer";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSocket } from "../../fakes/FakeNetServer";

/**
 * Minimal concrete BaseSocketServer that records every line the base-class
 * line-framing dispatches to processLine, so the buffer/newline assembly in
 * handleConnection can be driven directly through a fake socket.
 */
class FramingTestServer extends BaseSocketServer {
  public readonly dispatched: string[] = [];

  constructor() {
    // idleTimeoutMs = 0 so handleConnection installs no idle timer.
    super("/fake/framing.sock", new FakeTimer(), "Framing", 0);
  }

  /** Expose the protected connection setup for direct driving in tests. */
  attach(socket: FakeSocket): void {
    this.handleConnection(socket as unknown as Socket);
  }

  protected async processLine(_socket: Socket, line: string): Promise<void> {
    this.dispatched.push(line);
  }
}

describe("BaseSocketServer line framing", () => {
  it("does not dispatch a partial line before its newline arrives", () => {
    const server = new FramingTestServer();
    const socket = new FakeSocket();
    server.attach(socket);

    // A single chunk with no newline is an incomplete request.
    socket.simulateData('{"id":"1","acti');

    expect(server.dispatched).toEqual([]);
  });

  it("assembles a JSON request split mid-value across two chunks into one dispatch", () => {
    const server = new FramingTestServer();
    const socket = new FakeSocket();
    server.attach(socket);

    // The split lands mid-JSON (inside the "action" key).
    socket.simulateData('{"id":"1","acti');
    socket.simulateData('on":"go"}\n');

    expect(server.dispatched).toHaveLength(1);
    expect(JSON.parse(server.dispatched[0])).toEqual({ id: "1", action: "go" });
  });

  it("dispatches each newline-delimited request in a single chunk", () => {
    const server = new FramingTestServer();
    const socket = new FakeSocket();
    server.attach(socket);

    socket.simulateData('{"id":"1","action":"a"}\n{"id":"2","action":"b"}\n');

    expect(server.dispatched).toHaveLength(2);
    expect(JSON.parse(server.dispatched[0])).toEqual({ id: "1", action: "a" });
    expect(JSON.parse(server.dispatched[1])).toEqual({ id: "2", action: "b" });
  });

  it("retains a trailing partial line after complete lines until its newline arrives", () => {
    const server = new FramingTestServer();
    const socket = new FakeSocket();
    server.attach(socket);

    // One complete request followed by the start of a second.
    socket.simulateData('{"id":"1","action":"a"}\n{"id":"2","act');
    expect(server.dispatched).toHaveLength(1);
    expect(JSON.parse(server.dispatched[0])).toEqual({ id: "1", action: "a" });

    // The remainder of the second request completes it.
    socket.simulateData('ion":"b"}\n');
    expect(server.dispatched).toHaveLength(2);
    expect(JSON.parse(server.dispatched[1])).toEqual({ id: "2", action: "b" });
  });
});
