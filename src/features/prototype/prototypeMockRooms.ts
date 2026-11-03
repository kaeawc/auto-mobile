/**
 * Realtime rooms of a mock backend (#14271): WebSocket and SSE connections to a room path join that
 * room. `onConnect` frames greet each connection, `timeline` frames follow on the injected `Timer`,
 * `echo` returns a client's send, `relay` fans it out to the other members, and `publish` and
 * collection broadcasts reach every member. No socket is involved.
 */
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { Timer } from "../../utils/SystemTimer";
import { bindMockValue, matchMockPath, type MockBindingContext } from "./prototypeMockBinding";
import { MAX_PROTOTYPE_CHANNEL_FRAME_BYTES } from "./prototypeChannelLimits";
import { MAX_MOCK_ROOM_MEMBERS, type MockRoom } from "./prototypeMockSchema";
import type { PrototypeRequestJson } from "./prototypeRequestProtocol";

/** What a room delivers to one connection. */
export interface MockRoomMember {
  deliver(data: string): void;
  /** The room or its backend went away: end the connection. */
  close(code: number, reason: string): void;
}

export type MockRoomSendResult = { ok: true } | { ok: false; reason: "not_open" | "too_large" };

export interface MockRoomConnection {
  send(data: string): MockRoomSendResult;
  /** Leaves the room and stops its timeline; idempotent. */
  leave(): void;
}

export type MockRoomJoin =
  | { ok: true; connection: MockRoomConnection }
  | { ok: false; status: 404 | 503; message: string };

/** Who put a frame into a room, as `backendLog` reports it. */
export type MockFrameSource = "client" | "publish" | "broadcast";

export interface MockRoomsDeps {
  timer: Pick<Timer, "setTimeout" | "clearTimeout">;
  record(room: string, from: MockFrameSource, data: string): void;
}

interface Member {
  room: MockRoom;
  path: string;
  target: MockRoomMember;
  timers: NodeJS.Timeout[];
  left: boolean;
}

/** A JSON frame on the wire: a string as written, anything else as JSON text. */
export function mockFrameData(frame: PrototypeRequestJson): string {
  return typeof frame === "string" ? frame : JSON.stringify(frame);
}

/** The path as a URL would carry it, so `/rooms/a b` and `/rooms/a%20b` name the same room. */
export function normalizeMockRoomPath(path: string): string {
  // Appended, not resolved: a `//x` path must stay a path, never become a protocol-relative host.
  return new URL(`https://room.invalid${path.startsWith("/") ? "" : "/"}${path}`).pathname;
}

const fits = (data: string): boolean =>
  Buffer.byteLength(data) <= MAX_PROTOTYPE_CHANNEL_FRAME_BYTES;

export class MockRooms {
  private readonly members = new Set<Member>();

  constructor(
    private readonly rooms: readonly MockRoom[],
    private readonly deps: MockRoomsDeps,
  ) {}

  /** Members of `path`, or of every room. */
  memberCount(path?: string): number {
    return this.membersOf(path === undefined ? undefined : normalizeMockRoomPath(path)).length;
  }

  /**
   * Joins the first room whose pattern matches `path`, delivering its `onConnect` frames at once
   * and scheduling its timeline.
   */
  join(path: string, query: Record<string, string>, target: MockRoomMember): MockRoomJoin {
    const normalized = normalizeMockRoomPath(path);
    const match = this.match(normalized);
    if (match === undefined) {
      return { ok: false, status: 404, message: `No mock room matches ${normalized}.` };
    }
    if (this.membersOf(normalized).length >= MAX_MOCK_ROOM_MEMBERS) {
      return {
        ok: false,
        status: 503,
        message: `Mock room ${normalized} already has ${MAX_MOCK_ROOM_MEMBERS} connections.`,
      };
    }
    const member: Member = { room: match.room, path: normalized, target, timers: [], left: false };
    this.members.add(member);
    const context: MockBindingContext = { params: match.params, query, body: undefined };
    for (const frame of match.room.onConnect ?? []) {
      this.deliverBound(member, frame, context);
    }
    for (const entry of match.room.timeline ?? []) {
      member.timers.push(
        this.deps.timer.setTimeout(
          () => this.deliverBound(member, entry.frame, context),
          entry.afterMs,
        ),
      );
    }
    return {
      ok: true,
      connection: { send: (data) => this.send(member, data), leave: () => this.leave(member) },
    };
  }

  /** Sends `frame` to every member of `path`; the number of members it reached. */
  publish(path: string, frame: PrototypeRequestJson, from: MockFrameSource): number {
    const normalized = normalizeMockRoomPath(path);
    const data = mockFrameData(frame);
    if (!fits(data)) {
      logger.warn(
        `[PrototypeMock] dropped a ${from} frame to ${normalized}: over ${MAX_PROTOTYPE_CHANNEL_FRAME_BYTES} bytes`,
      );
      return 0;
    }
    this.deps.record(normalized, from, data);
    const members = this.membersOf(normalized);
    members.forEach((member) => member.target.deliver(data));
    return members.length;
  }

  /** The backend is being replaced, cleared or the session ended. */
  closeAll(reason: string): void {
    for (const member of [...this.members]) {
      this.leave(member);
      member.target.close(1001, reason);
    }
  }

  private send(member: Member, data: string): MockRoomSendResult {
    if (member.left) {
      return { ok: false, reason: "not_open" };
    }
    if (!fits(data)) {
      return { ok: false, reason: "too_large" };
    }
    this.deps.record(member.path, "client", data);
    if (member.room.echo === true) {
      member.target.deliver(data);
    }
    if (member.room.relay === true) {
      this.membersOf(member.path)
        .filter((other) => other !== member)
        .forEach((other) => other.target.deliver(data));
    }
    return { ok: true };
  }

  private leave(member: Member): void {
    if (member.left) {
      return;
    }
    member.left = true;
    member.timers.forEach((handle) => this.deps.timer.clearTimeout(handle));
    this.members.delete(member);
  }

  private deliverBound(
    member: Member,
    frame: PrototypeRequestJson,
    context: MockBindingContext,
  ): void {
    if (member.left) {
      return;
    }
    let data: string;
    try {
      data = mockFrameData(bindMockValue(frame, context, MAX_PROTOTYPE_CHANNEL_FRAME_BYTES));
    } catch (error) {
      logger.warn(
        `[PrototypeMock] dropped a scripted frame to ${member.path}: ${errorMessage(error)}`,
      );
      return;
    }
    if (fits(data)) {
      member.target.deliver(data);
    } else {
      logger.warn(`[PrototypeMock] dropped a scripted frame to ${member.path}: too large`);
    }
  }

  private match(path: string): { room: MockRoom; params: Record<string, string> } | undefined {
    for (const room of this.rooms) {
      const params = matchMockPath(room.path, path);
      if (params !== undefined) {
        return { room, params };
      }
    }
    return undefined;
  }

  private membersOf(path: string | undefined): Member[] {
    return [...this.members].filter((member) => path === undefined || member.path === path);
  }
}
