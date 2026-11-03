import { describe, expect, test } from "bun:test";
import {
  MockRooms,
  mockFrameData,
  type MockFrameSource,
  type MockRoomConnection,
} from "../../../src/features/prototype/prototypeMockRooms";
import {
  MAX_MOCK_ROOM_MEMBERS,
  type MockRoom,
} from "../../../src/features/prototype/prototypeMockSchema";
import { MAX_PROTOTYPE_CHANNEL_FRAME_BYTES } from "../../../src/features/prototype/prototypeChannelLimits";
import { FakeTimer } from "../../fakes/FakeTimer";

class Member {
  readonly frames: string[] = [];
  readonly closes: [number, string][] = [];
  deliver(data: string): void {
    this.frames.push(data);
  }
  close(code: number, reason: string): void {
    this.closes.push([code, reason]);
  }
}

function setup(rooms: MockRoom[]) {
  const timer = new FakeTimer();
  const log: [string, MockFrameSource, string][] = [];
  const engine = new MockRooms(rooms, {
    timer,
    record: (room, from, data) => log.push([room, from, data]),
  });
  const join = (path: string, query: Record<string, string> = {}) => {
    const member = new Member();
    const joined = engine.join(path, query, member);
    if (!joined.ok) {
      throw new Error(joined.message);
    }
    return { member, connection: joined.connection as MockRoomConnection };
  };
  return { timer, log, engine, join };
}

describe("MockRooms", () => {
  test("onConnect frames greet each connection with params and query bound", () => {
    const { join } = setup([
      {
        path: "/rooms/:roomId",
        onConnect: [{ type: "welcome", room: "{params.roomId}", me: "{query.user}" }, "hi"],
      },
    ]);
    const { member } = join("/rooms/general", { user: "ana" });
    expect(member.frames).toEqual(['{"type":"welcome","room":"general","me":"ana"}', "hi"]);
  });

  test("a path no room matches is refused with 404", () => {
    const { engine } = setup([{ path: "/rooms/:roomId" }]);
    expect(engine.join("/feed", {}, new Member())).toEqual({
      ok: false,
      status: 404,
      message: "No mock room matches /feed.",
    });
  });

  test("relay fans a send out to the other members of the same path only", () => {
    const { join, log } = setup([{ path: "/rooms/:roomId", relay: true }]);
    const a = join("/rooms/x");
    const b = join("/rooms/x");
    const other = join("/rooms/y");
    expect(a.connection.send("hello")).toEqual({ ok: true });
    expect([a.member.frames, b.member.frames, other.member.frames]).toEqual([[], ["hello"], []]);
    expect(log).toEqual([["/rooms/x", "client", "hello"]]);
  });

  test("echo returns a send to its sender; neither echo nor relay only logs it", () => {
    const echo = setup([{ path: "/echo", echo: true }]);
    const a = echo.join("/echo");
    const b = echo.join("/echo");
    a.connection.send("ping");
    expect([a.member.frames, b.member.frames]).toEqual([["ping"], []]);
    const quiet = setup([{ path: "/quiet" }]);
    const q = quiet.join("/quiet");
    expect(q.connection.send("x")).toEqual({ ok: true });
    expect(q.member.frames).toEqual([]);
    expect(quiet.log).toEqual([["/quiet", "client", "x"]]);
  });

  test("timeline frames fire on the injected timer per connection and stop when it leaves", () => {
    const { join, timer } = setup([
      {
        path: "/drivers/:id",
        timeline: [
          { afterMs: 1000, frame: { lat: 1, driver: "{params.id}" } },
          { afterMs: 3000, frame: { lat: 2 } },
        ],
      },
    ]);
    const first = join("/drivers/7");
    timer.advanceTime(1000);
    const second = join("/drivers/7");
    expect(first.member.frames).toEqual(['{"lat":1,"driver":"7"}']);
    first.connection.leave();
    timer.advanceTime(2000);
    expect(first.member.frames).toHaveLength(1);
    expect(second.member.frames).toEqual(['{"lat":1,"driver":"7"}']);
    timer.advanceTime(1000);
    expect(second.member.frames).toEqual(['{"lat":1,"driver":"7"}', '{"lat":2}']);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("publish reaches every member of the path, counts them and is logged", () => {
    const { join, engine, log } = setup([{ path: "/rooms/:roomId" }]);
    const a = join("/rooms/x");
    const b = join("/rooms/x");
    expect(engine.publish("/rooms/x", { n: 1 }, "publish")).toBe(2);
    expect(engine.publish("/rooms/empty", "x", "broadcast")).toBe(0);
    expect([a.member.frames, b.member.frames]).toEqual([['{"n":1}'], ['{"n":1}']]);
    expect(log).toEqual([
      ["/rooms/x", "publish", '{"n":1}'],
      ["/rooms/empty", "broadcast", "x"],
    ]);
  });

  test("room paths compare percent-encoded, so a space and %20 are one room", () => {
    const { join, engine } = setup([{ path: "/rooms/:roomId" }]);
    const a = join("/rooms/a%20b");
    expect(engine.publish("/rooms/a b", "x", "publish")).toBe(1);
    expect(a.member.frames).toEqual(["x"]);
  });

  test("oversized sends and publishes are refused", () => {
    const { join, engine } = setup([{ path: "/r", relay: true }]);
    const a = join("/r");
    const big = "x".repeat(MAX_PROTOTYPE_CHANNEL_FRAME_BYTES + 1);
    expect(a.connection.send(big)).toEqual({ ok: false, reason: "too_large" });
    expect(engine.publish("/r", big, "publish")).toBe(0);
  });

  test("a room holds a bounded number of connections", () => {
    const { join, engine } = setup([{ path: "/r" }]);
    for (let index = 0; index < MAX_MOCK_ROOM_MEMBERS; index++) {
      join("/r");
    }
    expect(engine.join("/r", {}, new Member())).toMatchObject({ ok: false, status: 503 });
    expect(engine.memberCount("/r")).toBe(MAX_MOCK_ROOM_MEMBERS);
  });

  test("closeAll ends every connection once, cancels timelines and refuses later sends", () => {
    const { join, engine, timer } = setup([{ path: "/r", timeline: [{ afterMs: 5, frame: 1 }] }]);
    const a = join("/r");
    engine.closeAll("gone");
    engine.closeAll("again");
    timer.advanceTime(10);
    expect(a.member.closes).toEqual([[1001, "gone"]]);
    expect(a.member.frames).toEqual([]);
    expect(a.connection.send("x")).toEqual({ ok: false, reason: "not_open" });
    expect(engine.memberCount()).toBe(0);
  });

  test("mockFrameData keeps strings and serializes other JSON", () => {
    expect([mockFrameData("a"), mockFrameData(1), mockFrameData(null), mockFrameData([1])]).toEqual(
      ["a", "1", "null", "[1]"],
    );
  });
});
