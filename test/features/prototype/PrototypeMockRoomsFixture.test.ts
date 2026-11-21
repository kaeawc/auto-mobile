import { describe, expect, test } from "bun:test";
import { PrototypeMockBackend } from "../../../src/features/prototype/PrototypeMockBackend";
import type { MockRoomConnection } from "../../../src/features/prototype/prototypeMockRooms";
import { mockBackendDefinitionSchema } from "../../../src/features/prototype/prototypeMockSchema";
import type { PrototypeRequestJson } from "../../../src/features/prototype/prototypeRequestProtocol";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { SeededRandom } from "../../fakes/SeededRandom";
import fixture from "../../fixtures/prototype-mock/rooms.json";

interface Step {
  join?: string;
  path?: string;
  query?: Record<string, string>;
  send?: string;
  data?: string;
  publish?: string;
  frame?: PrototypeRequestJson;
  delivered?: number;
  leave?: string;
  advanceMs?: number;
  request?: { method: string; path: string; body?: PrototypeRequestJson };
  status?: number;
  expect?: PrototypeRequestJson;
  collections?: Record<string, PrototypeRequestJson[]>;
  refused?: number | string;
  deliveries?: Record<string, string[]>;
}

/** One backend and its named connections; every frame a connection receives lands in `inbox`. */
class Replay {
  readonly timer = new FakeTimer();
  readonly engine: PrototypeMockBackend;
  private readonly connections = new Map<string, MockRoomConnection>();
  private readonly inbox = new Map<string, string[]>();
  collections: Record<string, PrototypeRequestJson[]>;

  constructor(definition: unknown) {
    this.engine = new PrototypeMockBackend(mockBackendDefinitionSchema.parse(definition), {
      random: new SeededRandom(1),
      ids: new FakeIdGenerator(),
      timer: this.timer,
    });
    this.collections = this.engine.snapshot();
  }

  /** Runs one step and returns what it reported: a refusal, a delivered count or a response. */
  async run(step: Step): Promise<Record<string, unknown>> {
    if (step.join !== undefined) {
      return this.join(step.join, step.path ?? "/", step.query ?? {});
    }
    if (step.send !== undefined) {
      const result = this.connection(step.send).send(step.data ?? "");
      return result.ok ? {} : { refused: result.reason };
    }
    if (step.publish !== undefined) {
      return { delivered: this.engine.publish(step.publish, step.frame ?? null) };
    }
    if (step.leave !== undefined) {
      this.connection(step.leave).leave();
      return {};
    }
    if (step.advanceMs !== undefined) {
      this.timer.advanceTime(step.advanceMs);
      return {};
    }
    return this.request(step);
  }

  /** Every frame delivered since the last call, per connection that received any. */
  drain(): Record<string, string[]> {
    const drained = Object.fromEntries([...this.inbox].filter(([, frames]) => frames.length > 0));
    this.inbox.clear();
    return drained;
  }

  private join(name: string, path: string, query: Record<string, string>) {
    const joined = this.engine.join(path, query, {
      deliver: (data) => this.inbox.set(name, [...(this.inbox.get(name) ?? []), data]),
      close: () => {},
    });
    if (!joined.ok) {
      return { refused: joined.status };
    }
    this.connections.set(name, joined.connection);
    return {};
  }

  private async request(step: Step): Promise<Record<string, unknown>> {
    const request = step.request!;
    const url = new URL(request.path, "https://x.test");
    const response = await this.engine.answer({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: request.body,
    });
    this.collections = { ...this.collections, ...step.collections };
    return { status: response.status, expect: response.body, collections: this.engine.snapshot() };
  }

  private connection(name: string): MockRoomConnection {
    const connection = this.connections.get(name);
    if (connection === undefined) {
      throw new Error(`fixture step names unknown connection ${name}`);
    }
    return connection;
  }
}

/** What the fixture says a step reports, in the shape `Replay.run` returns. */
function expected(step: Step, collections: Record<string, PrototypeRequestJson[]>) {
  if (step.request !== undefined) {
    return { status: step.status, expect: step.expect, collections };
  }
  if (step.refused !== undefined) {
    return { refused: step.refused };
  }
  return step.publish === undefined ? {} : { delivered: step.delivered };
}

describe("PrototypeMockBackend room fixtures", () => {
  test.each(fixture.cases.map((entry) => [entry.name, entry] as const))(
    "%s",
    async (_name, entry) => {
      const replay = new Replay(entry.definition);
      for (const [index, step] of (entry.steps as Step[]).entries()) {
        const reported = await replay.run(step);
        expect({ step: index, reported, deliveries: replay.drain() }).toEqual({
          step: index,
          reported: expected(step, replay.collections),
          deliveries: step.deliveries ?? {},
        });
      }
      replay.engine.dispose();
    },
  );
});
