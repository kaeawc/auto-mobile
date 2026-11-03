import { describe, expect, test } from "bun:test";
import { PrototypeMockBackend } from "../../../src/features/prototype/PrototypeMockBackend";
import { PrototypeMockBackendRegistry } from "../../../src/features/prototype/PrototypeMockBackendRegistry";
import {
  mockBackendDefinitionSchema,
  type MockBackendDefinition,
} from "../../../src/features/prototype/prototypeMockSchema";
import type { PrototypeRequestJson } from "../../../src/features/prototype/prototypeRequestProtocol";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { SeededRandom } from "../../fakes/SeededRandom";
import fixture from "../../fixtures/prototype-mock/actors.json";

interface TimelineStep {
  request?: { method: string; path: string; body?: PrototypeRequestJson };
  status?: number;
  advanceMs?: number;
  expect?: Record<string, unknown>;
}

function engine(definition: unknown) {
  const timer = new FakeTimer();
  const parsed = mockBackendDefinitionSchema.parse(definition);
  const backend = new PrototypeMockBackend(parsed, {
    random: new SeededRandom(1),
    ids: new FakeIdGenerator(),
    timer,
  });
  return { timer, backend };
}

describe("PrototypeMockActors fixtures", () => {
  test.each(fixture.cases.map((entry) => [entry.name, entry] as const))(
    "%s",
    async (_name, entry) => {
      const { timer, backend } = engine(entry.definition);
      for (const [at, step] of (entry.steps as TimelineStep[]).entries()) {
        if (step.request !== undefined) {
          const response = await backend.answer({
            ...step.request,
            query: {},
            body: step.request.body,
          });
          expect({ at, status: response.status }).toEqual({ at, status: step.status! });
        }
        if (step.advanceMs !== undefined) {
          timer.advanceTime(step.advanceMs);
        }
        if (step.expect !== undefined) {
          const snapshot: Record<string, unknown> = backend.snapshot();
          for (const [name, items] of Object.entries(step.expect)) {
            expect({ at, name, items: snapshot[name] }).toEqual({ at, name, items });
          }
        }
      }
      backend.dispose();
    },
  );
});

describe("PrototypeMockActors lifecycle", () => {
  const ticking: MockBackendDefinition = {
    collections: { ticks: [] },
    actors: [{ every: 100, maxRuns: 50, do: [{ append: "ticks", value: { n: 1 } }] }],
  };

  test("replacing or clearing a backend cancels its scheduled steps", () => {
    const timer = new FakeTimer();
    const registry = new PrototypeMockBackendRegistry({ ids: new FakeIdGenerator(), timer });
    registry.define("feed", ticking);
    const first = registry.get("feed")!;
    timer.advanceTime(100);
    registry.define("feed", ticking);
    timer.advanceTime(100);
    expect(first.snapshot().ticks).toHaveLength(1);
    registry.clear("feed");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("session end cancels every backend's steps", () => {
    const timer = new FakeTimer();
    const registry = new PrototypeMockBackendRegistry({ ids: new FakeIdGenerator(), timer });
    registry.define("a", ticking);
    registry.define("b", ticking);
    registry.clearAll();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a trigger past the pending cap is dropped instead of growing without bound", async () => {
    const { timer, backend } = engine({
      collections: { log: [] },
      actors: [{ on: { route: "GET /log" }, afterMs: 1000, do: [{ append: "log", value: {} }] }],
    });
    for (let index = 0; index < 300; index++) {
      await backend.answer({ method: "GET", path: "/log", query: {}, body: undefined });
    }
    expect(timer.getPendingTimeoutCount()).toBe(256);
    timer.advanceTime(1000);
    expect(backend.snapshot().log).toHaveLength(256);
  });
});

describe("mock actor definitions", () => {
  const issueOf = (definition: unknown): string | undefined => {
    const result = mockBackendDefinitionSchema.safeParse(definition);
    return result.success ? undefined : result.error.issues[0]?.message;
  };

  test.each([
    [
      "publish is refused until mock channels exist",
      { actors: [{ every: 100, maxRuns: 1, do: [{ publish: { channel: "room:1" } }] }] },
      "publish is not supported",
    ],
    [
      "an unknown collection",
      { actors: [{ every: 100, maxRuns: 1, do: [{ append: "nope", value: {} }] }] },
      'no collection named "nope"',
    ],
    [
      "every without maxRuns",
      { collections: { a: [] }, actors: [{ every: 100, do: [{ afterMs: 1 }] }] },
      "every needs maxRuns",
    ],
    [
      "both on and every",
      {
        actors: [{ on: { route: "GET /a" }, every: 100, maxRuns: 1, do: [{ afterMs: 1 }] }],
      },
      "exactly one of on or every",
    ],
    [
      "a route without a method",
      { actors: [{ on: { route: "/a" }, do: [{ afterMs: 1 }] }] },
      'route must look like "POST /feed/:id"',
    ],
    [
      "update without an id",
      {
        collections: { a: [] },
        actors: [{ every: 100, maxRuns: 1, do: [{ update: "a", value: {} }] }],
      },
      "id goes with update or remove",
    ],
    [
      "two writes in one step",
      {
        collections: { a: [] },
        actors: [{ every: 100, maxRuns: 1, do: [{ append: "a", remove: "a", id: 1, value: {} }] }],
      },
      "at most one of append, update or remove",
    ],
  ])("%s", (_name, definition, message) => {
    expect(issueOf(definition)).toContain(message);
  });

  test("more than 16 actors or 64 steps are refused", () => {
    const actor = { every: 100, maxRuns: 1, do: [{ afterMs: 1 }] };
    expect(issueOf({ actors: Array.from({ length: 17 }, () => actor) })).toBeDefined();
    expect(issueOf({ actors: [actor] })).toBeUndefined();
    expect(
      issueOf({ actors: [{ ...actor, do: Array.from({ length: 65 }, () => ({ afterMs: 1 })) }] }),
    ).toBeDefined();
  });
});
