import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PrototypeFakeMediaEngine,
  type PrototypeFakeMediaEvent,
  type PrototypeFakeMediaFailure,
  type PrototypeFakeMediaResult,
  type PrototypeFakeMediaState,
  type PrototypeMediaSimEvent,
  type PrototypeMediaSimStatus,
} from "../../../src/features/prototype/prototypeFakeMediaEngine";
import { validatePrototypeMediaSimPayload } from "../../../src/features/prototype/prototypeMediaSimulate";

interface Step {
  op: "load" | "play" | "pause" | "seek" | "advance" | "simulate" | "release";
  player?: string;
  durationMs?: number;
  loop?: boolean;
  positionMs?: number;
  ms?: number;
  event?: PrototypeMediaSimEvent;
  data?: { player?: string; status?: PrototypeMediaSimStatus; code?: string; advanceMs?: number };
  error?: PrototypeFakeMediaFailure;
}

interface SimCase {
  name: string;
  steps: Step[];
  expected: {
    events: PrototypeFakeMediaEvent[];
    state: { players: Record<string, PrototypeFakeMediaState> };
  };
}

const cases = JSON.parse(
  readFileSync(join(import.meta.dir, "../../fixtures/prototype-media-sim/scripts.json"), "utf8"),
) as SimCase[];

function run(engine: PrototypeFakeMediaEngine, step: Step): PrototypeFakeMediaResult {
  const player = step.player ?? "";
  switch (step.op) {
    case "load":
      engine.load(player, step.durationMs!, step.loop ?? false);
      return { success: true };
    case "play":
      return engine.play(player);
    case "pause":
      return engine.pause(player);
    case "seek":
      return engine.seek(player, step.positionMs!);
    case "advance":
      engine.advance(step.ms!);
      return { success: true };
    case "release":
      return engine.release(player);
    case "simulate": {
      const data = step.data ?? {};
      return engine.simulate({ event: step.event!, ...data, player: data.player ?? "" });
    }
  }
}

describe("prototype fake media engine", () => {
  test("replays every shared media simulation script", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const simCase of cases) {
      const engine = new PrototypeFakeMediaEngine();
      for (const step of simCase.steps) {
        const result = run(engine, step);
        expect({ name: simCase.name, step, result }).toEqual({
          name: simCase.name,
          step,
          result: step.error ? { success: false, code: step.error } : { success: true },
        });
      }
      expect({ name: simCase.name, events: engine.events }).toEqual({
        name: simCase.name,
        events: simCase.expected.events,
      });
      expect({ name: simCase.name, state: engine.snapshot() }).toEqual({
        name: simCase.name,
        state: simCase.expected.state,
      });
    }
  });

  test("the host accepts every scripted event payload the engine does not refuse as invalid", () => {
    for (const step of cases.flatMap((simCase) => simCase.steps)) {
      if (step.op !== "simulate") {
        continue;
      }
      expect({
        step,
        accepted: validatePrototypeMediaSimPayload(step.event!, step.data).success,
      }).toEqual({ step, accepted: step.error !== "invalid_args" });
    }
  });

  test("release drops the player from /platform/media", () => {
    const engine = new PrototypeFakeMediaEngine();
    engine.load("a", 1000);
    engine.load("b", 2000);
    expect(engine.release("a")).toEqual({ success: true });
    expect(Object.keys(engine.snapshot().players)).toEqual(["b"]);
    expect(engine.play("a")).toEqual({ success: false, code: "unknown_player" });
  });
});
